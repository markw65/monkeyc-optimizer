import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, getSuperClasses, isLocal, isStateNode } from "./api";
import { getPostOrder } from "./control-flow";
import {
  buildDataFlowGraph,
  DataFlowBlock as TypeFlowBlock,
  DataflowQueue,
  declFullName,
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
  StateNodeDecl,
} from "./optimizer-types";
import { evaluate, InterpState, TypeMap } from "./type-flow/interp";
import {
  intersection,
  restrictByEquality,
} from "./type-flow/intersection-type";
import {
  cloneType,
  display,
  ExactOrUnion,
  getObjectValue,
  getStateNodeDeclsFromType,
  isExact,
  ObjectLikeTagsConst,
  SingleTonTypeTagsConst,
  typeFromLiteral,
  typeFromTypespec,
  typeFromTypeStateNode,
  TypeTag,
} from "./type-flow/types";
import { clearValuesUnder, unionInto } from "./type-flow/union-type";
import { forEach, map, reduce, some } from "./util";

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

type TypeState = Map<EventDecl, ExactOrUnion>;

function mergeTypeState(
  blockStates: TypeState[],
  index: number,
  from: TypeState
) {
  const to = blockStates[index];
  if (!to) {
    blockStates[index] = new Map(from);
    return true;
  }
  let changes = false;
  from.forEach((v, k) => {
    const tov = to.get(k);
    let result;
    if (tov) {
      if (!unionInto((result = cloneType(tov)), v)) return;
    } else {
      result = v;
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

function printBlockEvents(block: TypeFlowBlock, typeMap?: TypeMap) {
  console.log("Events:");
  forEach(
    block.events,
    (event) =>
      event.type !== "exn" &&
      console.log(
        `    ${event.type}: ${
          event.type === "flw"
            ? formatAst(event.node)
            : event.decl
            ? declFullName(event.decl)
            : "??"
        } ${
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

function printBlockState(block: TypeFlowBlock, state: TypeState) {
  console.log("State:");
  if (!state) {
    console.log("Not visited!");
    return;
  }
  state.forEach((value, key) => {
    console.log(
      ` - ${map(key, (k) => {
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
      }).join("|")} = ${display(value)}`
    );
  });
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

  if (logging && process.env["TYPEFLOW_FUNC"] === func.fullName) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockEvents(block);
      printBlockTrailer(block);
    });
  }

  const blockStates: TypeState[] = [];

  const typeMap = new Map<mctree.Node, ExactOrUnion>();
  const istate: InterpState = {
    state,
    typeMap,
    stack: [],
  };

  const modifiableDecl = (decls: EventDecl, callees?: ModEvent["callees"]) =>
    some(
      decls,
      (decl) =>
        decl.type === "VariableDeclarator" &&
        decl.node.kind === "var" &&
        !isLocal(decl) &&
        (!callees ||
          callees.some((callee) => functionMayModify(state, callee, decl)))
    );

  const declInitVal = (decls: EventDecl) => {
    return reduce<StateNodeDecl | mctree.Literal, ExactOrUnion>(
      decls,
      (result, decl) => {
        if (decl.type === "Identifier" || decl.type === "BinaryExpression") {
          // It looks like this can happen due to catch clauses
          // throw new Error(`Internal error: Unexpected function parameter`);
          unionInto(result, { type: TypeTag.Any });
          return result;
        }
        const declType =
          decl.type === "Literal"
            ? typeFromLiteral(decl)
            : typeFromTypeStateNode(state, decl, true);

        unionInto(result, declType);

        return result;
      },
      { type: TypeTag.Never }
    );
  };

  const mergeSuccState = (top: TypeFlowBlock, curState: TypeState) => {
    top.succs?.forEach((succ: TypeFlowBlock) => {
      if (succ.order == null) {
        throw new Error("Unreachable block was visited");
      }
      if (mergeTypeState(blockStates, succ.order, curState)) {
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
        tmpState.set(leftDecl, leftr);
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
          tmpState.set(rightDecl, rightr);
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
        tmpState.set(event.left, singletonRemoved);
        return tmpState;
      }
      return null;
    };
    const apply = (truthy: boolean) => {
      switch (event.kind) {
        case FlowKind.LEFT_EQ_RIGHT_DECL:
        case FlowKind.LEFT_NE_RIGHT_DECL: {
          const left = curState.get(event.left);
          const right = curState.get(event.right_decl);
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
          const left = curState.get(event.left);
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
          const left = curState.get(event.left);
          if (!left) return false;
          if (truthy === (event.kind === FlowKind.LEFT_TRUTHY)) {
            if (left.type & (TypeTag.Null | TypeTag.False)) {
              // left evaluates as true, so remove null, false
              const singletonRemoved = cloneType(left);
              singletonRemoved.type &= ~(TypeTag.Null | TypeTag.False);
              if (singletonRemoved.type === TypeTag.Never) return false;
              const tmpState = new Map(curState);
              tmpState.set(event.left, singletonRemoved);
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
            tmpState.set(event.left, nonNullRemoved);
            return tmpState;
          }
          break;
        }
        case FlowKind.INSTANCEOF:
        case FlowKind.NOTINSTANCE: {
          const left = curState.get(event.left);
          let right = curState.get(event.right_decl);
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
            tmpState.set(event.left, result);
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
    if (
      sTrue !== false &&
      mergeTypeState(blockStates, trueSucc.order!, sTrue || curState)
    ) {
      queue.enqueue(trueSucc);
    }
    if (
      sFalse !== false &&
      mergeTypeState(blockStates, falseSucc.order!, sFalse || curState)
    ) {
      queue.enqueue(falseSucc);
    }
    return true;
  }

  const head = (blockStates[0] = new Map());
  // set the parameters to their initial types
  func.node.params.forEach((param) => {
    head.set(
      param,
      param.type === "BinaryExpression"
        ? typeFromTypespec(state, param.right)
        : { type: TypeTag.Any }
    );
  });

  // set every other modifiable (ie non-local variables that
  // could be affected by "mod" events) decl to its initial
  // value too.
  order.forEach((block) => {
    forEach(block.events, (event) => {
      if (
        event.type === "ref" &&
        !head.has(event.decl) &&
        modifiableDecl(event.decl)
      ) {
        head.set(event.decl, declInitVal(event.decl));
      }
    });
  });

  queue.enqueue(order[0]);

  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }
    if (!blockStates[top.order]) continue;
    const curState = new Map(blockStates[top.order]);
    let successorsHandled = false;
    if (top.events) {
      for (let i = 0; i < top.events.length; i++) {
        const event = top.events[i];
        if (event.mayThrow && top.exsucc) {
          if (
            mergeTypeState(
              blockStates,
              (top.exsucc as TypeFlowBlock).order!,
              curState
            )
          ) {
            queue.enqueue(top.exsucc);
          }
        }
        switch (event.type) {
          case "ref": {
            let curType = curState.get(event.decl);
            if (!curType) {
              curState.set(event.decl, (curType = declInitVal(event.decl)));
            }
            typeMap.set(event.node, curType!);
            break;
          }
          case "mod": {
            curState.forEach((type, decls) => {
              if (
                event.callees !== undefined &&
                modifiableDecl(decls, event.callees)
              ) {
                curState.set(decls, declInitVal(decls));
              } else if (
                type.type & (TypeTag.Array | TypeTag.Dictionary) &&
                type.value != null
              ) {
                // Arrays and dictionaries are reference types, so until
                // we try to track side effects, just drop any type knowledge
                // about their contents
                const newType = cloneType(type);
                unionInto(newType, {
                  type: type.type & (TypeTag.Array | TypeTag.Dictionary),
                });
                curState.set(decls, newType);
              }
            });
            break;
          }
          case "def": {
            const beforeType = curState.get(event.decl);
            const lval =
              event.node.type === "UpdateExpression"
                ? event.node.argument
                : event.node.type === "AssignmentExpression"
                ? event.node.left
                : null;
            if (beforeType && lval) {
              typeMap.set(lval, beforeType);
            }
            const expr: mctree.Expression | null =
              event.node.type === "VariableDeclarator"
                ? event.node.init || null
                : event.node;
            if (expr) {
              const type = evaluate(istate, expr);
              curState.set(event.decl, type.value);
            } else {
              curState.set(event.decl, { type: TypeTag.Any });
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
            if (handleFlowEvent(event, top, curState)) {
              successorsHandled = true;
            }
          }
        }
      }
    }

    if (!successorsHandled) {
      mergeSuccState(top, curState);
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
