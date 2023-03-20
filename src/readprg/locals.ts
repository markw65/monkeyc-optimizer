import assert from "node:assert";
import { log, logger, wouldLog } from "../logger";
import {
  bytecodeToString,
  Context,
  FuncEntry,
  functionBanner,
} from "./bytecode";
import { postOrderPropagate } from "./cflow";
import {
  Bytecode,
  Frpush,
  Lgetv,
  LocalRange,
  Lputv,
  Nop,
  Opcodes,
} from "./opcodes";

function cloneLive(locals: Map<number, Set<Bytecode>> | undefined) {
  const clone: Map<number, Set<Bytecode>> = new Map();
  locals?.forEach((value, key) => clone.set(key, new Set(value)));
  return clone;
}

function mergeInto(
  from: Map<number, Set<Bytecode>>,
  to: Map<number, Set<Bytecode>>
) {
  let changed = false;
  from.forEach((local, key) => {
    const curr = to.get(key);
    if (!curr) {
      to.set(key, new Set(local));
      changed = true;
      return;
    }
    local.forEach((inst) => {
      if (!curr.has(inst)) {
        changed = true;
        curr.add(inst);
      }
    });
  });
  return changed;
}

export function minimizeLocals(
  func: FuncEntry,
  equivSets: Map<Lputv, Set<number>>,
  context: Context
) {
  const splitRanges = computeSplitRanges(func, equivSets);
  const locals = mergeSplitRanges(splitRanges);
  const numLocals = Math.max(...Array.from(splitRanges.keys())) + 1;

  if (wouldLog("locals", 10)) {
    log(functionBanner(func, context, "Minimize Locals")());
  }
  const colors = new Map<Bytecode, number>();
  const merge: Array<LocalKey[]> = [];
  // Locals keyed by an lgetv were live in; ie they're arguments, so we can't
  // renumber them. Process them first.
  //
  // Also, local 0 is read by frpush, so even if it wasn't live in (and its not
  // live into non-class methods), we need to pin it to zero.
  locals.forEach((local, key) => {
    if (key.op === Opcodes.lgetv || key.arg === 0) {
      colors.set(key, key.arg);
      const merged = merge[key.arg];
      if (merged) {
        assert(!key.arg);
        merged.push(key);
      } else {
        merge[key.arg] = [key];
      }
    }
  });
  // In theory, choosing a good order here could help; in practice it rarely
  // seems to make a difference. Needs revisiting
  locals.forEach((local, key) => {
    if (key.op === Opcodes.lgetv) return;
    let inUse = 0n;
    local.conflicts.forEach((conflict) => {
      const color = colors.get(conflict);
      if (color != null) {
        inUse |= 1n << BigInt(color);
      }
    });
    let lowest = 0;
    while (inUse & 1n) {
      lowest++;
      inUse >>= 1n;
    }
    colors.set(key, lowest);
    if (!merge[lowest]) {
      merge[lowest] = [key];
    } else {
      merge[lowest].push(key);
    }
  });
  if (merge.length >= numLocals) return false;
  if (wouldLog("locals", 1)) {
    if (!wouldLog("locals", 10)) {
      logger("locals", 5, functionBanner(func, context, "Minimize Locals")());
    }
    log(
      `>>> Merging locals in ${func.name} (in: ${numLocals} => out: ${merge.length})`
    );
    merge
      .slice()
      .sort((a, b) => (colors.get(a[0]) ?? 0) - (colors.get(b[0]) ?? 0))
      .forEach((merged) =>
        console.log(
          ` ${colors.get(merged[0])} - ${merged
            .map((k) => bytecodeToString(k, context.symbolTable))
            .join(" | ")}`
        )
      );
  }
  const fixupMap: Map<Bytecode, { color: number; range: LocalRange | null }> =
    new Map();
  locals.forEach((value, key) => {
    const color = colors.get(key);
    assert(color != null);
    let name = null as string | null | Set<string>;
    Array.from(value.live).some((bc) => {
      if ((bc.op === Opcodes.lgetv || bc.op === Opcodes.lputv) && bc.range) {
        if (!name) {
          name = bc.range.name;
        } else if (name !== bc.range.name) {
          if (typeof name === "string") {
            name = new Set([name]);
          }
          name.add(bc.range.name);
        }
      }
    });
    let range: LocalRange | null = null;
    if (name) {
      if (typeof name !== "string") {
        name = Array.from(name).join("_");
      }
      range = { name, id: context.nextLocalId++ };
      if (key.op === Opcodes.lgetv) {
        range.isParam = true;
      }
    }
    value.live.forEach((bc) => fixupMap.set(bc, { color, range }));
  });
  let argc: number | null = null;
  func.blocks.forEach((block) => {
    let filter = false;
    block.bytecodes.forEach((bc) => {
      switch (bc.op) {
        case Opcodes.argc:
          argc = bc.arg;
          break;
        case Opcodes.incsp: {
          let newinc;
          if (argc != null) {
            newinc = merge.length - argc;
          } else {
            newinc = bc.arg + merge.length - numLocals;
          }
          if (newinc > 0) {
            bc.arg = newinc;
          } else {
            const nop = bc as Bytecode as Nop;
            nop.op = Opcodes.nop;
            delete nop.arg;
            nop.size = 1;
            filter = true;
          }
          break;
        }
        case Opcodes.lgetv:
        case Opcodes.lputv: {
          const info = fixupMap.get(bc);
          assert(info != null);
          bc.arg = info.color;
          if (info.range) {
            bc.range = info.range;
          } else {
            delete bc.range;
          }
          break;
        }
      }
    });
    if (filter) {
      block.bytecodes = block.bytecodes.filter((bc) => bc.op !== Opcodes.nop);
    }
  });
  return true;
}

