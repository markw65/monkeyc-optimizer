import assert from "node:assert";
import { log, logger, setBanner, wouldLog } from "../util";
import {
  addPred,
  Block,
  blockToString,
  bytecodeToString,
  Context,
  countFallthroughPreds,
  FuncEntry,
  functionBanner,
  makeArgless,
  offsetToString,
  redirect,
  removeBlock,
} from "./bytecode";
import { localDCE } from "./dce";
import { Bytecode, isBoolOp, isCondBranch, Mulv, Opcodes } from "./opcodes";
import { blockSharing } from "./sharing";

export function optimizeFunc(func: FuncEntry, context: Context) {
  let changes;
  do {
    cleanCfg(func, context);
    changes = localDCE(func, context);
    changes = blockSharing(func, context) || changes;
    changes = simpleOpts(func, context) || changes;
  } while (changes);
}

function simpleOpts(func: FuncEntry, _context: Context) {
  const logging = wouldLog("optimize", 5);
  return Array.from(func.blocks.values()).reduce((changes, block) => {
    for (let i = block.bytecodes.length; i--; ) {
      const cur = block.bytecodes[i];
      if (cur.op === Opcodes.nop) {
        block.bytecodes.splice(i, 1);
        changes = true;
        if (logging) {
          log(`${func.name}: deleting nop`);
          if (i > 0) {
            log(
              ` - previous bytecode was ${bytecodeToString(
                block.bytecodes[i - 1],
                null
              )}`
            );
          }
        }
      } else if (i && cur.op === Opcodes.shlv) {
        const prev = block.bytecodes[i - 1];
        if (prev.op === Opcodes.ipush || prev.op === Opcodes.lpush) {
          const shift = BigInt(prev.arg) & 63n;
          if (!shift && prev.op === Opcodes.ipush) {
            block.bytecodes.splice(i - 1, 2);
            changes = true;
            logging && log(`${func.name}: deleting no-op shift (${shift})`);
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
            logging &&
              log(
                `${func.name}: converting shlv(${shift}) to mulv(${prev.arg})`
              );

            changes = true;
            const mulv = cur as Bytecode as Mulv;
            mulv.op = Opcodes.mulv;
            mulv.size = 1;
            delete mulv.arg;
          }
        }
      } else if (
        cur.op === Opcodes.jsr &&
        func.blocks.get(block.taken!)?.bytecodes[0]?.op === Opcodes.ret
      ) {
        block.bytecodes.splice(i, 1);
        func.blocks.get(block.taken!)!.preds!.delete(block.offset);
        delete block.taken;
        changes = true;
        logging && log(`${func.name}: deleting empty finally handler`);
      } else if (isCondBranch(cur.op)) {
        const next = func.blocks.get(block.next!)!;
        const taken = func.blocks.get(block.taken!)!;
        if (next.preds!.size > 1 && taken.preds!.size === 1) {
          const newOp = cur.op === Opcodes.bt ? Opcodes.bf : Opcodes.bt;
          if (logging) {
            log(
              `${func.name}: converting ${Opcodes[cur.op]} to ${Opcodes[newOp]}`
            );
          }
          changes = true;
          cur.op = newOp;
          block.next = taken.offset;
          cur.arg = block.taken = next.offset;
        }
        /*
         * Garmin implements `x && y` as `x ? x & y : false`
         * As long as one of x and y is Boolean, this is equivalent to
         * `x ? y : false`. If the result is assigned to a variable,
         * there's not much we can do. But when its just branched on,
         * we can simplify.
         * The typical pattern is
         *        <x>
         *        dup 0
         *        bt/bf taken
         * next:  <y>
         *        andv/orv
         * taken: bt/bf final
         * tnext:
         *
         * and the optimization is to drop the dup and the andv/orv,
         * and redirect the first branch to either final or tnext.
         */
        if (
          i &&
          block.bytecodes[i - 1].op === Opcodes.dup &&
          !block.bytecodes[i - 1].arg
        ) {
          const isBool = i >= 2 && isBoolOp(block.bytecodes[i - 2].op);
          if (
            next.next === block.taken &&
            next.taken == null &&
            taken.bytecodes.length === 1 &&
            isCondBranch(taken.bytecodes[0].op) &&
            next.bytecodes.length > 1 &&
            next.bytecodes[next.bytecodes.length - 1].op ===
              (cur.op === Opcodes.bf ? Opcodes.andv : Opcodes.orv) &&
            (isBool ||
              (next.bytecodes.length > 2 &&
                isBoolOp(next.bytecodes[next.bytecodes.length - 2].op))) &&
            next.preds?.size === 1 &&
            taken.preds?.size === 2
          ) {
            if (logging) {
              log(
                `${func.name}: simplifying ${
                  next.bytecodes[next.bytecodes.length - 1].op === Opcodes.andv
                    ? "'&&'"
                    : "'||'"
                } at ${offsetToString(block.offset)}:${offsetToString(
                  next.offset
                )}:${offsetToString(taken.offset)}:`
              );
            }
            // drop the dup
            block.bytecodes.splice(i - 1, 1);
            // redirect the branch
            redirect(
              func,
              block,
              block.taken!,
              taken.bytecodes[0].op === cur.op ? taken.taken! : taken.next!
            );
            // drop the andv/orv
            next.bytecodes.pop();
            changes = true;
          } else if (
            taken.next === block.next &&
            taken.taken == null &&
            next.bytecodes.length === 1 &&
            isCondBranch(next.bytecodes[0].op) &&
            taken.bytecodes.length > 1 &&
            taken.bytecodes[taken.bytecodes.length - 1].op ===
              (cur.op === Opcodes.bt ? Opcodes.andv : Opcodes.orv) &&
            (isBool ||
              (taken.bytecodes.length > 2 &&
                isBoolOp(taken.bytecodes[taken.bytecodes.length - 2].op))) &&
            next.preds?.size === 2 &&
            taken.preds?.size === 1
          ) {
            if (logging) {
              log(
                `${func.name}: simplifying ${
                  taken.bytecodes[taken.bytecodes.length - 1].op ===
                  Opcodes.andv
                    ? "'&&'"
                    : "'||'"
                } at ${offsetToString(block.offset)}:${offsetToString(
                  taken.offset
                )}:${offsetToString(next.offset)}:`
              );
            }
            // drop the dup
            block.bytecodes.splice(i - 1, 1);
            // redirect the branch
            redirect(
              func,
              block,
              block.next!,
              next.bytecodes[0].op === cur.op ? next.next! : next.taken!
            );
            // drop the andv/orv
            taken.bytecodes.pop();
            changes = true;
          }
        }
      }
    }
    return changes;
  }, false);
}

