import assert from "node:assert";
import { evaluateBinaryTypes } from "../type-flow/interp-binary";
import { log, logger, setBanner, wouldLog } from "../logger";
import { ExactOrUnion, mctree } from "../optimizer";
import { evaluateUnaryTypes, roundToFloat } from "../type-flow/interp";
import {
  cloneType,
  display,
  ExactTypes,
  hasValue,
  isExact,
  mustBeFalse,
  mustBeTrue,
  TypeTag,
} from "../type-flow/types";
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
import { RpoFlags, rpoPropagate } from "./cflow";
import { Bytecode, getOpInfo, Lputv, Opcodes } from "./opcodes";

interface InterpItemInfo {
  type: ExactOrUnion;
  // other items that contain the same value as this item
  equivs?: Set<number>;
}

export type InterpState = {
  stack: InterpItemInfo[];
  locals: InterpItemInfo[];
  // set if we're reprocessing a special loop block that unbalances the stack
  // (eg array-init loops). This is used to prevent optimizations that appear to
  // be valid on the last iteration of the loop, but in fact are not
  loopBlock?: true;
};

function interpItemToString(item: InterpItemInfo) {
  let str = display(item.type);
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

export function cloneState(state: InterpState | null | undefined): InterpState {
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

function mergeElems(fromElem: InterpItemInfo, toElem: InterpItemInfo) {
  let changes = false;
  toElem.type = cloneType(toElem.type);
  if (unionInto(toElem.type, fromElem.type)) {
    changes = true;
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
  const find = (elems: InterpItemInfo[], d: number) => {
    let alternate = null;
    for (let i = elems.length - d; i--; ) {
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
  const stackIndex = find(localState.stack, 1);
  if (stackIndex != null && stackIndex < localState.stack.length) {
    return ~stackIndex;
  }
  const localIndex = find(localState.locals, 0);
  if (localIndex != null && localIndex < localState.locals.length) {
    return localIndex;
  }
  return stackIndex != null ? ~stackIndex : localIndex;
}

export function interpBytecode(
  bc: Bytecode,
  localState: InterpState,
  context: Context
) {
  const xpush = <T extends ExactTypes["type"]>(
    type: T,
    value?: Extract<ExactTypes, { type: T }>["value"]
  ) => {
    const tt: ExactTypes = { type };
    if (value != null) {
      tt.value = value;
    }
    localState.stack.push({
      type: tt,
    });
  };

  const binary = <T extends mctree.BinaryOperator>(op: T) => {
    const args = localState.stack.slice(-2);
    if (args.length !== 2) {
      args.splice(
        0,
        2,
        { type: { type: TypeTag.Any } },
        { type: { type: TypeTag.Any } }
      );
    }
    const type = evaluateBinaryTypes(op, args[0].type, args[1].type);
    if (args[0].equivs) {
      removeEquiv(localState, 1 - localState.stack.length);
    }
    if (args[1].equivs) {
      removeEquiv(localState, 0 - localState.stack.length);
    }
    localState.stack.splice(-2, 2, { type });
  };

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
    case Opcodes.dup: {
      const dup = localState.stack.length - bc.arg - 1;
      let other = localState.stack[dup];
      if (other) {
        other = { ...other };
        delete other.equivs;
      } else {
        other = { type: { type: TypeTag.Any } };
      }
      localState.stack.push(other);
      if (dup >= 0) {
        addEquiv(localState, -localState.stack.length, ~dup);
      }
      break;
    }
    case Opcodes.lputv: {
      let curItem = localState.locals[bc.arg];
      if (!curItem) {
        curItem = localState.locals[bc.arg] = {
          type: { type: TypeTag.Any },
        };
      }
      const value = localState.stack[localState.stack.length - 1];
      if (value.equivs) {
        if (curItem.equivs?.has(-localState.stack.length)) {
          // this is a self store
          removeEquiv(localState, -localState.stack.length);
          localState.stack.pop();
          break;
        }
        removeEquiv(localState, bc.arg);
        addEquiv(localState, bc.arg, -localState.stack.length);
        removeEquiv(localState, -localState.stack.length);
      } else if (curItem.equivs) {
        removeEquiv(localState, bc.arg);
      }
      localState.stack.pop();
      localState.locals[bc.arg].type = value.type;
      break;
    }
    case Opcodes.ipush:
      xpush(TypeTag.Number, bc.arg);
      break;
    case Opcodes.lpush:
      xpush(TypeTag.Long, bc.arg);
      break;
    case Opcodes.fpush:
      xpush(TypeTag.Float, roundToFloat(bc.arg));
      break;
    case Opcodes.dpush:
      xpush(TypeTag.Double, bc.arg);
      break;
    case Opcodes.cpush:
      xpush(TypeTag.Char, String.fromCharCode(bc.arg));
      break;
    case Opcodes.bpush:
      xpush(bc.arg ? TypeTag.True : TypeTag.False);
      break;
    case Opcodes.npush:
      xpush(TypeTag.Null);
      break;
    case Opcodes.spush: {
      const argSym = context.symbolTable.symbolToLabelMap.get(bc.arg);
      const name = argSym && context.symbolTable.symbols.get(argSym)?.str;
      const value = `${name ?? "symbol"}<${bc.arg}>`;
      xpush(TypeTag.Symbol, value);
      break;
    }
    case Opcodes.news: {
      const symbol = context.symbolTable?.symbols.get(bc.arg);
      xpush(TypeTag.Symbol, symbol?.str);
      break;
    }
    case Opcodes.addv:
      binary("+");
      break;
    case Opcodes.subv:
      binary("-");
      break;
    case Opcodes.mulv:
      binary("*");
      break;
    case Opcodes.divv:
      binary("/");
      break;
    case Opcodes.modv:
      binary("%");
      break;
    case Opcodes.shlv:
      binary("<<");
      break;
    case Opcodes.shrv:
      binary(">>");
      break;
    case Opcodes.andv:
      binary("&");
      break;
    case Opcodes.orv:
      binary("|");
      break;
    case Opcodes.xorv:
      binary("^");
      break;
    case Opcodes.eq:
      binary("==");
      break;
    case Opcodes.ne:
      binary("!=");
      break;
    case Opcodes.lt:
      binary("<");
      break;
    case Opcodes.lte:
      binary("<=");
      break;
    case Opcodes.gt:
      binary(">");
      break;
    case Opcodes.gte:
      binary(">=");
      break;
    case Opcodes.invv: {
      removeEquiv(localState, -localState.stack.length);
      const arg = localState.stack.pop()?.type ?? { type: TypeTag.Any };
      const result = evaluateUnaryTypes("~", arg);
      localState.stack.push({ type: result });
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
        case Opcodes.lputv: {
          selfStores.delete(bc);
          equivSets.delete(bc);
          const curItem = localState.locals[bc.arg];
          const curEquivs = curItem?.equivs;
          const selfStore =
            curEquivs?.has(bc.arg) && curEquivs.has(-localState.stack.length);
          interpBytecode(bc, localState, context);
          if (!localState.loopBlock) {
            if (selfStore) {
              selfStores.add(bc);
              break;
            }
            const postItem = curItem ?? localState.locals[bc.arg];
            if (postItem.equivs) {
              equivSets.set(
                bc,
                new Set(Array.from(postItem.equivs).filter((e) => e >= 0))
              );
            }
          }
          break;
        }
        case Opcodes.ipush:
        case Opcodes.lpush:
        case Opcodes.fpush:
        case Opcodes.dpush:
        case Opcodes.cpush:
        case Opcodes.spush: {
          interpBytecode(bc, localState, context);
          const topType = localState.stack[localState.stack.length - 1].type;
          assert(isExact(topType));
          const index = localState.loopBlock
            ? null
            : findEquivalent(localState, topType.type, topType.value);
          let blockReps = replacements.get(block);

          if (index != null) {
            if (!blockReps) {
              blockReps = new Map();
              replacements.set(block, blockReps);
            }
            if (index < 0) {
              const arg =
                localState.stack.length -
                (~index % localState.stack.length) -
                2;
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
          break;
        }
        case Opcodes.bt:
        case Opcodes.bf:
          if (block.taken === block.offset) {
            const inState = liveInState.get(block.offset);
            assert(inState);
            if (inState.stack.length !== localState.stack.length - 1) {
              // this is a loop we inserted for array initialization. We have to
              // re-process this block until the loop terminates in order to
              // keep the stack balanced.
              const condition = localState.stack[localState.stack.length - 1];
              const isTrue = mustBeTrue(condition.type);
              const isFalse = mustBeFalse(condition.type);
              assert(isTrue || isFalse);
              interpBytecode(bc, localState, context);
              if (isTrue === (bc.op === Opcodes.bt)) {
                localState.loopBlock = true;
                inState.loopBlock = true;
                return RpoFlags.RestartBlock;
              }
              return RpoFlags.SkipTaken;
            }
          }
          interpBytecode(bc, localState, context);
          break;

        default:
          interpBytecode(bc, localState, context);
      }
      return null;
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
        //
        // Note that in reality, the runtime doesn't seem to get this right. See
        // https://forums.garmin.com/developer/connect-iq/i/bug-reports/try-catch-breaks-finally-blocks
        // An explicit throw does seem to preserve the state of the stack, while
        // a call that throws appears to enter the catch block with an empty
        // stack (apart from the exception). This makes (some) sense - there's
        // no information in garmin's exception tables that would tell the
        // unwinder how deep the stack should be on entry to the handler, so it
        // just clears the stack, and pushes the exception.
        //
        // In any case, modeling it as if the stack were preserved seems to make
        // most sense. Apart from the crash on exit from the finally block
        // (which we can't do anything about), and possibly changing the result
        // of a return with no argument, it shouldn't really matter, and doing
        // this makes the stack consistent.

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
        invv.offset = context.nextOffset++;
        delete invv.arg;
        block.bytecodes.splice(i + 1, 0, invv);
      }
    }
  });
  if (interpLogging) setBanner(null);
  return {
    liveInState,
    equivSets,
    changes: selfStores.size || replacements.size,
  };
}

export function instForType(
  type: ExactOrUnion,
  offset: number
): Bytecode | null {
  if (!hasValue(type)) return null;
  switch (type.type) {
    case TypeTag.Null:
      return { op: Opcodes.npush, offset, size: 1 };
    case TypeTag.False:
    case TypeTag.True:
      return {
        op: Opcodes.bpush,
        arg: type.type === TypeTag.False ? 0 : 1,
        offset,
        size: 1,
      };
    case TypeTag.Number:
      return { op: Opcodes.ipush, arg: type.value, offset, size: 1 };
    case TypeTag.Long:
      return { op: Opcodes.lpush, arg: type.value, offset, size: 1 };
    case TypeTag.Float:
      return { op: Opcodes.fpush, arg: type.value, offset, size: 1 };
    case TypeTag.Double:
      return { op: Opcodes.dpush, arg: type.value, offset, size: 1 };
    case TypeTag.Char:
      return {
        op: Opcodes.cpush,
        arg: type.value.charCodeAt(0),
        offset,
        size: 1,
      };
    case TypeTag.Symbol: {
      const match = type.value.match(/<(\d+)>$/);
      assert(match);
      return {
        op: Opcodes.ipush,
        arg: parseInt(match[1], 10),
        offset,
        size: 1,
      };
    }
  }
  return null;
}