type LocalKey = Lputv | Lgetv;
type SingleLocal = { live: Set<Bytecode>; conflicts: Set<Bytecode> };
type LocalInfo = Map<LocalKey, SingleLocal>;

function computeSplitRanges(
  func: FuncEntry,
  equivSets: Map<Lputv, Set<number>>
) {
  const liveOutLocals: Map<number, Map<number, Set<Bytecode>>> = new Map();
  const liveInLocals: Map<number, Map<number, Set<Bytecode>>> = new Map();

  /*
   * Map from register number, to a map from Lputv's to the set of dependent
   * Lgetv's, and the set of conflicting Lgetvs
   */
  const splitRanges: Map<number, LocalInfo> = new Map();

  const recordLgetv = (locals: Map<number, Set<Bytecode>>, bc: Lgetv) => {
    const bcs = locals.get(bc.arg);
    if (!bcs) {
      locals.set(bc.arg, new Set([bc]));
    } else {
      bcs.add(bc);
    }
  };

  const fakeLgetvs: Map<Frpush, Lgetv> = new Map();

  postOrderPropagate(
    func,
    (block) => cloneLive(liveOutLocals.get(block.offset)),
    (block, bc, locals) => {
      switch (bc.op) {
        case Opcodes.frpush: {
          let fakeLgetv = fakeLgetvs.get(bc);
          if (!fakeLgetv) {
            fakeLgetv = {
              op: Opcodes.lgetv,
              arg: 0,
              size: 2,
              offset: bc.offset,
            };
            fakeLgetvs.set(bc, fakeLgetv);
          }
          // frpush gets the last base used in a getv (ie in Foo.bar it would be
          // Foo). If that is a class, it pushes local 0, otherwise it pushes
          // Foo. If we did a bit more analysis, we could know whether it cares about
          // local 0 or not. But for now, just assume it does.
          recordLgetv(locals, fakeLgetv);
          break;
        }
        case Opcodes.lgetv:
          recordLgetv(locals, bc);
          break;

        case Opcodes.lputv: {
          let bcs = locals.get(bc.arg);
          if (!bcs) {
            bcs = new Set();
          }
          let ranges = splitRanges.get(bc.arg);
          const equiv = equivSets.get(bc);
          const conflicts: Set<Bytecode> = new Set();
          locals.forEach((liveBcs, local) => {
            // a store doesn't conflict with itself
            if (local === bc.arg) return;
            // a store doesn't conflict with any locals in its equiv set
            if (equiv?.has(local)) return;
            liveBcs.forEach((lbc) => conflicts.add(lbc));
          });
          if (!ranges) {
            splitRanges.set(
              bc.arg,
              (ranges = new Map([[bc, { live: bcs, conflicts }]]))
            );
          } else {
            ranges.set(bc, { live: bcs, conflicts });
          }
          locals.delete(bc.arg);
          break;
        }
        case Opcodes.throw:
        case Opcodes.invokem:
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
        liveOutLocals.set(predBlock.offset, cloneLive(locals));
        return true;
      }
      return mergeInto(locals, predLocals);
    }
  );
  const liveIn = liveInLocals.get(func.offset);
  liveIn?.forEach((bcs, num) => {
    const bc = bcs.values().next().value as Lgetv;
    let range = splitRanges.get(num);
    if (!range) {
      splitRanges.set(num, (range = new Map()));
    }
    range.set(bc, { live: bcs, conflicts: new Set() });
  });
  return splitRanges;
}

