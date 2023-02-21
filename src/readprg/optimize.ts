import * as assert from "node:assert";
import { log, logger, wouldLog } from "../util";
import {
  bytecodeToString,
  Context,
  FuncEntry,
  makeArgless,
  offsetToString,
} from "./bytecode";
import { localDCE } from "./dce";
import { Bytecode, isBoolOp, isCondBranch, Mulv, Opcodes } from "./opcodes";

export function optimizeFunc(func: FuncEntry, context: Context) {
  do {
    cleanCfg(func, context);
    localDCE(func, context);
  } while (simpleOpts(func, context));
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
        func.blocks.get(cur.arg)?.bytecodes[0]?.op === Opcodes.ret
      ) {
        block.bytecodes.splice(i, 1);
        delete block.taken;
        changes = true;
        logging && log(`${func.name}: deleting empty finally handler`);
      } else if (i && (cur.op === Opcodes.bt || cur.op === Opcodes.bf)) {
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
          block.bytecodes[i - 1].op === Opcodes.dup &&
          !block.bytecodes[i - 1].arg
        ) {
          const isBool = i >= 2 && isBoolOp(block.bytecodes[i - 2].op);
          const next = func.blocks.get(block.next!)!;
          const taken = func.blocks.get(block.taken!)!;
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
                isBoolOp(next.bytecodes[next.bytecodes.length - 2].op)))
          ) {
            // drop the dup
            block.bytecodes.splice(i - 1, 1);
            // redirect the branch
            block.taken =
              taken.bytecodes[0].op === cur.op ? taken.taken : taken.next;
            // drop the andv/orv
            next.bytecodes.pop();
            changes = true;
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
                isBoolOp(taken.bytecodes[taken.bytecodes.length - 2].op)))
          ) {
            // drop the dup
            block.bytecodes.splice(i - 1, 1);
            // redirect the branch
            block.taken =
              next.bytecodes[0].op === cur.op ? next.next : next.taken;
            // drop the andv/orv
            next.bytecodes.pop();
            changes = true;
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
          }
        }
      }
    }
    return changes;
  }, false);
}

export function cleanCfg(func: FuncEntry, context: Context) {
  const deadBlocks = new Map<number, number>();
  func.blocks.forEach((block) => {
    if (
      block.bytecodes.length === 1 &&
      block.bytecodes[0].op === Opcodes.goto
    ) {
      deadBlocks.set(block.offset, block.bytecodes[0].arg);
    }
  });
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
        block.next = fixed;
      }
    }
    if (block.taken) {
      const fixed = deadBlocks.get(block.taken);
      if (fixed) {
        block.taken = fixed;
        const last = block.bytecodes[block.bytecodes.length - 1];
        switch (last.op) {
          case Opcodes.bf:
          case Opcodes.bt:
            if (block.taken === block.next) {
              logger(
                "cfg",
                1,
                `${func.name}: killing no-op ${bytecodeToString(
                  last,
                  context.symbolTable
                )}`
              );
              makeArgless(last, Opcodes.popv);
              break;
            }
            last.arg = fixed;
            break;
          case Opcodes.goto:
          case Opcodes.jsr:
            last.arg = fixed;
            break;
          default:
            assert(false);
        }
      }
    }
  });
}
