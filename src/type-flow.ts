import { mctree } from "@markw65/prettier-plugin-monkeyc";
import assert from "node:assert";
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
import { cloneDeep, withLoc, withLocDeep } from "./ast";
import { getPostOrder } from "./control-flow";
import {
  DataflowQueue,
  DefEvent,
  Event,
  EventDecl,
  FlowEvent,
  FlowKind,
  ModEvent,
  RefEvent,
  buildDataFlowGraph,
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
import {
  InterpState,
  evaluate,
  evaluateExpr,
  isByteArrayData,
} from "./type-flow/interp";
import { sysCallInfo } from "./type-flow/interp-call";
import {
  intersection,
  restrictByEquality,
} from "./type-flow/intersection-type";
import { subtypeOf } from "./type-flow/sub-type";
import {
  TypeFlowBlock,
  TypeStateKey,
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
} from "./type-flow/type-flow-util";
import {
  ExactOrUnion,
  ObjectLikeTagsConst,
  SingletonTypeTagsConst,
  TypeTag,
  arrayLiteralKeyFromExpr,
  cloneType,
  display,
  getObjectValue,
  getStateNodeDeclsFromType,
  getUnionComponent,
  hasValue,
  isExact,
  objectLiteralKeyFromExpr,
  relaxType,
  setUnionComponent,
  typeFromLiteral,
  typeFromTypeStateNode,
  typeFromTypeStateNodes,
  typeFromTypespec,
} from "./type-flow/types";
import { clearValuesUnder, unionInto, widenType } from "./type-flow/union-type";
import { every, forEach, log, map, reduce, some } from "./util";

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
    false,
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
type AssocPath = Array<{
  name: string | null;
  type: ExactOrUnion;
  // for a computed member which is a Dictionary, whose type is an
  // ObjectLiteralType, this is the key (as a string)
  // for an Array, its the index
  keyStr?: string | number;
}>;

type CopyPropItem = {
  event: DefEvent;
  contained: Map<TypeStateKey | null, Array<RefEvent | ModEvent>>;
};

// Ownership model:
// A TypeStateValue is owned by the TypeState["map"] that
// contains it, and can be modified in place.
type TypeStateValue = {
  curType: ExactOrUnion;
  // Ownership model:
  // The equivSet is owned by this TypeStateValue,
  // and can be modified in place.
  equivSet?: Set<TypeStateKey>;
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
  // in a class initializer, whether we've seen an assignment
  // to this entry on all paths to this point.
  inited?: Set<TypeStateKey>;

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
  const keyVal = ts.get(key);
  const equivVal = ts.get(equiv);
  if (!keyVal || !equivVal) return false;
  if (equivVal.equivSet) {
    if (equivVal.equivSet.has(key)) {
      return true;
    }
    // equiv is already a member of a set. remove it
    removeEquiv(ts, equiv);
  }
  // equiv is not (or no longer) part of an equivSet
  if (!keyVal.equivSet) {
    keyVal.equivSet = new Set([key, equiv]);
  } else {
    keyVal.equivSet.add(equiv);
  }
  equivVal.equivSet = keyVal.equivSet;
  return false;
}

function removeEquiv(ts: TypeStateMap, equiv: TypeStateKey) {
  const equivVal = ts.get(equiv);
  if (!equivVal?.equivSet) return;
  equivVal.equivSet.delete(equiv);
  if (equivVal.equivSet.size === 1) {
    const other = Array.from(equivVal.equivSet)[0];
    const otherVal = ts.get(other)!;
    delete otherVal.equivSet;
  }
  delete equivVal.equivSet;
}

function getEquivSet(ts: TypeStateMap, k: TypeStateKey) {
  const keys = ts.get(k)?.equivSet;
  assert(keys);
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
  let removed = null as Set<TypeStateKey> | null;
  eq1.equivSet.forEach((key) => {
    if (!eq2.equivSet!.has(key)) {
      eq1.equivSet!.delete(key);
      if (!removed) {
        removed = new Set();
      }
      removed.add(key);
    }
  });
  if (eq1.equivSet.size === 1) {
    assert(eq1.equivSet.has(k));
    delete eq1.equivSet;
  }
  if (removed) {
    removed.forEach((k) =>
      removed!.size === 1
        ? delete ts1.get(k)!.equivSet
        : (ts1.get(k)!.equivSet = removed!)
    );
  }
  return false;
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
  const { map, inited, trackedMemberDecls, liveCopyPropEvents, ...rest } =
    blockState;
  const clone: TypeState = {
    map: new Map(map),
    ...rest,
  };
  if (inited) {
    clone.inited = new Set(inited);
  }
  clone.map.forEach((value, key) => {
    if (value.equivSet) {
      if (key === Array.from(value.equivSet)[0]) {
        const equivSet = new Set(value.equivSet);
        equivSet.forEach((k) =>
          clone.map.set(k, { ...clone.map.get(k)!, equivSet })
        );
      }
    } else {
      clone.map.set(key, { ...value });
    }
  });
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
  const tov = blockState.map.get(decl);
  assert(tov);
  tov.copyPropItem = item;

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
      const value = blockState.map.get(cpDecl);
      assert(value && value.copyPropItem);
      assert(
        Array.from(value.copyPropItem.contained).some(([key]) => {
          return decl === key;
        })
      );

      copyPropFailed(blockState, value.copyPropItem, nodeCopyProp);
      delete value.copyPropItem;
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
      }
    }
    if (tov.assocPaths) {
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
        delete tov.copyPropItem;
        changes = true;
      } else {
        assert(k === tov.copyPropItem.event.decl);
        addCopyPropEvent(to, tov.copyPropItem);
      }
    }
    if (widen) {
      if (subtypeOf(fromv.curType, tov.curType)) return;
      if (subtypeOf(tov.curType, fromv.curType)) {
        tov.curType = fromv.curType;
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
    tov.curType = result;
    changes = true;
  });
  to.inited?.forEach((k) => from.inited!.has(k) || to.inited?.delete(k));
  return changes;
}