function mergeSplitRanges(splitRanges: Map<number, LocalInfo>) {
  /*
   * splitRanges is a map from local id, to a map from lputv's for that local id
   * to the set of lgetv's that are reachable from it. But we need to turn that
   * into a disjoint collection of sets of bytecodes: if two lputv's have at
   * least one lgetv in common, we need to combine them into a single live
   * range.
   *
   * We use a "reference" type, so that when we combine two sets, we can replace
   * all uses of the second set with the combined set without having to actually
   * find them all.
   */
  type LputvSetRef = { ref: Set<LocalKey> };
  const bcToLiveRange: Map<Bytecode, LocalKey> = new Map();
  splitRanges.forEach((range, localid) => {
    const reverseMap: Map<Bytecode, LputvSetRef> = new Map();
    const pvMap: Map<LocalKey, LputvSetRef> = new Map();
    range.forEach(({ live }, key) => {
      const putvSetRef: LputvSetRef = { ref: new Set([key]) };
      pvMap.set(key, putvSetRef);
      live.forEach((bc) => {
        const m = reverseMap.get(bc);
        if (!m) {
          reverseMap.set(bc, putvSetRef);
        } else if (m.ref !== putvSetRef.ref) {
          putvSetRef.ref.forEach((pv) => {
            m.ref.add(pv);
            const other = pvMap.get(pv)!;
            other.ref = m.ref;
          });
        }
      });
    });
    const putvSets: Set<Set<LocalKey>> = new Set();
    reverseMap.forEach(({ ref }) => putvSets.add(ref));
    // verify that putvSets contains all the lputvs, and that every lputv is in
    // one and only one of the sets.
    range.forEach((x, key) => {
      const num = Array.from(putvSets).reduce(
        (count, set) => count + (set.has(key) ? 1 : 0),
        0
      );
      assert(num === 1);
    });
    const newRange: typeof range = new Map();
    putvSets.forEach((pvSet) => {
      let lputv: LocalKey | null = null;
      let singleRange: SingleLocal | null = null;
      pvSet.forEach((pv) => {
        if (!lputv || pv.op === Opcodes.lgetv) lputv = pv;
      });
      pvSet.forEach((pv) => {
        const { live, conflicts } = range.get(pv)!;
        if (!singleRange) {
          singleRange = { live, conflicts };
        } else {
          live.forEach((l) => singleRange!.live.add(l));
          conflicts.forEach((c) => singleRange!.conflicts.add(c));
        }
        singleRange.live.add(pv);
        live.forEach((bc) => {
          const prev = bcToLiveRange.get(bc);
          assert(!prev || prev === lputv);
          bcToLiveRange.set(bc, lputv!);
        });
      });
      assert(singleRange && lputv);
      newRange.set(lputv, singleRange);
    });
    splitRanges.set(localid, newRange);
  });
  // each entry in localInfo is keyed by the canonical lputv for this group
  // (there may be more lputvs), and its value consists of `live`, the set of
  // bytecodes in this group, and `conflicts`, the set of canonical lputvs that
  // it conflicts with.
  const localInfo: LocalInfo = new Map();
  splitRanges.forEach((range) => {
    range.forEach((v, lputv) => {
      v.conflicts = new Set(
        Array.from(v.conflicts).flatMap((bc) => {
          const r = bcToLiveRange.get(bc);
          if (!r) {
            // this must have been a fake Lgetv inserted for an frpush
            assert(bc.arg === 0);
            return [];
          }
          return r;
        })
      );
      localInfo.set(lputv, v);
    });
  });
  // conflicts need to be symmetric
  localInfo.forEach((info, key) => {
    info.conflicts.forEach((v) =>
      localInfo.get(v as LocalKey)!.conflicts.add(key)
    );
  });

  return localInfo;
}
