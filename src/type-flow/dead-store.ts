import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { withLoc } from "../ast";
import { unused } from "../inliner";
import { formatAst, traverseAst } from "../api";
import { getPostOrder } from "../control-flow";
import { DataflowQueue, DefEvent } from "../data-flow";
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

export function findDeadStores(graph: TypeFlowBlock, logThisRun: boolean) {
  const order = getPostOrder(graph) as TypeFlowBlock[];
  order.forEach((block, i) => {
    block.order = i;
  });

  const blockStates: Array<Set<TypeStateKey>> = [];

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
    order.flatMap((block) =>
      block.events
        ? block.events
            .filter(
              (event): event is DefEvent =>
                event.type === "def" && declIsLocal(event.decl)
            )
            .map((def) => def.decl as TypeStateKey)
        : []
    )
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
              ((event.node.type === "AssignmentExpression" &&
                event.node.operator === "=") ||
                (event.node.type === "VariableDeclarator" && event.node.init))
            ) {
              if (curState.has(event.decl)) {
                deadStores.add(event.node);
              } else {
                deadStores.delete(event.node);
              }
              curState.add(event.decl);
              if (logThisRun) {
                console.log(`  anticipated => ${tsKey(event.decl)}`);
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
  return deadStores;
}

export function eliminateDeadStores(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  logThisRun: boolean
) {
  const deadStores = findDeadStores(graph, logThisRun);
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
      if (body.length) {
        return withLoc({ type: "BlockStatement", body }, node, node);
      }
      changes = true;
      return false;
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
