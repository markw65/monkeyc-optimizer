import * as assert from "node:assert";
import { Context, SectionKinds } from "./bytecode";
import { SymbolTable } from "./symbols";

export function parseData(view: DataView, symbols: SymbolTable) {
  let current = 0;
  while (current < view.byteLength) {
    const code = view.getInt32(current);
    if (code === -1046127121) {
      current = skipClassDef(view, current + 4, symbols);
    } else if (view.getUint8(current) === 1) {
      current = symbols.parseSymbol(view, current, current + 1);
    } else {
      throw new Error(`Unknown code: ${code}`);
    }
  }
}

function skipClassDef(view: DataView, current: number, symbols: SymbolTable) {
  current += 4; // skip extends
  current += 4; // skip statics
  current += 4; // skip parent module
  current += 4; // skip module id
  current += 2; // skip appTypes
  let fields = view.getUint8(current++);
  while (fields--) {
    const f1 = view.getUint32((current += 4) - 4);
    const addr = view.getUint32((current += 4) - 4);
    if ((f1 & 15) !== 6) continue;
    // its a method;
    const section = addr >>> 28;
    if (section === 1) {
      const pc = addr & 0xffffff;
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
      symbols.methods.set(pc, { name: label, id: f1 >>> 8 });
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
    if (code === -1046127121) {
      current = fixupClassDef(view, current + 4, offsetMap);
    } else if (view.getUint8(current) === 1) {
      current = symbols.parseSymbol(view, current, current + 1);
    } else {
      throw new Error(`Unknown code: ${code}`);
    }
  }
}

function fixupClassDef(
  view: DataView,
  current: number,
  offsetMap: Map<number, number>
) {
  current += 4; // skip extends
  current += 4; // skip statics
  current += 4; // skip parent module
  current += 4; // skip module id
  current += 2; // skip appTypes
  let fields = view.getUint8(current++);
  while (fields--) {
    const f1 = view.getUint32((current += 4) - 4);
    const addr = view.getUint32((current += 4) - 4);
    if ((f1 & 15) !== 6) continue;
    // its a method;
    const section = addr >>> 28;
    if (section === 1) {
      const pc = addr & 0xffffff;
      const newPc = offsetMap.get(pc);
      assert(newPc != null);
      view.setUint32(current - 4, addr - pc + newPc);
    }
  }
  return current;
}
