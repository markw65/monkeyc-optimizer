import { mctree } from "@markw65/prettier-plugin-monkeyc";
import assert from "node:assert";
import { formatAstLongLines, traverseAst } from "../api";
import { withLoc } from "../ast";
import { getPostOrder } from "../control-flow";
import { DataflowQueue, DefEvent, RefNode } from "../data-flow";
import { unused } from "../inliner";
import { FunctionStateNode, ProgramStateAnalysis } from "../optimizer-types";
import { NodeEquivMap } from "../type-flow";
import { log } from "../util";
import { variableCleanup } from "./minimize-locals";
import {
  TypeFlowBlock,
  TypeStateKey,
  declIsLocal,
  describeEvent,
  isTypeStateKey,
  printBlockHeader,
  sourceLocation,
  tsKey,
} from "./type-flow-util";

export type CopyPropStores = Map<
  mctree.Node,
  { ref: mctree.Node; ant: boolean }
>;

type NodeConflictsMap = Map<mctree.Node, Set<TypeStateKey>>;

type AntMap = Map<TypeStateKey, mctree.Identifier | false>;
type DeadState = {
  dead: Set<TypeStateKey>;
  anticipated?: AntMap;
  partiallyAnticipated?: AntMap;
};

function cloneAnt(antMap: AntMap) {
  return new Map(antMap);
}

function addAnt(antMap: AntMap, decl: TypeStateKey, node: mctree.Node) {
  assert(node.type === "Identifier");
  const ant = antMap.get(decl);
  if (ant === false || ant === node) return;
  if (ant === undefined) {
    antMap.set(decl, node);
  } else {
    antMap.set(decl, false);
  }
}

function cloneState(blockState: DeadState) {
  const clone: DeadState = { dead: new Set(blockState.dead) };
  if (blockState.anticipated) {
    clone.anticipated = cloneAnt(blockState.anticipated);
  }
  if (blockState.partiallyAnticipated) {
    clone.partiallyAnticipated = cloneAnt(blockState.partiallyAnticipated);
  }
  return clone;
}

