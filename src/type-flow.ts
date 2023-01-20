import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  formatAst,
  getSuperClasses,
  hasProperty,
  isLocal,
  isStateNode,
  lookupNext,
  traverseAst,
  variableDeclarationName,
} from "./api";
import { withLoc } from "./ast";
import { getPostOrder } from "./control-flow";
import {
  buildDataFlowGraph,
  DataFlowBlock as TypeFlowBlock,
  DataflowQueue,
  declFullName,
  Event,
  EventDecl,
  FlowEvent,
  FlowKind,
} from "./data-flow";
import { findCalleesByNode, functionMayModify } from "./function-info";
import {
  ClassStateNode,
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNode,
  VariableStateNode,
} from "./optimizer-types";
import {
  evaluate,
  evaluateExpr,
  InterpState,
  TypeMap,
} from "./type-flow/interp";
import { sysCallInfo } from "./type-flow/interp-call";
import {
  intersection,
  restrictByEquality,
} from "./type-flow/intersection-type";
import { subtypeOf } from "./type-flow/sub-type";
import {
  cloneType,
  display,
  ExactOrUnion,
  getObjectValue,
  getStateNodeDeclsFromType,
  getUnionComponent,
  hasValue,
  isExact,
  ObjectLikeTagsConst,
  setUnionComponent,
  SingleTonTypeTagsConst,
  typeFromLiteral,
  typeFromTypespec,
  typeFromTypeStateNode,
  typeFromTypeStateNodes,
  TypeTag,
} from "./type-flow/types";
import { clearValuesUnder, unionInto, widenType } from "./type-flow/union-type";
import { every, forEach, map, pushUnique, reduce, some } from "./util";

const logging = true;

// Toybox APIs often fail to include Null when they should.
// To avoid over zealous optimizations, we don't optimize
// away any Null checks for now.
export const missingNullWorkaround = true;

export function buildTypeInfo(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  optimizeEquivalencies: boolean
) {
  if (!func.node.body || !func.stack) return;
  const { graph } = buildDataFlowGraph(state, func, () => false, false, true);
  state = { ...state, stack: func.stack };
  return propagateTypes(state, func, graph, optimizeEquivalencies);
}

function declIsLocal(
  decl: EventDecl
): decl is VariableStateNode | VariableStateNode[] | mctree.TypedIdentifier {
  return some(
    decl,
    (d) =>
      d.type === "BinaryExpression" ||
      d.type === "Identifier" ||
      (d.type === "VariableDeclarator" && isLocal(d))
  );
}

function localDeclName(decl: EventDecl) {
  if (Array.isArray(decl)) decl = decl[0];
  switch (decl.type) {
    case "Identifier":
      return decl.name;
    case "BinaryExpression":
      return decl.left.name;
    case "VariableDeclarator":
      return variableDeclarationName(decl.node.id);
  }
  throw new Error(`Invalid local decl: ${declFullName(decl)}`);
}

type TypeStateKey = Exclude<EventDecl, { type: "MemberDecl" | "Unknown" }>;
type TypeStateValue = {
  curType: ExactOrUnion;
  equivSet?: { next: TypeStateKey };
};
type TypeState = Map<TypeStateKey, TypeStateValue>;

function addEquiv(ts: TypeState, key: TypeStateKey, equiv: TypeStateKey) {
  if (key === equiv) return true;
  let keyVal = ts.get(key);
  let equivVal = ts.get(equiv);
  if (!keyVal || !equivVal) return false;
  if (equivVal.equivSet) {
    if (keyVal.equivSet) {
      // key is already a member of a set, see if
      // equiv is part of it.
      let s = keyVal.equivSet.next;
      do {
        if (s === equiv) {
          // these two are already equivalent
          return true;
        }
        const next = ts.get(s);
        if (!next || !next.equivSet) {
          throw new Error(
            `Inconsistent equivSet for ${tsKey(key)}: missing value for ${tsKey(
              s
            )}`
          );
        }
        s = next.equivSet.next;
      } while (s !== key);
    }
    // equiv is already a member of a set. remove it
    removeEquiv(ts, equiv);
  }
  // equiv is not (or no longer) part of an equivSet
  keyVal = { ...keyVal };
  if (!keyVal.equivSet) {
    keyVal.equivSet = { next: key };
  }
  equivVal = { ...equivVal, equivSet: keyVal.equivSet };
  keyVal.equivSet = { next: equiv };
  ts.set(key, keyVal);
  ts.set(equiv, equivVal);
  return false;
}

function removeEquiv(ts: TypeState, equiv: TypeStateKey) {
  const equivVal = ts.get(equiv);
  if (!equivVal?.equivSet) return;
  let s = equivVal.equivSet.next;
  do {
    const next = ts.get(s);
    if (!next || !next.equivSet) {
      throw new Error(
        `Inconsistent equivSet for ${tsKey(equiv)}: missing value for ${tsKey(
          s
        )}`
      );
    }
    if (next.equivSet.next === equiv) {
      const { equivSet: _e, ...rest } = next;
      if (equivVal.equivSet.next === s) {
        // this is a pair. just kill both
        ts.set(s, rest);
      } else {
        ts.set(s, { ...rest, equivSet: equivVal.equivSet });
      }
      break;
    }
    s = next.equivSet.next;
  } while (true);
  const newVal = { ...equivVal };
  delete newVal.equivSet;
  ts.set(equiv, newVal);
}

