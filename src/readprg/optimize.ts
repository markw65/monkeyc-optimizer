import { FuncEntry } from "./bytecode";
import { Opcodes } from "./opcodes";

export function optimizeFunc(func: FuncEntry) {
  clearSelf(func);
}

function clearSelf(func: FuncEntry) {
  const blocks = Array.from(func.blocks.values());
  const usesSelf = blocks.some((b) =>
    b.bytecodes.some(
      (bytecode) => bytecode.op === Opcodes.lgetv && bytecode.arg === 0
    )
  );
  if (usesSelf) return;
  const entry = blocks[0];
  let i = entry.bytecodes.length;
  while (i-- > 2) {
    if (
      entry.bytecodes[i].op === Opcodes.lputv &&
      entry.bytecodes[i].arg === 0 &&
      entry.bytecodes[i - 1].op === Opcodes.getm &&
      entry.bytecodes[i - 2].op === Opcodes.spush
    ) {
      console.log(`Deleting self from ${func.name}`);
      entry.bytecodes.splice(i - 2, 3);
      return;
    }
  }
}
