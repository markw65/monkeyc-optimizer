import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, isLocal, isStateNode } from "./api";
import { getPostOrder } from "./control-flow";
import {
  buildDataFlowGraph,
  DataFlowBlock as TypeFlowBlock,
  DataflowQueue,
  declFullName,
  EventDecl,
  ModEvent,
} from "./data-flow";
import { functionMayModify } from "./function-info";
import {
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNodeDecl,
} from "./optimizer-types";
import { evaluate, InterpState, TypeMap } from "./type-flow/interp";
import {
  cloneType,
  display,
  ExactOrUnion,
  typeFromLiteral,
  typeFromTypespec,
  typeFromTypeStateNode,
  TypeTag,
} from "./type-flow/types";
import { unionInto } from "./type-flow/union-type";
import { forEach, map, reduce, some } from "./util";

const logging = true;

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

function mergeTypeState(to: TypeState, from: TypeState) {
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
  forEach(
    block.events,
    (event) =>
      event.type !== "exn" &&
      console.log(
        `    ${event.type}: ${event.decl ? declFullName(event.decl) : "??"} ${
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
  state.forEach((value, key) => {
    console.log(
      `${map(key, (k) => {
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

  const blockStates = order.map((block, i) => {
    block.order = i;
    queue.enqueue(block);
    return new Map() as TypeState;
  });

  if (logging && process.env["TYPEFLOW_FUNC"] === func.fullName) {
    order.forEach((block) => {
      printBlockHeader(block);
      printBlockEvents(block);
      printBlockTrailer(block);
    });
  }

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

  const head = blockStates[0];
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

  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }

    const curState = new Map(blockStates[top.order]);

    if (top.events) {
      for (let i = 0; i < top.events.length; i++) {
        const event = top.events[i];
        if (event.mayThrow && top.exsucc) {
          const succState = blockStates[(top.exsucc as TypeFlowBlock).order!];
          if (succState) {
            if (mergeTypeState(succState, curState)) {
              queue.enqueue(top.exsucc);
            }
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
        }
      }
    }

    top.succs?.forEach((succ: TypeFlowBlock) => {
      if (succ.order == null) {
        throw new Error("Unreachable block was visited");
      }
      if (mergeTypeState(blockStates[succ.order], curState)) {
        queue.enqueue(succ);
      }
    });
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
