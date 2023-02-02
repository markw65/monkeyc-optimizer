import { mctree } from "@markw65/prettier-plugin-monkeyc";
import * as assert from "node:assert";
import {
  formatAst,
  formatAstLongLines,
  getSuperClasses,
  hasProperty,
  isClassVariable,
  isLocal,
  lookupNext,
  traverseAst,
} from "./api";
import { withLoc, withLocDeep } from "./ast";
import { getPostOrder } from "./control-flow";
import {
  buildDataFlowGraph,
  DataflowQueue,
  DefEvent,
  Event,
  EventDecl,
  FlowEvent,
  FlowKind,
  ModEvent,
  RefEvent,
} from "./data-flow";
import { findCalleesByNode, functionMayModify } from "./function-info";
import { inlineRequested } from "./inliner";
import {
  ClassStateNode,
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNodeAttributes,
  StateNodeDecl,
} from "./optimizer-types";
import { couldBeShallow } from "./type-flow/could-be";
import {
  CopyPropStores,
  eliminateDeadStores,
  findDeadStores,
} from "./type-flow/dead-store";
import { evaluate, evaluateExpr, InterpState } from "./type-flow/interp";
import { sysCallInfo } from "./type-flow/interp-call";
import {
  intersection,
  restrictByEquality,
} from "./type-flow/intersection-type";
import { subtypeOf } from "./type-flow/sub-type";
import {
  declIsLocal,
  declIsNonLocal,
  describeEvent,
  findNextObjectType,
  findObjectDeclsByProperty,
  isTypeStateKey,
  localDeclName,
  printBlockEvents,
  printBlockHeader,
  printBlockTrailer,
  refineObjectTypeByDecls,
  sourceLocation,
  tsKey,
  TypeFlowBlock,
  TypeStateKey,
} from "./type-flow/type-flow-util";
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
  SingletonTypeTagsConst,
  typeFromLiteral,
  typeFromTypespec,
  typeFromTypeStateNode,
  typeFromTypeStateNodes,
  TypeTag,
} from "./type-flow/types";
import { clearValuesUnder, unionInto, widenType } from "./type-flow/union-type";
import { every, map, reduce, some } from "./util";

const logging = true;

const enum UpdateKind {
  None,
  Inner,
  Reassign,
}

// Toybox APIs often fail to include Null when they should.
// To avoid over zealous optimizations, we don't optimize
// away any Null checks for now.
export const missingNullWorkaround = true;

export type NodeEquivMap = Map<
  mctree.Node,
  { decl: EventDecl; equiv: Array<EventDecl> }
>;

type CopyPropMap = Map<mctree.Node, mctree.Node | false>;

function loggingEnabledFor(env: string, func: FunctionStateNode) {
  const pattern = process.env[env];
  if (!pattern) return false;
  const match = pattern.match(/^\/(.*)\/(i?)$/);
  if (match) {
    return new RegExp(match[1], match[2]).test(func.fullName);
  }
  return pattern === func.fullName;
}

export function buildTypeInfo(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  optimizeEquivalencies: boolean
) {
  if (!func.node.body || !func.stack) return;
  const logThisRun = logging && loggingEnabledFor("TYPEFLOW_FUNC", func);
  while (true) {
    const { graph } = buildDataFlowGraph(state, func, () => false, false, true);
    let copyPropStores: CopyPropStores | undefined;
    if (optimizeEquivalencies) {
      const result = eliminateDeadStores(state, func, graph, logThisRun);
      if (result.changes) {
        /*
         * eliminateDeadStores can change the control flow graph,
         * so we need to recompute it if it did anything.
         */
        continue;
      }
      if (result.copyPropStores.size) {
        copyPropStores = result.copyPropStores;
      }
    }
    const result = propagateTypes(
      { ...state, stack: func.stack },
      func,
      graph,
      optimizeEquivalencies,
      copyPropStores,
      logThisRun
    );

    if (!result.redo) {
      return result.istate;
    }
  }
}

export function buildConflictGraph(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  if (!func.node.body || !func.stack) return;
  const logThisRun = logging && loggingEnabledFor("CONFLICT_FUNC", func);
  const { graph, identifiers } = buildDataFlowGraph(
    state,
    func,
    () => false,
    false,
    true
  );

  const { nodeEquivs } = propagateTypes(
    { ...state, stack: func.stack },
    func,
    graph,
    false,
    undefined,
    logThisRun
  );
  const { locals, localConflicts } = findDeadStores(
    func,
    graph,
    nodeEquivs,
    logThisRun
  );
  return { graph, localConflicts, locals, identifiers, logThisRun };
}

// A path thats associated with a TypeStateKey
// ie there's a MemberDecl with the TypeStateKey as
// its base.
// The types are the types seen when the MemberDecl was
// evaluated, and we keep them around so we know when
// to invalidate this entry (or at least, remove some of
// its type specializations)
type AssocPath = Array<{ name: string | null; type: ExactOrUnion }>;

type CopyPropItem = {
  event: DefEvent;
  contained: Map<TypeStateKey | null, Array<RefEvent | ModEvent>>;
};
type TypeStateValue = {
  curType: ExactOrUnion;
  equivSet?: { next: TypeStateKey };
  // set of paths used by MemberDecls whose base
  // points to this entry.
  assocPaths?: Set<string>;
  // used to implement single-use copy-prop
  // ie
  //   var x = y + z;
  //   foo(x); // only use of x
  // becomes
  //   foo(y + z);
  copyPropItem?: CopyPropItem;
};

type AffectedDecls = Set<TypeStateKey>;

type TypeStateMap = Map<TypeStateKey, TypeStateValue>;

