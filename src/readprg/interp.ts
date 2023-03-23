import assert from "node:assert";
import { log, logger, setBanner, wouldLog } from "../logger";
import { ExactOrUnion } from "../optimizer";
import { roundToFloat } from "../type-flow/interp";
import { cloneType, display, ExactTypes, TypeTag } from "../type-flow/types";
import { unionInto } from "../type-flow/union-type";
import {
  Block,
  blockToString,
  bytecodeToString,
  Context,
  FuncEntry,
  functionBanner,
  lineInfoToString,
  makeArgless,
  offsetToString,
} from "./bytecode";
import { rpoPropagate } from "./cflow";
import { Bytecode, getOpInfo, Lputv, Opcodes } from "./opcodes";

interface InterpItemInfo {
  type: ExactOrUnion;
  // other items that contain the same value as this item
  equivs?: Set<number>;
}

interface InterpStackElem extends InterpItemInfo {
  dup?: number;
}

type InterpState = {
  stack: InterpStackElem[];
  locals: InterpItemInfo[];
};

function interpItemToString(item: InterpStackElem) {
  let str = display(item.type);
  if (item.dup != null) str += ` dup<${item.dup}>`;
  if (item.equivs) {
    str += ` equivs: ${Array.from(item.equivs).join(", ")}`;
  }
  return str;
}

function interpStateToString(state?: InterpState | undefined) {
  return `liveInState\n stack:\n${
    state?.stack
      .map((item, i) => `  ${i}: ${interpItemToString(item)}\n`)
      .join("") ?? "<empty>"
  }\n locals:\n${
    state?.locals
      .map((item, i) => `  ${i}: ${interpItemToString(item)}\n`)
      .join("") ?? "<none>"
  }`;
}

function checkState(state: InterpState) {
  const checkArray = (items: InterpItemInfo[]) =>
    items.forEach((item) => {
      item.equivs?.forEach((e) => {
        if (getEquivs(state, e) !== item.equivs) {
          assert(getEquivs(state, e) === item.equivs);
        }
      });
    });
  checkArray(state.stack);
  checkArray(state.locals);
}

function getEquivs(state: InterpState, a: number) {
  return a < 0 ? state.stack[~a]?.equivs : state.locals[a]?.equivs;
}

function setEquivs(
  state: InterpState,
  a: number,
  equivs: Set<number> | null | undefined
) {
  if (a < 0) {
    if (equivs) {
      state.stack[~a].equivs = equivs;
    } else {
      delete state.stack[~a].equivs;
    }
  } else {
    if (!state.locals[a]) {
      state.locals[a] = { type: { type: TypeTag.Any } };
    }
    if (equivs) {
      state.locals[a].equivs = equivs;
    } else {
      delete state.locals[a].equivs;
    }
  }
}

function addEquiv(state: InterpState, a: number, b: number) {
  const aEquiv = getEquivs(state, a);
  const bEquiv = getEquivs(state, b);
  if (aEquiv) {
    if (bEquiv) {
      bEquiv.forEach((i) => {
        aEquiv.add(i);
        setEquivs(state, i, aEquiv);
      });
    } else {
      aEquiv.add(b);
      setEquivs(state, b, aEquiv);
    }
    return;
  }
  if (bEquiv) {
    bEquiv.add(a);
    setEquivs(state, a, bEquiv);
    return;
  }
  const equivs = new Set([a, b]);
  setEquivs(state, a, equivs);
  setEquivs(state, b, equivs);
}

function removeEquiv(state: InterpState, a: number) {
  const aEquiv = getEquivs(state, a);
  if (!aEquiv || !aEquiv.has(a)) return;
  aEquiv.delete(a);
  setEquivs(state, a, null);
  if (aEquiv.size === 1) {
    aEquiv.forEach((i) => setEquivs(state, i, null));
  }
}

function cloneState(state: InterpState | undefined): InterpState {
  if (!state) {
    return { stack: [], locals: [] };
  }
  const clone: InterpState = {
    ...state,
    stack: state.stack.map((elem) => {
      const { equivs: _equivs, ...clone } = elem;
      return clone;
    }),
    locals: state.locals.map((elem) => {
      const { equivs: _equivs, ...clone } = elem;
      return clone;
    }),
  };
  state.locals.forEach((elem, i) => {
    if (elem.equivs && !clone.locals[i].equivs) {
      elem.equivs.forEach((e) => e === i || addEquiv(clone, i, e));
    }
  });
  checkState(clone);
  return clone;
}

