import { Context, SectionKinds } from "./bytecode";

export type LineNumber = {
  offset: number;
  pc: number;
  file: number;
  symbol: number;
  line: number;
};

export function parseLineNum(view: DataView) {
  const size = view.getUint16(0);
  let current = 2;
  const results: Map<number, LineNumber> = new Map();
  for (let i = 0; i < size; i++) {
    const offset = current;
    const pc = view.getUint32((current += 4) - 4);
    const file = view.getUint32((current += 4) - 4);
    const symbol = view.getUint32((current += 4) - 4);
    const line = view.getUint32((current += 4) - 4);
    results.set(pc, { offset, pc, file, symbol, line });
  }
  return results;
}

export function fixupLineNum(context: Context, offsetMap: Map<number, number>) {
  const view = context.sections[SectionKinds.LINENUM].view;

  const size = view.getUint16(0);
  let current = 2;
  for (let i = 0; i < size; i++) {
    const pc = view.getUint32(current);
    if (pc >>> 28 === 1) {
      const newPc = offsetMap.get(pc & 0xffffff);
      if (newPc != null) {
        view.setUint32(current, newPc | 0x10000000);
      }
    }
    current += 16;
  }
}