type TypeState = {
  // Ownership model:
  // The map itself is owned by this TypeState. The entries are shared
  // though, so any changes need to be to new copies.
  map: TypeStateMap;
  visits: number;
  // For each entry in map with assocPaths, we provide a mechanism to go
  // from any of its path components back to itself.
  // So for example if there is an entry with a path x.y.z, and key k1, and
  // another entry with path u.x and key k2, we'll end up with
  // {
  //   x => [{k1, "x.y.z"}, {k2, "u.x"}],
  //   y => [{k1, "x.y.z"}],
  //   z => [{k1, "x.y.z"}],
  //   u => [{k2, "u.v"}],
  // }
  // This means that when we see a def to foo.bar.x, we can lookup x in this
  // map, and find that the assignment to foo.bar.x might affect k1:x.y.z,
  // and it might affect k2:u.x; so we only have to check those two, rather
  // than search every entry in the map.
  //
  // Note that trackedMemberDecls.get(s).get(k) should always be a subset
  // of map.get(k).assocPaths.
  //
  // Ownership model:
  // Never shared. Always safe to update in place
  trackedMemberDecls?: Map<string, AffectedDecls>;

  // liveCopyPropEvents.get(decl) is a set of decls, all of which
  // have copyPropItems whose contained events depend on decl.
  // This means that when we see a def or kill event for decl,
  // we can quickly find all the map entries whose
  // copyPropEvents depend on decl.
  //
  // Ownership model:
  // Fully owned by this TypeState. Always safe to modify in place.
  liveCopyPropEvents?: Map<EventDecl | null, Set<TypeStateKey>>;
};

function addEquiv(ts: TypeStateMap, key: TypeStateKey, equiv: TypeStateKey) {
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

function removeEquiv(ts: TypeStateMap, equiv: TypeStateKey) {
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

function getEquivSet(ts: TypeStateMap, k: TypeStateKey) {
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
  } while (s !== k);
  return keys;
}

function intersectEquiv(ts1: TypeStateMap, ts2: TypeStateMap, k: TypeStateKey) {
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
  } while (s !== k);
  return ret;
}

function clearAssocPaths(
  blockState: TypeState,
  decl: TypeStateKey,
  v: TypeStateValue
) {
  if (v.assocPaths?.size) {
    assert(blockState.trackedMemberDecls);
    v.assocPaths.forEach((assocPath) => {
      assocPath.split(".").forEach((pathItem) => {
        const tmd = blockState.trackedMemberDecls?.get(pathItem);
        if (tmd) {
          tmd.delete(decl);
        }
      });
    });
  }
}

function cloneTypeState(blockState: TypeState): TypeState {
  const { map, trackedMemberDecls, liveCopyPropEvents, ...rest } = blockState;
  const clone: TypeState = { map: new Map(map), ...rest };
  if (trackedMemberDecls) {
    clone.trackedMemberDecls = new Map();
    trackedMemberDecls.forEach((value, key) => {
      clone.trackedMemberDecls!.set(key, new Set(value));
    });
  }
  if (liveCopyPropEvents) {
    clone.liveCopyPropEvents = new Map();
    liveCopyPropEvents.forEach((value, key) => {
      clone.liveCopyPropEvents?.set(key, new Set(value));
    });
  }
  return clone;
}

function addTrackedMemberDecl(
  blockState: TypeState,
  key: TypeStateKey,
  assocKey: string
) {
  if (!blockState.trackedMemberDecls) {
    blockState.trackedMemberDecls = new Map();
  }
  assocKey.split(".").forEach((pathItem) => {
    const entries = blockState.trackedMemberDecls!.get(pathItem);
    if (!entries) {
      blockState.trackedMemberDecls!.set(pathItem, new Set([key]));
      return;
    }
    entries.add(key);
  });
}

function addCopyPropEvent(blockState: TypeState, item: CopyPropItem) {
  if (!blockState.liveCopyPropEvents) {
    blockState.liveCopyPropEvents = new Map();
  }
  const liveCopyPropEvents = blockState.liveCopyPropEvents;
  const decl = item.event.decl;
  assert(declIsLocal(decl));
  let tov = blockState.map.get(decl);
  assert(tov);
  if (tov.copyPropItem !== item) {
    tov = { ...tov, copyPropItem: item };
    blockState.map.set(decl, tov);
  }
  item.contained.forEach((value, key) => {
    const decls = liveCopyPropEvents.get(key);
    if (!decls) {
      liveCopyPropEvents.set(key, new Set([decl]));
    } else {
      decls.add(decl);
    }
  });
}

function clearCopyProp(blockState: TypeState, item: CopyPropItem) {
  const liveCopyPropEvents = blockState.liveCopyPropEvents;
  assert(liveCopyPropEvents);
  const itemDecl = item.event.decl as TypeStateKey;
  item.contained.forEach((event, decl) => {
    const decls = liveCopyPropEvents.get(decl);
    assert(decls && decls.has(itemDecl));
    decls.delete(itemDecl);
  });
}

function copyPropFailed(
  blockState: TypeState,
  item: CopyPropItem,
  nodeCopyProp: CopyPropMap
) {
  clearCopyProp(blockState, item);
  const ref = nodeCopyProp.get(item.event.node);
  if (ref) {
    nodeCopyProp.delete(ref);
  }
  nodeCopyProp.set(item.event.node, false);
}

function clearRelatedCopyPropEvents(
  blockState: TypeState,
  decl: EventDecl | null,
  nodeCopyProp: CopyPropMap
) {
  blockState.liveCopyPropEvents
    ?.get(decl as TypeStateKey)
    ?.forEach((cpDecl) => {
      let value = blockState.map.get(cpDecl);
      assert(value && value.copyPropItem);
      assert(
        Array.from(value.copyPropItem.contained).some(([key]) => {
          return decl === key;
        })
      );

      copyPropFailed(blockState, value.copyPropItem, nodeCopyProp);
      value = { ...value };
      delete value.copyPropItem;
      blockState.map.set(cpDecl, value);
    });
}