function getEquivSet(ts: TypeState, k: TypeStateKey) {
  const keys = new Set<TypeStateKey>();
  let s = k;
  do {
    const next = ts.get(s);
    if (!next || !next.equivSet) {
      throw new Error(
        `Inconsistent equivSet for ${tsKey(k)}: missing value for ${tsKey(s)}`
      );
    }
    keys.add(s);
    s = next.equivSet.next;
  } while (s != k);
  return keys;
}

function intersectEquiv(ts1: TypeState, ts2: TypeState, k: TypeStateKey) {
  const eq1 = ts1.get(k);
  const eq2 = ts2.get(k);

  if (!eq1?.equivSet) return false;
  if (!eq2?.equivSet) {
    removeEquiv(ts1, k);
    return true;
  }

  const keys = getEquivSet(ts2, k);
  let ret = false;
  let s = eq1.equivSet.next;
  do {
    const next = ts1.get(s);
    if (!next || !next.equivSet) {
      throw new Error(
        `Inconsistent equivSet for ${tsKey(k)}: missing value for ${tsKey(s)}`
      );
    }
    if (!keys.has(s)) {
      ret = true;
      removeEquiv(ts1, s);
    }
    s = next.equivSet.next;
  } while (s != k);
  return ret;
}

function mergeTypeState(
  blockStates: TypeState[],
  blockVisits: number[],
  index: number,
  from: TypeState
) {
  const to = blockStates[index];
  if (!to) {
    blockStates[index] = new Map(from);
    blockVisits[index] = 1;
    return true;
  }
  const widen = ++blockVisits[index] > 10;

  let changes = false;
  to.forEach((tov, k) => {
    const fromv = from.get(k);
    if (!fromv) {
      changes = true;
      if (tov.equivSet) {
        removeEquiv(to, k);
      }
      to.delete(k);
      return;
    }
    if (tov.equivSet) {
      if (intersectEquiv(to, from, k)) {
        changes = true;
        tov = to.get(k)!;
      }
    }
    if (widen) {
      if (subtypeOf(fromv.curType, tov.curType)) return;
      if (subtypeOf(tov.curType, fromv.curType)) {
        to.set(k, { ...tov, curType: fromv.curType });
        changes = true;
        return;
      }
    }
    let result = cloneType(tov.curType);
    if (!unionInto(result, fromv.curType)) return;
    if (widen) {
      const wide = widenType(result);
      if (wide) result = wide;
    }
    to.set(k, { ...tov, curType: result });
    changes = true;
  });
  return changes;
}

function sourceLocation(loc: mctree.SourceLocation | null | undefined) {
  return loc
    ? `${loc.source || "??"}:${loc.start.line}:${loc.start.column}`
    : "??";
}

function printBlockHeader(block: TypeFlowBlock) {
  console.log(
    block.order,
    `(${block.node?.loc?.source || "??"}:${
      block.node?.loc?.start.line || "??"
    })`,
    `Preds: ${(block.preds || [])
      .map((block) => (block as TypeFlowBlock).order)
      .join(", ")}`
  );
}

function describeEvent(event: Event) {
  if (event.type === "exn") return "exn:";
  return `${event.type}: ${
    event.type === "flw" ||
    event.type === "mod" ||
    (!Array.isArray(event.decl) &&
      (event.decl.type === "MemberDecl" || event.decl.type === "Unknown"))
      ? formatAst(event.node)
      : event.decl
      ? declFullName(event.decl)
      : "??"
  }`;
}

function printBlockEvents(block: TypeFlowBlock, typeMap?: TypeMap) {
  console.log("Events:");
  forEach(block.events, (event) =>
    console.log(
      `    ${describeEvent(event)} ${
        event.type === "ref" && typeMap && typeMap.has(event.node)
          ? display(typeMap.get(event.node)!)
          : ""
      }`
    )
  );
}

function printBlockTrailer(block: TypeFlowBlock) {
  console.log(
    `Succs: ${(block.succs || [])
      .map((block) => (block as TypeFlowBlock).order)
      .join(", ")} ExSucc: ${
      block.exsucc ? (block.exsucc as TypeFlowBlock).order : ""
    }`
  );
}

function tsKey(key: TypeStateKey) {
  return `${map(key, (k) => {
    if (k.type === "Literal") {
      return k.raw;
    } else if (isStateNode(k)) {
      return k.fullName;
    } else if (k.type === "BinaryExpression") {
      return k.left.name;
    } else if (k.type === "Identifier") {
      return k.name;
    } else if (k.type === "EnumStringMember") {
      return k.id.name;
    }
    return "<unknown>";
  }).join("|")}`;
}

