import assert from "node:assert";
import { Context, fixSectionSize, SectionKinds } from "./bytecode";

export type ExceptionEntry = {
  tryStart: number;
  tryEnd: number;
  handler: number;
};

export type ExceptionsMap = Map<number, ExceptionEntry[]>;

export function parseExceptions(view: DataView) {
  let num = view.getUint16(0);
  let current = 2;
  const exceptionsMap: ExceptionsMap = new Map();
  while (num--) {
    const tryStart = read24(view, (current += 3) - 3);
    const tryEnd = read24(view, (current += 3) - 3);
    const handler = read24(view, (current += 3) - 3);
    const exns = exceptionsMap.get(tryStart);
    if (!exns) {
      exceptionsMap.set(tryStart, [{ tryStart, tryEnd, handler }]);
    } else {
      for (let i = 0; ; i++) {
        if (i === exns.length || tryEnd > exns[i].tryEnd) {
          exns.splice(i, 0, { tryStart, tryEnd, handler });
          break;
        }
      }
    }
  }
  return exceptionsMap;
}

function read24(view: DataView, current: number) {
  return (
    (view.getUint8(current) << 16) +
    (view.getUint8(current + 1) << 8) +
    view.getUint8(current + 2)
  );
}

export function fixupExceptions(
  context: Context,
  offsetMap: Map<number, number>
) {
  const view = context.sections[SectionKinds.EXCEPTIONS].view;

  let num = view.getUint16(0);
  let readPos = 2;
  let writePos = 2;
  while (num--) {
    const tryStart = read24(view, (readPos += 3) - 3);
    const tryEnd = read24(view, (readPos += 3) - 3);
    const handler = read24(view, (readPos += 3) - 3);

    const newStart = offsetMap.get(tryStart);
    if (newStart == null) continue;
    const newEnd = offsetMap.get(tryEnd);
    const newHandler = offsetMap.get(handler);
    if (!newEnd || !newHandler) {
      assert(newEnd != null && newHandler != null);
    }
    write24(view, (writePos += 3) - 3, newStart);
    write24(view, (writePos += 3) - 3, newEnd);
    write24(view, (writePos += 3) - 3, newHandler);
  }
  const elems = (writePos - 2) / 9;
  view.setUint16(0, elems);

  fixSectionSize(SectionKinds.EXCEPTIONS, context.sections, writePos);
}

function write24(view: DataView, current: number, value: number) {
  view.setUint8(current, value >>> 16);
  view.setUint8(current + 1, value >>> 8);
  view.setUint8(current + 2, value);
}
