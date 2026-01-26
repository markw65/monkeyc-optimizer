import assert from "node:assert";
import {
  Context,
  PC_OFFSET_MASK,
  SECTION_PC_MASK,
  SectionKinds,
  TEXT_SECTION_PC,
} from "./bytecode";
import { SymbolTable } from "./symbols";

export function parseData(view: DataView, symbols: SymbolTable) {
  let current = 0;
  while (current < view.byteLength) {
    const code = view.getInt32(current);
    if (code === -1046127121 || code === -1029349905) {
      current = skipClassDef(view, current + 4, symbols, code);
    } else if (view.getUint8(current) === 1) {
      current = symbols.parseSymbol(view, current, current + 1);
    } else if (view.getUint8(current) === 3) {
      current += view.getUint32(current + 1) + 6;
    } else {
      throw new Error(`Unknown code: ${code}`);
    }
  }
}

function skipClassDef(
  view: DataView,
  current: number,
  symbols: SymbolTable,
  code: number
) {
  const isVariableSized = code === -1029349905;
  const flags = isVariableSized ? view.getUint8(current++) : -1;
  if (flags & 1) current += 4; // skip extends
  if (flags & 2) current += 4; // skip statics
  if (flags & 4) current += 4; // skip parent module
  if (flags & 8) current += 4; // skip module id
  current += 2; // skip appTypes
  let fields = isVariableSized
    ? view.getUint16((current += 2) - 2)
    : view.getUint8(current++);
  while (fields--) {
    const f1 = view.getUint32((current += 4) - 4);
    const type = isVariableSized ? view.getUint8(current++) : f1 & 15;
    const addr = view.getUint32((current += 4) - 4);
    if (type !== 6) continue;
    // its a method;
    if ((addr & SECTION_PC_MASK) === TEXT_SECTION_PC) {
      const pc = addr & PC_OFFSET_MASK;
      const method = symbols.methods.get(pc);
      if (method) {
        if (method.id != null) {
          // More than one method can be mapped to
          // the same pc (generally shared, no-op <init>
          // and initialize methods)
          // assert(method.id === f1 >>> 8);
        } else {
          method.id = f1 >>> 8;
        }
        continue;
      }
      let label = symbols.symbols.get(pc)?.str;
      if (!label) {
        const offset = symbols.symbolToLabelMap.get(f1 >>> 8);
        label =
          (offset != null && symbols.symbols.get(offset)?.str) ||
          `method_${pc}`;
        //symbols.symbols.set(pc, { str: label, label });
      }
      symbols.methods.set(pc, { name: label, id: f1 >>> 8, argc: null });
    }
  }
  return current;
}

export function fixupData(context: Context, offsetMap: Map<number, number>) {
  const view = context.sections[SectionKinds.DATA].view;
  const symbols = context.symbolTable;
  let current = 0;
  while (current < view.byteLength) {
    const code = view.getInt32(current);
    if (code === -1046127121 || code === -1029349905) {
      current = fixupClassDef(view, current + 4, offsetMap, code);
    } else if (view.getUint8(current) === 1) {
      current = symbols.parseSymbol(view, current, current + 1);
    } else if (view.getUint8(current) === 3) {
      current += view.getUint32(current + 1) + 6;
    } else {
      throw new Error(`Unknown code: ${code}`);
    }
  }
}

function fixupClassDef(
  view: DataView,
  current: number,
  offsetMap: Map<number, number>,
  code: number
) {
  const isVariableSized = code === -1029349905;
  const flags = isVariableSized ? view.getUint8(current++) : -1;
  if (flags & 1) current += 4; // skip extends
  if (flags & 2) current += 4; // skip statics
  if (flags & 4) current += 4; // skip parent module
  if (flags & 8) current += 4; // skip module id
  current += 2; // skip appTypes
  let fields = isVariableSized
    ? view.getUint16((current += 2) - 2)
    : view.getUint8(current++);
  while (fields--) {
    const f1 = view.getUint32((current += 4) - 4);
    const type = isVariableSized ? view.getUint8(current++) : f1 & 15;
    const addr = view.getUint32((current += 4) - 4);
    if (type !== 6) continue;
    // its a method;
    if ((addr & SECTION_PC_MASK) === TEXT_SECTION_PC) {
      const pc = addr & PC_OFFSET_MASK;
      const newPc = offsetMap.get(pc);
      assert(newPc != null);
      view.setUint32(current - 4, addr - pc + newPc);
    }
  }
  return current;
}