function tsEquivs(state: TypeState, key: TypeStateKey) {
  const result: string[] = [];
  let s = key;
  do {
    result.push(tsKey(s));
    const next = state.get(s);
    if (!next || !next.equivSet) {
      throw new Error(
        `Inconsistent equivSet for ${tsKey(key)}: missing value for ${tsKey(s)}`
      );
    }
    s = next.equivSet.next;
  } while (s != key);
  return `[(${result.join(", ")})]`;
}

function typeStateEntry(value: TypeStateValue, key: TypeStateKey) {
  return `${tsKey(key)} = ${display(value.curType)}`;
}

function printBlockState(block: TypeFlowBlock, state: TypeState, indent = "") {
  console.log(indent + "State:");
  if (!state) {
    console.log(indent + "Not visited!");
    return;
  }
  state.forEach((value, key) => {
    console.log(
      `${indent} - ${typeStateEntry(value, key)}${
        value.equivSet ? " " + tsEquivs(state, key) : ""
      }`
    );
  });
}

function filterDecls(decls: StateNode[], possible: StateNode[] | false) {
  if (!possible) return null;
  const result = possible.reduce<StateNode[] | null>((cur, decl) => {
    const sup = decl.type === "ClassDeclaration" && getSuperClasses(decl);
    if (decls.some((d) => d === decl || (sup && sup.has(d)))) {
      if (!cur) {
        return [decl];
      }
      cur.push(decl);
    }
    return cur;
  }, null);

  return decls.reduce((cur, decl) => {
    if (decl.type === "ClassDeclaration") {
      const sup = getSuperClasses(decl);
      if (sup && possible.some((d) => sup.has(d))) {
        if (!cur) return [decl];
        pushUnique(cur, decl);
      }
    }
    return cur;
  }, result);
}

export function findObjectDeclsByProperty(
  istate: InterpState,
  object: ExactOrUnion,
  next: mctree.DottedMemberExpression
) {
  const decls = getStateNodeDeclsFromType(istate.state, object);
  if (!decls) return null;
  const possibleDecls =
    hasProperty(istate.state.allDeclarations, next.property.name) &&
    istate.state.allDeclarations[next.property.name];

  return filterDecls(decls, possibleDecls);
}

function refineObjectTypeByDecls(
  istate: InterpState,
  object: ExactOrUnion,
  trueDecls: StateNode[]
) {
  const refinedType = typeFromTypeStateNodes(istate.state, trueDecls);
  return intersection(object, refinedType);
}

function findNextObjectType(
  istate: InterpState,
  trueDecls: StateNode[],
  next: mctree.DottedMemberExpression
) {
  const results = lookupNext(
    istate.state,
    [{ parent: null, results: trueDecls }],
    "decls",
    next.property
  );
  if (!results) return null;
  return results.reduce<ExactOrUnion>(
    (cur, lookupDefn) => {
      unionInto(cur, typeFromTypeStateNodes(istate.state, lookupDefn.results));
      return cur;
    },
    { type: TypeTag.Never }
  );
}

export function resolveDottedMember(
  istate: InterpState,
  object: ExactOrUnion,
  next: mctree.DottedMemberExpression
) {
  const decls = findObjectDeclsByProperty(istate, object, next);
  if (!decls) return null;
  const property = findNextObjectType(istate, decls, next);
  if (!property) return null;
  const type = refineObjectTypeByDecls(istate, object, decls);
  const mayThrow = !subtypeOf(object, type);
  return { mayThrow, object: type, property };
}

