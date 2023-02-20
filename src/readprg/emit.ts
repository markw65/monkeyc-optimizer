import * as assert from "node:assert";
import { hasProperty } from "../ast";
import { Block, Context, FuncEntry } from "./bytecode";
import { ExceptionEntry } from "./exceptions";
import { Bytecode, emitBytecode, Opcodes } from "./opcodes";
import { cleanCfg } from "./optimize";

export type LocalsMap = Map<number, { startPc: number; endPc: number }>;
export type UpdateInfo = {
  offsetMap: Map<number, number>;
  localsMap: Map<FuncEntry, LocalsMap>;
};

export function emitFunc(
  func: FuncEntry,
  view: DataView,
  start: number,
  updateInfo: UpdateInfo,
  context: Context
) {
  cleanCfg(func, context);
  groupBlocks(func);

  const { offsetMap } = updateInfo;
  const localsMap: LocalsMap = new Map();
  let numArgs = 0;
  updateInfo.localsMap.set(func, localsMap);
  const linktable = new Map<number, number>();
  let offset = start;
  Array.from(func.blocks.values()).forEach((block, i, blocks) => {
    offsetMap.set(block.offset, offset);
    block.bytecodes.forEach((bytecode) => {
      if (bytecode.op === Opcodes.goto) {
        return;
      }
      offsetMap.set(bytecode.offset, offset);
      if (bytecode.op === Opcodes.argc) {
        numArgs = bytecode.arg;
      } else if (
        bytecode.op === Opcodes.lputv ||
        bytecode.op === Opcodes.lgetv
      ) {
        const li = localsMap.get(bytecode.arg);
        if (!li) {
          localsMap.set(bytecode.arg, { startPc: offset, endPc: offset });
        } else {
          li.endPc = offset + bytecode.size;
        }
      }
      offset = emitBytecode(bytecode, view, offset, linktable);
    });
    if (block.try) {
      const end = block.try[block.try.length - 1].tryEnd;
      offsetMap.set(end, offset);
    }
    if (block.next != null && block.next !== blocks[i + 1]?.offset) {
      const bc: Bytecode = {
        op: Opcodes.goto,
        arg: block.next,
        offset: block.offset,
        size: 3,
      };
      offset = emitBytecode(bc, view, offset, linktable);
    }
  });

  localsMap.forEach((item, slot) => {
    if (slot < numArgs) {
      item.startPc = start;
    }
    item.endPc = offset;
  });

  // fixup all the relative branches within the function
  linktable.forEach((target, from) => {
    const newOffset = offsetMap.get(target);
    if (newOffset == null) {
      assert(newOffset != null);
    }
    view.setInt16(from, newOffset - from - 2);
  });

  return offset;
}

type CFGNode = { items: Set<CFGNode | Block>; succs: Set<number> };

function groupBlocks(func: FuncEntry) {
  const cfgMap = new Map<ExceptionEntry | null, CFGNode>([
    [null, { items: new Set(), succs: new Set() }],
  ]);
  const outer = cfgMap.get(null)!;
  func.blocks.forEach((block) => {
    if (block.try) {
      let inner: CFGNode | null = null;
      for (let i = block.try.length; i--; ) {
        const tryInfo = block.try[i];
        let cfgNode: CFGNode | undefined = cfgMap.get(tryInfo);
        if (!cfgNode) {
          cfgNode = { items: new Set(), succs: new Set([tryInfo.handler]) };
          cfgMap.set(tryInfo, cfgNode);
        }
        if (inner) {
          cfgNode.items.add(inner);
        } else {
          cfgNode.items.add(block);
        }
        inner = cfgNode;
      }
      outer.items.add(inner!);
    } else {
      outer.items.add(block);
    }
  });

  const isCfgNode = (node: CFGNode | Block): node is CFGNode => {
    return hasProperty(node, "items");
  };
  const sortHelper = (node: CFGNode): number[] => {
    const itemsToSort = new Set<CFGNode>();
    const itemsFromOffset = new Map<number, CFGNode>();
    node.items.forEach((item) => {
      if (isCfgNode(item)) {
        sortHelper(item).forEach((offset) => itemsFromOffset.set(offset, item));
        itemsToSort.add(item);
        item.items.forEach((block) => {
          assert(!isCfgNode(block));
          if (block.next && itemsFromOffset.get(block.next) !== item) {
            item.succs.add(block.next);
          }
          if (block.taken && itemsFromOffset.get(block.taken) !== item) {
            item.succs.add(block.taken);
          }
        });
      } else {
        const succs = new Set<number>();
        if (item.taken != null) {
          succs.add(item.taken);
        }
        if (item.next != null) {
          succs.add(item.next);
        }
        const cfg = { items: new Set([item]), succs };
        itemsToSort.add(cfg);
        itemsFromOffset.set(item.offset, cfg);
      }
    });

    const ordered: number[] = [];
    const visited = new Set<CFGNode>();
    const helper = (cur: CFGNode) => {
      if (visited.has(cur)) return;
      visited.add(cur);
      if (cur.succs) {
        cur.succs.forEach((offset) => {
          const item = itemsFromOffset.get(offset);
          if (item) {
            helper(item);
          }
        });
      }
      cur.items.forEach((item) => {
        assert(!isCfgNode(item));
        if (isCfgNode(item)) {
          item.items.forEach((block) => {
            assert(!isCfgNode(block));
            ordered.push(block.offset);
          });
          assert(false);
        } else {
          ordered.push(item.offset);
        }
      });
    };
    helper(itemsToSort.values().next().value);
    node.items = new Set(ordered.map((offset) => func.blocks.get(offset)!));

    return ordered;
  };
  func.blocks = new Map(
    sortHelper(outer)
      .reverse()
      .map((offset) => [offset, func.blocks.get(offset)!] as const)
  );
}
