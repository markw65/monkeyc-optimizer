import assert from "node:assert";
import { log, wouldLog } from "../util";
import {
  Block,
  blockToString,
  Context,
  equalBlocks,
  FuncEntry,
  offsetToString,
  redirect,
} from "./bytecode";

export function blockSharing(func: FuncEntry, context: Context) {
  const candidates: Map<bigint, Set<Block>> = new Map();
  let any = false;
  func.blocks.forEach((block) => {
    const hash =
      BigInt(block.next ?? 0) +
      (BigInt(block.taken ?? 0) << 24n) +
      (BigInt(block.bytecodes.length) << 48n);
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
  candidates.forEach((blocks) => {
    while (blocks.size > 1) {
      const group: Block[] = [];
      blocks.forEach((block) => {
        if (group.length && !equalBlocks(group[0], block)) {
          return;
        }
        group.push(block);
        blocks.delete(block);
      });
      if (
        group.length > 1 &&
        group[0].bytecodes.reduce((size, bc) => bc.size + size, 0) >= 2
      ) {
        any = true;
        group.forEach((block, i) => {
          if (!i) return;
          const target = group[0];
          if (logging) {
            log(
              `Sharing block(${offsetToString(
                block.offset
              )}) with block(${offsetToString(target.offset)})`
            );
            if (wouldLog("sharing", 5)) {
              log(blockToString(target, context));
            }
          }
          block.preds?.forEach((p) => {
            redirect(func, func.blocks.get(p)!, block.offset, target.offset);
          });
          assert(block.preds?.size === 0);
          func.blocks.delete(block.offset);
        });
      }
    }
  });
  return any;
}
