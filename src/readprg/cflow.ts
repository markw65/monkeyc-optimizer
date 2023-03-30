import assert from "node:assert";
import { GenericQueue } from "../util";
import { Block, FuncEntry } from "./bytecode";
import { Bytecode, Opcodes } from "./opcodes";

export function postOrderTraverse(
  func: FuncEntry,
  visitor: (block: Block) => void
) {
  const visited = new Set<number>();
  const helper = (offset: number) => {
    if (visited.has(offset)) return;
    visited.add(offset);
    const cur = func.blocks.get(offset)!;
    if (cur.exsucc != null) helper(cur.exsucc);
    if (cur.taken != null) helper(cur.taken);
    if (cur.next != null) helper(cur.next);
    visitor(cur);
  };
  helper(func.offset);
}

export function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  if (a.size > b.size) return intersect(b, a);
  const result: Set<T> = new Set();
  a.forEach((x) => b.has(x) && result.add(x));
  return result;
}

export type DomLike = Map<number, Set<number>>;

export function computePostDominators(func: FuncEntry): DomLike {
  const order: Map<Block, number> = new Map();
  const queue = new GenericQueue<Block>(
    (b, a) => order.get(a)! - order.get(b)!
  );
  postOrderTraverse(func, (block) => {
    order.set(block, order.size);
    queue.enqueue(block);
  });
  const states: DomLike = new Map();
  while (!queue.empty()) {
    const block = queue.dequeue();
    const postDoms = new Set(states.get(block.offset));
    postDoms.add(block.offset);
    block.preds?.forEach((pred) => {
      const predState = states.get(pred);
      let changes;
      if (!predState) {
        states.set(pred, new Set(postDoms));
        changes = true;
      } else {
        const newState = intersect(postDoms, predState);
        states.set(pred, newState);
        changes = newState.size !== predState.size;
      }
      if (changes) {
        queue.enqueue(func.blocks.get(pred)!);
      }
    });
  }
  // every block post-dominates itself
  states.forEach((pd, offset) => pd.add(offset));
  return states;
}

