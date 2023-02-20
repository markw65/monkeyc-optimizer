import * as assert from "node:assert";
import { log, logger, wouldLog } from "../util";
import {
  FuncEntry,
  Context,
  bytecodeToString,
  printFunction,
} from "./bytecode";
import { Opcodes, getOpInfo, Bytecode } from "./opcodes";

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

  let before = wouldLog("dce", 5)
    ? () => {
        log("======== dce: Before =========");
        printFunction(func, context);
        before = null;
      }
    : null;

  let changes = false;
  const makeArgless = (bc: Bytecode, op: Opcodes) => {
    bc.op = op;
    delete bc.arg;
    bc.size = 1;
    changes = true;
  };
  const makeNop = (bc: Bytecode) => makeArgless(bc, Opcodes.nop);
  const makePopv = (bc: Bytecode) => makeArgless(bc, Opcodes.popv);
  type DceLiveItem = { dead: false };
  type DceDeadItem = { dead: true; deps: number[] };
  type DceStackItem = DceLiveItem | DceDeadItem;
  type DceInfo = {
    stack: DceStackItem[];
  };
  func.blocks.forEach((block) => {
    const reportPopv = (i: number, item: DceDeadItem, kill: boolean) => {
      before && before();
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
      before && before();
      logger(
        "dce",
        2,
        `${func.name}: Kill ${item.deps
          .map((i) => bytecodeToString(block.bytecodes[i], context.symbolTable))
          .join(", ")}`
      );
    };
    changes = false;
    const dceInfo: DceInfo = { stack: [] };

    for (let i = block.bytecodes.length; i--; ) {
      const bytecode = block.bytecodes[i];
      switch (bytecode.op) {
        case Opcodes.lputv: {
          const local = locals[bytecode.arg];
          if (!local.read) {
            before && before();
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
        case Opcodes.npush:
        case Opcodes.bpush:
        case Opcodes.lgetv:
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
      block.bytecodes = block.bytecodes.filter((bc) => bc.op !== Opcodes.nop);
      if (wouldLog("dce", 3)) {
        log("======== dce: After =========");
        printFunction(func, context);
      }
    }
  });
}