function typeStateEntry(value: TypeStateValue, key: TypeStateKey) {
  return `${tsKey(key)} = ${display(value.curType)}`;
}

function printBlockState(block: TypeFlowBlock, state: TypeState, indent = "") {
  log(indent + "State:");
  if (!state) {
    log(indent + "Not visited!");
    return;
  }
  state.map.forEach((value, key) => {
    log(
      `${indent} - ${typeStateEntry(value, key)}${
        value.equivSet
          ? " " + `[(${Array.from(value.equivSet).map(tsKey).join(", ")})]`
          : ""
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
          if (newAssocKey !== path) {
            entry.assocPaths = new Set(entry.assocPaths!);
            entry.assocPaths.delete(path);
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
          entry.curType = updateByAssocPath(assocPath, assignedType);
          break;
        }
        if (pathItem === "*") {
          const newType = { type: TypeTag.Never };
          if (type.type & TypeTag.Array) {
            const atype = getUnionComponent(type, TypeTag.Array);
            if (atype) {
              if (Array.isArray(atype)) {
                // Array TODO: Handle literal keys
                atype.forEach((value) => unionInto(newType, value));
              } else {
                unionInto(newType, atype);
              }
            }
          }
          if (type.type & TypeTag.Dictionary) {
            const dtype = getUnionComponent(type, TypeTag.Dictionary);
            if (dtype) {
              if (dtype.value) {
                unionInto(newType, dtype.value);
              } else {
                // Dictionary TODO: Handle literal keys here
                dtype.forEach((value) => unionInto(newType, value));
              }
              newType.type |= TypeTag.Null;
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
    if (droppedComponents) {
      entry.assocPaths!.forEach((path) =>
        path
          .split(".")
          .forEach((pathComponent) => droppedComponents!.delete(pathComponent))
      );
      droppedComponents.forEach((pathComponent) =>
        blockState.trackedMemberDecls!.get(pathComponent)!.delete(key)
      );
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

  const isStatic = !!(func.attributes & StateNodeAttributes.STATIC);
  const klass = func.stack?.[func.stack?.length - 1].sn;
  const selfClassDecl =
    klass && klass.type === "ClassDeclaration" ? klass : null;
  const uninitClassDecls =
    selfClassDecl && func.name === "initialize" && selfClassDecl.decls
      ? new Set(
          Object.values(selfClassDecl.decls)
            .filter((decls) =>
              decls.some(
                (decl) =>
                  decl.type === "VariableDeclarator" &&
                  decl.node.kind === "var" &&
                  !decl.node.init
              )
            )
            .flat()
        )
      : null;

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

  function withNull(type: ExactOrUnion) {
    if (type.type & TypeTag.Null) return type;
    type = cloneType(type);
    type.type |= TypeTag.Null;
    return type;
  }
  function memberDeclInfo(
    blockState: TypeState,
    decl: Extract<EventDecl, { type: "MemberDecl" }>,
    newValue?: ExactOrUnion | undefined
  ): [ExactOrUnion, boolean] | null {
    let cur = getStateType(blockState, decl.base);
    const assocValue: AssocPath = [];

    let updateAny = false;
    for (let i = 0, l = decl.path.length - 1; i <= l; i++) {
      let next = null as ExactOrUnion | null;
      const me = decl.path[i];
      assocValue.push({
        name: me.computed ? null : me.property.name,
        type: cur,
      });
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
        let byteArray = false;
        if (cur.type & TypeTag.Object && cur.value) {
          const odata = getObjectValue(cur);
          if (odata && isByteArrayData(odata)) {
            byteArray = true;
          }
        }
        if (
          cur.type &
          (TypeTag.Module | TypeTag.Class | (byteArray ? 0 : TypeTag.Object))
        ) {
          next = {
            type: TypeTag.Any,
          };
          if (newValue && !updateAny) {
            updateAny = true;
          }
        } else {
          if (byteArray) {
            const t = { type: TypeTag.Number };
            if (next) {
              unionInto(t, next);
            }
            next = t;
          }
          if (cur.type & TypeTag.Array) {
            let avalue = getUnionComponent(cur, TypeTag.Array) || {
              type: TypeTag.Any,
            };
            if (Array.isArray(avalue)) {
              const index = arrayLiteralKeyFromExpr(me.property);
              if (index != null && avalue[index] != null) {
                if (!next) {
                  assocValue[i].keyStr = index;
                }
                avalue = avalue[index];
              }
              if (next || i !== l || !newValue) {
                const n = next ? cloneType(next) : { type: TypeTag.Never };
                forEach(avalue, (v) => unionInto(n, v));
                next = n;
              }
            } else {
              if (next) {
                unionInto((next = cloneType(next)), avalue);
              } else {
                next = avalue;
              }
            }
          }
          let isExact = false;
          if (cur.type & TypeTag.Dictionary) {
            const ddict = getUnionComponent(cur, TypeTag.Dictionary);
            if (ddict && !ddict.value) {
              const keyStr = objectLiteralKeyFromExpr(me.property);
              if (keyStr) {
                const n = ddict.get(keyStr);
                if (!next) {
                  isExact = true;
                  assocValue[i].keyStr = keyStr;
                  if (n) {
                    next = withNull(n);
                  } else if (i !== l || !newValue) {
                    next = { type: TypeTag.Any };
                  }
                } else {
                  delete assocValue[i].keyStr;
                  if (n) {
                    unionInto((next = cloneType(next)), n);
                    next.type |= TypeTag.Null;
                  } else {
                    next = { type: TypeTag.Any };
                  }
                }
              }
            }
            if (!isExact) {
              const dvalue = ddict?.value ?? {
                type: TypeTag.Any,
              };
              if (next) {
                unionInto((next = cloneType(next)), dvalue);
              } else {
                next = dvalue;
              }
              next = withNull(next);
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
      assocValue[i].type = cur;
      cur = next;
    }
    const assocKey = assocValue.map((av) => av.name ?? "*").join(".");
    const newType = updateByAssocPath(assocValue, cur, newValue != null);
    setStateEvent(
      blockState,
      decl.base,
      newType,
      newValue ? UpdateKind.Inner : UpdateKind.None
    );
    const tsv = blockState.map.get(decl.base)!;
    tsv.assocPaths = new Set(tsv.assocPaths);
    tsv.assocPaths.add(assocKey);
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
            cur
          );
        }
      }
      if (!isStatic && selfClassDecl) {
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
              const doUpdate = (key: TypeStateKey, value: TypeStateValue) => {
                const update = cloneType(value.curType);
                unionInto(update, cur);
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
    return [cur, updateAny];
  }

  function typeConstraint(
    decls: TypeStateKey,
    blockState: TypeState
  ): ExactOrUnion {
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
        if (
          blockState.inited &&
          !blockState.inited.has(decl) &&
          decl.type === "VariableDeclarator" &&
          !decl.node.init &&
          decl.node.kind === "var" &&
          decl.stack[decl.stack.length - 1].sn === selfClassDecl
        ) {
          cur.type |= TypeTag.Null;
        }
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
      const v = blockState.map.get(decl);
      if (!v) {
        blockState.map.set(decl, { curType: value });
        return;
      }
      if (updateKind !== UpdateKind.Reassign) {
        /*
         * If we're not re-assigning, the equivalencies don't
         * change, so this update must be applied to every
         * element of the set
         */
        if (v.equivSet) {
          v.equivSet.forEach((s) => {
            const next = blockState.map.get(s);
            assert(next && next.equivSet?.has(s));
            next.curType = value;
          });
        } else {
          v.curType = value;
        }
      } else {
        removeEquiv(blockState.map, decl);
        if (v.assocPaths?.size) {
          clearAssocPaths(blockState, decl, v as TypeStateValue);
          delete v.assocPaths;
        }
        if (v.copyPropItem) {
          copyPropFailed(blockState, v.copyPropItem, nodeCopyProp);
          delete v.copyPropItem;
        }
        v.curType = value;
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
        tsVal = { curType: typeConstraint(decl, blockState) };
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
          log(`re-merge: ${top.order} -> ${succ.order}`);
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
    let calleeResult = null as ExactOrUnion | null;
    let effectFree = true;
    forEach(callees, (callee) => {
      const info = sysCallInfo(istate.state, callee);
      if (!info) {
        effectFree = false;
        return;
      }
      const result = info(istate.state, callee, calleeObj, () =>
        node.arguments.map((arg) => evaluateExpr(state, arg, typeMap).value)
      );
      if (!result.effectFree) {
        effectFree = false;
      }
      if (result.calleeObj) {
        if (!calleeResult) {
          calleeResult = { type: TypeTag.Never } as ExactOrUnion;
        }
        unionInto(calleeResult, result.calleeObj);
      }
    });
    return { effectFree, calleeResult };
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
      const { effectFree, calleeResult } = checkModResults(
        blockState,
        event.calleeObj,
        callees,
        event.node as mctree.CallExpression
      );
      if (calleeResult) {
        if (doUpdate) {
          setStateEvent(
            blockState,
            event.calleeObj,
            calleeResult,
            UpdateKind.None
          );
        }
        return effectFree;
      }
      if (effectFree) {
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
        log(`  Flow (true): merge to ${trueSucc.order || -1}`);
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
          log(`re-merge: ${top.order} -> ${trueSucc.order}`);
        }
        queue.enqueue(trueSucc);
      }
    }
    if (sFalse === false) {
      setTruthy && typeMap.set(event.node, { type: TypeTag.True });
    } else {
      if (logThisRun) {
        log(`  Flow (false): merge to: ${falseSucc.order || -1}`);
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
          log(`re-merge: ${top.order} -> ${falseSucc.order}`);
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
        const curEntry = getStateEntry(curState, event.decl);
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
            delete curEntry.copyPropItem;
          } else if (declIsNonLocal(event.decl)) {
            clearRelatedCopyPropEvents(curState, null, nodeCopyProp);
          }
        }
        if (logThisRun) {
          log(
            describeEvent(event).then(
              (eventStr) => `  ${eventStr} == ${display(curEntry.curType)}`
            )
          );
        }
        break;
      }
      case "mod": {
        if (logThisRun) {
          log(describeEvent(event).then((eventStr) => `  ${eventStr}`));
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
          if (
            nodeCopyProp.size &&
            event.node.type === "CallExpression" &&
            some(callees, (callee) => inlineRequested(state, callee))
          ) {
            // we don't want to copy-prop to the argument of
            // an inline function, because that could prevent
            // inlining.
            event.node.arguments.forEach((arg) => {
              const def = nodeCopyProp.get(arg);
              if (def && nodeCopyProp.get(def) !== false) {
                nodeCopyProp.set(def, false);
                nodeCopyProp.delete(arg);
              }
            });
          }
          let calleeEffects: boolean | undefined;
          curState.map.forEach((tsv, decl) => {
            let type = tsv.curType;
            if (
              (type.value == null ||
                !(
                  type.type &
                  (TypeTag.Object | TypeTag.Array | TypeTag.Dictionary)
                )) &&
              !some(decl, (d) => d.type === "VariableDeclarator" && !isLocal(d))
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
              curState.map.set(decl, {
                curType: typeConstraint(decl, curState),
              });
            } else if (
              type.type &
                (TypeTag.Object | TypeTag.Array | TypeTag.Dictionary) &&
              (calleeEffects == null
                ? (calleeEffects =
                    !callees ||
                    !every(callees, (callee) => callee.info === false))
                : calleeEffects)
            ) {
              if (type.value != null && type.type & TypeTag.Object) {
                const odata = getObjectValue(tsv.curType);
                if (odata?.obj) {
                  type = cloneType(type);
                  const newData = { klass: odata.klass };
                  setUnionComponent(type, TypeTag.Object, newData);
                  if (tsv.assocPaths) {
                    clearAssocPaths(curState, decl, tsv);
                    delete tsv.assocPaths;
                  }
                  tsv.curType = type;
                }
              }
              clearRelatedCopyPropEvents(curState, decl, nodeCopyProp);
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
          if (nodeCopyProp.size && lval.type === "MemberExpression") {
            // We can convert
            // x = foo(); x[0] = 1
            // to
            // foo()[0] = 1;
            // but we can't do that for
            // x = foo() as Type; x[0] = 1
            // because of a Garmin parser bug.
            let t = lval as mctree.Expression;
            while (t.type === "MemberExpression") {
              t = t.object;
            }
            const target = nodeCopyProp.get(t);
            if (target) {
              const copyExpr =
                target.type === "AssignmentExpression"
                  ? target.right
                  : target.type === "VariableDeclarator"
                  ? target.init
                  : null;
              if (copyExpr?.type === "BinaryExpression") {
                nodeCopyProp.set(target, false);
                nodeCopyProp.delete(t);
              }
            }
          }
          if (declIsLocal(event.decl)) {
            if (!istate.localLvals) {
              istate.localLvals = new Set();
            }
            istate.localLvals.add(lval);
          }
          if (nodeEquivs.has(lval)) {
            // if this is an update, we add a "ref" for the lhs.
            // but that should never be equivalent to anything else
            nodeEquivs.delete(lval);
          }
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
            delete before.copyPropItem;
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
              curState.map.set(decls, {
                curType: typeConstraint(decls, curState),
              });
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
                    if (key && declIsLocal(key)) {
                      if (nodeCopyProp.has(event.node)) {
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
                      } else if (
                        event.node.type === "AssignmentExpression" &&
                        event.node.operator !== "=" &&
                        nodeCopyProp.has(event.node.left)
                      ) {
                        // If we're copy-propping into the lhs of an update
                        // assignment, we're going to have to rewrite it.
                        // similar to the above, don't also do forward copy
                        // prop. eg
                        //
                        //  var x = a + b;
                        //  x += c;
                        //  return x;
                        //
                        // becomes
                        //
                        //  var x;
                        //  x = (a + b) + c;
                        //  return x; // <- don't propagate to here (yet), in case a+b has changed.
                        return false;
                      }
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
        if (uninitClassDecls?.size) {
          forEach(
            event.decl,
            (decl) =>
              uninitClassDecls.has(decl as StateNodeDecl) &&
              curState.inited?.add(decl as StateNodeDecl)
          );
        }
        if (logThisRun) {
          log(
            describeEvent(event).then(
              (eventStr) => `  ${eventStr} := ${display(type)}`
            )
          );
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
          log(
            describeEvent(event).then(
              (eventStr) =>
                `  ${eventStr} : ${
                  !Array.isArray(event.left) && event.left.type === "MemberDecl"
                    ? `${display(
                        curState.map.get(event.left.base)?.curType || {
                          type: TypeTag.Any,
                        }
                      )} :: `
                    : ""
                }${display(getStateType(curState, event.left))}`
            )
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
  if (uninitClassDecls?.size) head.inited = new Set();
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
        log(
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

    log("====== TypeMap =====");
    typeMap.forEach((value, key) => {
      log(
        formatAst(key).then(
          (keyStr) =>
            `${keyStr} = ${display(value)} ${
              key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""
            }`
        )
      );
    });
    log("====== EquivMap =====");
    nodeEquivs.forEach((value, key) => {
      log(
        formatAst(key).then(
          (keyStr) =>
            `${keyStr} = [${value.equiv.map((equiv) =>
              tsKey(equiv as TypeStateKey)
            )}] ${
              key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""
            }`
        )
      );
    });
    log("====== Copy Prop =====");
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
      log(
        formatAst(key).then((keyStr) =>
          formatAstLongLines(node).then(
            (nodeStr) =>
              `${keyStr} = [${nodeStr}] ${
                key.loc && key.loc.source ? ` (${sourceLocation(key.loc)})` : ""
              }`
          )
        )
      );
    });
  }

  if (logThisRun) {
    log(formatAstLongLines(func.node));
    if (copyPropStores) {
      copyPropStores.forEach(({ ref, ant }, node) => {
        log(
          formatAstLongLines(node).then(
            (nodeStr) =>
              `copy-prop-store: ${nodeStr}${ant ? "!" : ""} => ${
                nodeCopyProp.get(node) !== ref ? "Failed" : "Success"
              }`
          )
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
        log("====== Self Assignments =====");
        selfAssignments.forEach((self) =>
          log(
            formatAst(self).then(
              (selfStr) => `${selfStr} (${sourceLocation(self.loc)})`
            )
          )
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

    traverseAst(
      func.node.body!,
      (node) => {
        if (
          node.type === "AssignmentExpression" &&
          node.operator !== "=" &&
          nodeCopyProp.has(node.left)
        ) {
          const left = cloneDeep(node.left);
          const right: mctree.BinaryExpression = withLoc(
            {
              type: "BinaryExpression",
              operator: node.operator.slice(0, -1) as mctree.BinaryOperator,
              left: withLocDeep(node.left, node.right, false, true),
              right: node.right,
            },
            node.left,
            node.right
          );
          node.operator = "=";
          node.left = left;
          node.right = right;
        }
      },
      (node) => {
        const copyNode = nodeCopyProp.get(node);
        if (copyNode) {
          if (node.type === "AssignmentExpression") {
            if (logThisRun) {
              log(
                formatAstLongLines(node).then(
                  (nodeStr) => `Killing copy-prop assignment ${nodeStr}`
                )
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
              log(
                formatAstLongLines(node).then(
                  (nodeStr) =>
                    `Killing copy-prop variable initialization ${nodeStr}`
                )
              );
            }
            const dup = { ...node };
            delete dup.init;
            return dup;
          }
          if (copyNode.type === "AssignmentExpression") {
            const replacement: mctree.Expression =
              copyNode.operator === "="
                ? copyNode.right
                : {
                    type: "BinaryExpression",
                    operator: copyNode.operator.slice(
                      0,
                      -1
                    ) as mctree.BinaryOperator,
                    left: copyNode.left,
                    right: copyNode.right,
                  };
            if (logThisRun) {
              log(
                formatAstLongLines(node).then((nodeStr) =>
                  formatAstLongLines(replacement).then(
                    (repStr) => `copy-prop ${nodeStr} => ${repStr}`
                  )
                )
              );
            }
            return withLocDeep(replacement, node, node, false);
          } else if (copyNode.type === "VariableDeclarator") {
            const init = copyNode.init;
            assert(init);
            if (logThisRun) {
              log(
                formatAstLongLines(node).then((nodeStr) =>
                  formatAstLongLines(init).then(
                    (initStr) => `copy-prop ${nodeStr} => ${initStr}`
                  )
                )
              );
            }
            return withLocDeep(init, node, node, false);
          }
          assert(false);
        }
        if (selfAssignments.has(node)) {
          if (logThisRun) {
            log(
              formatAst(node).then(
                (nodeStr) =>
                  `Deleting self assignment: ${nodeStr} (${sourceLocation(
                    node.loc
                  )})`
              )
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
            `Missing info for equiv ${sourceLocation(node.loc)} = [${equiv.equiv
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
          log(
            formatAst(node).then(
              (nodeStr) =>
                `Replacing ${nodeStr} with ${name} at ${sourceLocation(
                  node.loc
                )}`
            )
          );
        }
        const replacement = withLoc({ type: "Identifier", name }, node, node);
        const tm = typeMap.get(node);
        if (tm) typeMap.set(replacement, tm);
        return replacement;
      }
    );
  }

  return {
    istate,
    nodeEquivs,
    redo: optimizeEquivalencies && nodeCopyProp.size,
  };
}

/*
 * Figure out the base type for a member expression.
 *
 * There are three cases:
 *
 * i) `update = false`
 *    This is just a read of something like foo.bar.baz
 *
 *    We may be able to refine the type of foo, because we now know
 *    that it has a bar member, and that *that* has a baz member.
 *    Note that this doesn't help with computed members, such as
 *    foo[1].bar, because although we now know that foo[1] has a bar
 *    member, we don't know anything about foo[0] or foo[42].
 *
 * ii) `update = true`
 *    This is an assignment to something like foo.bar.baz
 *
 *    In addition to the refinements we can make in case i), we
 *    also know that the type of the last member is whatever got
 *    assigned to it. In this case, if the last member is computed,
 *    we do need to widen the type to include the assigned value.
 *    eg if foo is known to be `Array<Number>`, and we assign
 *    `foo[1] = "bar"`, then foo's type has to widen to
 *    `Array<Number or String>`
 *
 * iii) `update = undefined`
 *    There is an assignment that might alias this member expression.
 *    The new type should be the union of the old type, and the type
 *    that would have resulted from case ii).
 */
function updateByAssocPath(
  path: AssocPath,
  property: ExactOrUnion,
  update?: boolean | undefined
) {
  const valueToStore = (base: ExactOrUnion | null | undefined) => {
    if (update == null) {
      const clone = base ? cloneType(base) : { type: TypeTag.Any };
      unionInto(clone, property);
      return clone;
    }
    return property;
  };
  for (let i = path.length; i--; ) {
    const pathElem = path[i];
    let object = pathElem.type;
    if (pathElem.name) {
      const value = getObjectValue(object);
      if (value) {
        const obj = value.obj ? { ...value.obj } : {};
        obj[pathElem.name] = valueToStore(obj[pathElem.name]);
        object = cloneType(object);
        setUnionComponent(object, TypeTag.Object, {
          klass: value.klass,
          obj,
        });
      }
    } else if (update) {
      if (object.type & TypeTag.Array) {
        let avalue = getUnionComponent(object, TypeTag.Array);
        if (Array.isArray(avalue)) {
          const key = pathElem.keyStr;
          const relaxed = relaxType(property);
          if (typeof key === "number" && key >= 0 && key < avalue.length) {
            avalue = avalue.slice();
            avalue[key] = relaxed;
          } else {
            avalue = avalue.map((v) => {
              v = cloneType(v);
              unionInto(v, relaxed);
              return v;
            });
          }
        } else {
          avalue = valueToStore(avalue);
        }
        object = cloneType(object);
        setUnionComponent(object, TypeTag.Array, avalue);
      }
      if (object.type & TypeTag.Dictionary) {
        const dvalue = getUnionComponent(object, TypeTag.Dictionary);
        if (dvalue) {
          if (dvalue.value) {
            object = cloneType(object);
            setUnionComponent(object, TypeTag.Dictionary, {
              key: dvalue.key || { type: TypeTag.Any },
              value: valueToStore(dvalue.value),
            });
          } else {
            if (typeof pathElem.keyStr === "string") {
              object = cloneType(object);
              const relaxed = cloneType(relaxType(property));
              relaxed.type &= ~TypeTag.Null;
              setUnionComponent(
                object,
                TypeTag.Dictionary,
                new Map(dvalue).set(pathElem.keyStr, relaxed)
              );
            }
          }
        }
      }
    }
    path[i].type = object;
    property = object;
    update = false;
  }
  return property;
}
