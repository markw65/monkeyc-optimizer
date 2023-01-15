import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  formatAst,
  getSuperClasses,
  hasProperty,
  isLocal,
  isStateNode,
  lookupNext,
} from "./api";
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
  ModEvent,
} from "./data-flow";
import { functionMayModify } from "./function-info";
import {
  ClassStateNode,
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNode,
} from "./optimizer-types";
import { evaluate, InterpState, TypeMap } from "./type-flow/interp";
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
  func: FunctionStateNode
) {
  if (!func.node.body || !func.stack) return;
  const { graph } = buildDataFlowGraph(state, func, () => false, false, true);
  state = { ...state, stack: func.stack };
  return propagateTypes(state, func, graph);
}

type TypeStateKey = Exclude<EventDecl, { type: "MemberDecl" }>;
type TypeState = Map<TypeStateKey, ExactOrUnion>;

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
      to.delete(k);
      return;
    }
    if (widen) {
      if (subtypeOf(fromv, tov)) return;
      if (subtypeOf(tov, fromv)) {
        to.set(k, fromv);
        changes = true;
        return;
      }
    }
    let result = cloneType(tov);
    if (!unionInto(result, fromv)) return;
    if (widen) {
      const wide = widenType(result);
      if (wide) result = wide;
    }
    to.set(k, result);
    changes = true;
  });
  return changes;
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
    (!Array.isArray(event.decl) && event.decl.type === "MemberDecl")
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

