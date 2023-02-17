import * as assert from "node:assert";
import * as crypto from "node:crypto";
import { xmlUtil } from "src/sdk-util";
import { hasProperty } from "../ast";
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
  //functions.forEach((func) => printFunction(func, context));

  functions.forEach((func) => optimizeFunc(func));

  const code = context.sections[SectionKinds.TEXT].view;
  let offset = 0;
  const updateInfo: UpdateInfo = {
    offsetMap: new Map(),
    localsMap: new Map(),
  };

  functions.forEach((func) => {
    if (!func.name) return;
    false &&
      console.log(
        `${func.name}: ${offset.toString(16)} ${offset - func.offset}`
      );
    offset = emitFunc(func, code, offset, updateInfo);
  });

  const { offsetMap } = updateInfo;
  offsetMap.set(code.byteLength, offset);

  console.log(
    `${context.filepath}: code size: ${
      context.sections[SectionKinds.TEXT].length
    } => ${offset} difference: ${
      context.sections[SectionKinds.TEXT].length - offset
    }`
  );

  fixSectionSize(SectionKinds.TEXT, context.sections, offset);

  //functions.forEach((func) => printFunction(func, context));

  fixupExceptions(context, offsetMap);
  fixupData(context, offsetMap);
  fixupLineNum(context, offsetMap);
  if (context.debugXml.body instanceof Error) {
    return;
  }
  const fixpc = (pc: number) => {
    if (pc >>> 28 !== 1) return pc;
    const newPc = offsetMap.get(pc & 0xffffff);
    if (newPc == null) return null;
    return newPc | 0x10000000;
  };

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

  context.debugXml.body
    .children("pcToLineNum")
    .elements.forEach((lineNumEntries) => {
      const kids = lineNumEntries.children;
      if (!kids) return;
      for (let i = kids.length, j = i; i--; ) {
        const entry = kids[i];
        if (entry.type === "element") {
          assert(entry.name === "entry");
          const pc = entry.attr.pc;
          assert(pc);
          const newPc = fixpc(Number(pc.value.value));
          if (newPc == null) {
            kids.splice(i, j - i);
          } else {
            pc.value.value = newPc.toString();
          }
          j = i;
        }
      }
    });

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

export function printFunction(func: FuncEntry, context: Context | null) {
  console.log(`${func.name ?? "<unknown>"}:`);
  func.blocks.forEach((block) => {
    console.log(`${offsetToString(block.offset)}:`);
    block.try?.forEach((exInfo) => {
      assert(exInfo);
      console.log(
        `tryCatch - start: ${offsetToString(
          exInfo.tryStart
        )} end: ${offsetToString(exInfo.tryEnd)} handler: ${offsetToString(
          exInfo.handler
        )}`
      );
    });
    if (context) {
      const pc = block.offset | 0x10000000;
      const lineInfo = context.lineTable.get(pc);
      if (lineInfo) {
        const file = context.symbolTable.symbols.get(lineInfo.file);
        console.log(`${file?.str || "<unknown>"}:${lineInfo.line}`);
      }
    }
    block.bytecodes.forEach((bytecode) => {
      console.log(`    ${bytecodeToString(bytecode, context?.symbolTable)}`);
    });
    if (block.next != null) {
      console.log(`  -> ${offsetToString(block.next)}`);
    }
    if (block.taken != null) {
      console.log(`  -> ${offsetToString(block.taken)}`);
    }
  });
  console.log(`${func.name ?? "<unknown>"}_end`);
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
          arg = symbol.str;
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

function findFunctions({
  bytecodes,
  lineTable,
  symbolTable,
  exceptionsMap,
}: Context) {
  const blockStarts = new Set<number>();
  for (const pc of lineTable.keys()) {
    const section = pc >>> 28;
    if (section === 1) {
      blockStarts.add(pc & 0xffffff);
    }
  }

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
  let next: number | undefined;
  let taken: number | undefined;
  bytecodes.forEach((bytecode, i) => {
    if (blockStarts.has(bytecode.offset)) {
      if (i > start) {
        const offset = bytecodes[start].offset;
        const block: Block = {
          bytecodes: bytecodes.slice(start, i),
          offset,
        };
        if (next != null) {
          block.next = next;
        }
        if (taken != null) {
          block.taken = taken;
        }
        if (exnStack.length) {
          block.try = exnStack.slice();
        }
        blocks.set(offset, block);
      }
      if (
        exnStack.length &&
        exnStack[exnStack.length - 1].tryEnd === bytecode.offset
      ) {
        exnStack.pop();
      }
      start = i;
      const exnEntry = exceptionsMap.get(bytecode.offset);
      if (exnEntry) {
        exnStack.push(...exnEntry);
      }
    }
    next = bytecode.offset + bytecode.size;
    taken = undefined;
    switch (bytecode.op) {
      case Opcodes.return:
      case Opcodes.ret:
      case Opcodes.throw:
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
    const name = symbolTable.methods.get(offset);
    if (name) f.name = name;
    functions.set(offset, f);
  }

  return functions;
}