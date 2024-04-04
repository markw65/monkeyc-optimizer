import assert from "node:assert";
import { hasProperty } from "../ast";
import { Block, Context, FuncEntry } from "./bytecode";
import { postOrderPropagate } from "./cflow";
import { ExceptionEntry, ExceptionsMap } from "./exceptions";
import { LineNumber } from "./linenum";
import { Bytecode, emitBytecode, isCondBranch, Opcodes } from "./opcodes";
import { cleanCfg } from "./optimize";

type LocalXmlInfo = {
  name: string;
  startPc: number;
  endPc: number;
  isParam: boolean;
  slot: number;
  id: number;
};
export type LocalsMap = Map<number, { startPc: number; endPc: number }>;
export type UpdateInfo = {
  offsetMap: Map<number, number>;
  localRanges: LocalXmlInfo[];
  lineMap: LineNumber[];
  exceptionsMap: ExceptionsMap;
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

  const shift_hack = context.header.ciqVersion < 0x50000;

  const { liveInLocals } = getLocalsInfo(func);
  const liveLocalRanges: Map<number, LocalXmlInfo> = new Map();

  const { localRanges, offsetMap } = updateInfo;
  const linktable = new Map<number, number>();
  let offset = start;
  let lineNum: LineNumber | null = null;
  const compareLineInfo = (a: LineNumber, b: LineNumber) => {
    return (
      a.line === b.line &&
      a.file === b.file &&
      a.symbol === b.symbol &&
      a.fileStr === b.fileStr &&
      a.symbolStr === b.symbolStr
    );
  };
  const startLocalRange = (
    slot: number,
    id: number,
    name: string,
    isParam: boolean
  ) => {
    const liveRange = liveLocalRanges.get(slot);
    if (liveRange) {
      if (liveRange.id === id) {
        return;
      }
      liveRange.endPc = offset - 1;
      liveLocalRanges.delete(slot);
    }
    if (id < 0) return;
    const newRange: LocalXmlInfo = {
      startPc: offset,
      endPc: offset,
      id,
      isParam,
      name,
      slot,
    };
    liveLocalRanges.set(slot, newRange);
    localRanges.push(newRange);
  };
  const exceptionStack: ExceptionEntry[] = [];
  Array.from(func.blocks.values()).forEach((block, i, blocks) => {
    offsetMap.set(block.offset, offset);
    exceptionStack.forEach((entry) => (entry.tryEnd = offset));
    if (block.try) {
      let i;
      for (i = 0; i < block.try.length; i++) {
        const entry = block.try[i];
        if (exceptionStack[i]?.handler !== entry.handler) {
          exceptionStack.length = i;
          const newEntry: ExceptionEntry = {
            tryStart: offset,
            tryEnd: offset,
            handler: entry.handler,
          };
          const e = updateInfo.exceptionsMap.get(offset);
          if (!e) {
            updateInfo.exceptionsMap.set(offset, [newEntry]);
          } else {
            e.push(newEntry);
          }
          exceptionStack.push(newEntry);
        }
      }
      exceptionStack.splice(i);
    } else {
      exceptionStack.length = 0;
    }
    const liveInState = liveInLocals.get(block.offset);
    liveInState?.forEach((local) =>
      startLocalRange(local.slot, local.id, local.name, local.isParam)
    );
    block.bytecodes.forEach((bytecode) => {
      if (bytecode.op === Opcodes.goto) {
        return;
      }
      if (bytecode.lineNum) {
        if (!lineNum || !compareLineInfo(lineNum, bytecode.lineNum)) {
          lineNum = { ...bytecode.lineNum };
          lineNum.pc = offset | 0x10000000;
          updateInfo.lineMap.push(lineNum);
        }
      }
      if (bytecode.op === Opcodes.lputv) {
        const range = bytecode.range;
        if (range) {
          startLocalRange(
            bytecode.arg,
            range.id,
            range.name,
            range.isParam === true
          );
        } else {
          startLocalRange(bytecode.arg, -1, "", false);
        }
      }
      if (
        isCondBranch(bytecode.op) &&
        block.taken != null &&
        block.taken === blocks[i + 1]?.offset
      ) {
        // flip the sense of the branch if we were going to branch to the next
        // (in bytecode order) block. This will avoid a goto
        const taken = block.next;
        block.next = block.taken;
        block.taken = taken;
        bytecode.arg = taken;
        bytecode.op = bytecode.op === Opcodes.bt ? Opcodes.bf : Opcodes.bt;
      }
      offset = emitBytecode(bytecode, view, offset, linktable, shift_hack);
    });
    if (block.next != null && block.next !== blocks[i + 1]?.offset) {
      const bc: Bytecode = {
        op: Opcodes.goto,
        arg: block.next,
        offset: block.offset,
        size: 3,
      };
      offset = emitBytecode(bc, view, offset, linktable, shift_hack);
    }
  });
  assert(exceptionStack.length === 0);
  liveLocalRanges.forEach((liveRange) => {
    liveRange.endPc = offset - 1;
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

// compute the live ranges for all locals with a "range" field. These are the
// ones that were listed in the debug.xml, and we want to be able to spit out a
// new version.
//
// For each stack slot, we need to know which local (if any) is live in and out
// of each block. We will want to extend the live ends of the live ranges as far
// as possible, so that you can still see the value in the debugger even after
// the last reference (ie we don't want to mark the range as over immediately
// after the last reference to a variable), but we do need to stop the range if
// a different variable takes over the slot.
function getLocalsInfo(func: FuncEntry) {
  type LocalInfo = { name: string; id: number; isParam: boolean; slot: number };
  type LocalState = Map<number, LocalInfo>;
  const liveOutLocals: Map<number, LocalState> = new Map();
  const liveInLocals: Map<number, LocalState> = new Map();

  function mergeInto(from: LocalState, to: LocalState) {
    let changed = false;
    from.forEach((local, key) => {
      const curr = to.get(key);
      if (!curr) {
        to.set(key, local);
        changed = true;
        return;
      }
      // if the minimize locals pass ran, it should be guaranteed that to and
      // from refer to the same local, but if we skipped it, we're just trusting
      // what debug.xml told us, and its not guaranteed.
      //
      // Either way, its not safe to assert here, and there's no good solution
      // if to and from refer to different locals. So we'll just keep to.

      // assert(curr.id === local.id);
    });
    return changed;
  }

  postOrderPropagate(
    func,
    (block) => new Map(liveOutLocals.get(block.offset)),
    (block, bc, locals) => {
      switch (bc.op) {
        case Opcodes.lgetv: {
          const range = bc.range;
          if (range) {
            locals.set(bc.arg, {
              name: range.name,
              id: range.id,
              isParam: range.isParam === true,
              slot: bc.arg,
            });
          }
          break;
        }

        case Opcodes.lputv:
          locals.delete(bc.arg);
          break;

        case Opcodes.throw:
        case Opcodes.invokem:
        case Opcodes.invokemz:
          if (block.exsucc) {
            const from = liveInLocals.get(block.exsucc);
            if (from) {
              mergeInto(from, locals);
            }
          }
          break;
      }
    },
    (block, locals) => {
      liveInLocals.set(block.offset, locals);
    },
    (locals, predBlock, isExPred) => {
      if (isExPred) return false;
      const predLocals = liveOutLocals.get(predBlock.offset);
      if (!predLocals) {
        liveOutLocals.set(predBlock.offset, new Map(locals));
        return true;
      }
      return mergeInto(locals, predLocals);
    }
  );

  return { liveInLocals, liveOutLocals };
}