export function computeDominators(func: FuncEntry): DomLike {
  const states: DomLike = new Map();
  rpoPropagate(
    func,
    (block) => {
      let state = states.get(block.offset);
      if (!state) {
        state = new Set();
        states.set(block.offset, state);
      }
      return new Set(state).add(block.offset);
    },
    null,
    () => {
      /* */
    },
    (from, state, succBlock) => {
      const succState = states.get(succBlock.offset);
      if (!succState) {
        states.set(succBlock.offset, new Set(state));
        return true;
      }
      const newState = intersect(state, succState);
      if (newState.size !== succState.size) {
        states.set(succBlock.offset, newState);
        return true;
      }
      return false;
    }
  );
  // we computed the in-states, but want the out-states
  states.forEach((state, offset) => state.add(offset));
  return states;
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

export function postOrderPropagate<T>(
  func: FuncEntry,
  preBlock: (block: Block) => T,
  processBc: (block: Block, bc: Bytecode, state: T) => void,
  postBlock: (block: Block, state: T) => void,
  merge: (state: T, predBlock: Block, isExPred: boolean) => boolean
) {
  const order: Map<Block, number> = new Map();
  const queue = new GenericQueue<Block>(
    (b, a) => order.get(a)! - order.get(b)!
  );
  postOrderTraverse(func, (block) => {
    order.set(block, order.size);
    queue.enqueue(block);
  });
  const jsrMap = computeJsrMap(func);
  while (!queue.empty()) {
    const top = queue.dequeue();
    const localState = preBlock(top);
    for (let i = top.bytecodes.length; i--; ) {
      const bc = top.bytecodes[i];
      processBc(top, bc, localState);
    }
    postBlock(top, localState);
    top.preds?.forEach((pred) => {
      const predBlock = func.blocks.get(pred)!;
      const isExPred =
        predBlock.next !== top.offset && predBlock.taken !== top.offset;
      assert(!isExPred || predBlock.exsucc === top.offset);
      merge(localState, predBlock, isExPred) && queue.enqueue(predBlock);
      const jsrPreds = jsrMap.get(pred);
      if (jsrPreds) {
        if (predBlock.next === top.offset) {
          jsrPreds.forEach((jsrPred) => {
            const jsrPredBlock = func.blocks.get(jsrPred)!;
            merge(localState, jsrPredBlock, false) &&
              queue.enqueue(jsrPredBlock);
          });
        }
      }
    });
  }
}

function computeRetMap(func: FuncEntry) {
  const jsrMap = computeJsrMap(func);
  const retMap: Map<number, Set<number>> = new Map();
  jsrMap.forEach((retBlocks, jsrBlock) => {
    const jsrNext = func.blocks.get(jsrBlock)!.next;
    assert(jsrNext);
    retBlocks.forEach((retBlock) => {
      const retSuccs = retMap.get(retBlock);
      if (retSuccs) {
        retSuccs.add(jsrNext);
      } else {
        retMap.set(retBlock, new Set([jsrNext]));
      }
    });
  });
  return retMap;
}

export enum RpoFlags {
  EnqueueTaken = 1,
  EnqueueNext = 2,
  SkipTaken = 4,
  SkipNext = 8,
  RestartBlock = 16,
}

export function rpoPropagate<T>(
  func: FuncEntry,
  preBlock: (block: Block) => T,
  processBc:
    | ((
        block: Block,
        bc: Bytecode,
        state: T
      ) => RpoFlags | null | undefined | void)
    | null,
  postBlock: (block: Block, state: T) => void,
  merge: (from: Block, state: T, succBlock: Block, isExSucc: boolean) => boolean
) {
  const order: Map<Block, number> = new Map();
  {
    const blocks: Block[] = [];
    postOrderTraverse(func, (block) => {
      blocks.push(block);
    });
    blocks.reverse().forEach((block, i) => order.set(block, i));
  }
  const queue = new GenericQueue<Block>(
    (b, a) => order.get(a)! - order.get(b)!
  );
  queue.enqueue(func.blocks.get(func.offset)!);
  const retMap = computeRetMap(func);
  while (!queue.empty()) {
    const top = queue.dequeue();
    const localState = preBlock(top);
    const doMerge = (to: number, isExSucc: boolean) => {
      const toBlock = func.blocks.get(to)!;
      merge(top, localState, toBlock, isExSucc) && queue.enqueue(toBlock);
    };
    let flags: RpoFlags | null | undefined | void;
    if (processBc) {
      for (let i = 0; i < top.bytecodes.length; i++) {
        const bc = top.bytecodes[i];
        flags = processBc(top, bc, localState);
        if (flags != null && flags & RpoFlags.RestartBlock) {
          i = -1;
          continue;
        }
        if (
          top.exsucc &&
          (bc.op === Opcodes.invokem || bc.op === Opcodes.throw)
        ) {
          doMerge(top.exsucc, true);
        }
      }
    }
    postBlock(top, localState);
    if (flags == null) flags = 0;
    if (top.next != null) {
      if (!(flags & RpoFlags.SkipNext)) {
        doMerge(top.next, false);
      }
      if (flags & RpoFlags.EnqueueNext) {
        queue.enqueue(func.blocks.get(top.next)!);
      }
    }
    if (top.taken) {
      if (!(flags & RpoFlags.SkipTaken)) {
        doMerge(top.taken, false);
      }
      if (flags & RpoFlags.EnqueueTaken) {
        queue.enqueue(func.blocks.get(top.taken)!);
      }
    }
    if (!processBc && top.exsucc) {
      doMerge(top.exsucc, true);
    }
    retMap.get(top.offset)?.forEach((retSucc) => doMerge(retSucc, false));
  }
}
