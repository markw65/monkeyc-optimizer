import assert from "node:assert";
import { log, logger, wouldLog } from "../logger";
import {
  bytecodeToString,
  Context,
  FuncEntry,
  functionBanner,
} from "./bytecode";
import { computeDominators, intersect, postOrderTraverse } from "./cflow";
import { Bytecode, Incsp, Opcodes, opcodeSize } from "./opcodes";

export function sizeBasedPRE(func: FuncEntry, context: Context) {
  if (func.argc == null) {
    return;
  }
  const canonicalMap: Map<bigint, Set<Bytecode>> = new Map();
  let states: Map<number, Map<bigint, Set<Bytecode>>> = new Map();
  let incSp = null as Incsp | false | null;
  const getBigInt = (bc: Bytecode, index: number, bcs: Bytecode[]) => {
    switch (bc.op) {
      case Opcodes.dpush: {
        const buffer = new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
        const view = new DataView(buffer);
        view.setFloat64(0, bc.arg);
        return (view.getBigInt64(0) << 8n) | BigInt(bc.op);
      }
      case Opcodes.fpush: {
        const buffer = new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT);
        const view = new DataView(buffer);
        view.setFloat32(0, bc.arg);
        return (BigInt(view.getInt32(0)) << 8n) | BigInt(bc.op);
      }
      case Opcodes.spush:
        if (bcs[index + 1]?.op === Opcodes.getm) {
          break;
        }
      // fall through
      case Opcodes.ipush:
      case Opcodes.lpush:
      case Opcodes.cpush:
      case Opcodes.news:
        return (BigInt(bc.arg) << 8n) | BigInt(bc.op);
      case Opcodes.incsp:
        if (incSp != null) {
          incSp = false;
        }
        incSp = bc;
        return null;
      case Opcodes.getm:
        if (index && bcs[index - 1].op === Opcodes.spush) {
          return (BigInt(bcs[index - 1].arg as number) << 8n) | BigInt(bc.op);
        }
        break;
    }
    return null;
  };
  const order: Map<number, number> = new Map();
  postOrderTraverse(func, (block) => {
    order.set(block.offset, order.size);
  });

  order.forEach((order, offset) => {
    const block = func.blocks.get(offset);
    assert(block);
    const state: Map<bigint, Set<Bytecode>> = new Map();
    block.bytecodes.forEach((bc, i, bcs) => {
      const id = getBigInt(bc, i, bcs);
      if (id == null) return;
      let canon = canonicalMap.get(id);
      if (!canon) {
        canon = new Set();
        canonicalMap.set(id, canon);
      }
      canon.add(bc);
      state.set(id, canon);
    });
    states.set(block.offset, state);
  });
  if (incSp === false) {
    return;
  }
  states = new Map(
    Array.from(states)
      .map(
        ([offset, state]) =>
          [
            offset,
            new Map(Array.from(state).filter(([, bcs]) => bcs.size >= 3)),
          ] as const
      )
      .filter(([, state]) => state.size)
  );
  if (!states.size) return;
  const dominatorMap = computeDominators(func);
  const insertionBlocks: Map<bigint, Set<number>> = new Map();
  states.forEach((state, offset) => {
    const dominators = dominatorMap.get(offset);
    assert(dominators);
    state.forEach((bcs, key) => {
      const insertions = insertionBlocks.get(key);
      if (!insertions) {
        insertionBlocks.set(key, dominators);
      } else {
        insertionBlocks.set(key, intersect(insertions, dominators));
      }
    });
  });
  let nextSlot = func.argc + (incSp?.arg ?? 0);
  const bytecode = <T extends Opcodes>(
    op: T,
    arg: Extract<Bytecode, { op: T }>["arg"]
  ): Bytecode => {
    const bc = { op, arg, size: opcodeSize(op), offset: context.nextOffset++ };
    if (arg == null) delete bc.arg;
    return bc as Bytecode;
  };
  if (wouldLog("pre", 1)) {
    if (wouldLog("pre", 5)) {
      log(functionBanner(func, context, "PRE")());
    } else {
      log(`================ PRE : ${func.name} ================\n`);
    }
    insertionBlocks.forEach((o, key) => {
      const bcs = canonicalMap.get(key)!;
      log(
        `Replacing ${bcs.size} instances of ${bytecodeToString(
          bcs.values().next().value,
          context.symbolTable
        )}`
      );
    });
  }
  insertionBlocks.forEach((blockOffsets, key) => {
    // blockOffsets is a list of blocks which dominate all the uses of key. We
    // want to choose the "latest" block, which will be the earliest one in
    // post-order
    const blockOffset = Array.from(blockOffsets).sort(
      (a, b) => order.get(a)! - order.get(b)!
    )[0];
    assert(blockOffset != null);
    const block = func.blocks.get(blockOffset);
    assert(block);
    const bcs = canonicalMap.get(key);
    assert(bcs);
    // if the one of the target bytecodes is in the target block,
    // then we want to insert just before it
    let index = block.bytecodes.findIndex(
      (bc) =>
        bcs.has(bc) ||
        (block.exsucc && (bc.op === Opcodes.invokem || bc.op === Opcodes.throw))
    );
    if (index < 0) {
      // if its not there, we want to insert at the end; except we can't insert
      // after a conditional branch, or a throw (or a return, but that should
      // never happen)
      if (block.next && !block.taken) {
        index = block.bytecodes.length;
      }
    }
    const bc: Bytecode = bcs.values().next().value;
    const slot = nextSlot++;
    if (bc.op === Opcodes.getm) {
      assert(index !== 0);
      let spush = null as Bytecode | null;
      func.blocks.forEach(
        (b) =>
          states.get(b.offset)?.get(key) &&
          b.bytecodes.forEach((bc, i) => {
            if (bcs.has(bc)) {
              assert(i > 0);
              const prev = b.bytecodes[i - 1];
              if (!spush) {
                spush = { ...prev };
              }
              bc.op = Opcodes.nop;
              prev.op = Opcodes.lgetv;
              prev.arg = slot;
              prev.size = 2;
            }
          })
      );
      assert(spush);
      if (index >= 0 && index < block.bytecodes.length) {
        index--;
      }
      block.bytecodes.splice(
        index,
        0,
        bytecode(spush.op, spush.arg),
        bytecode(Opcodes.getm, undefined),
        bytecode(Opcodes.lputv, slot)
      );
    } else {
      block.bytecodes.splice(
        index,
        0,
        bytecode(bc.op, bc.arg),
        bytecode(Opcodes.lputv, slot)
      );
      bcs.forEach((bc) => {
        bc.op = Opcodes.lgetv;
        bc.arg = slot;
        bc.size = 2;
      });
    }
  });
  if (incSp) {
    incSp.arg += insertionBlocks.size;
  } else {
    const startBlock = func.blocks.get(func.offset)!;
    const index =
      startBlock.bytecodes.length === 0 ||
      startBlock.bytecodes[0].op !== Opcodes.argc
        ? 0
        : 1;
    startBlock.bytecodes.splice(
      index,
      0,
      bytecode(Opcodes.incsp, insertionBlocks.size)
    );
  }
  logger("pre", 5, functionBanner(func, context, "post-PRE"));
  return true;
}