function validateTypeState(curState: TypeState) {
  curState.liveCopyPropEvents?.forEach((decls) =>
    decls.forEach((cpDecl) => {
      const value = curState.map.get(cpDecl);
      assert(value && value.copyPropItem);
    })
  );
  curState.trackedMemberDecls?.forEach((affected, key) => {
    affected.forEach((decl) => {
      const value = curState.map.get(decl);
      assert(value && value.assocPaths);
      if (
        !Array.from(value.assocPaths).some((path) =>
          `.${path}.`.includes(`.${key}.`)
        )
      ) {
        throw new Error("What");
      }
    });
  });
}

function mergeTypeState(
  blockStates: TypeState[],
  index: number,
  from: TypeState,
  nodeCopyProp: CopyPropMap
) {
  const to = blockStates[index];
  if (!to) {
    blockStates[index] = cloneTypeState(from);
    blockStates[index].visits = 1;
    return true;
  }
  const widen = ++to.visits > 10;

  // we'll rebuild these from scratch
  delete to.trackedMemberDecls;
  delete to.liveCopyPropEvents;

  let changes = false;
  to.map.forEach((tov, k) => {
    const fromv = from.map.get(k);
    if (!fromv) {
      changes = true;
      if (tov.equivSet) {
        removeEquiv(to.map, k);
      }
      to.map.delete(k);
      return;
    }
    if (tov.equivSet) {
      if (intersectEquiv(to.map, from.map, k)) {
        changes = true;
        tov = to.map.get(k)!;
      }
    }
    if (tov.assocPaths) {
      tov = { ...tov };
      if (!fromv.assocPaths) {
        changes = true;
        delete tov.assocPaths;
      } else {
        const assocPaths = new Set(tov.assocPaths);
        assocPaths.forEach((key) => {
          if (!fromv.assocPaths!.has(key)) {
            assocPaths.delete(key);
            changes = true;
          } else {
            addTrackedMemberDecl(to, k, key);
          }
        });
        if (assocPaths.size) {
          tov.assocPaths = assocPaths;
        } else {
          delete tov.assocPaths;
        }
      }
      to.map.set(k, tov);
    }
    // if both from and to have copyPropEvents, we can only
    // keep it if they're the same event.
    if (tov.copyPropItem) {
      if (tov.copyPropItem.event !== fromv.copyPropItem?.event) {
        const toProp = nodeCopyProp.get(tov.copyPropItem.event.node);
        if (toProp) {
          nodeCopyProp.delete(toProp);
        }
        nodeCopyProp.set(tov.copyPropItem.event.node, false);
        if (fromv.copyPropItem) {
          const fromProp = nodeCopyProp.get(fromv.copyPropItem.event.node);
          if (fromProp) {
            nodeCopyProp.delete(fromProp);
          }
          nodeCopyProp.set(fromv.copyPropItem.event.node, false);
        }
        tov = { ...tov };
        delete tov.copyPropItem;
        changes = true;
        to.map.set(k, tov);
      } else {
        assert(k === tov.copyPropItem.event.decl);
        addCopyPropEvent(to, tov.copyPropItem);
      }
    }
    if (widen) {
      if (subtypeOf(fromv.curType, tov.curType)) return;
      if (subtypeOf(tov.curType, fromv.curType)) {
        to.map.set(k, { ...tov, curType: fromv.curType });
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
    to.map.set(k, { ...tov, curType: result });
    changes = true;
  });
  return changes;
}

function tsEquivs(state: TypeStateMap, key: TypeStateKey) {
  const result: string[] = [];
  let s = key;
  do {
    result.push(tsKey(s));
    const next = state.get(s);
    assert(next && next.equivSet);
    s = next.equivSet.next;
  } while (s !== key);
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
  state.map.forEach((value, key) => {
    console.log(
      `${indent} - ${typeStateEntry(value, key)}${
        value.equivSet ? " " + tsEquivs(state.map, key) : ""
      }`
    );
  });
}

function updateAffected(
  blockState: TypeState,
  objectType: ExactOrUnion,
  baseDecl: TypeStateKey,
  assignedPath: string,
  affectedName: string,
  affected: AffectedDecls,
  assignedType: ExactOrUnion
) {
  affected.forEach((key) => {
    let droppedComponents = null as Set<string> | null;
    const entry = blockState.map.get(key);
    assert(entry && entry.assocPaths);
    let newEntry = entry;
    entry.assocPaths.forEach((path) => {
      if (key === baseDecl && path === assignedPath) {
        return;
      }
      const pathSegments = path.split(".");
      if (!pathSegments.includes(affectedName)) {
        return;
      }
      const assocPath: AssocPath = [];
      let type = entry.curType;
      for (let i = 0; i < pathSegments.length; i++) {
        const pathItem = pathSegments[i];
        assocPath.push({
          name: pathItem === "*" ? null : pathItem,
          type,
        });
        if (pathItem === affectedName && couldBeShallow(type, objectType)) {
          const newAssocKey = assocPath.map((av) => av.name ?? "*").join(".");
          if (newEntry === entry) {
            newEntry = { ...entry };
          }
          if (newAssocKey !== path) {
            newEntry.assocPaths = new Set(newEntry.assocPaths!);
            newEntry.assocPaths.delete(path);
            // the "extra" path components will also have entries
            // in blockState.trackedMemberDecls. Since they're gone
            // from here, we (may) need to remove them from there
            if (!droppedComponents) {
              droppedComponents = new Set();
            }
            while (++i < pathSegments.length) {
              droppedComponents.add(pathSegments[i]);
            }
            break;
          }
          const baseType = updateByAssocPath(assocPath, assignedType, true);
          newEntry.curType = baseType;
          break;
        }
        if (pathItem === "*") {
          const newType = { type: TypeTag.Never };
          if (type.type & TypeTag.Array) {
            const atype = getUnionComponent(type, TypeTag.Array);
            if (atype) {
              unionInto(newType, atype);
            }
          }
          if (type.type & TypeTag.Dictionary) {
            const dtype = getUnionComponent(type, TypeTag.Dictionary);
            if (dtype) {
              unionInto(newType, dtype.value);
            }
          }
          if (newType.type === TypeTag.Never) break;
          type = newType;
        } else {
          const objValue = getObjectValue(type);
          if (!objValue || !hasProperty(objValue.obj, pathItem)) {
            break;
          }
          type = objValue.obj[pathItem];
        }
      }
    });
    if (newEntry !== entry) {
      if (droppedComponents) {
        newEntry.assocPaths!.forEach((path) =>
          path
            .split(".")
            .forEach((pathComponent) =>
              droppedComponents!.delete(pathComponent)
            )
        );
        droppedComponents.forEach((pathComponent) =>
          blockState.trackedMemberDecls!.get(pathComponent)!.delete(key)
        );
      }
      blockState.map.set(key, newEntry);
    }
  });
}
function propagateTypes(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  optimizeEquivalencies: boolean,
  copyPropStores: CopyPropStores | undefined,
  logThisRun: boolean
) {
  // We want to traverse the blocks in reverse post order, in
  // order to propagate the "availability" of the types.
  const order = getPostOrder(graph).reverse() as TypeFlowBlock[];
  const queue = new DataflowQueue();

  let selfClassDecl: ClassStateNode | null = null;
  if (!(func.attributes & StateNodeAttributes.STATIC)) {
    const klass = func.stack?.[func.stack?.length - 1].sn;
    if (klass && klass.type === "ClassDeclaration") {
      selfClassDecl = klass;
    }
  }

  order.forEach((block, i) => {
    block.order = i;
  });

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
    newValue?: ExactOrUnion | undefined
  ): [ExactOrUnion, boolean] | null {
    const baseType = getStateType(blockState, decl.base);
    const typePath: ExactOrUnion[] = [baseType];
    let next = null as ExactOrUnion | null;
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
          const [objDecls, trueDecls] = findObjectDeclsByProperty(
            istate.state,
            cur,
            me
          );
          if (!objDecls) {
            return null;
          }
          cur = refineObjectTypeByDecls(istate, cur, objDecls);
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
    const assocValue: AssocPath = decl.path.map((me, i) => ({
      name: me.computed ? null : me.property.name,
      type: typePath[i],
    }));
    const assocKey = assocValue.map((av) => av.name ?? "*").join(".");
    const newType = updateByAssocPath(assocValue, next!, false);
    setStateEvent(
      blockState,
      decl.base,
      newType,
      newValue ? UpdateKind.Inner : UpdateKind.None
    );
    const tsv = { ...blockState.map.get(decl.base)! };
    tsv.assocPaths = new Set(tsv.assocPaths);
    tsv.assocPaths.add(assocKey);
    blockState.map.set(decl.base, tsv);
    addTrackedMemberDecl(blockState, decl.base, assocKey);
    if (newValue) {
      const baseElem = assocValue[decl.path.length - 1];
      if (baseElem.name) {
        const affected = blockState.trackedMemberDecls?.get(baseElem.name);
        if (affected) {
          updateAffected(
            blockState,
            baseElem.type,
            decl.base,
            assocKey,
            baseElem.name,
            affected,
            next!
          );
        }
      }
      if (selfClassDecl) {
        // Handle interference between the MemberDecl store
        // and the "self" object.
        const baseObj = getObjectValue(baseElem.type);
        if (
          baseObj &&
          baseObj.klass.type === TypeTag.Class &&
          some(
            baseObj.klass.value,
            (cls) =>
              cls === selfClassDecl ||
              getSuperClasses(cls)?.has(selfClassDecl!) ||
              getSuperClasses(selfClassDecl!)?.has(cls) ||
              false
          )
        ) {
          const last = decl.path[decl.path.length - 1];
          if (!last.computed) {
            const result = lookupNext(
              state,
              [{ parent: null, results: [selfClassDecl] }],
              "decls",
              last.property
            );
            if (result) {
              const decls: StateNodeDecl[] = result.flatMap(
                (lookupDef) => lookupDef.results
              );
              const doUpdate = (key: TypeStateKey, cur: TypeStateValue) => {
                const update = cloneType(cur.curType);
                unionInto(update, next!);
                setStateEvent(blockState, key, update, UpdateKind.None);
              };

              if (decls.length === 1) {
                const cur = blockState.map.get(decls[0]);
                cur && doUpdate(decls[0], cur);
              } else {
                blockState.map.forEach((cur, key) => {
                  if (Array.isArray(key) && key[0] === decls[0]) {
                    doUpdate(key, cur);
                  }
                });
              }
            }
          }
        }
      }
    }
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
    updateKind: UpdateKind
  ) {
    if (
      Array.isArray(decl) ||
      (decl.type !== "MemberDecl" && decl.type !== "Unknown")
    ) {
      if (updateKind !== UpdateKind.None) {
        // even if we're only modifying an Object, rather
        // than reassigning it, we need to clear the
        // related copy prop events, because although
        // we may only see the object itself, the expression
        // could access its fields. eg if x is the decl, then
        //
        //   foo(x);
        //
        // might change when x.a.b.c is changed, even if we know
        // that foo is side-effect free, and accesses no globals.
        clearRelatedCopyPropEvents(blockState, decl, nodeCopyProp);
      }
      if (updateKind !== UpdateKind.Reassign) {
        /*
         * If we're not re-assigning, the equivalencies don't
         * change, so this update must be applied to every
         * element of the set
         */
        const v = blockState.map.get(decl);
        if (v?.equivSet) {
          let s = decl;
          do {
            const next = blockState.map.get(s);
            if (!next || !next.equivSet) {
              throw new Error(
                `Inconsistent equivSet for ${tsKey(
                  decl
                )}: missing value for ${tsKey(s)}`
              );
            }
            blockState.map.set(s, { ...next, curType: value });
            s = next.equivSet.next;
          } while (s !== decl);
        } else {
          blockState.map.set(decl, { ...v, curType: value });
        }
      } else {
        const v = blockState.map.get(decl);
        removeEquiv(blockState.map, decl);
        if (v?.assocPaths?.size) {
          clearAssocPaths(blockState, decl, v as TypeStateValue);
        }
        if (v?.copyPropItem) {
          copyPropFailed(blockState, v.copyPropItem, nodeCopyProp);
        }
        blockState.map.set(decl, { curType: value });
      }
      return;
    }
    if (decl.type === "Unknown") {
      return;
    }
    return memberDeclInfo(blockState, decl, value)?.[1];
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
      let tsVal = blockState.map.get(decl);
      if (!tsVal) {
        tsVal = { curType: typeConstraint(decl) };
        blockState.map.set(decl, tsVal);
      }
      return tsVal;
    }

    if (decl.type === "Unknown") {
      return { curType: { type: TypeTag.Never } };
    }

    const info = memberDeclInfo(blockState, decl);
    return { curType: info ? info[0] : { type: TypeTag.Any } };
  }

  const blockStates: TypeState[] = [];
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
      if (mergeTypeState(blockStates, succ.order, curState, nodeCopyProp)) {
        if (logThisRun) {
          console.log(`re-merge: ${top.order} -> ${succ.order}`);
        }
        queue.enqueue(succ);
      }
    });
  };

  function checkModResults(
    curState: TypeState,
    calleeObjDecl: EventDecl,
    callees: FunctionStateNode | FunctionStateNode[] | undefined | null,
    node: mctree.CallExpression
  ) {
    const calleeObj = getStateType(curState, calleeObjDecl);
    const calleeResult: ExactOrUnion = { type: TypeTag.Never };
    const result = every(callees, (callee) => {
      const info = sysCallInfo(callee);
      if (!info) return false;
      const result = info(istate.state, callee, calleeObj, () =>
        node.arguments.map((arg) => evaluateExpr(state, arg, typeMap).value)
      );
      if (!result.effectFree) {
        return false;
      }
      if (result.calleeObj) {
        unionInto(calleeResult, result.calleeObj);
      }
      return true;
    });
    return result ? calleeResult : null;
  }

  function modInterference(
    blockState: TypeState,
    event: ModEvent,
    doUpdate: boolean,
    callback: (
      callees: FunctionStateNode | FunctionStateNode[] | undefined | null,
      calleeObj: EventDecl | undefined
    ) => boolean
  ) {
    let callees: FunctionStateNode | FunctionStateNode[] | undefined | null =
      undefined;
    if (event.calleeDecl) {
      const calleeType = getStateType(blockState, event.calleeDecl);
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
      const calleeObjResult = checkModResults(
        blockState,
        event.calleeObj,
        callees,
        event.node as mctree.CallExpression
      );
      if (calleeObjResult) {
        if (calleeObjResult.type !== TypeTag.Never) {
          if (doUpdate) {
            setStateEvent(
              blockState,
              event.calleeObj,
              calleeObjResult,
              UpdateKind.None
            );
          }
        }
        return true;
      }
    }
    return callback(callees, event.calleeObj);
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
        const tmpState = cloneTypeState(curState);
        setStateEvent(tmpState, leftDecl, leftr, UpdateKind.None);
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
          setStateEvent(tmpState, rightDecl, rightr, UpdateKind.None);
        }
        return tmpState;
      }
      if (
        isExact(right) &&
        right.type & SingletonTypeTagsConst &&
        left.type & right.type
      ) {
        // left is not equal to right, and right is one of the
        // singleton types; so we can remove that type from left.
        const singletonRemoved = cloneType(left);
        singletonRemoved.type -= right.type;
        if (singletonRemoved.type === TypeTag.Never) return false;
        const tmpState = cloneTypeState(curState);
        setStateEvent(tmpState, leftDecl, singletonRemoved, UpdateKind.None);
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
              const tmpState = cloneTypeState(curState);
              setStateEvent(
                tmpState,
                event.left,
                singletonRemoved,
                UpdateKind.None
              );
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
            const tmpState = cloneTypeState(curState);
            setStateEvent(
              tmpState,
              event.left,
              nonNullRemoved,
              UpdateKind.None
            );
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
                          ldec === rdec ||
                          (ldec.type === "ClassDeclaration" &&
                            getSuperClasses(ldec)?.has(rdec))
                      )
                  );
                  if (leftReduced.length !== leftDecls.length) {
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
            const tmpState = cloneTypeState(curState);
            setStateEvent(tmpState, event.left, result, UpdateKind.None);
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
          trueSucc.order!,
          sTrue || curState,
          nodeCopyProp
        )
      ) {
        if (logThisRun) {
          console.log(`re-merge: ${top.order} -> ${trueSucc.order}`);
        }
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
          falseSucc.order!,
          sFalse || curState,
          nodeCopyProp
        )
      ) {
        if (logThisRun) {
          console.log(`re-merge: ${top.order} -> ${falseSucc.order}`);
        }
        queue.enqueue(falseSucc);
      }
    }
    return true;
  }

  /*
   * nodeCopyProp contains two related maps. It maps ref nodes
   * to the def node that should be copy propagated. It also maps
   * def nodes to false, to indicate a previous failure to find
   * a copy prop candidate.
   */
  const nodeCopyProp: CopyPropMap = new Map();
  const nodeEquivs: NodeEquivMap = new Map();
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
          (top.exsucc as TypeFlowBlock).order!,
          curState,
          nodeCopyProp
        )
      ) {
        queue.enqueue(top.exsucc);
      }
    }
    validateTypeState(curState);
    switch (event.type) {
      case "kil": {
        const curEntry = getStateEntry(curState, event.decl);
        if (curEntry.equivSet) {
          removeEquiv(curState.map, event.decl);
        }
        if (curEntry.assocPaths) {
          clearAssocPaths(curState, event.decl, curEntry);
        }
        if (curEntry.copyPropItem) {
          copyPropFailed(curState, curEntry.copyPropItem, nodeCopyProp);
        }
        clearRelatedCopyPropEvents(curState, event.decl, nodeCopyProp);
        curState.map.delete(event.decl);
        break;
      }
      case "ref": {
        let curEntry = getStateEntry(curState, event.decl);
        typeMap.set(event.node, curEntry.curType);
        nodeEquivs.delete(event.node);
        if (curEntry.equivSet) {
          const equiv = Array.from(
            getEquivSet(curState.map, event.decl as TypeStateKey)
          ).filter((decl) => decl !== event.decl && declIsLocal(decl));
          if (equiv.length) {
            nodeEquivs.set(event.node, {
              decl: event.decl,
              equiv,
            });
          }
        }
        if (copyPropStores) {
          nodeCopyProp.delete(event.node);
          if (curEntry.copyPropItem) {
            const copyPropInfo = copyPropStores.get(
              curEntry.copyPropItem.event.node
            );
            assert(copyPropInfo && copyPropInfo.ref === event.node);
            const defNode = nodeCopyProp.get(curEntry.copyPropItem.event.node);
            assert(!defNode || defNode === event.node);
            if (defNode !== false) {
              nodeCopyProp.set(event.node, curEntry.copyPropItem.event.node);
              nodeCopyProp.set(curEntry.copyPropItem.event.node, event.node);
            }
            clearCopyProp(curState, curEntry.copyPropItem);
            curEntry = { ...curEntry };
            delete curEntry.copyPropItem;
            curState.map.set(event.decl as TypeStateKey, curEntry);
          } else if (declIsNonLocal(event.decl)) {
            clearRelatedCopyPropEvents(curState, null, nodeCopyProp);
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
        modInterference(curState, event, true, (callees, calleeObj) => {
          clearRelatedCopyPropEvents(curState, null, nodeCopyProp);
          if (calleeObj) {
            const objType = getStateType(curState, calleeObj);
            if (
              objType.type &
              (TypeTag.Object | TypeTag.Array | TypeTag.Dictionary)
            ) {
              setStateEvent(curState, calleeObj, objType, UpdateKind.Inner);
            }
          }
          curState.map.forEach((tsv, decl) => {
            let type = tsv.curType;
            if (
              !some(
                decl,
                (d) =>
                  d.type === "VariableDeclarator" &&
                  (d.node.kind === "var" ||
                    // even a "const" could have its "inner" type altered
                    (type.value != null && (type.type & TypeTag.Object) !== 0))
              )
            ) {
              return;
            }
            if (modifiableDecl(decl, callees)) {
              if (tsv.equivSet) {
                removeEquiv(curState.map, decl);
              }
              if (tsv.assocPaths) {
                clearAssocPaths(curState, decl, tsv);
              }
              // we only attach copyPropItems to locals,
              // which can't be modified by a call.
              assert(!tsv.copyPropItem);
              clearRelatedCopyPropEvents(curState, decl, nodeCopyProp);
              curState.map.set(decl, { curType: typeConstraint(decl) });
            } else if (
              type.value != null &&
              (!callees || !every(callees, (callee) => callee.info === false))
            ) {
              if (type.type & TypeTag.Object) {
                const odata = getObjectValue(tsv.curType);
                if (odata?.obj) {
                  type = cloneType(type);
                  const newData = { klass: odata.klass };
                  setUnionComponent(type, TypeTag.Object, newData);
                  if (tsv.assocPaths) {
                    clearAssocPaths(curState, decl, tsv);
                    tsv = { ...tsv };
                    delete tsv.assocPaths;
                  }
                  if (tsv.copyPropItem) {
                    copyPropFailed(curState, tsv.copyPropItem, nodeCopyProp);
                    tsv = { ...tsv };
                    delete tsv.copyPropItem;
                  }
                  clearRelatedCopyPropEvents(curState, decl, nodeCopyProp);
                  curState.map.set(decl, { ...tsv, curType: type });
                }
              }
            }
          });
          return true;
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
          const before = getStateEntry(curState, event.decl);
          if (before.curType) {
            typeMap.set(lval, before.curType);
          }
          if (
            before.copyPropItem &&
            (event.node.type !== "AssignmentExpression" ||
              event.node.operator !== "=")
          ) {
            copyPropFailed(curState, before.copyPropItem, nodeCopyProp);
            const v = { ...before };
            delete v.copyPropItem;
            assert(isTypeStateKey(event.decl));
            curState.map.set(event.decl, v);
          }
        }
        const expr: mctree.Expression | null =
          event.node.type === "VariableDeclarator"
            ? event.node.init || null
            : event.node;
        const type = expr
          ? evaluate(istate, expr).value
          : { type: TypeTag.Any };
        const wasComputedDecl = setStateEvent(
          curState,
          event.decl,
          type,
          UpdateKind.Reassign
        );
        some(event.decl, (decl) => {
          if (
            decl.type !== "VariableDeclarator" ||
            decl.node.kind !== "var" ||
            !isClassVariable(decl)
          ) {
            return false;
          }
          // A write to a class variable could interfere with
          // a MemberDecl
          const affected = curState.trackedMemberDecls?.get(decl.name);
          if (affected) {
            const objType = typeFromTypeStateNodes(
              istate.state,
              map(
                event.decl,
                (decl) =>
                  decl.type === "VariableDeclarator" &&
                  decl.stack[decl.stack.length - 1].sn
              ).filter(
                (decl): decl is ClassStateNode =>
                  decl && decl.type === "ClassDeclaration"
              )
            );
            updateAffected(
              curState,
              objType,
              event.decl as TypeStateKey,
              decl.name,
              decl.name,
              affected,
              type
            );
          }
          return true;
        });
        if (wasComputedDecl) {
          curState.map.forEach((value, decls) => {
            // we wrote through a computed member expression
            // which might have been a Class, Module or Object.
            // That could have affected any non-local...
            if (
              some(
                decls as TypeStateKey,
                (decl) =>
                  decl.type === "VariableDeclarator" &&
                  decl.node.kind === "var" &&
                  !isLocal(decl)
              )
            ) {
              if (value.equivSet) {
                removeEquiv(curState.map, decls);
              }
              if (value.assocPaths) {
                clearAssocPaths(curState, decls, value);
              }
              assert(!value.copyPropItem);
              curState.map.set(decls, { curType: typeConstraint(decls) });
              clearRelatedCopyPropEvents(curState, decls, nodeCopyProp);
            }
          });
        }
        if (event.rhs) {
          const selfAssign = addEquiv(
            curState.map,
            event.rhs as TypeStateKey,
            event.decl as TypeStateKey
          );
          if (
            event.node.type === "AssignmentExpression" &&
            event.node.operator === "="
          ) {
            if (selfAssign) {
              // rhs and lhs are identical
              selfAssignments.add(event.node);
            } else {
              selfAssignments.delete(event.node);
            }
          }
        }

        if (!declIsLocal(event.decl)) {
          clearRelatedCopyPropEvents(curState, null, nodeCopyProp);
        } else {
          if (
            event.containedEvents &&
            copyPropStores &&
            nodeCopyProp.get(event.node) !== false &&
            (!event.rhs || !declIsLocal(event.rhs))
          ) {
            const copyPropCandidate = copyPropStores.get(event.node);
            if (copyPropCandidate) {
              const contained = new Map() as CopyPropItem["contained"];
              if (
                event.containedEvents.every((event) => {
                  if (event.type === "mod") {
                    if (modInterference(curState, event, false, () => false)) {
                      return true;
                    }
                    if (
                      !copyPropCandidate.ant ||
                      // If the ref isn't anticipated, we can't propagate it
                      // in case it has side effects.
                      some(
                        event.calleeDecl,
                        (callee) =>
                          callee.type === "FunctionDeclaration" &&
                          inlineRequested(state, callee)
                      )
                    ) {
                      // Don't copy prop if the rhs is marked for
                      // inline, because we might move it out of
                      // assignment context, to somewhere it can't be
                      // inlined.
                      return false;
                    }
                  }

                  if (
                    !event.decl ||
                    (isTypeStateKey(event.decl) &&
                      some(
                        event.decl,
                        (decl) =>
                          (decl.type === "VariableDeclarator" &&
                            decl.node.kind === "var") ||
                          decl.type === "BinaryExpression" ||
                          decl.type === "Identifier"
                      ))
                  ) {
                    const key = event.decl ?? null;
                    if (
                      key &&
                      declIsLocal(key) &&
                      nodeCopyProp.has(event.node)
                    ) {
                      // we might have
                      //
                      //   var x = foo();
                      //   var y = x + 1;
                      //   bar();
                      //   return y;
                      //
                      // In that case, its ok to drop "x = foo()" and rewrite as y = foo() + 1"
                      // OR its ok to drop "y = x + 1" and rewrite as "return x + 1".
                      // But we can't do both, and rewrite as "bar(); return foo() + 1;"
                      // So just disable copy prop for *this* node. We'll re-run and have a
                      // second chance later.
                      return false;
                    }
                    const item = contained.get(key);
                    if (!item) {
                      contained.set(key, [event]);
                    } else {
                      item.push(event);
                    }
                  }
                  return true;
                })
              ) {
                addCopyPropEvent(curState, { event, contained });
              }
            }
          }
          const name = localDeclName(event.decl);
          const locals = localDecls.get(name);
          if (!locals) {
            localDecls.set(name, new Set([event.decl]));
          } else {
            locals.forEach((local) => {
              if (
                local !== event.decl &&
                curState.map.has(local as TypeStateKey)
              ) {
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
                    curState.map.get(event.left.base)?.curType || {
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

  blockStates[0] = { map: new Map(), visits: 0 };
  const head = blockStates[0];
  // set the parameters to their initial types
  func.node.params.forEach((param) => {
    setStateEvent(
      head,
      param,
      param.type === "BinaryExpression"
        ? typeFromTypespec(state, param.right)
        : { type: TypeTag.Any },
      UpdateKind.None
    );
  });

  queue.enqueue(order[0]);

  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }
    if (!blockStates[top.order]) continue;
    const curState = cloneTypeState(blockStates[top.order]);
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

  nodeCopyProp.forEach((value, key) => {
    if (
      key.type === "VariableDeclarator" ||
      key.type === "AssignmentExpression"
    ) {
      if (value === false) {
        nodeCopyProp.delete(key);
        return;
      }
      assert(nodeCopyProp.get(value) === key);
    }
  });

  if (logThisRun) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockState(block, blockStates[block.order!]);
      printBlockEvents(block, (event) =>
        event.type === "ref" && typeMap && typeMap.has(event.node)
          ? display(typeMap.get(event.node)!)
          : ""
      );
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
    console.log("====== Copy Prop =====");
    nodeCopyProp.forEach((value, key) => {
      assert(value !== false);
      if (
        key.type === "VariableDeclarator" ||
        key.type === "AssignmentExpression"
      ) {
        return;
      }
      assert(
        (value.type === "VariableDeclarator" && value.init) ||
          value.type === "AssignmentExpression"
      );
      const node =
        value.type === "VariableDeclarator" ? value.init! : value.right;
      console.log(
        `${formatAst(key)} = [${formatAstLongLines(node)}] ${
          key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""
        }`
      );
    });
  }

  if (logThisRun) {
    console.log(formatAstLongLines(func.node));
    if (copyPropStores) {
      copyPropStores.forEach(({ ref, ant }, node) => {
        console.log(
          `copy-prop-store: ${formatAstLongLines(node)}${ant ? "!" : ""} => ${
            nodeCopyProp.get(node) !== ref ? "Failed" : "Success"
          }`
        );
      });
    }
  }

  if (optimizeEquivalencies) {
    if (!nodeEquivs.size && !selfAssignments.size && !nodeCopyProp.size) {
      return { istate, nodeEquivs };
    }
    if (logThisRun) {
      if (selfAssignments.size) {
        console.log("====== Self Assignments =====");
        selfAssignments.forEach((self) =>
          console.log(`${formatAst(self)} (${sourceLocation(self.loc)})`)
        );
      }
    }
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
      const copyNode = nodeCopyProp.get(node);
      if (copyNode) {
        if (node.type === "AssignmentExpression") {
          if (logThisRun) {
            console.log(
              `Killing copy-prop assignment ${formatAstLongLines(node)}`
            );
          }
          return withLoc(
            { type: "Literal", value: null, raw: "null" },
            node,
            node
          );
        }
        if (node.type === "VariableDeclarator") {
          assert(node.init);
          if (logThisRun) {
            console.log(
              `Killing copy-prop variable initialization ${formatAstLongLines(
                node
              )}`
            );
          }
          const dup = { ...node };
          delete dup.init;
          return dup;
        }
        if (copyNode.type === "AssignmentExpression") {
          if (logThisRun) {
            console.log(
              `copy-prop ${formatAstLongLines(node)} => ${formatAstLongLines(
                copyNode.right
              )}`
            );
          }
          return withLocDeep(copyNode.right, node, node, false);
        } else if (copyNode.type === "VariableDeclarator") {
          assert(copyNode.init);
          if (logThisRun) {
            console.log(
              `copy-prop ${formatAstLongLines(node)} => ${formatAstLongLines(
                copyNode.init
              )}`
            );
          }
          return withLocDeep(copyNode.init, node, node, false);
        }
        assert(false);
      }
      if (selfAssignments.has(node)) {
        if (logThisRun) {
          console.log(
            `Deleting self assignment: ${formatAst(node)} (${sourceLocation(
              node.loc
            )})`
          );
        }
        return withLoc(
          { type: "Literal", value: null, raw: "null" },
          node,
          node
        );
      }
      if (nodeCopyProp.size) {
        /*
         * Copy prop and equiv can interfere with each other:
         *
         *   var c = g; // copy prop kills this
         *   ...
         *   var x = g + 2; // node equiv replaces g with c
         *   ...
         *   return c; // copy prop changes this to g
         *
         * So ignore equivalencies if copy prop is active.
         * Note that we have to re-run propagation anyway
         * if copy prop did anything.
         */
        return null;
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

  return {
    istate,
    nodeEquivs,
    redo: optimizeEquivalencies && nodeCopyProp.size,
  };
}

function updateByAssocPath(
  path: AssocPath,
  property: ExactOrUnion,
  union: boolean
) {
  const valueToStore = (base: ExactOrUnion) => {
    const clone = cloneType(base);
    unionInto(clone, property);
    return clone;
  };
  for (let i = path.length; i--; ) {
    const pathElem = path[i];
    let object = pathElem.type;
    if (pathElem.name) {
      const value = getObjectValue(object);
      if (value) {
        const obj = value.obj ? { ...value.obj } : {};
        obj[pathElem.name] = union
          ? valueToStore(obj[pathElem.name] || { type: TypeTag.Any })
          : property;
        object = cloneType(object);
        setUnionComponent(object, TypeTag.Object, {
          klass: value.klass,
          obj,
        });
      }
    } else {
      if (object.type & TypeTag.Array) {
        object = cloneType(object);
        setUnionComponent(
          object,
          TypeTag.Array,
          union
            ? valueToStore(
                getUnionComponent(object, TypeTag.Array) || {
                  type: TypeTag.Any,
                }
              )
            : property
        );
      }
      if (object.type & TypeTag.Dictionary) {
        const dvalue = getUnionComponent(object, TypeTag.Dictionary);
        object = cloneType(object);
        setUnionComponent(object, TypeTag.Dictionary, {
          key: dvalue?.key || { type: TypeTag.Any },
          value: union
            ? valueToStore(
                getUnionComponent(object, TypeTag.Dictionary)?.value || {
                  type: TypeTag.Any,
                }
              )
            : property,
        });
      }
    }
    path[i].type = object;
    property = object;
    union = false;
  }
  return property;
}
