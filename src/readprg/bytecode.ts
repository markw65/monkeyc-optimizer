import assert from "node:assert";
import * as crypto from "node:crypto";
import { hasProperty } from "../ast";
import { xmlUtil } from "../sdk-util";
import { bumpLogging, log, logger, wouldLog } from "../util";
import { fixupData } from "./data";
import { emitFunc, UpdateInfo } from "./emit";
import { ExceptionEntry, ExceptionsMap, fixupExceptions } from "./exceptions";
import { fixupLineNum, LineNumber } from "./linenum";
import { Bytecode, Opcodes } from "./opcodes";
import { optimizeFunc } from "./optimize";
import { SymbolTable } from "./symbols";

export const enum SectionKinds {
  TEXT = 0xc0debabe | 0,
  DATA = 0xda7ababe | 0,
  SYMBOLS = 0x5717b015 | 0,
  LINENUM = 0xc0de7ab1 | 0,
  EXCEPTIONS = 0xece7105 | 0,
  SIGNATURE = 0xe1c0de12 | 0,
  STORE_SIG = 20833 | 0,
}

export type SectionInfo = { offset: number; length: number; view: DataView };
export type Logger = (module: string, level: number, message: string) => void;

export type Context = {
  filepath: string;
  sections: Record<number, SectionInfo>;
  symbolTable: SymbolTable;
  lineTable: Map<number, LineNumber>;
  exceptionsMap: ExceptionsMap;
  bytecodes: Bytecode[];
  key?: crypto.KeyObject;
  debugXml: xmlUtil.Document;
};

export type Block = {
  offset: number;
  bytecodes: Bytecode[];
  try?: ExceptionEntry[];
  next?: number;
  taken?: number;
  exsucc?: number;
  preds?: Set<number>;
};

export type FuncEntry = {
  name?: string;
  offset: number;
  blocks: Map<number, Block>;
};

export function offsetToString(offset: number) {
  return ("000000" + offset.toString(16)).slice(-6);
}

export function fixSectionSize(
  section: SectionKinds,
  sections: Context["sections"],
  newSize: number
) {
  const sectionInfo = sections[section];
  assert(sectionInfo);
  const view = sectionInfo.view;
  sectionInfo.length = newSize;
  new DataView(view.buffer, view.byteOffset - 4, 4).setUint32(0, newSize);
  sectionInfo.view = new DataView(view.buffer, view.byteOffset, newSize);
}

