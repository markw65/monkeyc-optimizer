import * as assert from "node:assert";
import { log, logger, wouldLog } from "../util";
import { bytecodeToString, Context, FuncEntry, makeArgless } from "./bytecode";
import { localDCE } from "./dce";
import { Bytecode, Mulv, Opcodes } from "./opcodes";

export function optimizeFunc(func: FuncEntry, context: Context) {
  cleanCfg(func, context);
  localDCE(func, context);
  simpleOpts(func, context);
}

function simpleOpts(func: FuncEntry, _context: Context) {
  const logging = wouldLog("optimize", 5);
  func.blocks.forEach((block) => {
    for (let i = block.bytecodes.length; i--; ) {
      const cur = block.bytecodes[i];
      if (cur.op === Opcodes.nop) {
        block.bytecodes.splice(i, 1);
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
        logging && log(`${func.name}: deleting empty finally handler`);
      }
    }
  });
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