export function findDeadStores(
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  nodeEquivs: NodeEquivMap | null,
  findCopyPropCandidates: boolean,
  logThisRun: boolean
) {
  const order = getPostOrder(graph) as TypeFlowBlock[];
  order.forEach((block, i) => {
    block.order = i;
  });

  const blockStates: Array<DeadState> = [];
  const nodeConflicts: NodeConflictsMap | null = nodeEquivs && new Map();

  const mergeStates = (to: DeadState, from: DeadState) => {
    let changed = Array.from(to.dead).reduce((changed, decl) => {
      if (!from.dead.has(decl)) {
        to.dead.delete(decl);
        changed = true;
      }
      return changed;
    }, false);
    if (to.anticipated) {
      if (!from.anticipated) {
        delete to.anticipated;
        changed = true;
      } else {
        changed = Array.from(to.anticipated).reduce(
          (changed, [decl, toant]) => {
            const fromant = from.anticipated!.get(decl);
            if (toant !== fromant) {
              to.anticipated!.delete(decl);
              changed = true;
            }
            return changed;
          },
          changed
        );
      }
    }
    if (from.partiallyAnticipated) {
      if (!to.partiallyAnticipated) {
        to.partiallyAnticipated = cloneAnt(from.partiallyAnticipated);
        changed = true;
      } else {
        changed = Array.from(from.partiallyAnticipated).reduce(
          (changed, [decl, fromant]) => {
            const toant = to.partiallyAnticipated!.get(decl);
            if (toant === undefined) {
              to.partiallyAnticipated!.set(decl, fromant);
              changed = true;
            } else {
              if (toant !== fromant) {
                changed = true;
                to.partiallyAnticipated!.set(decl, false);
              }
            }
            return changed;
          },
          changed
        );
      }
    }
    return changed;
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
  const copyPropStores: CopyPropStores = new Map();

  const copyPropRef = (
    curState: DeadState,
    key: TypeStateKey,
    node: RefNode
  ) => {
    if (findCopyPropCandidates && declIsLocal(key)) {
      if (!curState.anticipated) {
        curState.anticipated = new Map();
      }
      addAnt(curState.anticipated, key, node);
      if (!curState.partiallyAnticipated) {
        curState.partiallyAnticipated = new Map();
      }
      addAnt(curState.partiallyAnticipated, key, node);
      if (logThisRun) {
        log(
          `  antrefs: ${curState.partiallyAnticipated.get(key) !== false} ${
            curState.anticipated.get(key) !== false
          }`
        );
      }
    }
  };
  order.forEach((block) => {
    if (!block.succs) {
      queue.enqueue(block);
      blockStates[block.order!] = { dead: new Set(locals) };
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
    const curState = cloneState(blockStates[top.order]);
    if (logThisRun) {
      printBlockHeader(top);
      curState.dead.forEach((decl) => log(` - anticipated: ${tsKey(decl)}`));
    }
    if (top.events) {
      for (let i = top.events.length; i--; ) {
        const event = top.events[i];
        if (top.exsucc && event.mayThrow) {
          // Suboptimal. Currently we merge both the regular and exceptional
          // successors back into each block's state. Instead, we could keep
          // them separate and merge from the exceptional state here. Or only
          // merge the regular state, and keep an inState for each block, and
          // merge from top.exsucc's inState here.
          mergeStates(curState, blockStates[(top as TypeFlowBlock).order!]);
        }
        switch (event.type) {
          case "ref":
            if (isTypeStateKey(event.decl)) {
              if (logThisRun) {
                log(
                  describeEvent(event).then(
                    (eventStr) =>
                      `${eventStr} (${sourceLocation(event.node.loc)})`
                  )
                );
                log(`  kill => ${tsKey(event.decl)}`);
              }
              copyPropRef(curState, event.decl, event.node);
              curState.dead.delete(event.decl);
            }
            break;
          case "def":
            if (
              isTypeStateKey(event.decl) &&
              (event.node.type !== "VariableDeclarator" || event.node.init)
            ) {
              if (logThisRun) {
                log(
                  describeEvent(event).then(
                    (eventStr) =>
                      `${eventStr} (${sourceLocation(event.node.loc)})`
                  )
                );
              }
              const assignNode =
                (event.node.type === "AssignmentExpression" &&
                  event.node.operator === "=" &&
                  event.node.right) ||
                (event.node.type === "VariableDeclarator" && event.node.init);

              if (curState.dead.has(event.decl)) {
                deadStores.add(event.node);
              } else {
                deadStores.delete(event.node);
                copyPropStores.delete(event.node);
                if (declIsLocal(event.decl) && curState.partiallyAnticipated) {
                  const pant = curState.partiallyAnticipated.get(event.decl);
                  if (pant) {
                    if (logThisRun) {
                      log(
                        `  is copy-prop-candidate ${
                          curState.anticipated?.get(event.decl) === pant
                        }`
                      );
                    }
                    copyPropStores.set(event.node, {
                      ref: pant,
                      ant: curState.anticipated?.get(event.decl) === pant,
                    });
                  }
                  curState.partiallyAnticipated.delete(event.decl);
                  curState.anticipated?.delete(event.decl);
                }
              }
              if (nodeConflicts) {
                const conflicts = new Set(locals);
                curState.dead.forEach((dead) => conflicts.delete(dead));
                if (event.rhs) {
                  conflicts.delete(event.rhs as TypeStateKey);
                  const equiv = assignNode && nodeEquivs!.get(assignNode);
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
              if (assignNode) {
                curState.dead.add(event.decl);
                if (logThisRun) {
                  log(`  anticipated => ${tsKey(event.decl)}`);
                }
              } else if (event.node.type === "UpdateExpression") {
                copyPropRef(curState, event.decl, event.node.argument);
              }
            }
            break;
          case "kil":
            if (isTypeStateKey(event.decl)) {
              curState.dead.add(event.decl);
              if (logThisRun) {
                log(`  anticipated => ${tsKey(event.decl)}`);
              }
            }
            break;
          case "mod":
            curState.dead.forEach(
              (decl) => declIsLocal(decl) || curState.dead.delete(decl)
            );
            break;
          case "flw":
            break;
        }
      }
    }
    const doMerge = (pred: TypeFlowBlock) => {
      if (pred.order == null) {
        // this block is unreachable on a forward walk, so don't try to merge
        // into it, or enqueue it
        return;
      }
      const pi = pred.order;
      if (!blockStates[pi]) {
        blockStates[pi] = cloneState(curState);
        queue.enqueue(pred);
      } else if (mergeStates(blockStates[pi], curState)) {
        queue.enqueue(pred);
      }
    };
    top.preds?.forEach(doMerge);
    top.expreds?.forEach(doMerge);
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
  return { deadStores, locals, localConflicts, copyPropStores };
}

export function eliminateDeadStores(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  graph: TypeFlowBlock,
  logThisRun: boolean
): { changes: boolean; copyPropStores: CopyPropStores } {
  const { deadStores, copyPropStores } = findDeadStores(
    func,
    graph,
    null,
    state.config?.singleUseCopyProp ?? true,
    logThisRun
  );
  if (!deadStores.size) return { changes: false, copyPropStores };
  if (logThisRun) {
    log("====== Dead Stores =====");
    deadStores.forEach(
      (dead) =>
        (dead.type === "AssignmentExpression" ||
          dead.type === "UpdateExpression" ||
          dead.type === "VariableDeclarator") &&
        log(
          formatAstLongLines(dead).then(
            (deadStr) => `${deadStr} (${sourceLocation(dead.loc)})`
          )
        )
    );
  }
  let changes = false;
  traverseAst(func.node.body!, null, (node) => {
    const cleaned = variableCleanup(node);
    if (cleaned !== null) return cleaned;
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

    if (node.type === "VariableDeclarator") {
      const decl = node;
      if (decl.init && deadStores.has(decl)) {
        const body = unused(state, decl.init);
        delete decl.init;
        changes = true;
        if (!body.length) {
          return null;
        }
        body.unshift(decl as unknown as mctree.Statement);
        return body;
      }
    }
    return null;
  });

  return { copyPropStores, changes };
}