function propagateTypes(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  optimizeEquivalencies: boolean
) {
  // We want to traverse the blocks in reverse post order, in
  // order to propagate the "availability" of the types.
  const order = getPostOrder(graph).reverse() as TypeFlowBlock[];
  const queue = new DataflowQueue();

  order.forEach((block, i) => {
    block.order = i;
  });

  const logThisRun = logging && process.env["TYPEFLOW_FUNC"] === func.fullName;

  if (logThisRun) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockEvents(block);
      printBlockTrailer(block);
    });
  }

  function memberDeclInfo(
    blockState: TypeState,
    decl: Extract<EventDecl, { type: "MemberDecl" }>,
    clearEquiv: boolean,
    newValue?: ExactOrUnion | undefined
  ): [ExactOrUnion, boolean] | null {
    const baseType = getStateType(blockState, decl.base);
    const typePath: ExactOrUnion[] = [baseType];
    let next: ExactOrUnion | null;
    let updateAny = false;
    for (let i = 0, l = decl.path.length - 1; i <= l; i++) {
      let cur = typePath.pop()!;
      const me = decl.path[i];
      next = null;
      if (!me.computed) {
        const value = getObjectValue(cur);
        if (i === l && newValue) {
          next = newValue;
        } else if (value && hasProperty(value.obj, me.property.name)) {
          next = value.obj[me.property.name];
        } else {
          const trueDecls = findObjectDeclsByProperty(istate, cur, me);
          if (
            !trueDecls ||
            some(trueDecls, (decl) => decl.type !== "ClassDeclaration")
          ) {
            return null;
          }
          cur = refineObjectTypeByDecls(istate, cur, trueDecls);
          next = findNextObjectType(istate, trueDecls, me);
        }
      } else {
        if (cur.type & (TypeTag.Module | TypeTag.Class | TypeTag.Object)) {
          next = {
            type: TypeTag.Any,
          };
          if (newValue && !updateAny) {
            updateAny = true;
          }
        } else {
          if (cur.type & TypeTag.Array) {
            const avalue = getUnionComponent(cur, TypeTag.Array) || {
              type: TypeTag.Any,
            };
            if (next) {
              unionInto((next = cloneType(next)), avalue);
            } else {
              next = avalue;
            }
          }
          if (cur.type & TypeTag.Dictionary) {
            const dvalue = getUnionComponent(cur, TypeTag.Dictionary)
              ?.value || {
              type: TypeTag.Any,
            };
            if (next) {
              unionInto((next = cloneType(next)), dvalue);
            } else {
              next = dvalue;
            }
          }
          if (i === l && newValue) {
            if (next) {
              unionInto((next = cloneType(next)), newValue);
            } else {
              next = newValue;
            }
          }
        }
      }
      if (!next) return null;
      typePath.push(cur);
      typePath.push(next);
    }
    for (let i = decl.path.length; i--; ) {
      const me = decl.path[i];
      const property = typePath.pop()!;
      let object = typePath.pop()!;
      if (!me.computed) {
        const value = getObjectValue(object);
        if (value) {
          if (value.obj && hasProperty(value.obj, me.property.name)) {
            const prevProp = value.obj[me.property.name];
            if (!subtypeOf(prevProp, property)) {
              object = cloneType(object);
              const newValue = { klass: value.klass, obj: { ...value.obj } };
              newValue.obj[me.property.name] = intersection(prevProp, property);
              setUnionComponent(object, TypeTag.Object, newValue);
            }
          } else {
            const obj = value.obj ? { ...value.obj } : {};
            obj[me.property.name] = property;
            object = cloneType(object);
            setUnionComponent(object, TypeTag.Object, {
              klass: value.klass,
              obj,
            });
          }
        }
      } else {
        if (object.type & TypeTag.Array) {
          const avalue = getUnionComponent(object, TypeTag.Array);
          if (!avalue || !subtypeOf(property, avalue)) {
            object = cloneType(object);
            setUnionComponent(object, TypeTag.Array, property);
          }
        }
        if (object.type & TypeTag.Dictionary) {
          const dvalue = getUnionComponent(object, TypeTag.Dictionary);
          if (!dvalue || !subtypeOf(property, dvalue.value)) {
            object = cloneType(object);
            setUnionComponent(object, TypeTag.Dictionary, {
              key: dvalue?.key || { type: TypeTag.Any },
              value: property,
            });
          }
        }
      }
      typePath.push(object);
    }
    setStateEvent(blockState, decl.base, typePath[0], false);
    return [next!, updateAny];
  }

  function typeConstraint(decls: TypeStateKey): ExactOrUnion {
    return reduce(
      decls,
      (cur, decl) => {
        if (decl.type === "Identifier" || decl.type === "BinaryExpression") {
          // It looks like this can happen due to catch clauses
          // throw new Error(`Internal error: Unexpected function parameter`);
          unionInto(cur, { type: TypeTag.Any });
          return cur;
        }
        unionInto(
          cur,
          decl.type === "Literal"
            ? typeFromLiteral(decl)
            : typeFromTypeStateNode(state, decl, true)
        );
        return cur;
      },
      { type: TypeTag.Never }
    );
  }

  function setStateEvent(
    blockState: TypeState,
    decl: EventDecl,
    value: ExactOrUnion,
    clearEquiv: boolean
  ) {
    if (
      Array.isArray(decl) ||
      (decl.type !== "MemberDecl" && decl.type !== "Unknown")
    ) {
      if (!clearEquiv) {
        const v = blockState.get(decl);
        if (v?.equivSet) {
          blockState.set(decl, { ...v, curType: value });
          return;
        }
      } else {
        removeEquiv(blockState, decl);
      }
      blockState.set(decl, { curType: value });
      return;
    }
    if (decl.type === "Unknown") {
      return;
    }
    return memberDeclInfo(blockState, decl, clearEquiv, value)?.[1];
  }

  function getStateType(blockState: TypeState, decl: EventDecl): ExactOrUnion {
    return getStateEntry(blockState, decl).curType;
  }

  function getStateEntry(
    blockState: TypeState,
    decl: EventDecl
  ): TypeStateValue {
    if (
      Array.isArray(decl) ||
      (decl.type !== "MemberDecl" && decl.type !== "Unknown")
    ) {
      let tsVal = blockState.get(decl);
      if (!tsVal) {
        tsVal = { curType: typeConstraint(decl) };
        blockState.set(decl, tsVal);
      }
      return tsVal;
    }

    if (decl.type === "Unknown") {
      return { curType: { type: TypeTag.Never } };
    }

    const info = memberDeclInfo(blockState, decl, false);
    return { curType: info ? info[0] : { type: TypeTag.Any } };
  }

  const blockStates: TypeState[] = [];
  const blockVisits: number[] = [];
  const typeMap = new Map<mctree.Node, ExactOrUnion>();
  const istate: InterpState = {
    state,
    typeMap,
    stack: [],
    func,
  };

  const modifiableDecl = (
    decls: TypeStateKey,
    callees?: FunctionStateNode | FunctionStateNode[] | null
  ) =>
    some(
      decls,
      (decl) =>
        decl.type === "VariableDeclarator" &&
        decl.node.kind === "var" &&
        !isLocal(decl) &&
        (!callees ||
          some(callees, (callee) => functionMayModify(state, callee, decl)))
    );

  const mergeSuccState = (top: TypeFlowBlock, curState: TypeState) => {
    top.succs?.forEach((succ: TypeFlowBlock) => {
      if (succ.order == null) {
        throw new Error("Unreachable block was visited");
      }
      if (mergeTypeState(blockStates, blockVisits, succ.order, curState)) {
        queue.enqueue(succ);
      }
    });
  };

  function handleMod(
    curState: TypeState,
    calleeObjDecl: EventDecl,
    callees: FunctionStateNode | FunctionStateNode[] | undefined | null,
    node: mctree.CallExpression
  ) {
    const calleeObj = getStateType(curState, calleeObjDecl);
    return every(callees, (callee) => {
      const info = sysCallInfo(callee);
      if (!info) return false;
      const result = info(callee, calleeObj, () =>
        node.arguments.map((arg) => evaluateExpr(state, arg, typeMap).value)
      );
      if (result.calleeObj) {
        setStateEvent(curState, calleeObjDecl, result.calleeObj, false);
      }
      return true;
    });
  }

  function handleFlowEvent(
    event: FlowEvent,
    top: TypeFlowBlock,
    curState: TypeState
  ) {
    const fixTypes = (
      equal: boolean,
      left: ExactOrUnion | undefined,
      right: ExactOrUnion | undefined,
      leftDecl: EventDecl,
      rightDecl: EventDecl | null
    ): TypeState | null | false => {
      if (!left || !right) return null;
      if (equal) {
        let leftr = restrictByEquality(right, left);
        if (leftr.type === TypeTag.Never) {
          if (missingNullWorkaround && right.type & TypeTag.Null) {
            // Its tempting to set leftr = {type:TypeTag.Null} here,
            // but that would add Null to left's type when we reconverge
            // which seems like its suboptimal.
            leftr = left;
          } else {
            return false;
          }
        }
        const tmpState = new Map(curState);
        setStateEvent(tmpState, leftDecl, leftr, false);
        if (rightDecl) {
          let rightr = restrictByEquality(left, right);
          if (rightr.type === TypeTag.Never) {
            if (missingNullWorkaround && left.type & TypeTag.Null) {
              // see comment for left above.
              rightr = right;
            } else {
              return false;
            }
          }
          setStateEvent(tmpState, rightDecl, rightr, false);
        }
        return tmpState;
      }
      if (
        isExact(right) &&
        right.type & SingleTonTypeTagsConst &&
        left.type & right.type
      ) {
        // left is not equal to right, and right is one of the
        // singleton types; so we can remove that type from left.
        const singletonRemoved = cloneType(left);
        singletonRemoved.type -= right.type;
        if (singletonRemoved.type === TypeTag.Never) return false;
        const tmpState = new Map(curState);
        setStateEvent(tmpState, leftDecl, singletonRemoved, false);
        return tmpState;
      }
      return null;
    };
    const apply = (truthy: boolean) => {
      switch (event.kind) {
        case FlowKind.LEFT_EQ_RIGHT_DECL:
        case FlowKind.LEFT_NE_RIGHT_DECL: {
          const left = getStateType(curState, event.left);
          const right = getStateType(curState, event.right_decl);
          return fixTypes(
            truthy === (event.kind === FlowKind.LEFT_EQ_RIGHT_DECL),
            left,
            right,
            event.left,
            event.right_decl
          );
        }
        case FlowKind.LEFT_EQ_RIGHT_NODE:
        case FlowKind.LEFT_NE_RIGHT_NODE: {
          const left = getStateType(curState, event.left);
          const right = evaluate(istate, event.right_node).value;
          return fixTypes(
            truthy === (event.kind === FlowKind.LEFT_EQ_RIGHT_NODE),
            left,
            right,
            event.left,
            null
          );
        }
        case FlowKind.LEFT_TRUTHY:
        case FlowKind.LEFT_FALSEY: {
          const left = getStateType(curState, event.left);
          if (!left) return null;
          if (truthy === (event.kind === FlowKind.LEFT_TRUTHY)) {
            if (left.type & (TypeTag.Null | TypeTag.False)) {
              // left evaluates as true, so remove null, false
              const singletonRemoved = cloneType(left);
              singletonRemoved.type &= ~(TypeTag.Null | TypeTag.False);
              if (singletonRemoved.type === TypeTag.Never) return false;
              const tmpState = new Map(curState);
              setStateEvent(tmpState, event.left, singletonRemoved, false);
              return tmpState;
            }
          } else {
            const nonNullRemoved = intersection(left, {
              type:
                TypeTag.Null |
                TypeTag.False |
                TypeTag.Number |
                TypeTag.Long |
                TypeTag.Enum,
            });
            if (nonNullRemoved.type === TypeTag.Never) return false;
            const tmpState = new Map(curState);
            setStateEvent(tmpState, event.left, nonNullRemoved, false);
            return tmpState;
          }
          break;
        }
        case FlowKind.INSTANCEOF:
        case FlowKind.NOTINSTANCE: {
          const left = getStateType(curState, event.left);
          let right = getStateType(curState, event.right_decl);
          if (!left || !right) break;
          if (isExact(right) && right.type === TypeTag.Class) {
            right = { type: TypeTag.Object, value: { klass: right } };
          }
          let result: ExactOrUnion | null = null;
          if (truthy === (event.kind === FlowKind.INSTANCEOF)) {
            result = intersection(left, right);
          } else if (isExact(right)) {
            if (right.type === TypeTag.Object) {
              if (right.value == null) {
                result = cloneType(left);
                clearValuesUnder(
                  result,
                  ObjectLikeTagsConst | TypeTag.Object,
                  true
                );
              } else if (left.type & TypeTag.Object) {
                const leftValue = getObjectValue(left);
                if (leftValue) {
                  const rightDecls = getStateNodeDeclsFromType(
                    state,
                    right
                  ) as ClassStateNode[];
                  const leftDecls = getStateNodeDeclsFromType(state, {
                    type: TypeTag.Object,
                    value: leftValue,
                  }) as ClassStateNode[];
                  const leftReduced = leftDecls.filter(
                    (ldec) =>
                      !rightDecls.every(
                        (rdec) =>
                          ldec == rdec ||
                          (ldec.type === "ClassDeclaration" &&
                            getSuperClasses(ldec)?.has(rdec))
                      )
                  );
                  if (leftReduced.length != leftDecls.length) {
                    result = cloneType(left);
                    clearValuesUnder(result, TypeTag.Object, true);
                    if (leftReduced.length) {
                      unionInto(result, {
                        type: TypeTag.Object,
                        value: {
                          klass: { type: TypeTag.Class, value: leftReduced },
                        },
                      });
                    }
                  }
                }
              }
            } else if (
              right.type & ObjectLikeTagsConst &&
              right.type & left.type
            ) {
              result = cloneType(left);
              clearValuesUnder(result, right.type, true);
            }
          }
          if (result) {
            const tmpState = new Map(curState);
            setStateEvent(tmpState, event.left, result, false);
            return tmpState;
          }
        }
      }
      return null;
    };

    const setTruthy =
      event.kind !== FlowKind.LEFT_FALSEY &&
      event.kind !== FlowKind.LEFT_TRUTHY;
    if (setTruthy) {
      typeMap.delete(event.node);
    }
    const sTrue = apply(true);
    const sFalse = apply(false);
    if (sTrue == null && sFalse == null) {
      return false;
    }

    const trueSucc = top.succs![0] as TypeFlowBlock;
    const falseSucc = top.succs![1] as TypeFlowBlock;
    if (sTrue === false) {
      setTruthy && typeMap.set(event.node, { type: TypeTag.False });
    } else {
      if (logThisRun) {
        console.log(`  Flow (true): merge to ${trueSucc.order || -1}`);
        printBlockState(top, sTrue || curState, "    >true ");
      }
      if (
        mergeTypeState(
          blockStates,
          blockVisits,
          trueSucc.order!,
          sTrue || curState
        )
      ) {
        queue.enqueue(trueSucc);
      }
    }
    if (sFalse === false) {
      setTruthy && typeMap.set(event.node, { type: TypeTag.True });
    } else {
      if (logThisRun) {
        console.log(`  Flow (false): merge to: ${falseSucc.order || -1}`);
        printBlockState(top, sFalse || curState, "    >false ");
      }
      if (
        mergeTypeState(
          blockStates,
          blockVisits,
          falseSucc.order!,
          sFalse || curState
        )
      ) {
        queue.enqueue(falseSucc);
      }
    }
    return true;
  }

  const nodeEquivs = new Map<
    mctree.Node,
    { decl: EventDecl; equiv: Array<EventDecl> }
  >();
  const localDecls = new Map<string, Set<EventDecl>>();
  const localConflicts = new Set<EventDecl>();
  const selfAssignments = new Set<mctree.Node>();

  const processEvent = (
    top: TypeFlowBlock,
    curState: TypeState,
    event: Event,
    skipMerge: boolean
  ) => {
    if (!skipMerge && event.mayThrow && top.exsucc) {
      if (
        mergeTypeState(
          blockStates,
          blockVisits,
          (top.exsucc as TypeFlowBlock).order!,
          curState
        )
      ) {
        queue.enqueue(top.exsucc);
      }
    }
    switch (event.type) {
      case "kil": {
        const curEntry = getStateEntry(curState, event.decl);
        if (curEntry.equivSet) {
          removeEquiv(curState, event.decl);
        }
        curState.delete(event.decl);
        break;
      }
      case "ref": {
        const curEntry = getStateEntry(curState, event.decl);
        typeMap.set(event.node, curEntry.curType);
        nodeEquivs.delete(event.node);
        if (curEntry.equivSet) {
          const equiv = Array.from(
            getEquivSet(curState, event.decl as TypeStateKey)
          ).filter((decl) => decl !== event.decl && declIsLocal(decl));
          if (equiv.length) {
            nodeEquivs.set(event.node, {
              decl: event.decl,
              equiv,
            });
          }
        }
        if (logThisRun) {
          console.log(
            `  ${describeEvent(event)} == ${display(curEntry.curType)}`
          );
        }
        break;
      }
      case "mod": {
        if (logThisRun) {
          console.log(`  ${describeEvent(event)}`);
        }
        let callees:
          | FunctionStateNode
          | FunctionStateNode[]
          | undefined
          | null = undefined;
        if (event.calleeDecl) {
          const calleeType = getStateType(curState, event.calleeDecl);
          if (hasValue(calleeType) && calleeType.type === TypeTag.Function) {
            callees = calleeType.value;
          } else {
            callees = findCalleesByNode(state, event.node as mctree.Expression);
          }
        }
        if (callees === undefined && event.callees !== undefined) {
          callees = event.callees;
        }
        if (event.calleeObj) {
          if (
            handleMod(
              curState,
              event.calleeObj,
              callees,
              event.node as mctree.CallExpression
            )
          ) {
            break;
          }
        }
        curState.forEach((tsv, decl) => {
          let type = tsv.curType;
          if (callees === undefined || modifiableDecl(decl, callees)) {
            if (tsv.equivSet) {
              removeEquiv(curState, decl);
            }
            curState.set(decl, { curType: typeConstraint(decl) });
          } else if (
            type.value != null &&
            !every(callees, (callee) => callee.info === false)
          ) {
            if (type.type & TypeTag.Object) {
              const odata = getObjectValue(tsv.curType);
              if (odata?.obj) {
                type = cloneType(type);
                const newData = { klass: odata.klass };
                setUnionComponent(type, TypeTag.Object, newData);
                curState.set(decl, { ...tsv, curType: type });
              }
            }
          }
        });
        break;
      }
      case "def": {
        const lval =
          event.node.type === "UpdateExpression"
            ? event.node.argument
            : event.node.type === "AssignmentExpression"
            ? event.node.left
            : null;
        if (lval) {
          const beforeType = getStateType(curState, event.decl);
          if (beforeType) {
            typeMap.set(lval, beforeType);
          }
        }
        const expr: mctree.Expression | null =
          event.node.type === "VariableDeclarator"
            ? event.node.init || null
            : event.node;
        const type = expr
          ? evaluate(istate, expr).value
          : { type: TypeTag.Any };
        if (setStateEvent(curState, event.decl, type, true)) {
          // we wrote through a computed member expression
          // which might have been a Class, Module or Object.
          // That could have affected anything...
          curState.forEach((value, decls) => {
            if (
              some(
                decls,
                (decl) =>
                  decl.type === "VariableDeclarator" &&
                  decl.node.kind === "var" &&
                  !isLocal(decl)
              )
            ) {
              if (value.equivSet) {
                removeEquiv(curState, decls);
              }
              curState.set(decls, { curType: typeConstraint(decls) });
            }
          });
        }
        if (event.rhs) {
          const selfAssign = addEquiv(
            curState,
            event.rhs as TypeStateKey,
            event.decl as TypeStateKey
          );
          if (event.node.type === "AssignmentExpression") {
            if (selfAssign) {
              // rhs and lhs are identical
              selfAssignments.add(event.node);
            } else {
              selfAssignments.delete(event.node);
            }
          }
        }
        if (declIsLocal(event.decl)) {
          const name = localDeclName(event.decl);
          const locals = localDecls.get(name);
          if (!locals) {
            localDecls.set(name, new Set([event.decl]));
          } else {
            locals.forEach((local) => {
              if (local !== event.decl && curState.has(local as TypeStateKey)) {
                localConflicts.add(local);
              }
            });
            locals.add(event.decl);
          }
        }
        if (logThisRun) {
          console.log(`  ${describeEvent(event)} := ${display(type)}`);
        }
        break;
      }
      case "flw": {
        if (event !== top.events?.[top.events.length - 1]) {
          throw new Error("Flow event was not last in block");
        }
        if (top.succs?.length !== 2) {
          throw new Error(
            `Flow event had ${
              top.succs?.length || 0
            } successors (should have 2)`
          );
        }
        if (logThisRun) {
          console.log(
            `  ${describeEvent(event)} : ${
              !Array.isArray(event.left) && event.left.type === "MemberDecl"
                ? `${display(
                    curState.get(event.left.base)?.curType || {
                      type: TypeTag.Any,
                    }
                  )} :: `
                : ""
            }${display(getStateType(curState, event.left))}`
          );
        }
        if (!skipMerge && handleFlowEvent(event, top, curState)) {
          return true;
        }
      }
    }
    return false;
  };

  blockStates[0] = new Map();
  const head = blockStates[0];
  // set the parameters to their initial types
  func.node.params.forEach((param) => {
    setStateEvent(
      head,
      param,
      param.type === "BinaryExpression"
        ? typeFromTypespec(state, param.right)
        : { type: TypeTag.Any },
      false
    );
  });

  queue.enqueue(order[0]);

  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }
    if (!blockStates[top.order]) continue;
    const curState = new Map(blockStates[top.order]);
    if (logThisRun) {
      printBlockHeader(top);
      printBlockState(top, curState);
    }
    let successorsHandled = false;
    if (top.events) {
      for (let i = 0; i < top.events.length; i++) {
        const event = top.events[i];
        if (processEvent(top, curState, event, false)) {
          successorsHandled = true;
        }
      }
    }

    if (!successorsHandled) {
      if (logThisRun) {
        console.log(
          `  merge to: ${map<TypeFlowBlock, number>(
            top.succs,
            (succ) => succ.order || -1
          ).join(", ")}`
        );
      }

      mergeSuccState(top, curState);
    }
    if (logThisRun) {
      printBlockTrailer(top);
    }
  }

  if (logThisRun) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockState(block, blockStates[block.order!]);
      printBlockEvents(block, typeMap);
      printBlockTrailer(block);
    });

    console.log("====== TypeMap =====");
    typeMap.forEach((value, key) => {
      console.log(
        `${formatAst(key)} = ${display(value)} ${
          key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""
        }`
      );
    });
    console.log("====== EquivMap =====");
    nodeEquivs.forEach((value, key) => {
      console.log(
        `${formatAst(key)} = [${value.equiv.map((equiv) =>
          tsKey(equiv as TypeStateKey)
        )}] ${key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""}`
      );
    });
  }

  if (optimizeEquivalencies && (nodeEquivs.size || selfAssignments.size)) {
    const nodeEquivDeclInfo = new Map<
      EventDecl,
      { decl: EventDecl; cost: number; numAssign: number; numEquiv: number }
    >();
    nodeEquivs.forEach(
      (value) =>
        localConflicts.has(value.decl) ||
        nodeEquivDeclInfo.has(value.decl) ||
        nodeEquivDeclInfo.set(value.decl, {
          decl: value.decl,
          cost: declIsLocal(value.decl)
            ? Array.isArray(value.decl) ||
              value.decl.type === "VariableDeclarator"
              ? 3
              : 1
            : 4,
          numAssign: 0,
          numEquiv: 0,
        })
    );
    nodeEquivs.forEach((value) =>
      value.equiv.forEach((equiv) => {
        if (!localConflicts.has(equiv)) {
          const info = nodeEquivDeclInfo.get(equiv);
          if (info) info.numEquiv++;
        }
      })
    );

    order.forEach(
      (block, i) =>
        blockStates[i] &&
        block.events?.forEach((event) => {
          if (event.type === "def" && event.rhs) {
            const rhs = nodeEquivDeclInfo.get(event.rhs);
            if (rhs) {
              rhs.numAssign++;
            }
            const def = nodeEquivDeclInfo.get(event.decl);
            if (def) {
              def.numAssign--;
            }
          }
        })
    );
    traverseAst(func.node.body!, null, (node) => {
      if (selfAssignments.has(node)) {
        return withLoc(
          { type: "Literal", value: null, raw: "null" },
          node,
          node
        );
      }
      const equiv = nodeEquivs.get(node);
      if (!equiv || localConflicts.has(equiv.decl)) return null;
      const curInfo = nodeEquivDeclInfo.get(equiv.decl);
      if (!curInfo) {
        throw new Error(
          `Missing info for equiv ${formatAst(node)} = [${equiv.equiv
            .map((decl) => tsKey(decl as TypeStateKey))
            .join(", ")}]`
        );
      }
      const rep = equiv.equiv.reduce((cur, decl) => {
        if (localConflicts.has(decl)) return cur;
        let info = nodeEquivDeclInfo.get(decl);
        if (!info) {
          // this is a one way equivalency. There are
          // no references to decl while equiv.decl
          // is equivalent to it. eg
          //
          //   var b = a;
          //   ... use b but not a ...
          //
          const cost =
            Array.isArray(decl) || decl.type === "VariableDeclarator" ? 2 : 0;
          info = { cost, numAssign: 0, decl, numEquiv: 0 };
        }
        if (info.cost > 3) {
          throw new Error(`Replacement decl is not a local!`);
        }
        if (
          info.cost < cur.cost ||
          (info.cost === cur.cost &&
            (info.numAssign > cur.numAssign ||
              (info.numAssign === cur.numAssign &&
                info.numEquiv > cur.numEquiv)))
        ) {
          return info;
        }
        return cur;
      }, curInfo);
      if (rep === curInfo) return null;
      const name = reduce(
        rep.decl,
        (cur, decl) => (decl.type === "VariableDeclarator" ? decl.name : cur),
        null as string | null
      );
      if (!name) return null;
      if (logThisRun) {
        console.log(
          `Replacing ${formatAst(node)} with ${name} at ${sourceLocation(
            node.loc
          )}`
        );
      }
      const replacement = withLoc({ type: "Identifier", name }, node, node);
      const tm = typeMap.get(node);
      if (tm) typeMap.set(replacement, tm);
      return replacement;
    });
  }

  return istate;
}