function mergeElems(fromElem: InterpStackElem, toElem: InterpStackElem) {
  let changes = false;
  toElem.type = cloneType(toElem.type);
  if (unionInto(toElem.type, fromElem.type)) {
    changes = true;
  }
  if (toElem.dup !== fromElem.dup) {
    changes = true;
    delete toElem.dup;
  }
  return changes;
}

function mergeInto(from: InterpState, to: InterpState) {
  let changes = false;
  if (from.stack.length > to.stack.length) {
    let delta = from.stack.length - to.stack.length;
    for (let i = to.stack.length; i--; ) {
      const elem = to.stack[i];
      if (elem.equivs) {
        elem.equivs.delete(~i);
        elem.equivs.add(~(i + delta));
      }
    }
    changes = true;
    do {
      to.stack.unshift({ type: { type: TypeTag.Any } });
    } while (--delta);
  }
  const toEquivs = to.locals.map((elem) => {
    const equivs = elem.equivs;
    delete elem.equivs;
    return equivs;
  });
  const delta = to.stack.length - from.stack.length;
  for (let i = to.stack.length; i--; ) {
    const toElem = to.stack[i];
    const fromElem =
      i >= delta ? from.stack[i - delta] : { type: { type: TypeTag.Any } };
    if (mergeElems(fromElem, toElem)) {
      changes = true;
    }
    delete toElem.equivs;
  }
  for (let i = to.locals.length; i--; ) {
    const toElem = to.locals[i];
    if (toElem) {
      const fromElem = from.locals[i];
      if (!fromElem) {
        changes = true;
        delete to.locals[i];
      } else {
        if (mergeElems(fromElem, toElem)) {
          changes = true;
        }
      }
    }
  }
  toEquivs.forEach((equiv, i) => {
    if (!equiv || to.locals[i]?.equivs) {
      return;
    }
    const fromEquiv = from.locals[i]?.equivs;
    if (!fromEquiv) {
      changes = true;
      return;
    }
    equiv.forEach((e) => {
      if (
        e >= 0 ? !fromEquiv.has(e) : e + delta >= 0 || !fromEquiv.has(e + delta)
      ) {
        changes = true;
        return;
      }
      if (i !== e) {
        addEquiv(to, i, e);
      }
    });
  });
  checkState(to);
  return changes;
}

function findEquivalent(
  localState: InterpState,
  type: ExactTypes["type"],
  value?: ExactTypes["value"]
) {
  const find = (elems: InterpItemInfo[]) => {
    let alternate = null;
    for (let i = elems.length; i--; ) {
      const t = elems[i];
      if (t && t.type.type === type) {
        if (t.type.value === value) {
          return i;
        } else if (
          (t.type.type === TypeTag.Long || t.type.type === TypeTag.Number) &&
          t.type.value != null &&
          ~t.type.value === value
        ) {
          alternate = i + elems.length;
        }
      }
    }
    return alternate;
  };
  const stackIndex = find(localState.stack);
  if (stackIndex != null && stackIndex < localState.stack.length) {
    return ~stackIndex;
  }
  const localIndex = find(localState.locals);
  if (localIndex != null && localIndex < localState.locals.length) {
    return localIndex;
  }
  return stackIndex != null ? ~stackIndex : localIndex;
}

