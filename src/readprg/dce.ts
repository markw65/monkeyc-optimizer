import assert from "node:assert";
import { GenericQueue, log, logger, setBanner, wouldLog } from "../util";
import {
  Block,
  bytecodeToString,
  Context,
  FuncEntry,
  functionBanner,
  makeArgless,
  offsetToString,
} from "./bytecode";
import { postOrderTraverse } from "./cflow";
import { Bytecode, getOpInfo, Opcodes } from "./opcodes";

export function localDCE(func: FuncEntry, context: Context) {
  if (wouldLog("dce", 5)) {
    setBanner(
      functionBanner(func, context, "local-dce-start", (block) => {
        return `liveOutLocals: ${Array.from(
          liveOutLocals.get(block.offset) ?? []
        ).join(" ")}\n`;
      })
    );
  }
  const { liveInLocals, liveOutLocals } = computeLiveLocals(func);

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
    locals: Set<number>;
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
      locals: new Set(liveOutLocals.get(block.offset)),
    };

    for (let i = block.bytecodes.length; i--; ) {
      const bytecode = block.bytecodes[i];
      switch (bytecode.op) {
        case Opcodes.lputv: {
          const liveLocal = dceInfo.locals.has(bytecode.arg);
          if (!liveLocal) {
            logger(
              "dce",
              2,
              `${func.name}: Killing store to unused local ${
                bytecode.arg
              } at ${offsetToString(block.offset)}:${i}`
            );
            makePopv(bytecode);
            dceInfo.stack.push({ dead: true, deps: [i] });
          } else {
            dceInfo.stack.push({ dead: false });
          }
          dceInfo.locals.delete(bytecode.arg);
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
            dceInfo.locals.add(bytecode.arg);
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

        case Opcodes.throw:
        case Opcodes.invokem:
          // A call might throw, so if there's an exsucc
          // we need to mark all the locals that are live
          // into the exsucc as live here.
          if (block.exsucc) {
            liveInLocals
              .get(block.exsucc)
              ?.forEach((local) => dceInfo.locals.add(local));
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

function computeJsrMap(func: FuncEntry) {
  const jsrMap: Map<number, Set<number>> = new Map();
  const findRets = (
    offset: number,
    rets: Set<number>,
    visited: Set<number>
  ) => {
    if (visited.has(offset)) return;
    visited.add(offset);
    const block = func.blocks.get(offset)!;
    const last = block.bytecodes[block.bytecodes.length - 1];
    if (last?.op === Opcodes.ret) {
      rets.add(offset);
      return;
    }
    if (block.next != null) {
      findRets(block.next, rets, visited);
    }
    if (block.taken != null) {
      findRets(block.taken, rets, visited);
    }
  };
  func.blocks.forEach((block) => {
    const last = block.bytecodes[block.bytecodes.length - 1];
    if (last && last.op === Opcodes.jsr) {
      const rets: Set<number> = new Set();
      jsrMap.set(block.offset, rets);
      findRets(block.offset, rets, new Set());
    }
  });
  return jsrMap;
}

export function computeLiveLocals(func: FuncEntry) {
  const order: Map<Block, number> = new Map();
  const queue = new GenericQueue<Block>(
    (b, a) => order.get(a)! - order.get(b)!
  );
  postOrderTraverse(func, (block) => {
    order.set(block, order.size);
    queue.enqueue(block);
  });
  const jsrMap = computeJsrMap(func);
  const liveOutLocals: Map<number, Set<number>> = new Map();
  const liveInLocals: Map<number, Set<number>> = new Map();
  const merge = (locals: Set<number>, pred: number) => {
    const predLocals = liveOutLocals.get(pred);
    if (!predLocals) {
      liveOutLocals.set(pred, new Set(locals));
      queue.enqueue(func.blocks.get(pred)!);
      return;
    }
    const size = predLocals.size;
    locals.forEach((local) => predLocals.add(local));
    if (size !== predLocals.size) {
      queue.enqueue(func.blocks.get(pred)!);
    }
  };
  while (!queue.empty()) {
    const top = queue.dequeue();
    const locals = new Set(liveOutLocals.get(top.offset));
    for (let i = top.bytecodes.length; i--; ) {
      const bc = top.bytecodes[i];
      switch (bc.op) {
        case Opcodes.lgetv:
          locals.add(bc.arg);
          break;
        case Opcodes.lputv:
          locals.delete(bc.arg);
          break;
        case Opcodes.throw:
        case Opcodes.invokem:
          if (top.exsucc) {
            liveInLocals.get(top.exsucc)?.forEach((local) => locals.add(local));
          }
          break;
      }
    }
    liveInLocals.set(top.offset, locals);
    top.preds?.forEach((pred) => {
      const predBlock = func.blocks.get(pred)!;
      if (predBlock.next !== top.offset && predBlock.taken !== top.offset) {
        assert(predBlock.exsucc === top.offset);
        // if this is (only) an exceptional predecessor, we handle it separately
        return;
      }
      merge(locals, pred);
      const jsrPreds = jsrMap.get(pred);
      if (jsrPreds) {
        if (predBlock.next === top.offset) {
          jsrPreds.forEach((jsrPred) => merge(locals, jsrPred));
        }
      }
    });
  }
  return { liveInLocals, liveOutLocals };
}
