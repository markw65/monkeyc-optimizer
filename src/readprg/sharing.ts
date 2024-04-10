import assert from "node:assert";
import { log, setBanner, wouldLog } from "../util";
import {
  Block,
  Context,
  FuncEntry,
  blockToString,
  countFallthroughPreds,
  functionBanner,
  offsetToString,
  redirect,
  removeBlock,
  splitBlock,
} from "./bytecode";
import { Bytecode, Opcodes, isCondBranch, opcodeSize } from "./opcodes";

export function blockSharing(func: FuncEntry, context: Context) {
  const candidates: Map<number, Set<Block>> = new Map();
  let any = false;
  func.blocks.forEach((block) => {
    if (!block.bytecodes.length) return;
    let op = block.bytecodes[block.bytecodes.length - 1].op;
    let next = block.next;
    let taken = block.taken;
    /*
     * Normalize, so that "bf next,taken" hashes to the same thing
     * as "bt taken, next".
     */
    if (op === Opcodes.bf) {
      op = Opcodes.bt;
      const tmp = next;
      next = taken;
      taken = tmp;
    }
    const hash = (next ?? 0) + ((taken ?? 0) << 20) + (op << 40);
    const cand = candidates.get(hash);
    if (cand) {
      any = true;
      cand.add(block);
    } else {
      candidates.set(hash, new Set([block]));
    }
  });
  if (!any) return false;
  any = false;
  const logging = wouldLog("sharing", 1);
  if (logging && wouldLog("sharing", 10)) {
    setBanner(functionBanner(func, context, "sharing"));
  }
  candidates.forEach((blocks) => {
    while (blocks.size > 1) {
      const group: Block[] = [];
      // first find a subset of the blocks that end the same
      // (modulo bt <=> bf)
      let size = 0;
      blocks.forEach((block) => {
        const blockEnd = block.bytecodes[block.bytecodes.length - 1];
        if (!group.length) {
          size = opcodeSize(blockEnd.op);
        } else {
          const key = group[0];
          const keyEnd = key.bytecodes[key.bytecodes.length - 1];
          if (keyEnd.op !== blockEnd.op) {
            if (!isCondBranch(keyEnd.op) || !isCondBranch(blockEnd.op)) {
              return;
            }
            if (block.taken !== key.next || block.next !== key.taken) {
              return;
            }
          } else {
            if (
              keyEnd.arg !== blockEnd.arg ||
              block.taken !== key.taken ||
              block.next !== key.next
            ) {
              return;
            }
          }
          if (
            !block.try !== !key.try ||
            (block.try &&
              key.try &&
              block.try[block.try.length - 1] !== key.try[key.try.length - 1])
          ) {
            return;
          }
        }
        group.push(block);
        blocks.delete(block);
      });
      if (group.length <= 1) continue;
      group.sort((a, b) => b.bytecodes.length - a.bytecodes.length);
      // For each block in the group, we want to find out how many
      // bytecodes at the end of the block match with at least one
      // other block, and record that info.
      const matchingResults: Map<
        Block,
        { blocks: Block[]; group: Set<Block>; size: number }
      >[] = [];
      let length = 2;
      let state: Array<{ group: Block[]; size: number }> = [{ group, size }];
      do {
        const nextState: typeof state = [];
        state.forEach(({ group, size }) => {
          const bcToBlock: Array<{ bc: Bytecode | null; blocks: number[] }> =
            [];
          group.forEach((cur, i) => {
            if (cur.bytecodes.length < length) {
              bcToBlock.push({ bc: null, blocks: [i] });
              return;
            }
            const bc = cur.bytecodes[cur.bytecodes.length - length];
            let j = 0;
            while (true) {
              const entry = bcToBlock[j];
              if (!entry) {
                bcToBlock[j] = { bc, blocks: [i] };
                break;
              } else if (
                entry.bc &&
                bc.op === entry.bc.op &&
                bc.arg === entry.bc.arg
              ) {
                entry.blocks.push(i);
                break;
              }
              j++;
            }
          });
          bcToBlock.forEach(({ bc, blocks }) => {
            if (blocks.length === 1) {
              const map =
                matchingResults[length - 1] ??
                (matchingResults[length - 1] = new Map());

              let entry = map.get(group[0]);
              const block = group[blocks[0]];
              if (!entry) {
                entry = {
                  blocks: [block],
                  group: new Set(group),
                  size,
                };
                map.set(group[0], entry);
              } else {
                entry.blocks.push(block);
              }
              entry.group.delete(block);
            } else {
              const sz = size + (bc ? opcodeSize(bc.op) : 0);
              nextState.push({ group: blocks.map((b) => group[b]), size: sz });
            }
          });
        });
        state = nextState;
        length++;
      } while (state.length);
      // In order to combine the tails of two blocks, we have to add a
      // goto to all but one of them, which is 3 bytes. But if multiple
      // blocks fall through to the same place, all but one already
      // requires a goto. But if there's no fallthrough (return, ret or
      // throw) then adding the goto introduces a cost.
      const splittingOverhead = group[0].next ? 0 : 3;

      // If we break a block, we're going to end up adding a goto
      // at the end. Even if we replace the whole block, we probably
      // add a goto. But if we replace the whole block, and all of
      // its predecessors are conditional branches, whose other successor
      // has a single predecessor, then we can always arrange for the
      // conditional branch to goto the new target with no cost.
      const zeroOverhead = (block: Block, length: number) => {
        if (block.bytecodes.length !== length) return false;
        return countFallthroughPreds(func, block) === 0;
      };
      // collect the transformations first, so we can consistently
      // choose the target blocks.
      // If we do the transformation as we go, the choice of target
      // block could change to one thats already been
      // merged. eg
      // b1: ipush 42
      //     ipush 1
      //     ipush 2
      //     ipush 3
      //
      // b2: ipush 0
      //     ipush 1
      //     ipush 1
      //     ipush 2
      //     ipush 3
      //
      // b3: ipush 2
      //     ipush 3
      //
      // we initially choose b2 as the target for (b1, b2), but after doing
      // that we might choose b1 as the target for (b3, b1, b2); but at this
      // point b1 has been split, and is just ipush 42.
      // by making all the decisions up front, we ensure that we pick b2
      // consistently.
      const toDo: { target: Block; blocks: Block[]; length: number }[] = [];
      const targets: Set<Block> = new Set();
      while (--length) {
        const m = matchingResults[length];
        if (!m) continue;
        m.forEach((entry) => {
          const possibleTargets = entry.group.size
            ? Array.from(entry.group)
            : entry.blocks;
          const target =
            possibleTargets.find((block) => targets.has(block)) ??
            possibleTargets.reduce((t, block) => {
              if (!t) return block;
              const zot = zeroOverhead(t, length);
              const zob = zeroOverhead(block, length);
              // note that we want the blocks we replace
              // to be zero overhead, not the target block
              if (zot && !zob) return block;
              if (!zot && zob) return t;
              return t.offset < block.offset ? block : t;
            }, null as Block | null)!;
          if (entry.size <= splittingOverhead) {
            // in this case, we're saving a 3 byte (or shorter) sequence
            // ending in return/ret/throw, but we're probably
            // introducing a goto to get there (also 3 bytes).
            // But if the sequences is the whole of this block,
            // and every predecessor of this block ends
            // in a conditional branch, with its other successor
            // having a single predecessor, then by making the
            // other successor the "next" block, and this block
            // the "taken" block, there's no overhead
            //
            // ie
            //
            // if (cond1) return null;
            // ...
            // if (cond2) { foo(); return null; }
            // ...
            // return null;
            //
            // Its worth redirecting the "if (cond1)" to branch directly
            // to the final "return null", even though "return null" is
            // only 2 bytes, because we're going to have a conditional
            // branch there anyway.
            // But its not worth changing the second if to
            //
            // if (cond2) { foo(); goto final_return; }
            //
            // because the goto is bigger than the code it replaced.
            entry.blocks = entry.blocks.filter((block) => {
              if (block === target) return false;
              return zeroOverhead(block, length);
            });
            if (!entry.blocks.length) {
              return;
            }
          }
          targets.add(target);
          toDo.push({ target, blocks: entry.blocks, length });
        });
      }
      toDo.forEach(({ target, blocks, length }) => {
        blocks.forEach((block) => {
          if (block === target) return;
          any = true;
          if (logging) {
            const showBlock = (block: Block) => {
              return block.bytecodes.length > length
                ? `last ${length} bytecodes of block(${offsetToString(
                    block.offset
                  )})`
                : `block(${offsetToString(block.offset)})`;
            };
            log(`Sharing ${showBlock(block)} with ${showBlock(target)}`);
            if (wouldLog("sharing", 5)) {
              log(blockToString(target, context));
            }
          }
          if (target.bytecodes.length > length) {
            splitBlock(func, target, -length);
          }
          assert(block.bytecodes.length >= length);
          if (block.bytecodes.length > length) {
            splitBlock(func, block, block.bytecodes.length - length);
            const next = block.next!;
            redirect(func, block, next, target.offset);
            removeBlock(func, next);
          } else {
            block.preds?.forEach((pred) =>
              redirect(
                func,
                func.blocks.get(pred)!,
                block.offset,
                target.offset
              )
            );
            removeBlock(func, block.offset);
          }
        });
      });
    }
  });
  setBanner(null);
  return any;
}
