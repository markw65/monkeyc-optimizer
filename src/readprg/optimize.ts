import { bytecodeToString, FuncEntry } from "./bytecode";
import { Bytecode, Mulv, Opcodes } from "./opcodes";

export function optimizeFunc(func: FuncEntry) {
  clearSelf(func);

  // trivial transformations
  func.blocks.forEach((block) => {
    for (let i = block.bytecodes.length; i--; ) {
      const cur = block.bytecodes[i];
      if (cur.op === Opcodes.nop) {
        block.bytecodes.splice(i, 1);
        console.log(`${func.name}: deleting nop`);
        if (i > 0) {
          console.log(
            ` - previous bytecode was ${bytecodeToString(
              block.bytecodes[i - 1],
              null
            )}`
          );
        }
      } else if (i && cur.op === Opcodes.shlv) {
        const prev = block.bytecodes[i - 1];
        if (prev.op === Opcodes.ipush || prev.op === Opcodes.lpush) {
          const shift = BigInt(prev.arg);
          if (!(shift & 63n) && prev.op === Opcodes.ipush) {
            block.bytecodes.splice(i - 1, 2);
            console.log(`${func.name}: deleting no-op shift`);
            continue;
          }
          // note that 31 isn't safe if the other operand is a Long,
          // because we end up multiplying by -2^31.
          if (shift < (prev.op === Opcodes.lpush ? 64n : 31n)) {
            const mul = 1n << shift;
            if (prev.op === Opcodes.ipush) {
              prev.arg = Number(mul) | 0;
            } else {
              prev.arg = BigInt.asIntN(64, mul);
            }
            console.log(
              `${func.name}: converting shlv(${shift}) to mulv(${prev.arg})`
            );

            const mulv = cur as Bytecode as Mulv;
            mulv.op = Opcodes.mulv;
            mulv.size = 1;
            delete mulv.arg;
          }
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
