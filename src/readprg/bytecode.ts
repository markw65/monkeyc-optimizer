import assert from "node:assert";
import * as crypto from "node:crypto";
import { hasProperty } from "../ast";
import { BuildConfig } from "../optimizer-types";
import { xmlUtil } from "../sdk-util";
import { bumpLogging, log, logger, wouldLog } from "../util";
import { fixupData } from "./data";
import { UpdateInfo, emitFunc } from "./emit";
import { ExceptionEntry, ExceptionsMap, fixupExceptions } from "./exceptions";
import { Header, fixupHeader } from "./header";
import { LineNumber, fixupLineNum } from "./linenum";
import {
  Bytecode,
  LocalRange,
  Opcodes,
  isCondBranch,
  opcodeSize,
} from "./opcodes";
import { optimizeFunc } from "./optimize";
import { SymbolTable } from "./symbols";

export const enum SectionKinds {
  HEADER = 0xd000d000 | 0,
  HEADER_VERSIONED = 0xd000d00d | 0,
  TEXT = 0xc0debabe | 0,
  EXTENDED = 0xc0de10ad | 0,
  DATA = 0xda7ababe | 0,
  SYMBOLS = 0x5717b015 | 0,
  LINENUM = 0xc0de7ab1 | 0,
  EXCEPTIONS = 0xece7105 | 0,
  SIGNATURE = 0xe1c0de12 | 0,
  STORE_SIG = 20833 | 0,
}

export const TEXT_SECTION_PC = 0x10000000;
export const EXTENDED_SECTION_BASE = 0x50000000;
export const SECTION_PC_MASK = 0xf0000000;
export const PC_OFFSET_MASK = 0xffffff;
/*
HEADER(-805253120, 1, false),
  ENTRY_POINTS(1616953566, 11, false),
  PERMISSIONS(1610668801, 2, true),
  DATA(-629491010, 3, true),
  CODE(-1059145026, 4, true),
  EXTENDED_CODE(-1059188563),
  LINK_TABLE(-1046128719, 5, true),
  PC_TO_LINE_NUM(-1059161423, 6, true),
  RESOURCES(-267558899, 7, true),
  BACKGROUND_RESOURCES(-553727362, 8, true),
  GLANCE_RESOURCES(-804390194, 9, true),
  COMPLICATIONS(-87106950, 10, true),
  EXCEPTIONS(248410373, 12, true),
  SETTINGS(1584862309, 13, true),
  SYMBOLS(1461170197, 14, false),
  STRING_RESOURCE_SYMBOLS(-1163025067, 15, false),
  APP_UNLOCK(-804148571, 16, false),
  APP_STORE_SIGNATURE(20833, 17, false),
  DEVELOPER_SIGNATURE(-507453934, 18, false),
  DEBUG(-805303010, 19, true);
*/
export type SectionInfo = { offset: number; length: number; view: DataView };
export type Logger = (module: string, level: number, message: string) => void;