export function optimizeBytecode(context: Context) {
  const functions = findFunctions(context);

  const loggerFunc = process.env["MC_LOGGER_FUNC"]
    ? new RegExp(process.env["MC_LOGGER_FUNC"])
    : null;
  const forEachFunction = (callback: (func: FuncEntry) => unknown) => {
    if (!loggerFunc) {
      functions.forEach(callback);
      return;
    }
    bumpLogging(null, 10);
    functions.forEach((func) => {
      if (loggerFunc.test(func.name ?? "<null>")) {
        bumpLogging(null, -10);
        callback(func);
        bumpLogging(null, 10);
        return;
      }
      callback(func);
    });
    bumpLogging(null, -10);
  };
  if (wouldLog("list-input", 1)) {
    forEachFunction(
      (func) => wouldLog("list-input", 1) && printFunction(func, context)
    );
  }

  forEachFunction((func) => optimizeFunc(func, context));

  const code = context.sections[SectionKinds.TEXT].view;
  let offset = 0;
  const updateInfo: UpdateInfo = {
    offsetMap: new Map(),
    localsMap: new Map(),
    lineMap: [],
  };

  forEachFunction((func) => {
    if (!func.name) return;
    logger(
      "bytecode",
      5,
      `${func.name}: ${offset.toString(16)} ${offset - func.offset}`
    );
    offset = emitFunc(func, code, offset, updateInfo, context);
  });

  const { offsetMap } = updateInfo;
  offsetMap.set(code.byteLength, offset);

  logger(
    "bytecode",
    1,
    `${context.filepath}: code size: ${
      context.sections[SectionKinds.TEXT].length
    } => ${offset} difference: ${
      context.sections[SectionKinds.TEXT].length - offset
    }`
  );

  fixSectionSize(SectionKinds.TEXT, context.sections, offset);

  if (wouldLog("list-output", 1)) {
    forEachFunction(
      (func) => wouldLog("list-output", 1) && printFunction(func, context)
    );
  }

  fixupExceptions(context, offsetMap);
  fixupData(context, offsetMap);
  fixupLineNum(context, updateInfo);
  if (context.debugXml.body instanceof Error) {
    return;
  }

  const funcArray = Array.from(functions.values()).filter(
    (func) => func.name != null
  );
  funcArray.push({ offset: code.byteLength, blocks: new Map() });

  const funcIndex = (pc: number) => {
    let lo = 0,
      hi = funcArray.length;
    pc = pc & 0xffffff;
    while (hi - lo > 1) {
      const mid = (hi + lo) >>> 1;
      if (funcArray[mid].offset > pc) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    return lo;
  };

  const funcRange = (pc: number) => {
    const index = funcIndex(pc);
    assert(
      funcArray[index].offset <= (pc & 0xffffff) &&
        funcArray[index + 1].offset > (pc & 0xffffff)
    );
    const s = offsetMap.get(funcArray[index].offset);
    const e = offsetMap.get(funcArray[index + 1].offset);
    if (s == null || e == null) {
      assert(s != null && e != null);
    }
    return [s + 0x10000000, e + 0x10000000];
  };

  let func = funcArray[0];
  let fend = funcArray[1].offset;
  context.debugXml.body
    .children("localVars")
    .children("entry")
    .elements.forEach((entry) => {
      const { startPc, endPc, stackId } = entry.attr;
      assert(startPc && endPc && stackId);
      const spc = Number(startPc.value.value) & 0xffffff;
      const epc = Number(endPc.value.value) & 0xffffff;
      const sid = Number(stackId.value.value);
      if (spc < func.offset || epc > fend) {
        const index = funcIndex(Number(startPc.value.value));
        func = funcArray[index];
        fend = funcArray[index + 1].offset;
      }
      const info = updateInfo.localsMap.get(func);
      assert(info);
      const local = info.get(sid);
      if (!local) {
        entry.attr = {};
        return;
      }
      startPc.value.value = (local.startPc + 0x10000000).toString();
      endPc.value.value = (local.endPc + 0xfffffff).toString();
    });
  context.debugXml.body
    .children("localVars")
    .deleteChildren((entry) => !entry.attr.startPc);

  context.debugXml.body
    .children("functions")
    .children("functionEntry")
    .elements.forEach((entry) => {
      const { startPc, endPc } = entry.attr;
      if (!startPc || !endPc) return;
      const range = funcRange(Number(startPc.value.value));
      assert(funcRange(Number(endPc.value.value))[0] === range[0]);
      startPc.value.value = range[0].toString();
      endPc.value.value = (range[1] - 1).toString();
    });
}

export function functionBanner(
  func: FuncEntry,
  context: Context | null,
  pass: string
) {
  return () =>
    `================ ${pass} : ${
      func.name
    } ================\n${functionToString(func, context)}\n---------------- ${
      func.name
    } ----------------`;
}
export function printFunction(func: FuncEntry, context: Context | null) {
  log(functionToString(func, context));
}

export function functionToString(func: FuncEntry, context: Context | null) {
  const parts: string[] = [];
  parts.push(`${func.name ?? "<unknown>"}:`);
  func.blocks.forEach((block) => parts.push(blockToString(block, context)));
  parts.push(`${func.name ?? "<unknown>"}_end`);
  return parts.join("\n");
}

export function blockToString(block: Block, context: Context | null) {
  let lineNum: LineNumber | null = null;
  const parts: string[] = [];
  const log = (msg: string) => parts.push(msg + "\n");
  log(`${offsetToString(block.offset)}:`);
  block.try?.forEach((exInfo) => {
    assert(exInfo);
    log(
      `tryCatch - start: ${offsetToString(
        exInfo.tryStart
      )} end: ${offsetToString(exInfo.tryEnd)} handler: ${offsetToString(
        exInfo.handler
      )}`
    );
  });
  if (block.preds) {
    log(`preds: ${Array.from(block.preds).map(offsetToString).join(" ")}`);
  }
  block.bytecodes.forEach((bytecode) => {
    const lineInfo = bytecode.lineNum;
    if (lineInfo && (!lineNum || lineInfo.line !== lineNum.line)) {
      lineNum = lineInfo;
      const file =
        lineInfo.fileStr ??
        context?.symbolTable.symbols.get(lineInfo.file)?.str ??
        "<unknown>";
      log(
        `${file}:${lineInfo.line}${
          lineInfo.symbolStr ? ` - ${lineInfo.symbolStr}` : ""
        }`
      );
    }
    log(`    ${bytecodeToString(bytecode, context?.symbolTable)}`);
  });
  if (block.next != null) {
    log(`  -> ${offsetToString(block.next)}`);
  }
  if (block.taken != null) {
    log(`  -> ${offsetToString(block.taken)}`);
  }
  return parts.join("");
}

export function bytecodeToString(
  bytecode: Bytecode,
  symbolTable: SymbolTable | null | undefined
) {
  let arg: string | null = null;
  switch (bytecode.op) {
    case Opcodes.spush: {
      const argSym = symbolTable?.symbolToLabelMap.get(bytecode.arg);
      if (argSym) {
        const symbol = symbolTable?.symbols.get(argSym);
        if (symbol) {
          arg = `${symbol.str} (${bytecode.arg})`;
        }
      }
      break;
    }
    case Opcodes.news: {
      const symbol = symbolTable?.symbols.get(bytecode.arg);
      if (symbol) {
        arg = symbol.str;
      }
      break;
    }
    case Opcodes.bt:
    case Opcodes.bf:
    case Opcodes.goto:
    case Opcodes.jsr: {
      arg = offsetToString(bytecode.arg);
      break;
    }
  }
  if (arg == null && hasProperty(bytecode, "arg")) {
    arg = `${bytecode.arg}`;
  }
  if (arg != null) {
    arg = " " + arg;
  }

  return `${Opcodes[bytecode.op]}${arg ?? ""}`;
}

export function findFunctions({
  bytecodes,
  symbolTable,
  exceptionsMap,
}: Context) {
  const blockStarts = new Set<number>();

  exceptionsMap.forEach((exns) =>
    exns.forEach((exn) => {
      blockStarts.add(exn.tryStart);
      blockStarts.add(exn.tryEnd);
      blockStarts.add(exn.handler);
    })
  );

  bytecodes.forEach((bytecode) => {
    switch (bytecode.op) {
      case Opcodes.bt:
      case Opcodes.bf:
      case Opcodes.goto:
      case Opcodes.jsr:
        blockStarts.add(bytecode.offset + bytecode.size);
        blockStarts.add(bytecode.arg);
        return;

      case Opcodes.return:
      case Opcodes.ret:
      case Opcodes.throw:
        blockStarts.add(bytecode.offset + bytecode.size);
        return;
    }
  });

  const exnStack: ExceptionEntry[] = [];
  const blocks = new Map<number, Block>();
  let start = 0;
  let mayThrow = false;
  let next: number | undefined;
  let taken: number | undefined;
  bytecodes.forEach((bytecode, i) => {
    const nextBcOffset = bytecode.offset + bytecode.size;
    next = nextBcOffset;
    taken = undefined;
    switch (bytecode.op) {
      case Opcodes.throw:
        mayThrow = true;
        next = undefined;
        break;
      case Opcodes.invokem:
        mayThrow = true;
        break;
      case Opcodes.return:
      case Opcodes.ret:
        next = undefined;
        break;
      case Opcodes.goto:
        next = bytecode.arg;
        break;
      case Opcodes.bt:
      case Opcodes.bf:
      case Opcodes.jsr:
        taken = bytecode.arg;
        break;
    }
    if (blockStarts.has(nextBcOffset)) {
      const offset = bytecodes[start].offset;
      const block: Block = {
        bytecodes: bytecodes.slice(start, i + 1),
        offset,
      };
      if (bytecode.op === Opcodes.goto) {
        block.bytecodes.pop();
      }
      if (next != null) {
        block.next = next;
      }
      if (taken != null) {
        block.taken = taken;
      }
      if (exnStack.length) {
        block.try = exnStack.slice();
        if (mayThrow) {
          block.exsucc = exnStack[exnStack.length - 1].handler;
        }
      }
      blocks.set(offset, block);
      if (
        exnStack.length &&
        exnStack[exnStack.length - 1].tryEnd === nextBcOffset
      ) {
        exnStack.pop();
      }
      start = i + 1;
      mayThrow = false;
      const exnEntry = exceptionsMap.get(nextBcOffset);
      if (exnEntry) {
        exnStack.push(...exnEntry);
      }
    }
  });
  const functions = new Map<number, FuncEntry>();
  while (blocks.size) {
    const func = new Map<number, Block>();

    const queue = [blocks.keys().next().value as number];
    while (queue.length) {
      const next = queue.pop()!;
      const block = blocks.get(next);
      if (!block) {
        continue;
      }
      func.set(next, block);
      blocks.delete(next);
      exceptionsMap.get(block.offset)?.forEach((exInfo) => {
        queue.push(exInfo.tryEnd);
        queue.push(exInfo.handler);
      });
      if (block.next != null) {
        queue.push(block.next);
      }
      if (block.taken != null) {
        queue.push(block.taken);
      }
    }
    const funcSorted = Array.from(func.keys())
      .sort((a: number, b: number) => a - b)
      .map((key) => [key, func.get(key)!] as const);
    const offset = funcSorted[0][0];
    const f: FuncEntry = { offset, blocks: new Map(funcSorted) };
    const name = symbolTable.methods.get(offset)?.name;
    if (!name) continue;
    f.name = name;
    functions.set(offset, f);
  }

  const addPred = (
    func: FuncEntry,
    block: number,
    succ: number | undefined
  ) => {
    if (succ != null) {
      const next = func.blocks.get(succ)!;
      if (!next.preds) next.preds = new Set();
      next.preds.add(block);
    }
  };

  functions.forEach((func) => {
    let lineNum: LineNumber | null = null;
    func.blocks.forEach((block) => {
      addPred(func, block.offset, block.next);
      addPred(func, block.offset, block.taken);
      addPred(func, block.offset, block.exsucc);
      block.bytecodes.forEach((bc) => {
        if (bc.lineNum) {
          lineNum = bc.lineNum;
        } else if (lineNum) {
          bc.lineNum = lineNum;
        }
      });
    });
  });

  return functions;
}

export function makeArgless(bc: Bytecode, op: Opcodes) {
  bc.op = op;
  delete bc.arg;
  bc.size = 1;
}

export function equalBlocks(b1: Block, b2: Block) {
  if (b1.bytecodes.length !== b2.bytecodes.length) return false;
  if (b1.next !== b2.next) return false;
  if (b1.taken !== b2.taken) return false;
  return b1.bytecodes.every((bc1, i) => {
    const bc2 = b2.bytecodes[i];
    return bc1.op === bc2.op && bc1.arg === bc2.arg;
  });
}

export function removePred(func: FuncEntry, target: number, pred: number) {
  const targetBlock = func.blocks.get(target)!;
  assert(targetBlock.preds?.has(pred));
  targetBlock.preds!.delete(pred);
}

export function addPred(func: FuncEntry, target: number, pred: number) {
  const targetBlock = func.blocks.get(target)!;
  if (!targetBlock.preds) targetBlock.preds = new Set();
  targetBlock.preds.add(pred);
}

export function redirect(
  func: FuncEntry,
  block: Block,
  from: number,
  to: number
) {
  let changes = false;
  if (block.next === from) {
    block.next = to;
    changes = true;
  }
  if (block.taken === from) {
    block.taken = to;
    const last = block.bytecodes[block.bytecodes.length - 1];
    switch (last.op) {
      case Opcodes.bt:
      case Opcodes.bf:
      case Opcodes.jsr:
        last.arg = to;
        break;
      default:
        assert(false);
    }
    changes = true;
  }
  if (block.exsucc === from) {
    assert(block.try);
    block.try[block.try.length - 1].handler = to;
    block.exsucc = to;
    changes = true;
  }
  if (changes) {
    removePred(func, from, block.offset);
    addPred(func, to, block.offset);
  }
  return changes;
}

export function splitBlock(func: FuncEntry, block: Block, offset: number) {
  if (offset > 0) {
    assert(offset < block.bytecodes.length);
    const tail = block.bytecodes.splice(offset);
    const tailBlock: Block = {
      bytecodes: tail,
      offset: tail[0].offset,
      preds: new Set([block.offset]),
      next: block.next,
      taken: block.taken,
    };
    func.blocks.set(tailBlock.offset, tailBlock);
    if (block.next != null) {
      const next = func.blocks.get(block.next)!;
      next.preds!.delete(block.offset);
      next.preds!.add(tailBlock.offset);
    }
    block.next = tailBlock.offset;
    if (block.taken != null) {
      const taken = func.blocks.get(block.taken)!;
      taken.preds!.delete(block.offset);
      taken.preds!.add(tailBlock.offset);
      delete block.taken;
    }
  } else {
    assert(offset < 0 && offset + block.bytecodes.length > 0);
    const head = block.bytecodes.splice(0, block.bytecodes.length + offset);
    const headBlock: Block = {
      bytecodes: head,
      offset: block.offset,
      preds: block.preds,
    };
    block.offset = block.bytecodes[0].offset;
    block.preds = new Set([headBlock.offset]);
    headBlock.next = block.offset;

    func.blocks.set(headBlock.offset, headBlock);
    func.blocks.set(block.offset, block);
    if (block.next != null) {
      const next = func.blocks.get(block.next)!;
      next.preds!.delete(headBlock.offset);
      next.preds!.add(block.offset);
    }
    if (block.taken != null) {
      const taken = func.blocks.get(block.taken)!;
      taken.preds!.delete(headBlock.offset);
      taken.preds!.add(block.offset);
    }
  }
}
