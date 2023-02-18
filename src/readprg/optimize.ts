import { bytecodeToString, FuncEntry } from "./bytecode";
import { Opcodes } from "./opcodes";

export function optimizeFunc(func: FuncEntry) {
  clearSelf(func);

  // delete nops
  func.blocks.forEach((block) => {
    for (let i = block.bytecodes.length; i--; ) {
      if (block.bytecodes[i].op === Opcodes.nop) {
        block.bytecodes.splice(i, 1);
        console.log(`Deleting nop in ${func.name}`);
        if (i > 0) {
          console.log(
            ` - previous bytecode was ${bytecodeToString(
              block.bytecodes[i - 1],
              null
            )}`
          );
        }
      }
    }
  });
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