export function interpFunc(func: FuncEntry, context: Context) {
  const { symbolTable } = context;
  const equivSets: Map<Lputv, Set<number>> = new Map();
  const selfStores: Set<Bytecode> = new Set();
  const liveInState: Map<number, InterpState> = new Map();
  const replacements: Map<
    Block,
    Map<Bytecode, Bytecode & { invert?: boolean }>
  > = new Map();
  const interpLogging = wouldLog("interp", 1);
  if (interpLogging) {
    if (wouldLog("interp", 7)) {
      setBanner(functionBanner(func, context, "interp"));
    } else if (wouldLog("interp", 3)) {
      setBanner(
        () => `+++++++++++++ interp-prepare ${func.name} ++++++++++++++`
      );
    }
  }

  const xpush = <T extends ExactTypes["type"]>(
    localState: InterpState,
    block: Block,
    bc: Bytecode,
    type: T,
    value?: Extract<ExactTypes, { type: T }>["value"]
  ) => {
    const tt: ExactTypes = { type };
    if (value != null) {
      tt.value = value;
    }
    if (bc.size > 2) {
      const index = findEquivalent(localState, type, value);
      let blockReps = replacements.get(block);

      if (index != null) {
        if (!blockReps) {
          blockReps = new Map();
          replacements.set(block, blockReps);
        }
        if (index < 0) {
          const arg =
            localState.stack.length - (~index % localState.stack.length) - 1;
          blockReps.set(bc, {
            op: Opcodes.dup,
            arg,
            offset: bc.offset,
            size: 2,
            invert: localState.stack.length <= ~index,
          });
        } else {
          const arg = index % localState.locals.length;
          blockReps.set(bc, {
            op: Opcodes.lgetv,
            arg,
            offset: bc.offset,
            size: 2,
            invert: localState.locals.length <= index,
          });
        }
      } else if (blockReps) {
        blockReps.delete(bc);
        if (!blockReps.size) {
          replacements.delete(block);
        }
      }
    }
    localState.stack.push({
      type: tt,
    });
  };

  rpoPropagate(
    func,
    (block) => {
      if (interpLogging) {
        logger(
          "interp",
          3,
          `${offsetToString(block.offset)}: ${
            block.bytecodes[0]?.lineNum
              ? lineInfoToString(block.bytecodes[0]?.lineNum, context)
              : ""
          }\n ${interpStateToString(liveInState.get(block.offset))}`
        );
        logger("interp", 9, blockToString(block, context));
      }
      return cloneState(liveInState.get(block.offset));
    },
    (block, bc, localState) => {
      switch (bc.op) {
        case Opcodes.lgetv: {
          let local = localState.locals[bc.arg];
          if (local) {
            local = { ...local };
            delete local.equivs;
          } else {
            local = { type: { type: TypeTag.Any } };
          }
          localState.stack.push(local);
          addEquiv(localState, -localState.stack.length, bc.arg);
          break;
        }
        case Opcodes.lputv: {
          selfStores.delete(bc);
          equivSets.delete(bc);
          let curItem = localState.locals[bc.arg];
          if (!curItem) {
            curItem = localState.locals[bc.arg] = {
              type: { type: TypeTag.Any },
            };
          }
          const { dup: _dup, ...value } =
            localState.stack[localState.stack.length - 1];
          if (value.equivs) {
            if (curItem.equivs?.has(-localState.stack.length)) {
              // this is a self store
              selfStores.add(bc);
              removeEquiv(localState, -localState.stack.length);
              localState.stack.pop();
              break;
            }
            removeEquiv(localState, bc.arg);
            addEquiv(localState, bc.arg, -localState.stack.length);
            removeEquiv(localState, -localState.stack.length);
            if (curItem.equivs) {
              equivSets.set(
                bc,
                new Set(Array.from(curItem.equivs).filter((e) => e >= 0))
              );
            }
          } else if (curItem.equivs) {
            removeEquiv(localState, bc.arg);
          }
          localState.stack.pop();
          localState.locals[bc.arg].type = value.type;
          break;
        }
        case Opcodes.ipush:
          xpush(localState, block, bc, TypeTag.Number, bc.arg);
          break;
        case Opcodes.lpush:
          xpush(localState, block, bc, TypeTag.Long, bc.arg);
          break;
        case Opcodes.fpush:
          xpush(localState, block, bc, TypeTag.Float, roundToFloat(bc.arg));
          break;
        case Opcodes.dpush:
          xpush(localState, block, bc, TypeTag.Double, bc.arg);
          break;
        case Opcodes.cpush:
          xpush(
            localState,
            block,
            bc,
            TypeTag.Char,
            String.fromCharCode(bc.arg)
          );
          break;
        case Opcodes.bpush:
          xpush(localState, block, bc, bc.arg ? TypeTag.True : TypeTag.False);
          break;
        case Opcodes.npush:
          xpush(localState, block, bc, TypeTag.Null);
          break;
        case Opcodes.spush: {
          const argSym = symbolTable?.symbolToLabelMap.get(bc.arg);
          const value =
            (argSym && symbolTable?.symbols.get(argSym)?.str) ||
            `symbol<${bc.arg}>`;

          xpush(localState, block, bc, TypeTag.Symbol, value);
          break;
        }

        default: {
          const { pop, push } = getOpInfo(bc);
          for (let i = 0; i < pop; i++) {
            removeEquiv(localState, -localState.stack.length);
            localState.stack.pop();
          }
          for (let i = 0; i < push; i++) {
            localState.stack.push({ type: { type: TypeTag.Any } });
          }
          break;
        }
      }
    },
    () => {
      /*nothing to do*/
    },
    (from, localState, succBlock, isExSucc) => {
      if (isExSucc) {
        // The stack depth on entry to the catch block should be whatever it was
        // on entry to the try plus one. Note that the stack is normally empty
        // on entry to the try; but if the try is inside a switch, catch or
        // finally block there will be elements on the stack
        const tryEntry = from.try![from.try!.length - 1].tryStart;
        const entryDepth = liveInState.get(tryEntry)?.stack.length ?? 0;
        localState = cloneState(localState);
        while (entryDepth < localState.stack.length) {
          if (localState.stack[localState.stack.length - 1].equivs) {
            removeEquiv(localState, -localState.stack.length);
          }
          localState.stack.pop();
        }
        localState.stack.push({ type: { type: TypeTag.Any } });
      }
      const succState = liveInState.get(succBlock.offset);
      if (!succState) {
        liveInState.set(succBlock.offset, cloneState(localState));
        return true;
      }
      if (!mergeInto(localState, succState)) return false;
      if (interpLogging) {
        logger("interp", 3, `Re-Merge to ${offsetToString(succBlock.offset)}`);
      }
      return true;
    }
  );
  if (interpLogging) {
    if (wouldLog("interp", 5)) {
      setBanner(
        functionBanner(func, context, "interp", (block, footer) => {
          if (footer) return "";
          return interpStateToString(liveInState.get(block.offset));
        })
      );
    } else {
      setBanner(() => `=============== interp ${func.name} ==============`);
    }
    if (equivSets.size) {
      log(`====== equivSets =====`);
      equivSets.forEach((value, key) =>
        log(
          `L${key.arg} === ${Array.from(value).sort().join(" ")} ${
            key.lineNum ? lineInfoToString(key.lineNum, context) : ""
          }`
        )
      );
    }
    if (selfStores.size) {
      log(`====== selfStores =====`);
      selfStores.forEach((value) =>
        log(`${bytecodeToString(value, symbolTable)}`)
      );
    }
    if (replacements.size) {
      log(`====== replacements =====`);
      replacements.forEach((blockRep) =>
        blockRep.forEach((rep, bc) =>
          log(
            `${bytecodeToString(bc, symbolTable)} => ${
              rep.invert ? "~" : ""
            }${bytecodeToString(rep, symbolTable)} ${
              bc.lineNum ? lineInfoToString(bc.lineNum, context) : ""
            }`
          )
        )
      );
    }
  }
  selfStores.forEach((bc) => makeArgless(bc, Opcodes.popv));
  replacements.forEach((blockRep, block) => {
    for (let i = block.bytecodes.length; i--; ) {
      const orig = block.bytecodes[i];
      const rep = blockRep.get(orig);
      if (!rep) continue;
      orig.op = rep.op;
      if (rep.arg != null) {
        orig.arg = rep.arg;
      } else {
        delete orig.arg;
      }
      orig.size = rep.size;
      if (rep.invert) {
        const invv = { ...orig };
        invv.op = Opcodes.invv;
        invv.size = 1;
        // the original byte code was 5 or 9 bytes long, so
        // we can certainly use the next offset as a unique
        // identifier for the invv
        invv.offset++;
        delete invv.arg;
        block.bytecodes.splice(i + 1, 0, invv);
      }
    }
  });
  if (interpLogging) setBanner(null);
  return { liveInState, equivSets };
}
