import assert from "node:assert";
import { log, logger, wouldLog } from "../util";
import {
  Block,
  blockToString,
  bytecodeToString,
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

Finally, if all the initializers are the same:

        ipush 9       9
        newa          A
        ipush 9       A 9
loop    ipush 1
        subv          A 8
        dup 1         A 8 A
        dup 1         A 8 A 8
        ipush initVal A 8 A 8 I
        aputv         A 8
        dup 0         A 8 8
        bt <loop>     A 8
        popv
*/

export function optimizeArrayInit(
  func: FuncEntry,
  block: Block,
  index: number,
  stackPreserving: boolean,
  context: Context
) {
  assert(block.bytecodes[index].op === Opcodes.newa);
  const putvStarts: number[] = [];
  let i: number;
  let initVal: Bytecode | false | null = null;
  for (i = index; ++i < block.bytecodes.length - 1; ) {
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
    if (initVal !== false) {
      if (found === i + 3) {
        const bc = block.bytecodes[i + 2];
        if (initVal === null) {
          initVal = bc;
        } else if (initVal.op !== bc.op || initVal.arg !== bc.arg) {
          initVal = false;
        }
      } else {
        initVal = false;
      }
    }
    putvStarts.push(i);
    i = found;
  }
  if (block.bytecodes[i]?.op === Opcodes.popv) {
    // dce can't quite handle this case on its own,
    // so delete all the array dups, and ipushes,
    // and convert the aputvs to popv.
    const convertAputv = (i: number) => {
      const bc = block.bytecodes[i];
      const op = bc.op;
      bc.op = Opcodes.popv;
      bc.size = 1;
      delete bc.arg;
      assert(op === Opcodes.aputv);
    };
    convertAputv(i - 1);
    for (i = putvStarts.length; i--; ) {
      const offset = putvStarts[i];
      block.bytecodes.splice(offset, 2);
      if (i) {
        convertAputv(offset - 1);
      }
    }
    logger(
      "array-init",
      1,
      `Optimizing unused ${
        putvStarts.length
      } element array init at block ${offsetToString(
        block.offset
      )}, starting at index ${index}, at offset ${offsetToString(
        block.bytecodes[index].offset
      )}`
    );
    if (wouldLog("array-init", 5)) {
      log(blockToString(block, context));
    }
    return true;
  }
  const bytecode = <T extends Opcodes>(
    op: T,
    arg: Extract<Bytecode, { op: T }>["arg"]
  ) => {
    const bc = { op, arg, size: opcodeSize(op), offset: context.nextOffset++ };
    if (arg == null) delete bc.arg;
    return bc;
  };

  if (initVal) {
    if (putvStarts.length < 3) return false;
    logger(
      "array-init",
      1,
      `Optimizing ${
        putvStarts.length
      } element array init with constant initializer ${bytecodeToString(
        initVal,
        null
      )} at block ${offsetToString(
        block.offset
      )}, starting at index ${index}, at offset ${offsetToString(
        block.bytecodes[index].offset
      )}`
    );

    // delete everything except the first element assignment
    block.bytecodes.splice(
      putvStarts[1],
      putvStarts[putvStarts.length - 1] - putvStarts[0]
    );
    // delete the leading "dup 0"
    block.bytecodes.splice(putvStarts[0], 1);
    // change the initial "ipush 0" to "ipush length"
    block.bytecodes[putvStarts[0]].arg = putvStarts.length;
    const loopOffset = context.nextOffset;
    block.bytecodes.splice(
      index + 2,
      0,
      bytecode(Opcodes.ipush, 1),
      bytecode(Opcodes.subv, undefined),
      bytecode(Opcodes.dup, 1),
      bytecode(Opcodes.dup, 1)
    );
    // index+6 is the init value, and index+7
    // is the aputv
    block.bytecodes.splice(
      index + 8,
      0,
      bytecode(Opcodes.dup, 0),
      bytecode(Opcodes.bt, loopOffset),
      bytecode(Opcodes.popv, undefined)
    );
    splitBlock(func, block, index + 10);
    splitBlock(func, block, index + 2);
    const loop = func.blocks.get(loopOffset)!;
    loop.preds!.add(loopOffset);
    loop.taken = loopOffset;
    return true;
  }
  if (stackPreserving || putvStarts.length < 4) return false;
  // delete each "dup 0; ipush <n>" pair except the first one
  for (i = putvStarts.length; i-- > 1; ) {
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
