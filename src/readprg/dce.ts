import assert from "node:assert";
import { log, logger, setBanner, wouldLog } from "../util";
import {
  bytecodeToString,
  Context,
  FuncEntry,
  functionBanner,
  makeArgless,
} from "./bytecode";
import { Bytecode, getOpInfo, Opcodes } from "./opcodes";

export function localDCE(func: FuncEntry, context: Context) {
  let numArgs = 0;
  let numLocals = 0;
  const locals: { read?: true; write?: true }[] = [];
  func.blocks.forEach((block) =>
    block.bytecodes.forEach((bytecode) => {
      switch (bytecode.op) {
        case Opcodes.argc:
          numArgs = bytecode.arg;
          assert(numLocals === 0);
          numLocals = numArgs;
          break;
        case Opcodes.incsp:
          numArgs = bytecode.arg;
          break;
        case Opcodes.lgetv: {
          const local = locals[bytecode.arg];
          if (!local) {
            locals[bytecode.arg] = { read: true };
          } else {
            local.read = true;
          }
          break;
        }
        case Opcodes.lputv: {
          const local = locals[bytecode.arg];
          if (!local) {
            locals[bytecode.arg] = { write: true };
          } else {
            local.write = true;
          }
        }
      }
    })
  );

  if (wouldLog("dce", 5)) {
    setBanner(functionBanner(func, context, "local-dce-start"));
  }

  let anyChanges = false;
  let changes = false;
  const makeNop = (bc: Bytecode) => {
    changes = true;
    makeArgless(bc, Opcodes.nop);
  };
  const makePopv = (bc: Bytecode) => {
    changes = true;
    makeArgless(bc, Opcodes.popv);
  };
  type DceLiveItem = { dead: false };
  type DceDeadItem = { dead: true; deps: number[] };
  type DceStackItem = DceLiveItem | DceDeadItem;
  type DceInfo = {
    stack: DceStackItem[];
    locals: typeof locals;
  };
  func.blocks.forEach((block) => {
    const reportPopv = (i: number, item: DceDeadItem, kill: boolean) => {
      logger(
        "dce",
        2,
        `${func.name}: Convert ${i}:${bytecodeToString(
          block.bytecodes[i],
          context.symbolTable
        )} to popv for ${item.deps
          .map(
            (i) =>
              `${i}:${bytecodeToString(
                block.bytecodes[i],
                context.symbolTable
              )}${kill ? "=>nop" : ""}`
          )
          .join(", ")} }`
      );
    };
    const reportNop = (item: DceDeadItem) => {
      logger(
        "dce",
        2,
        `${func.name}: Kill ${item.deps
          .map((i) => bytecodeToString(block.bytecodes[i], context.symbolTable))
          .join(", ")}`
      );
    };
    changes = false;
    /*
     * For local dce, we don't know what's live on exit from
     * the block, except that all locals are dead on exit
     * from the function. So if this block has no successors
     * (including a try handler) we can assume everything is
     * dead.
     * There's a special case for "ret", because although it
     * has no successors, it returns to the body of the function
     * so locals aren't necessarily dead there.
     */
    const resetLocal = () =>
      locals.map(
        (l) =>
          l &&
          (block.next ||
          block.taken ||
          block.exsucc ||
          block.bytecodes[block.bytecodes.length - 1]?.op === Opcodes.ret
            ? { ...l }
            : {})
      );

    /*
     * We're going to do a backward walk through each
     * block.
     *
     * Since we're going in reverse, each instruction
     * pops its outputs, and pushes its inputs. When an
     * instruction doesn't read its input (basically popv,
     * and lputv to a dead local), it pushes a `{ dead:true }`
     * entry onto the stack. When we encounter the instruction
     * that produced that stack entry, it will pop it, and
     * see the dead flag. Side effect free bytecodes can
     * then mark their own inputs as dead, modify themselves,
     * and kill their consumer.
     * eg
     *
     * 0:    ipush 42
     * 1:    ipush 1
     * 2:    addv
     * 3:    popv
     *
     * The `popv` pushes `{ dead:true, deps:[3] }`
     * The `addv` pops that, sees that its output is
     * unused. But turning itself and the popv into
     * nops would unbalance the stack, so it converts
     * itself to a popv, leaves the original popv
     * alone, re-pushes the thing it popped, and pushes
     * `{ dead:true, deps[2] }`.
     * Now the `ipush 1` pops `{ dead:true, deps[2] }`,
     * and turns both itself, and the `popv` (formerly
     * `addv` at index 2 into nops.
     * Finally `ipush 42` pops `{ dead:true, deps:[3] }`
     * and turns itself and the popv at index 3 into
     * nops.
     */
    const dceInfo: DceInfo = {
      stack: [],
      locals: resetLocal(),
    };

    for (let i = block.bytecodes.length; i--; ) {
      const bytecode = block.bytecodes[i];
      switch (bytecode.op) {
        case Opcodes.lputv: {
          const local = dceInfo.locals[bytecode.arg];
          if (!local.read) {
            logger(
              "dce",
              2,
              `${func.name}: Killing store to unused local ${bytecode.arg} at ${i}`
            );
            makePopv(bytecode);
            dceInfo.stack.push({ dead: true, deps: [i] });
          } else {
            dceInfo.stack.push({ dead: false });
          }
          delete local.read;
          break;
        }
        case Opcodes.popv:
          dceInfo.stack.push({ dead: true, deps: [i] });
          break;
        case Opcodes.dup: {
          const item = dceInfo.stack.pop();
          if (item?.dead) {
            item.deps.push(i);
            reportNop(item);
            item.deps.forEach((index) => makeNop(block.bytecodes[index]));
          } else {
            if (dceInfo.stack.length > bytecode.arg) {
              dceInfo.stack[dceInfo.stack.length - 1 - bytecode.arg].dead =
                false;
            }
          }
          break;
        }
        case Opcodes.lgetv:
        case Opcodes.npush:
        case Opcodes.bpush:
        case Opcodes.news:
        case Opcodes.ipush:
        case Opcodes.fpush:
        case Opcodes.spush:
        case Opcodes.cpush:
        case Opcodes.lpush:
        case Opcodes.dpush: {
          const item = dceInfo.stack.pop();
          if (item?.dead) {
            item.deps.push(i);
            reportNop(item);
            item.deps.forEach((index) => makeNop(block.bytecodes[index]));
          } else if (bytecode.op === Opcodes.lgetv) {
            dceInfo.locals[bytecode.arg].read = true;
          }
          break;
        }
        case Opcodes.addv:
        case Opcodes.subv:
        case Opcodes.mulv:
        case Opcodes.divv:
        case Opcodes.andv:
        case Opcodes.orv:
        case Opcodes.modv:
        case Opcodes.shlv:
        case Opcodes.shrv:
        case Opcodes.xorv:
        case Opcodes.eq:
        case Opcodes.lt:
        case Opcodes.lte:
        case Opcodes.gt:
        case Opcodes.gte:
        case Opcodes.ne:
        case Opcodes.canhazplz:
        case Opcodes.isa:
        case Opcodes.agetv:
        case Opcodes.getv: {
          const item = dceInfo.stack.pop();
          if (item?.dead) {
            reportPopv(i, item, false);
            makePopv(bytecode);
            dceInfo.stack.push({ dead: true, deps: item.deps.slice() });
            dceInfo.stack.push({ dead: true, deps: [i] });
          } else {
            dceInfo.stack.push({ dead: false });
            dceInfo.stack.push({ dead: false });
          }
          break;
        }
        case Opcodes.newc:
        case Opcodes.isnull:
        case Opcodes.invv:
        case Opcodes.getm:
        case Opcodes.newa:
        case Opcodes.newba:
        case Opcodes.newd: {
          const item = dceInfo.stack.pop();
          if (item?.dead) {
            reportPopv(i, item, true);
            makePopv(bytecode);
            item.deps.forEach((index) => makeNop(block.bytecodes[index]));
            dceInfo.stack.push({ dead: true, deps: [i] });
          } else {
            dceInfo.stack.push({ dead: false });
          }
          break;
        }
        case Opcodes.invokem:
          // A call might throw, so if there's an exsucc
          // we need to mark all the locals live again
          if (block.exsucc) {
            dceInfo.locals = resetLocal();
          }
        // fallthrough
        default: {
          let { push, pop } = getOpInfo(bytecode);
          while (push-- > 0) {
            dceInfo.stack.pop();
          }
          while (pop-- > 0) {
            dceInfo.stack.push({ dead: false });
          }
        }
      }
    }
    if (changes) {
      anyChanges = true;
      block.bytecodes = block.bytecodes.filter((bc) => bc.op !== Opcodes.nop);
      if (wouldLog("dce", 3)) {
        log(functionBanner(func, context, "local-dce-end")());
      }
    }
  });
  setBanner(null);
  return anyChanges;
}
