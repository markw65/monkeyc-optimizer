import assert from "node:assert";
import { log, logger, wouldLog } from "../logger";
import {
  Context,
  FuncEntry,
  bytecodeToString,
  functionBanner,
} from "./bytecode";
import { postOrderPropagate } from "./cflow";
import {
  Argc,
  Bytecode,
  Frpush,
  Getlocalv,
  Getself,
  Getselfv,
  Getv,
  Lgetv,
  LocalRange,
  Lputv,
  Nop,
  Opcodes,
  Putv,
  opReadsLocal,
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

function getLocalNum(key: LocalKey) {
  if (key.op === Opcodes.lputv) return key.arg;
  const local = opReadsLocal(key);
  assert(local !== null);
  return local;
}

export function minimizeLocals(
  func: FuncEntry,
  equivSets: Map<Lputv, Set<number>>,
  context: Context
) {
  const splitRanges = computeSplitRanges(func, equivSets);
  const locals = mergeSplitRanges(splitRanges);
  const numLocals = Math.max(...Array.from(splitRanges.keys())) + 1;

  logger("locals", 10, functionBanner(func, context, "Minimize Locals"));
  let argc: number | null = func.argc ?? null;

  const colors = new Map<Bytecode, number>();
  const merge: Array<LocalKey[]> = [];
  // Locals keyed by an lgetv were live in; ie they're arguments, so we can't
  // renumber them. Process them first.
  //
  // Also, local 0 is read by frpush, so even if it wasn't live in (and its not
  // live into non-class methods), we need to pin it to zero.
  locals.forEach((local, key) => {
    const localNum = getLocalNum(key);
    if (key.op !== Opcodes.lputv || localNum === 0) {
      colors.set(key, localNum);
      const merged = merge[localNum];
      if (argc == null || localNum < argc) {
        if (merged) {
          assert(!localNum);
          merged.push(key);
        } else {
          merge[localNum] = [key];
        }
      }
    }
  });
  // In theory, choosing a good order here could help; in practice it rarely
  // seems to make a difference. Needs revisiting
  locals.forEach((local, key) => {
    if (key.op !== Opcodes.lputv) return;
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
  // preserve as many locals as possible, to prevent unnecessary churn
  for (let i = merge.length; i--; ) {
    if (argc != null && i <= argc) break;
    const merged = merge[i];
    // if there's a single range mapped to this stack slot, and its original
    // stack slot was a smaller one, and *that* stack slot either has multiple
    // ranges, or doesn't match its original stack slot, then swap them.
    if (!merged) continue;
    const firstLocal = getLocalNum(merged[0]);
    if (
      firstLocal < i &&
      (argc == null || firstLocal >= argc) &&
      merged.every((elem) => getLocalNum(elem) === firstLocal)
    ) {
      const j = firstLocal;
      const other = merge[j];
      if (other.every((elem) => getLocalNum(elem) !== j)) {
        merge[i] = other;
        merge[j] = merged;
        merged.forEach((elem) => colors.set(elem, j));
        other.forEach((elem) => colors.set(elem, i));
        i++;
      }
    }
  }
  if (wouldLog("locals", 1)) {
    if (!wouldLog("locals", 10)) {
      logger("locals", 5, functionBanner(func, context, "Minimize Locals"));
    }
    log(
      `>>> Merging locals in ${func.name} (in: ${numLocals} => out: ${merge.length})`
    );
    merge
      .slice()
      .sort((a, b) => (colors.get(a[0]) ?? 0) - (colors.get(b[0]) ?? 0))
      .forEach((merged) =>
        log(
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
      if ("range" in bc && bc.range) {
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
      if (key.op !== Opcodes.lputv) {
        range.isParam = true;
      }
    }
    value.live.forEach((bc) => fixupMap.set(bc, { color, range }));
  });

  func.blocks.forEach((block) => {
    let filter = false;
    block.bytecodes.forEach((bc) => {
      switch (bc.op) {
        case Opcodes.argcincsp: {
          argc = bc.arg.argc;
          const newinc = merge.length - argc;
          if (newinc > 0) {
            bc.arg.incsp = newinc;
          } else {
            const argCount = bc as Bytecode as Argc;
            argCount.op = Opcodes.argc;
            argCount.arg = argc;
            filter = true;
          }
          break;
        }
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
            filter = true;
          }
          break;
        }
        case Opcodes.getlocalv:
        case Opcodes.lgetv:
        case Opcodes.lputv: {
          const info = fixupMap.get(bc);
          assert(info != null);
          if (bc.op === Opcodes.getlocalv) {
            bc.arg.local = info.color;
          } else {
            bc.arg = info.color;
          }
          if (info.range) {
            bc.range = info.range;
          } else {
            delete bc.range;
          }
          break;
        }
        case Opcodes.putv:
        case Opcodes.getv:
        case Opcodes.frpush:
        case Opcodes.getself:
        case Opcodes.getselfv: {
          const info = fixupMap.get(bc);
          if (info) {
            assert(!info.color);
          }
          break;
        }
        default:
          assert(!fixupMap.get(bc));
      }
    });
    if (filter) {
      block.bytecodes = block.bytecodes.filter((bc) => bc.op !== Opcodes.nop);
    }
  });
  return true;
}

type LocalReaders =
  | Lgetv
  | Getself
  | Getlocalv
  | Getselfv
  | Frpush
  | Getv
  | Putv;
type LocalKey = Lputv | LocalReaders;
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
   * LocalReaders's, and the set of conflicting LocalReaders
   */
  const splitRanges: Map<number, LocalInfo> = new Map();

  const recordLocalRead = (
    locals: Map<number, Set<Bytecode>>,
    bc: LocalReaders
  ) => {
    const localid = opReadsLocal(bc);
    assert(localid != null);
    const bcs = locals.get(localid);
    if (!bcs) {
      locals.set(localid, new Set([bc]));
    } else {
      bcs.add(bc);
    }
  };

  postOrderPropagate(
    func,
    (block) => cloneLive(liveOutLocals.get(block.offset)),
    (block, bc, locals) => {
      switch (bc.op) {
        case Opcodes.getself:
        case Opcodes.getselfv:
        case Opcodes.getlocalv:
        case Opcodes.frpush:
        case Opcodes.lgetv:
        case Opcodes.getv:
        case Opcodes.putv:
          recordLocalRead(locals, bc);
          break;

        case Opcodes.lputv: {
          let bcs = locals.get(bc.arg);
          if (!bcs) {
            bcs = new Set();
          }
          const ranges = splitRanges.get(bc.arg);
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
            splitRanges.set(bc.arg, new Map([[bc, { live: bcs, conflicts }]]));
          } else {
            ranges.set(bc, { live: bcs, conflicts });
          }
          locals.delete(bc.arg);
          break;
        }
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
        default:
          assert(opReadsLocal(bc) == null);
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
    const bc = bcs.values().next().value as LocalReaders;
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
        if (!lputv || pv.op !== Opcodes.lputv) lputv = pv;
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
          assert(r);
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