export type Context = {
  config: BuildConfig;
  filepath: string;
  sections: Record<number, SectionInfo>;
  header: Header;
  symbolTable: SymbolTable;
  lineTable: Map<number, LineNumber>;
  exceptionsMap: ExceptionsMap;
  bytecodes: Bytecode[];
  key?: crypto.KeyObject;
  debugXml: xmlUtil.Document;
  nextOffset: number;
  nextLocalId: number;
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
  argc?: number;
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

function markLocals(context: Context) {
  if (context.debugXml.body instanceof Error) {
    return;
  }

  type LocalInfo = {
    name: string;
    arg: boolean;
    sid: number;
    epc: number;
    range: number;
  };
  const localMap: Map<number, LocalInfo[]> = new Map();
  let range = context.nextLocalId;
  context.debugXml.body
    .children("localVars")
    .children("entry")
    .elements.forEach((entry) => {
      const { startPc, endPc, stackId, name, arg } = entry.attr;
      assert(startPc && endPc && stackId && name);
      const spcRaw = Number(startPc.value.value);
      const epcRaw = Number(endPc.value.value) + 1;
      const sid = Number(stackId.value.value);
      if (
        (spcRaw & SECTION_PC_MASK) !== TEXT_SECTION_PC ||
        (epcRaw & SECTION_PC_MASK) !== TEXT_SECTION_PC
      ) {
        return;
      }
      const spc = spcRaw & PC_OFFSET_MASK;
      const epc = epcRaw & PC_OFFSET_MASK;
      let locals = localMap.get(spc);
      if (!locals) {
        locals = [];
        localMap.set(spc, locals);
      }
      range++;
      locals.push({
        name: name.value.value,
        arg: arg?.value.value === "true",
        epc,
        sid,
        range,
      });
    });

  context.nextLocalId = range;
  // map from stackId to LocalInfo
  const live: Map<number, LocalInfo> = new Map();
  const ends: Map<number, number[]> = new Map();
  context.bytecodes.forEach((bc) => {
    const end = ends.get(bc.offset);
    if (end) {
      end.forEach((sid) => {
        assert(live.has(sid));
        live.delete(sid);
      });
      ends.delete(bc.offset);
    }

    const locals = localMap.get(bc.offset);
    locals?.forEach((localInfo) => {
      assert(!live.has(localInfo.sid));
      live.set(localInfo.sid, localInfo);
      const e = ends.get(localInfo.epc);
      if (e == null) {
        ends.set(localInfo.epc, [localInfo.sid]);
      } else {
        e.push(localInfo.sid);
      }
    });
    if (
      bc.op === Opcodes.lputv ||
      bc.op === Opcodes.lgetv ||
      bc.op === Opcodes.getlocalv
    ) {
      const localNum = bc.op === Opcodes.getlocalv ? bc.arg.local : bc.arg;
      const local = live.get(localNum);
      if (local) {
        const range: LocalRange = { name: local.name, id: local.range };
        if (local.arg) {
          range.isParam = true;
        }
        bc.range = range;
      }
    }
  });
}

export function optimizeBytecode(context: Context) {
  markLocals(context);
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
    localRanges: [],
    lineMap: [],
    exceptionsMap: new Map(),
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

  fixupHeader(context, updateInfo);
  fixupExceptions(context, updateInfo);
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
    pc = pc & PC_OFFSET_MASK;
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
      funcArray[index].offset <= (pc & PC_OFFSET_MASK) &&
        funcArray[index + 1].offset > (pc & PC_OFFSET_MASK)
    );
    const s = offsetMap.get(funcArray[index].offset);
    const e = offsetMap.get(funcArray[index + 1].offset);
    if (s == null || e == null) {
      assert(s != null && e != null);
    }
    return [s + TEXT_SECTION_PC, e + TEXT_SECTION_PC];
  };

  const localVars = context.debugXml.body.children("localVars");
  const addAttr = (
    element: xmlUtil.Element,
    attrName: string,
    attrValue: string
  ) => {
    element.attr[attrName] = xmlUtil.makeAttribute(attrName, attrValue);
  };
  localVars.elements.forEach((element, i) => {
    const original = element.children;
    delete element.children;
    if (i) return;
    const children =
      original?.filter((elt): elt is xmlUtil.Element => {
        if (elt.type !== "element") return false;
        if (!elt.attr?.startPc) return false;
        const spc = Number(elt.attr.startPc.value.value);
        return (spc & SECTION_PC_MASK) !== TEXT_SECTION_PC;
      }) ?? [];
    updateInfo.localRanges.forEach((localRange) => {
      if (localRange.endPc === localRange.startPc) {
        return;
      }
      const element: xmlUtil.Element = {
        type: "element",
        name: "entry",
        attr: {},
      };
      addAttr(element, "name", localRange.name);
      if (localRange.isParam) {
        addAttr(element, "arg", "true");
      }
      addAttr(
        element,
        "startPc",
        (localRange.startPc + TEXT_SECTION_PC).toString()
      );
      addAttr(
        element,
        "endPc",
        (localRange.endPc + TEXT_SECTION_PC).toString()
      );
      addAttr(element, "stackId", localRange.slot.toString());
      children.push(element);
    });
    element.children = children
      .sort(
        (a, b) =>
          Number(a.attr.startPc?.value.value ?? 0) -
          Number(b.attr.startPc?.value.value ?? 0)
      )
      .flatMap((e) => [{ type: "chardata", value: "\n" }, e]);
    element.children.push({ type: "chardata", value: "\n" });
  });

  context.debugXml.body
    .children("functions")
    .children("functionEntry")
    .elements.forEach((entry) => {
      const { startPc, endPc } = entry.attr;
      if (!startPc || !endPc) return;
      const spc = Number(startPc.value.value);
      const epc = Number(endPc.value.value);
      if ((spc & SECTION_PC_MASK) !== TEXT_SECTION_PC) {
        return;
      }
      const range = funcRange(spc);
      assert(funcRange(epc)[0] === range[0]);
      startPc.value.value = range[0].toString();
      endPc.value.value = (range[1] - 1).toString();
    });
}