function typeStateEntry(value: ExactOrUnion, key: TypeStateKey) {
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
  }).join("|")} = ${display(value)}`;
}

function printBlockState(block: TypeFlowBlock, state: TypeState) {
  console.log("State:");
  if (!state) {
    console.log("Not visited!");
    return;
  }
  state.forEach((value, key) => {
    console.log(` - ${typeStateEntry(value, key)}`);
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

function findObjectDeclsByProperty(
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
  graph: TypeFlowBlock
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
    newValue?: ExactOrUnion | undefined
  ): [ExactOrUnion, boolean] | null {
    const baseType = getStateEvent(blockState, decl.base);
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
    setStateEvent(blockState, decl.base, typePath[0]);
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
    value: ExactOrUnion
  ) {
    if (Array.isArray(decl) || decl.type !== "MemberDecl") {
      blockState.set(decl, value);
      return;
    }
    return memberDeclInfo(blockState, decl, value)?.[1];
  }

  function getStateEvent(blockState: TypeState, decl: EventDecl): ExactOrUnion {
    if (Array.isArray(decl) || decl.type !== "MemberDecl") {
      let type = blockState.get(decl);
      if (!type) {
        type = typeConstraint(decl);
        blockState.set(decl, type);
      }
      return type;
    }

    const info = memberDeclInfo(blockState, decl);
    return info ? info[0] : { type: TypeTag.Any };
  }

  const blockStates: TypeState[] = [];
  const blockVisits: number[] = [];
  const typeMap = new Map<mctree.Node, ExactOrUnion>();
  const istate: InterpState = {
    state,
    typeMap,
    stack: [],
  };

  const modifiableDecl = (decls: TypeStateKey, callees?: ModEvent["callees"]) =>
    some(
      decls,
      (decl) =>
        decl.type === "VariableDeclarator" &&
        decl.node.kind === "var" &&
        !isLocal(decl) &&
        (!callees ||
          callees.some((callee) => functionMayModify(state, callee, decl)))
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
        setStateEvent(tmpState, leftDecl, leftr);
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
          setStateEvent(tmpState, rightDecl, rightr);
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
        setStateEvent(tmpState, leftDecl, singletonRemoved);
        return tmpState;
      }
      return null;
    };
    const apply = (truthy: boolean) => {
      switch (event.kind) {
        case FlowKind.LEFT_EQ_RIGHT_DECL:
        case FlowKind.LEFT_NE_RIGHT_DECL: {
          const left = getStateEvent(curState, event.left);
          const right = getStateEvent(curState, event.right_decl);
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
          const left = getStateEvent(curState, event.left);
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
          const left = getStateEvent(curState, event.left);
          if (!left) return null;
          if (truthy === (event.kind === FlowKind.LEFT_TRUTHY)) {
            if (left.type & (TypeTag.Null | TypeTag.False)) {
              // left evaluates as true, so remove null, false
              const singletonRemoved = cloneType(left);
              singletonRemoved.type &= ~(TypeTag.Null | TypeTag.False);
              if (singletonRemoved.type === TypeTag.Never) return false;
              const tmpState = new Map(curState);
              setStateEvent(tmpState, event.left, singletonRemoved);
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
            setStateEvent(tmpState, event.left, nonNullRemoved);
            return tmpState;
          }
          break;
        }
        case FlowKind.INSTANCEOF:
        case FlowKind.NOTINSTANCE: {
          const left = getStateEvent(curState, event.left);
          let right = getStateEvent(curState, event.right_decl);
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
            setStateEvent(tmpState, event.left, result);
            return tmpState;
          }
        }
      }
      return null;
    };

    const sTrue = apply(true);
    const sFalse = apply(false);
    if (sTrue == null && sFalse == null) {
      return false;
    }

    const trueSucc = top.succs![0] as TypeFlowBlock;
    const falseSucc = top.succs![1] as TypeFlowBlock;
    if (sTrue !== false) {
      if (logThisRun) {
        console.log(`  Flow:`);
        printBlockState(top, sTrue || curState);
        console.log(`  merge to: ${trueSucc.order || -1}`);
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
    if (sFalse !== false) {
      if (logThisRun) {
        console.log(`  Flow:`);
        printBlockState(top, sFalse || curState);
        console.log(`  merge to: ${falseSucc.order || -1}`);
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

  blockStates[0] = new Map();
  const head = blockStates[0];
  // set the parameters to their initial types
  func.node.params.forEach((param) => {
    setStateEvent(
      head,
      param,
      param.type === "BinaryExpression"
        ? typeFromTypespec(state, param.right)
        : { type: TypeTag.Any }
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
        if (event.mayThrow && top.exsucc) {
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
          case "ref": {
            const curType = getStateEvent(curState, event.decl);
            if (!curType) {
              typeMap.delete(event.node);
              break;
            }
            if (logThisRun) {
              console.log(`  ${describeEvent(event)} == ${display(curType)}`);
            }
            typeMap.set(event.node, curType);
            break;
          }
          case "mod": {
            if (logThisRun) {
              console.log(`  ${describeEvent(event)}`);
            }
            curState.forEach((type, decl) => {
              if (
                event.callees === undefined ||
                modifiableDecl(decl, event.callees)
              ) {
                curState.set(decl, typeConstraint(decl));
              } else if (
                type.value != null &&
                !every(event.callees, (callee) => callee.info === false)
              ) {
                if (type.type & (TypeTag.Array | TypeTag.Dictionary)) {
                  // Arrays and dictionaries are reference types, so until
                  // we try to track side effects, just drop any type knowledge
                  // about their contents, that doesn't come from the type
                  // constraint.
                  type = cloneType(type);
                  const constraint = typeConstraint(decl);
                  const adtype = {
                    type: type.type & (TypeTag.Array | TypeTag.Dictionary),
                  } as const;
                  const source =
                    constraint.value != null &&
                    constraint.type &
                      type.type &
                      (TypeTag.Array | TypeTag.Dictionary)
                      ? intersection(adtype, constraint)
                      : adtype;
                  unionInto(type, source);
                  curState.set(decl, type);
                }
                if (type.type & TypeTag.Object) {
                  const odata = getObjectValue(type);
                  if (odata?.obj) {
                    type = cloneType(type);
                    const newData = { klass: odata.klass };
                    setUnionComponent(type, TypeTag.Object, newData);
                    curState.set(decl, type);
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
              const beforeType = getStateEvent(curState, event.decl);
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
            if (setStateEvent(curState, event.decl, type)) {
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
                  curState.set(decls, typeConstraint(decls));
                }
              });
            }
            if (logThisRun) {
              console.log(`  ${describeEvent(event)} := ${display(type)}`);
            }
            break;
          }
          case "flw": {
            if (i !== top.events.length - 1) {
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
                        curState.get(event.left.base) || {
                          type: TypeTag.Any,
                        }
                      )} :: `
                    : ""
                }${display(getStateEvent(curState, event.left))}`
              );
            }
            if (handleFlowEvent(event, top, curState)) {
              successorsHandled = true;
            }
          }
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

  if (logging && process.env["TYPEFLOW_FUNC"] === func.fullName) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockState(block, blockStates[block.order!]);
      printBlockEvents(block, typeMap);
      printBlockTrailer(block);
    });

    console.log("====== TypeMap =====");
    typeMap.forEach((value, key) => {
      console.log(`${formatAst(key)} = ${display(value)}`);
    });
  }

  return istate;
}
