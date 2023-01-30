import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { NodeEquivMap } from "src/type-flow";
import { formatAst, traverseAst } from "../api";
import { withLoc } from "../ast";
import { getPostOrder } from "../control-flow";
import { DataflowQueue, DefEvent } from "../data-flow";
import { unused } from "../inliner";
import { FunctionStateNode, ProgramStateAnalysis } from "../optimizer-types";
import {
  declIsLocal,
  isTypeStateKey,
  printBlockHeader,
  sourceLocation,
  tsKey,
  TypeFlowBlock,
  TypeStateKey,
} from "./type-flow-util";

type NodeConflictsMap = Map<mctree.Node, Set<TypeStateKey>>;

export function findDeadStores(
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  nodeEquivs: NodeEquivMap | null,
  logThisRun: boolean
) {
  const order = getPostOrder(graph) as TypeFlowBlock[];
  order.forEach((block, i) => {
    block.order = i;
  });

  const blockStates: Array<Set<TypeStateKey>> = [];
  const nodeConflicts: NodeConflictsMap | null = nodeEquivs && new Map();

  const mergeStates = (to: Set<TypeStateKey>, from: Set<TypeStateKey>) => {
    return Array.from(to).reduce((changed, decl) => {
      if (!from.has(decl)) {
        to.delete(decl);
        changed = true;
      }
      return changed;
    }, false);
  };

  const queue = new DataflowQueue();

  const locals = new Set(
    order
      .flatMap((block) =>
        block.events
          ? block.events
              .filter(
                (event): event is DefEvent =>
                  event.type === "def" && declIsLocal(event.decl)
              )
              .map((def) => def.decl as TypeStateKey)
          : []
      )
      .concat(func.node.params)
  );

  const deadStores = new Set<mctree.Node>();

  order.forEach((block) => {
    if (!block.succs) {
      queue.enqueue(block);
      blockStates[block.order!] = new Set(locals);
    }
  });
  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }
    if (!blockStates[top.order]) {
      throw new Error(`Block ${top.order || 0} had no state!`);
    }
    const curState = new Set(blockStates[top.order]);
    if (logThisRun) {
      printBlockHeader(top);
      curState.forEach((decl) => console.log(` - anticipated: ${tsKey(decl)}`));
    }
    if (top.events) {
      for (let i = top.events.length; i--; ) {
        const event = top.events[i];
        if (top.exsucc && event.mayThrow) {
          const from = blockStates[(top.exsucc as TypeFlowBlock).order!];
          if (!from) {
            throw new Error(`exsucc was not visited`);
          }
          mergeStates(
            curState,
            blockStates[(top.exsucc as TypeFlowBlock).order!]
          );
        }
        switch (event.type) {
          case "ref":
            if (isTypeStateKey(event.decl)) {
              curState.delete(event.decl);
              if (logThisRun) {
                console.log(`  kill => ${tsKey(event.decl)}`);
              }
            }
            break;
          case "def":
            if (
              isTypeStateKey(event.decl) &&
              (event.node.type !== "VariableDeclarator" || event.node.init)
            ) {
              if (curState.has(event.decl)) {
                deadStores.add(event.node);
              } else {
                deadStores.delete(event.node);
              }
              if (nodeConflicts) {
                const conflicts = new Set(locals);
                curState.forEach((dead) => conflicts.delete(dead));
                if (event.rhs) {
                  conflicts.delete(event.rhs as TypeStateKey);
                  const equiv =
                    event.node.type === "AssignmentExpression" &&
                    event.node.operator === "="
                      ? nodeEquivs!.get(event.node.right)
                      : event.node.type === "VariableDeclarator" &&
                        event.node.init
                      ? nodeEquivs!.get(event.node.init)
                      : null;
                  if (equiv) {
                    equiv.equiv.forEach(
                      (e) => isTypeStateKey(e) && conflicts.delete(e)
                    );
                    isTypeStateKey(equiv.decl) && conflicts.delete(equiv.decl);
                  }
                }
                conflicts.add(event.decl);
                nodeConflicts.set(event.node, conflicts);
              }
              if (
                (event.node.type === "AssignmentExpression" &&
                  event.node.operator === "=") ||
                (event.node.type === "VariableDeclarator" && event.node.init)
              ) {
                curState.add(event.decl);
                if (logThisRun) {
                  console.log(`  anticipated => ${tsKey(event.decl)}`);
                }
              }
            }
            break;
          case "kil":
            if (isTypeStateKey(event.decl)) {
              curState.add(event.decl);
              if (logThisRun) {
                console.log(`  anticipated => ${tsKey(event.decl)}`);
              }
            }
            break;
          case "mod":
            curState.forEach(
              (decl) => declIsLocal(decl) || curState.delete(decl)
            );
            break;
          case "flw":
            break;
        }
      }
    }
    const doMerge = (pred: TypeFlowBlock) => {
      const pi = pred.order || 0;
      if (!blockStates[pi]) {
        blockStates[pi] = new Set(curState);
        queue.enqueue(pred);
      } else if (mergeStates(blockStates[pi], curState)) {
        queue.enqueue(pred);
      }
    };
    top.preds?.forEach(doMerge);
    if (top.bogopred) {
      // Make sure we don't kill stores that would result in
      // garmin's (incorrect) "variable may be uninitialized"
      // error.
      doMerge(top.bogopred);
    }
  }

  let localConflicts: Map<TypeStateKey, Set<TypeStateKey>> | null = null;
  if (nodeConflicts) {
    localConflicts = new Map();
    const addConflicts = (
      conflict: TypeStateKey,
      conflicts: Set<TypeStateKey> | Array<TypeStateKey>
    ) => {
      let set = localConflicts!.get(conflict);
      if (set) {
        conflicts.forEach((c) => c !== conflict && set!.add(c));
      } else {
        set = new Set(conflicts);
        set.delete(conflict);
        localConflicts!.set(conflict, set);
      }
    };
    nodeConflicts.forEach((conflicts) =>
      conflicts.forEach((conflict) => addConflicts(conflict, conflicts))
    );
    func.node.params.forEach((param, index, arr) => addConflicts(param, arr));
  }
  return { deadStores, locals, localConflicts };
}