export function functionBanner(
  func: FuncEntry,
  context: Context | null,
  pass: string,
  extra?: (block: Block, footer: boolean) => string
) {
  return () =>
    `================ ${pass} : ${
      func.name
    } ================\n${functionToString(
      func,
      context,
      extra
    )}\n---------------- ${func.name} ----------------`;
}
export function printFunction(func: FuncEntry, context: Context | null) {
  log(functionToString(func, context));
}

export function functionToString(
  func: FuncEntry,
  context: Context | null,
  extra?: (block: Block, footer: boolean) => string
) {
  const parts: string[] = [];
  parts.push(`${func.name ?? "<unknown>"}:`);
  func.blocks.forEach((block) => {
    if (extra) parts.push(extra(block, false));
    parts.push(blockToString(block, context));
    if (extra) parts.push(extra(block, true));
  });
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
      log(lineInfoToString(lineInfo, context));
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

export function lineInfoToString(
  lineInfo: LineNumber,
  context: Context | null
) {
  const file =
    lineInfo.fileStr ??
    context?.symbolTable.symbols.get(lineInfo.file)?.str ??
    "<unknown>";
  return `${file}:${lineInfo.line}${
    lineInfo.symbolStr ? ` - ${lineInfo.symbolStr}` : ""
  }`;
}

export function bytecodeToString(
  bytecode: Bytecode,
  symbolTable: SymbolTable | null | undefined
) {
  let arg: string | null = null;
  const symbol = (arg: number) => {
    const argSym = symbolTable?.symbolToLabelMap.get(arg);
    if (argSym) {
      const symbol = symbolTable?.symbols.get(argSym);
      if (symbol) {
        return `${symbol.str} (${arg})`;
      }
    }
    return arg.toString();
  };
  switch (bytecode.op) {
    case Opcodes.lgetv:
    case Opcodes.lputv:
      if (bytecode.range) {
        arg = `${bytecode.range.name} ${bytecode.arg}${
          bytecode.range.isParam ? " (param)" : ""
        }`;
      }
      break;
    case Opcodes.spush:
      arg = symbol(bytecode.arg);
      break;
    case Opcodes.news: {
      const symbol = symbolTable?.symbols.get(bytecode.arg);
      if (symbol) {
        arg = `${JSON.stringify(symbol.str)} (${bytecode.arg})`;
      }
      break;
    }
    case Opcodes.bt:
    case Opcodes.bf:
    case Opcodes.goto:
    case Opcodes.jsr:
      arg = offsetToString(bytecode.arg);
      break;
    case Opcodes.getlocalv:
      arg = `${
        bytecode.range
          ? `${bytecode.range.name} ${bytecode.arg.local}${
              bytecode.range.isParam ? " (param)" : ""
            }`
          : bytecode.arg.local
      } ${symbol(bytecode.arg.var)}`;
      break;
    case Opcodes.getmv:
      arg = `${symbol(bytecode.arg.module)} ${symbol(bytecode.arg.var)}`;
      break;
    case Opcodes.argcincsp:
      arg = `${bytecode.arg.argc} ${bytecode.arg.incsp}`;
      break;
  }
  if (arg == null && hasProperty(bytecode, "arg")) {
    arg = `${bytecode.arg}`;
  }
  if (arg != null) {
    arg = " " + arg;
  }

  return `${Opcodes[bytecode.op]}${arg ?? ""}`;
}

export function offsetAfter(bc: Bytecode) {
  return bc.offset + opcodeSize(bc.op);
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
        blockStarts.add(offsetAfter(bytecode));
        blockStarts.add(bytecode.arg);
        return;

      case Opcodes.return:
      case Opcodes.ret:
      case Opcodes.throw:
        blockStarts.add(offsetAfter(bytecode));
        return;
    }
  });

  let exnStack: ExceptionEntry[] = [];
  const blocks = new Map<number, Block>();
  let start = 0;
  let mayThrow = false;
  let next: number | undefined;
  let taken: number | undefined;
  bytecodes.forEach((bytecode, i) => {
    const nextBcOffset = offsetAfter(bytecode);
    next = nextBcOffset;
    taken = undefined;
    switch (bytecode.op) {
      case Opcodes.throw:
        mayThrow = true;
        next = undefined;
        break;
      case Opcodes.invokem:
      case Opcodes.invokemz:
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
        block.try = exnStack;
        if (mayThrow) {
          block.exsucc = exnStack[exnStack.length - 1].handler;
        }
      }
      blocks.set(offset, block);
      if (
        exnStack.length &&
        exnStack[exnStack.length - 1].tryEnd === nextBcOffset
      ) {
        // block.try refers to exnStack, so never modify it in place
        exnStack = exnStack.slice(0, -1);
      }
      start = i + 1;
      mayThrow = false;
      const exnEntries = exceptionsMap.get(nextBcOffset);
      if (exnEntries) {
        // block.try refers to exnStack, so never modify it in place
        exnStack = exnStack.concat(
          exnEntries.filter((exnEntry) => exnEntry.tryEnd > nextBcOffset)
        );
      }
    }
  });
  const functions = new Map<number, FuncEntry>();
  while (blocks.size) {
    const func = new Map<number, Block>();

    let argc = null;
    const queue = [blocks.keys().next().value as number];
    while (queue.length) {
      const next = queue.pop()!;
      const block = blocks.get(next);
      if (!block) {
        continue;
      }
      func.set(next, block);
      if (func.size === 1 && block.bytecodes.length) {
        if (block.bytecodes[0].op === Opcodes.argc) {
          argc = block.bytecodes[0].arg;
        } else if (block.bytecodes[0].op === Opcodes.argcincsp) {
          argc = block.bytecodes[0].arg.argc;
        }
      }
      blocks.delete(next);
      if (block.exsucc != null) {
        queue.push(block.exsucc);
      }
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
    const method = symbolTable.methods.get(offset);
    const name = method?.name;
    if (!name) continue;
    f.name = name;
    if (argc == null && method.argc != null) {
      argc = method.argc;
    }
    if (argc != null) {
      f.argc = argc;
    }
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

export function removeBlock(func: FuncEntry, offset: number) {
  const block = func.blocks.get(offset);
  assert(block && !block.preds?.size);
  block.next && removePred(func, block.next, block.offset);
  block.taken && removePred(func, block.taken, block.offset);
  block.exsucc && removePred(func, block.exsucc, block.offset);
  func.blocks.delete(offset);
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
  to: number | null | undefined
) {
  let changes = false;
  if (block.next === from) {
    if (to) {
      block.next = to;
    } else {
      delete block.next;
    }
    changes = true;
  }
  if (block.taken === from) {
    if (to) {
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
    } else {
      delete block.taken;
    }
    changes = true;
  }
  if (block.exsucc === from) {
    assert(to);
    assert(block.try);
    block.try[block.try.length - 1].handler = to;
    block.exsucc = to;
    changes = true;
  }
  if (changes) {
    removePred(func, from, block.offset);
    if (to) {
      addPred(func, to, block.offset);
    }
  }
  return changes;
}

export function splitBlock(func: FuncEntry, block: Block, offset: number) {
  const fixEx = (block: Block, isNew: boolean) => {
    if (block.exsucc) {
      if (
        !block.bytecodes.some(
          (bc) =>
            bc.op === Opcodes.throw ||
            bc.op === Opcodes.invokem ||
            bc.op === Opcodes.invokemz
        )
      ) {
        if (!isNew) {
          removePred(func, block.exsucc, block.offset);
        }
        delete block.exsucc;
      } else if (isNew) {
        addPred(func, block.exsucc, block.offset);
      }
    }
  };
  if (offset > 0) {
    assert(offset < block.bytecodes.length);
    const tail = block.bytecodes.splice(offset);
    const tailBlock: Block = {
      ...block,
      bytecodes: tail,
      offset: tail[0].offset,
      preds: new Set([block.offset]),
    };
    fixEx(block, false);
    fixEx(tailBlock, true);
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
      ...block,
      bytecodes: head,
      offset: block.offset,
      preds: block.preds,
    };
    block.offset = block.bytecodes[0].offset;
    block.preds = new Set([headBlock.offset]);
    headBlock.next = block.offset;
    delete headBlock.taken;
    fixEx(block, true);
    fixEx(headBlock, false);

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

// Determine how many of a block's predecessors
// rely on a fall through to get there.
//
// A predecessor that ends in a conditional branch,
// where the other edge goes to a block with exactly
// one pred doesn't count, because we can arrange
// for that branch to fall through to its other pred,
// and branch to this block.
export function countFallthroughPreds(func: FuncEntry, block: Block) {
  if (!block.preds || !block.preds.size) return 0;
  return Array.from(block.preds).reduce((count, predOffset) => {
    const pred = func.blocks.get(predOffset)!;
    if (
      !isCondBranch(
        pred.bytecodes[pred.bytecodes.length - 1]?.op ?? Opcodes.nop
      ) ||
      (pred.taken !== block.offset &&
        func.blocks.get(pred.taken!)!.preds!.size !== 1) ||
      (pred.next !== block.offset &&
        func.blocks.get(pred.next!)!.preds!.size !== 1)
    ) {
      count++;
    }
    return count;
  }, 0);
}
