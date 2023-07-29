import assert from "node:assert";
import { hasValue, TypeTag, ValueTypes } from "../type-flow/types";
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
import { cloneState, instForType, interpBytecode, InterpState } from "./interp";
import { Bytecode, getOpInfo, Lgetv, Opcodes, opcodeSize } from "./opcodes";

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
  context: Context,
  interpState: InterpState | null
) {
  assert(
    block.bytecodes[index].op === Opcodes.newa ||
      block.bytecodes[index].op === Opcodes.newba
  );
  if (!interpState) {
    interpState = cloneState(null);
  }
  const putvStarts: number[] = [];
  let i: number;
  let initInst: Bytecode | null = null;
  let initType: ValueTypes | false | null = null;
  let initLocal: Lgetv | false | null = null;
  let usedLocals = 0n;
  let local = -1;
  const depth = interpState.stack.length;
  for (i = index; ++i < block.bytecodes.length - 1; ) {
    const dup = block.bytecodes[i];
    if (dup.op !== Opcodes.dup || dup.arg !== 0) {
      break;
    }
    interpBytecode(dup, interpState, context);
    const ipush = block.bytecodes[i + 1];
    interpBytecode(ipush, interpState, context);
    if (
      interpState.stack.length !== depth + 2 ||
      interpState.stack[depth + 1].type.type !== TypeTag.Number ||
      interpState.stack[depth + 1].type.value !== putvStarts.length
    ) {
      break;
    }
    let found = i;
    let thisInit: ValueTypes | null = null;
    let thisLocal: Lgetv | null = null;
    for (let k = i + 1; ++k < block.bytecodes.length; ) {
      const bc = block.bytecodes[k];
      interpBytecode(bc, interpState, context);
      if (bc.op === Opcodes.aputv && interpState.stack.length === depth) {
        found = k;
        break;
      }
      if (bc.op === Opcodes.lgetv) {
        usedLocals |= 1n << BigInt(bc.arg);
      }
      // stop if it does unexpected stack manipulation.
      const delta = interpState.stack.length - depth;
      if (delta === 3) {
        const t = interpState.stack[interpState.stack.length - 1].type;
        if (bc.op === Opcodes.lgetv) {
          thisLocal = bc;
        } else {
          thisLocal = null;
        }
        if (
          hasValue(t) &&
          t.type &
            (TypeTag.Null |
              TypeTag.Boolean |
              TypeTag.Numeric |
              TypeTag.Char |
              TypeTag.String |
              TypeTag.Symbol)
        ) {
          thisInit = t;
          continue;
        }
        thisInit = null;
      }
      if (delta < 0 || (bc.op === Opcodes.dup && bc.arg >= delta - 1)) {
        break;
      }
    }
    if (found === i) break;
    if (found - i !== 3) {
      initLocal = initType = false;
    } else {
      if (initLocal !== false) {
        if (thisLocal) {
          if (initLocal == null) {
            initLocal = thisLocal;
          } else if (
            initLocal.arg !== thisLocal.arg &&
            !interpState.locals[initLocal.arg]?.equivs?.has(thisLocal.arg)
          ) {
            initLocal = false;
          }
        } else {
          initLocal = false;
        }
      }
      if (initType !== false) {
        if (thisInit) {
          if (initType == null) {
            initType = thisInit;
          } else if (
            initType.type !== thisInit.type ||
            initType.value !== thisInit.value
          ) {
            initType = false;
          }
          if (initType) {
            const bc = block.bytecodes[found - 1];
            if (
              bc.op !== Opcodes.dup &&
              (!initInst || initInst.size > bc.size)
            ) {
              const { push, pop } = getOpInfo(bc);
              if (push === 1 && pop === 0) {
                initInst = bc;
              }
            }
          }
        } else {
          initType = false;
        }
      }
    }
    putvStarts.push(i);
    i = found;
  }
  if (
    initType &&
    (block.bytecodes[index].op === Opcodes.newa
      ? initType.type === TypeTag.Null
      : initType.type === TypeTag.Number && initType.value === 0)
  ) {
    // Every element is initialized with its default value.
    logger(
      "array-init",
      1,
      () =>
        `${func.name}: Removing initialization of default initialized ${
          putvStarts.length
        } element array init at block ${offsetToString(
          block.offset
        )}, starting at index ${index}, at offset ${offsetToString(
          block.bytecodes[index].offset
        )}`
    );
    block.bytecodes.splice(index + 1, i - index - 1);
    return true;
  }

  const terminal = block.bytecodes[i];
  if (terminal?.op === Opcodes.popv) {
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
    for (let i = putvStarts.length; i--; ) {
      const offset = putvStarts[i];
      block.bytecodes.splice(offset, 2);
      if (i) {
        convertAputv(offset - 1);
      }
    }
    logger(
      "array-init",
      1,
      () =>
        `${func.name}: Optimizing unused ${
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

  const tryLocal = (n: number) => {
    if (
      local === -1 &&
      terminal?.op === Opcodes.lputv &&
      !((usedLocals >> BigInt(terminal.arg)) & 1n) &&
      putvStarts.length >= n
    ) {
      local = terminal.arg as number;
      // remove the lputv from the end
      block.bytecodes.splice(i++, 1);
      // insert it after the newa
      block.bytecodes.splice(++index, 0, terminal);
      for (let ix = putvStarts.length; ix--; ) {
        const dupIx = ++putvStarts[ix];
        const dup = block.bytecodes[dupIx];
        assert(dup.op === Opcodes.dup && dup.arg === 0);
        block.bytecodes[dupIx].op = Opcodes.lgetv;
        block.bytecodes[dupIx].arg = local;
      }
      return true;
    }
    return false;
  };
  if (initType) {
    if (!initInst) {
      initInst = instForType(initType, block.bytecodes[index + 3].offset);
    }
  } else {
    initInst = null;
  }
  if (initLocal && (!initInst || initInst.size > initLocal.size)) {
    initInst = initLocal;
  }
  if (initInst) {
    if (putvStarts.length < 3) return false;
    tryLocal(3);
    logger(
      "array-init",
      1,
      () =>
        `${func.name}: Optimizing ${
          putvStarts.length
        } element array init with constant initializer ${bytecodeToString(
          initInst!,
          null
        )} at block ${offsetToString(
          block.offset
        )}, starting at index ${index}, at offset ${offsetToString(
          block.bytecodes[index].offset
        )}`
    );
    // delete everything except the first element assignment
    block.bytecodes.splice(index + 5, i - index - 5);
    // delete the leading "dup 0"
    block.bytecodes.splice(index + 1, 1);
    if (local < 0) {
      // change the initial "ipush 0" to "ipush length". Note that it may not be
      // an ipush - it might have been optimized to an lgetv or dup
      block.bytecodes[index + 1].op = Opcodes.ipush;
      block.bytecodes[index + 1].arg = putvStarts.length;
    } else {
      // we have:
      // index-1: newa
      // index+0: lputv x
      // index+1: ipush 0
      if (
        index >= 2 &&
        block.bytecodes[index - 2].op === Opcodes.ipush &&
        block.bytecodes[index - 2].arg === putvStarts.length
      ) {
        // there's already a push of the correct length (for the newa), so drop
        // the ipush 0, and insert a dup of the length
        block.bytecodes.splice(index + 1, 1);
        block.bytecodes.splice(index - 1, 0, bytecode(Opcodes.dup, 0));
      } else {
        block.bytecodes[index + 1].op = Opcodes.ipush;
        block.bytecodes[index + 1].arg = putvStarts.length;
      }
    }
    logger(
      "array-init",
      5,
      () => `index: ${index}, i: ${i}\n${blockToString(block, context)}`
    );

    const loopOffset = context.nextOffset;
    block.bytecodes.splice(
      index + 2,
      1,
      bytecode(Opcodes.ipush, 1),
      bytecode(Opcodes.subv, undefined),
      local >= 0 ? bytecode(Opcodes.lgetv, local) : bytecode(Opcodes.dup, 1),
      bytecode(Opcodes.dup, 1),
      initInst
    );
    // index+7 is the aputv
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
  if (!tryLocal(3) && putvStarts.length < 4) return false;
  if (local >= 0) {
    block.bytecodes.splice(i, 0, bytecode(Opcodes.popv, undefined));
  }
  // delete each "dup 0; ipush <n>" pair except the first one
  for (let i = putvStarts.length; i-- > 1; ) {
    block.bytecodes.splice(putvStarts[i], 2);
  }
  logger(
    "array-init",
    1,
    () =>
      `${func.name}: Optimizing ${
        putvStarts.length
      } element array init at block ${offsetToString(
        block.offset
      )}, starting at index ${index}, at offset ${offsetToString(
        block.bytecodes[index].offset
      )}`
  );
  let loopOffset;
  if (local >= 0) {
    // we have:
    // index-1: newa
    // index+0: lputv x
    // index+1: dup 0
    // index+2: ipush 0

    // drop the dup 0 and ipush 0
    block.bytecodes.splice(index + 1, 2);
    if (
      index >= 2 &&
      block.bytecodes[index - 2].op === Opcodes.ipush &&
      block.bytecodes[index - 2].arg === putvStarts.length
    ) {
      // there's already a push of the correct length (for the newa), so drop
      block.bytecodes.splice(index - 1, 0, bytecode(Opcodes.dup, 0));
    } else {
      block.bytecodes.splice(
        index + 1,
        0,
        bytecode(Opcodes.ipush, putvStarts.length)
      );
    }
    index--;
    loopOffset = context.nextOffset;
    block.bytecodes.splice(
      index + 3,
      0,
      bytecode(Opcodes.lgetv, local),
      bytecode(Opcodes.dup, 1),
      bytecode(Opcodes.ipush, 1),
      bytecode(Opcodes.subv, undefined),
      bytecode(Opcodes.dup, 0),
      bytecode(Opcodes.bt, loopOffset)
    );
  } else {
    block.bytecodes[index + 2].op = Opcodes.ipush;
    block.bytecodes[index + 2].arg = putvStarts.length - 1;
    loopOffset = context.nextOffset;
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
  }

  splitBlock(func, block, index + 9);
  splitBlock(func, block, index + 3);
  const loop = func.blocks.get(loopOffset)!;
  loop.preds!.add(loopOffset);
  loop.taken = loopOffset;
  return true;
}
