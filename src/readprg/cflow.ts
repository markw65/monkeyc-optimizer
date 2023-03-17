import { GenericQueue } from "../util";
import { Block, FuncEntry } from "./bytecode";

export function postOrderTraverse(
  func: FuncEntry,
  visitor: (block: Block) => void
) {
  const visited = new Set<number>();
  const helper = (offset: number) => {
    if (visited.has(offset)) return;
    visited.add(offset);
    const cur = func.blocks.get(offset)!;
    if (cur.next != null) helper(cur.next);
    if (cur.taken != null) helper(cur.taken);
    if (cur.exsucc != null) helper(cur.exsucc);
    visitor(cur);
  };
  helper(func.offset);
}

export function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  if (a.size > b.size) return intersect(b, a);
  const result = new Set(a);
  result.forEach((x) => b.has(x) || a.delete(x));
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
        const newState = intersect(postDoms!, predState);
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