export function eliminateDeadStores(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  logThisRun: boolean
) {
  const { deadStores } = findDeadStores(func, graph, null, logThisRun);
  if (!deadStores.size) return false;
  if (logThisRun) {
    console.log("====== Dead Stores =====");
    deadStores.forEach((dead) =>
      console.log(`${formatAst(dead)} (${sourceLocation(dead.loc)})`)
    );
  }
  let changes = false;
  traverseAst(func.node.body!, null, (node, parent) => {
    if (
      node.type === "ExpressionStatement" &&
      node.expression.type === "AssignmentExpression" &&
      deadStores.has(node.expression)
    ) {
      const body = unused(state, node.expression.left).concat(
        unused(state, node.expression.right)
      );
      changes = true;
      if (body.length) {
        return withLoc({ type: "BlockStatement", body }, node, node);
      }
      return false;
    }

    if (node.type === "UpdateExpression" && deadStores.has(node)) {
      changes = true;
      return { type: "Literal", value: null, raw: "null" };
    }

    if (
      node.type === "AssignmentExpression" &&
      deadStores.has(node) &&
      unused(state, node.right, true)?.length === 0 &&
      unused(state, node.left, true)?.length === 0
    ) {
      changes = true;
      return { type: "Literal", value: null, raw: "null" };
    }

    if (node.type === "VariableDeclaration") {
      const result: mctree.Statement[] = [];
      for (let i = 0; i < node.declarations.length; i++) {
        const decl = node.declarations[i];
        if (decl.init && deadStores.has(decl)) {
          const body = unused(state, decl.init);
          if (body.length) {
            if (
              !parent ||
              (parent.type !== "BlockStatement" && parent.type !== "SwitchCase")
            ) {
              // Must be the init in a for statement. Fixing
              // it would be complicated, so just punt for now.
              break;
            }
            const newDeclaration = withLoc({ ...node }, node, decl.id);
            if (i + 1 < node.declarations.length) {
              newDeclaration.declarations = node.declarations.splice(0, i + 1);
              result.push(newDeclaration);
              withLoc(node, node.declarations[0], node);
              i = -1;
            } else {
              result.push(node);
            }
            result.push(...body);
          }
          changes = true;
          delete decl.init;
        }
      }
      if (result.length) {
        if (!result.includes(node)) {
          result.push(node);
        }
        return result;
      }
    }
    return null;
  });

  return changes;
}
