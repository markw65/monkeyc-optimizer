import assert from "node:assert";
import { logger } from "../util";
import {
  Block,
  Context,
  FuncEntry,
  offsetToString,
  splitBlock,
} from "./bytecode";
import { Bytecode, getOpInfo, Opcodes, opcodeSize } from "./opcodes";

/*

An array initialization looks like:

    ipush 9 // Number of elements
    newa

    // initialize first element
    dup 0
    ipush 0
    <push0>
    aputv

    // initialize second element
    dup 0
    ipush 1
    <push1>
    aputv

    // initialize third element
    dup 0
    ipush 2
    <push2>
    aputv

    // etc

We could instead push A 8 A 7 A 6 A 5 A 4 A 3 A 2 A 1 A 0
and then:

    <push0>
    aputv
    <push1>
    aputv
    <push2>
    aputv
    // etc

Its tempting to try to re-use the array length as the loop counter:

     ipush 9  9
     dup 0    9 9
     newa     9 A
     dup 0    9 A A
     dup 2    9 A A 9
loop ipush 1  9 A A 9 1
     subv     9 A A 8
     dup 0    9 A A 8 8
     bf <end> 9 A A 8
     dup 1
     dup 1
     goto loop
end  nop      9 A A 8 A 7 A 6 A 5 A 4 A 3 A 2 A 1 A 0
     <push0>
     aputv
     ...
     popv (get rid of the 9)

but that ends up with the loop test at the head of the loop, resulting
in a goto at the end, and also requires a popv at the end.

It costs 25 bytes but saves 7 bytes per array element

So instead, we can just push length-1 at the head of the loop

        ipush 9  9
        newa     A
        dup 0    A A
        ipush 8  A A 8
loop    dup 1    A A 8 A
        dup 1    A A 8 A 8
        ipush 1  A A 8 A 8 1
        subv     A A 8 A 7
        dup 0    A A 8 A 7 7
        bt <loop> A A 8 A 7
        nop      A A 8 A 7 A 6 A 5 A 4 A 3 A 2 A 1 A 0

Cost 22 bytes vs 7 bytes per array element

We could try to do a shared version:

       ipush N
       jsr <array-init>
       nop       R A A N-1 A N-2 ... A 0

array-init:
       dup 1      N R N
       newa       N R A
       dup 0      N R A A
       dup 3      N R A A N
loop   dup 0      N R A A N N
       bf <end>   N R A A N
       ipush 1
       subv       N R A A N-1
       dup 1
       dup 1      N R A A N-1 A N-1
       goto loop
end    // but now there's no way to pick the return address
       // from deep on the stack. So we can only do this for
       // fixed N.
       // We could interleave copies of the return address
       // with the A N pairs. But now the caller has to pop
       // all of them. So we only save 6 bytes per element,
       // with an overhead of 4.
*/

export function optimizeArrayInit(
  func: FuncEntry,
  block: Block,
  index: number,
  context: Context
) {
  assert(block.bytecodes[index].op === Opcodes.newa);
  const putvStarts: number[] = [];
  for (let i = index; ++i < block.bytecodes.length - 1; ) {
    const dup = block.bytecodes[i];
    if (dup.op !== Opcodes.dup || dup.arg !== 0) {
      break;
    }
    const ipush = block.bytecodes[i + 1];
    if (ipush.op !== Opcodes.ipush || ipush.arg !== putvStarts.length) {
      break;
    }
    let found = i;
    for (let k = i + 1, depth = 0; ++k < block.bytecodes.length; ) {
      const bc = block.bytecodes[k];
      if (bc.op === Opcodes.aputv && depth === 1) {
        found = k;
        break;
      }
      const { pop, push } = getOpInfo(bc);
      depth += push - pop;
      // stop if it does unexpected stack manipulation.
      if (depth < 0 || (bc.op === Opcodes.dup && bc.arg >= depth)) {
        break;
      }
    }
    if (found === i) break;
    putvStarts.push(i);
    i = found;
  }
  if (putvStarts.length < 4) return false;
  // delete each "dup 0; ipush <n>" pair except the first one
  for (let i = putvStarts.length; i-- > 1; ) {
    block.bytecodes.splice(putvStarts[i], 2);
  }
  logger(
    "array-init",
    1,
    `Optimizing ${
      putvStarts.length
    } element array init at block ${offsetToString(
      block.offset
    )}, starting at index ${index}, at offset ${offsetToString(
      block.bytecodes[index].offset
    )}`
  );
  block.bytecodes[index + 2].arg = putvStarts.length - 1;
  const bytecode = <T extends Opcodes>(
    op: T,
    arg: Extract<Bytecode, { op: T }>["arg"]
  ) => {
    const bc = { op, arg, size: opcodeSize(op), offset: context.nextOffset++ };
    if (arg == null) delete bc.arg;
    return bc;
  };
  const loopOffset = context.nextOffset;
  block.bytecodes.splice(
    index + 3,
    0,
    bytecode(Opcodes.dup, 1),
    bytecode(Opcodes.dup, 1),
    bytecode(Opcodes.ipush, 1),
    bytecode(Opcodes.subv, undefined),
    bytecode(Opcodes.dup, 0),
    bytecode(Opcodes.bt, loopOffset)
  );

  splitBlock(func, block, index + 9);
  splitBlock(func, block, index + 3);
  const loop = func.blocks.get(loopOffset)!;
  loop.preds!.add(loopOffset);
  loop.taken = loopOffset;
  return true;
}