function isNopBlock(block: Block) {
  return (
    block.bytecodes.length === 0 ||
    (block.bytecodes.length === 1 &&
      (block.bytecodes[0].op === Opcodes.goto ||
        block.bytecodes[0].op === Opcodes.nop))
  );
}
export function cleanCfg(func: FuncEntry, context: Context) {
  if (wouldLog("cfg", 10)) {
    setBanner(functionBanner(func, context, "sharing"));
  }
  const deadBlocks = new Map<number, number>();
  func.blocks.forEach((block) => {
    if (isNopBlock(block)) {
      deadBlocks.set(block.offset, block.next!);
    }
  });
  if (deadBlocks.size) {
    deadBlocks.forEach((target, key) => {
      let next = deadBlocks.get(target);
      if (next != null) {
        do {
          deadBlocks.set(key, next);
          next = deadBlocks.get(next);
        } while (next);
      }
    });
    func.blocks.forEach((block) => {
      if (block.next) {
        const fixed = deadBlocks.get(block.next);
        if (fixed) {
          redirect(func, block, block.next, fixed);
        }
      }
      if (block.taken) {
        const fixed = deadBlocks.get(block.taken);
        if (fixed) {
          redirect(func, block, block.taken, fixed);
        }
      }
      if (block.exsucc) {
        const fixed = deadBlocks.get(block.exsucc);
        if (fixed) {
          redirect(func, block, block.exsucc, fixed);
        }
      }
    });
    deadBlocks.forEach((target, offset) => {
      removeBlock(func, offset);
    });
  }
  func.blocks.forEach((block) => {
    if (block.next && !block.taken && block.next !== block.offset) {
      const next = func.blocks.get(block.next)!;
      if (block.try === next.try) {
        if (next.preds!.size === 1) {
          logger(
            "cfg",
            1,
            `${func.name}: ${offsetToString(
              block.offset
            )}: Merging linear blocks: ${blockToString(next, context)}`
          );

          block.bytecodes.push(...next.bytecodes);
          redirect(func, block, next.offset, next.next);
          if (next.taken) {
            block.taken = next.taken;
            addPred(func, next.taken, block.offset);
          }
          if (next.exsucc) {
            assert(!block.exsucc || block.exsucc === next.exsucc);
            if (!block.exsucc) {
              block.exsucc = next.exsucc;
              addPred(func, next.exsucc, block.offset);
            }
          }
          delete next.preds;
          removeBlock(func, next.offset);
        } else if (
          next.next == null &&
          next.bytecodes.length < 3 &&
          next.bytecodes.reduce((size, bc) => size + bc.size, 0) < 3 &&
          countFallthroughPreds(func, next) > 1
        ) {
          logger(
            "cfg",
            1,
            `${func.name}: ${offsetToString(
              block.offset
            )}: Merging short fallthrough block: ${blockToString(
              next,
              context
            )}`
          );
          let offset = context.nextOffset;
          next.bytecodes.forEach((bc) => {
            block.bytecodes.push({ ...bc, offset });
            offset += bc.size;
          });
          context.nextOffset = offset;
          redirect(func, block, next.offset, null);
        }
      }
    }
    if (block.taken && block.taken === block.next) {
      const last = block.bytecodes[block.bytecodes.length - 1];
      switch (last.op) {
        case Opcodes.bf:
        case Opcodes.bt:
          logger(
            "cfg",
            1,
            `${func.name}: killing no-op ${bytecodeToString(
              last,
              context.symbolTable
            )}`
          );
          makeArgless(last, Opcodes.popv);
          delete block.taken;
          break;
        default:
          assert(false);
      }
    }
    if (block.try && !block.exsucc) {
      for (let i = block.try.length; i--; ) {
        const handler = block.try[i].handler;
        if (!func.blocks.get(handler)!.preds?.size) {
          logger(
            "cfg",
            1,
            `${func.name}: killing unused try-catch at ${offsetToString(
              block.offset
            )} with handler at ${handler}`
          );

          block.try.splice(i, 1);
        }
      }
      if (!block.try.length) {
        delete block.try;
      }
    }
  });
  setBanner(null);
}
