import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAstLongLines } from "./api";
import { isStatement, traverseAst, withLoc, withLocDeep } from "./ast";
import { getPostOrder, postOrderTraverse } from "./control-flow";
import {
  DataflowQueue,
  Event,
  EventDecl,
  ModEvent,
  DataFlowBlock as PREBlock,
  RefNode,
  buildDataFlowGraph,
  declFullName,
  declName,
} from "./data-flow";
import { cloneSet, functionMayModify, mergeSet } from "./function-info";
import { FunctionStateNode, ProgramStateAnalysis } from "./optimizer-types";
import { minimizeLocals } from "./type-flow/minimize-locals";
import { AwaitedError, every, log, some } from "./util";

/**
 * This implements a pseudo Partial Redundancy Elimination
 * pass. It isn't quite like traditional PRE because we're
 * aiming to minimize size, not dynamic instructions. So
 * for us, its worthwhile to take something like:
 *
 * switch (x) {
 *   case 1: foo(A.B); break;
 *   case 2: foo(C); break;
 *   case 3: bar(A.B); break;
 * }
 *
 * and rewrite it as
 *
 * var tmp = A.B;
 * switch (x) {
 *   case 1: foo(tmp); break;
 *   case 2: foo(C); break;
 *   case 3: bar(tmp); break;
 * }
 *
 * because even though A.B wasn't used on all paths where we
 * inserted the temporary, we still reduced the code size.
 */

const logging = false;

function logAntState(s: AnticipatedState, decl: EventDecl) {
  const defs = Array.from(s.ant).reduce<number>((defs, event) => {
    if (event.type === "def" || event.type === "mod") defs++;
    return defs;
  }, 0);
  log(
    declFullName(decl).then(
      (declStr) =>
        `  - ${declStr}: ${candidateCost(s)} bytes, ${
          s.ant.size - defs
        } refs, ${defs} defs, ${s.live ? "" : "!"}live, ${
          s.isIsolated ? "" : "!"
        }isolated`
    )
  );
  log(
    `    - members: ${Array.from(s.members)
      .map(([block, live]) => block.order! + (live ? "t" : "f"))
      .join(", ")}`
  );
}

function logAntDecls(antDecls: AnticipatedDecls) {
  antDecls.forEach(logAntState);
}

export async function sizeBasedPRE(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  if (!func.node.body) return;
  if (
    !state.config ||
    !state.config.sizeBasedPRE ||
    (typeof state.config.sizeBasedPRE === "string" &&
      state.config.sizeBasedPRE !== func.fullName)
  ) {
    return;
  }
  const { graph: head, identifiers } = buildPREGraph(state, func);
  const candidates = computeAttributes(state, head);
  if (candidates) {
    if (logging) {
      log(`Found ${candidates.size} candidates in ${func.fullName}`);
      logAntDecls(candidates);
    }
    const nodeMap = new Map<mctree.Node, Event[]>();
    const declMap = new Map<EventDecl, string>();
    const variableDecl = withLoc(
      {
        type: "VariableDeclaration",
        declarations: [],
        kind: "var",
      } as mctree.VariableDeclaration,
      func.node.body
    );
    variableDecl.end = variableDecl.start;
    variableDecl.loc!.end = variableDecl.loc!.start;
    const keys = Array.from(candidates.keys());
    const names = await Promise.all(keys.map((decl) => declFullName(decl)));
    keys
      .map((decl, i) => [names[i], decl] as const)
      .sort()
      .forEach(([, decl]) => {
        let name;
        let i = 0;
        do {
          name = `pre_${declName(decl)}${i ? "_" + i : ""}`;
          if (!identifiers.has(name)) {
            identifiers.add(name);
            break;
          }
          i++;
        } while (true);
        declMap.set(decl, name);
        const s = candidates.get(decl)!;
        variableDecl.declarations.push(
          withLoc(
            {
              type: "VariableDeclarator",
              id: withLoc({ type: "Identifier", name }, variableDecl),
              kind: "var",
            },
            variableDecl
          )
        );
        s.ant.forEach((event) => {
          const events = nodeMap.get(event.node);
          if (!events) {
            nodeMap.set(event.node, [event]);
          } else {
            events.push(event);
          }
        });
      });
    applyReplacements(func.node, nodeMap, declMap);
    func.node.body.body.unshift(variableDecl);
  }
  if (state.config?.minimizeLocals ?? true) {
    minimizeLocals(state, func);
  }
}

function buildPREGraph(state: ProgramStateAnalysis, func: FunctionStateNode) {
  const result = buildDataFlowGraph(
    state,
    func,
    (literal) =>
      !state.config?.preSkipLiterals && refCost(literal) > LocalRefCost,
    true,
    false
  );
  // Split blocks that contains refs and defs to the same thing,
  // to make it easier to pick and choose which refs are converted
  postOrderTraverse(result.graph, (block) => {
    if (!block.events) {
      return;
    }
    let modSeen = false;
    const refs = new Set<EventDecl>();
    const defs = new Set<EventDecl>();
    const splitBlock = (eventIndex: number) => {
      const newBlock = { ...block };
      delete newBlock.node;
      newBlock.events = block.events?.splice(eventIndex);
      newBlock.succs?.forEach((succ) => {
        const i = succ.preds!.findIndex((b) => b === block);
        succ.preds![i] = newBlock;
        if (succ.expreds?.includes(block)) {
          succ.expreds.push(newBlock);
        }
      });
      block.succs = [newBlock];
      newBlock.preds = [block];
      delete newBlock.expreds;
      modSeen = false;
      refs.clear();
      defs.clear();
    };
    for (let i = block.events.length; i--; ) {
      const event = block.events[i];
      switch (event.type) {
        case "ref":
          if (
            some(
              event.decl,
              (decl) =>
                decl.type === "Literal" ||
                (decl.type === "VariableDeclarator" &&
                  decl.node.kind === "const")
            )
          ) {
            break;
          }
          if (modSeen || defs.has(event.decl)) {
            splitBlock(i + 1);
          }
          refs.add(event.decl);
          break;
        case "def":
          if (refs.has(event.decl)) {
            splitBlock(i + 1);
          }
          defs.add(event.decl);
          break;
        case "mod":
          if (
            event.callees &&
            every(event.callees, (callee) => callee.info === false)
          ) {
            // calls known to have no side effects can be
            // dropped.
            block.events.splice(i, 1);
            break;
          }
          if (refs.size) {
            splitBlock(i + 1);
          }
          modSeen = true;
          break;
      }
    }
  });
  return result;
}

/**
 * AnticipatedEvents is the set of Ref, Def and Mod Events
 * for a particular EventDecl that may be visited starting
 * from a particular point in the program.
 */
type AnticipatedEvents = Set<Event>;
/**
 * AnticipatedState wraps an AnticipatedEvents set.
 *  - ant: the AnticipatedEvents
 *  - live: the set is live if one of its refs *may* occur
 *    prior to any of its defs.
 *  - node: the Identifier/MemberExpression that is associated
 *          with this state.
 *  - boundary: the set of predecessors of all live blocks in
 *    this state.
 */
type AnticipatedState = {
  ant: AnticipatedEvents;
  live: boolean;
  node: RefNode;
  members: Map<PREBlock, boolean>;
  head?: PREBlock;
  isIsolated?: true;
};
/**
 * AnticipatedDecls is a map from EventDecl to the
 * corresponding state.
 * We compute one of these maps per Block.
 */
type AnticipatedDecls = Map<EventDecl, AnticipatedState>;

function anticipatedDecls() {
  return new Map<EventDecl, AnticipatedState>();
}

function equalSet<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
function equalMap<T, U>(a: Map<T, U>, b: Map<T, U>) {
  if (a.size !== b.size) return false;
  for (const [item, value] of a) {
    if (b.get(item) !== value) return false;
  }
  return true;
}

function anticipatedState(
  node: RefNode,
  events?: AnticipatedEvents
): AnticipatedState {
  return { ant: events || new Set(), live: true, node, members: new Map() };
}

function cloneAnticipatedState(as: AnticipatedState): AnticipatedState {
  return {
    ant: cloneSet(as.ant),
    live: as.live,
    node: as.node,
    members: new Map(as.members),
  };
}

function mergeAnticipatedState(ae: AnticipatedState, be: AnticipatedState) {
  mergeSet(ae.ant, be.ant);
  be.members.forEach((live, block) => ae.members.set(block, live));
  if (be.live) ae.live = true;
}

function cloneAnticipatedDecls(ad: AnticipatedDecls) {
  const copy = anticipatedDecls();
  for (const [k, v] of ad) {
    if (!v.isIsolated) {
      copy.set(k, cloneAnticipatedState(v));
    }
  }
  return copy;
}

function mergeAnticipatedDecls(a: AnticipatedDecls, b: AnticipatedDecls) {
  for (const [k, v] of b) {
    if (v.isIsolated) continue;
    const ae = a.get(k);
    if (ae) {
      mergeAnticipatedState(ae, v);
    } else {
      a.set(k, cloneAnticipatedState(v));
    }
  }
}

function equalStates(a: AnticipatedDecls, b: AnticipatedDecls) {
  if (a.size !== b.size) return false;
  for (const [k, ae] of a) {
    const be = b.get(k);
    if (
      !be ||
      be.live !== ae.live ||
      be.isIsolated !== ae.isIsolated ||
      !equalSet(ae.ant, be.ant) ||
      !equalMap(ae.members, be.members)
    ) {
      return false;
    }
  }
  return true;
}

const LocalRefCost = 2;

function refCost(node: RefNode) {
  if (node.type === "Literal") {
    switch (typeof node.value) {
      case "bigint":
        return 9;
      case "string":
        return 5;
      case "number":
        return node.raw.match(/d/i) ? 9 : 5;
      case "boolean":
        return 2;
      default:
        if (node.value === null) {
          return 2;
        }
        return 0;
    }
  }
  // A read from a non-local identifier takes 8 bytes
  let cost = 8;
  if (node.type === "Identifier") return cost;
  while (true) {
    const next: mctree.Expression = node.object;
    if (next.type !== "MemberExpression") {
      if (next.type !== "ThisExpression") {
        cost += next.type === "Identifier" && next.name === "$" ? 4 : 6;
      }
      return cost;
    }
    node = next;
    cost += 6;
  }
}

function defCost(node: RefNode) {
  return refCost(node) + 2;
}

function candidateBoundary(candState: AnticipatedState) {
  const boundary: Set<PREBlock> = new Set();
  candState.members.forEach((live, block) => {
    if (live && block !== candState.head) {
      if (block.preds) {
        block.preds.forEach(
          (pred) => candState.members.has(pred) || boundary.add(pred)
        );
      }
    }
  });
  if (candState.live) {
    if (!candState.head) {
      throw new Error(`Missing head`);
    }
    boundary.add(candState.head);
  }
  return boundary;
}

function candidateCost(candState: AnticipatedState) {
  let cost = 0;
  candState.ant.forEach((event: Event) => {
    if (event.type === "ref") {
      cost -= refCost(candState.node) - LocalRefCost;
    } else {
      cost += defCost(candState.node);
    }
  });
  const boundarySize = candidateBoundary(candState).size;
  cost += defCost(candState.node) * boundarySize;
  return cost;
}

function computeAttributes(state: ProgramStateAnalysis, head: PREBlock) {
  const order = getPostOrder(head) as PREBlock[];
  order.forEach((block, i) => {
    block.order = i;
  });

  if (logging) {
    order.forEach((block) => {
      log(
        block.order,
        `(${block.node ? block.node.loc?.start.line : "??"})`,
        `Preds: ${(block.preds || [])
          .map((block) => (block as PREBlock).order)
          .join(", ")}`
      );
      if (block.events) {
        block.events.forEach(
          (event) =>
            event.type !== "exn" &&
            log(
              Promise.resolve(
                event.decl
                  ? declFullName(event.decl)
                  : event.node
                  ? formatAstLongLines(event.node)
                  : "??"
              ).then((eventDetails) => `    ${event.type}: ${eventDetails}`)
            )
        );
      }
      log(
        `Succs: ${(block.succs || [])
          .map((block) => (block as PREBlock).order)
          .join(", ")} ExSucc: ${
          block.exsucc ? (block.exsucc as PREBlock).order : ""
        }`
      );
    });
  }

  const queue = new DataflowQueue();
  const blockStates: AnticipatedDecls[] = [];

  /*
    Algorithm
    =========

    Process blocks in post-order, and the events in reverse
    order to collect the AnticipatedState at the start of each
    Block.

    Then for each EventDecl find the best starting block.
  */

  const modMap = new Map<Event, Map<EventDecl, Event>>();
  const getMod = (event: Event, decl: EventDecl, id: RefNode) => {
    if (id.type !== "Identifier" && id.type !== "MemberExpression") {
      throw new Error("Trying to modify a non-variable");
    }
    let eventMap = modMap.get(event);
    if (!eventMap) {
      modMap.set(event, (eventMap = new Map<EventDecl, Event>()));
    }
    let result = eventMap.get(decl);
    if (!result) {
      result = {
        type: "mod",
        node: event.node,
        decl,
        id,
        mayThrow: event.mayThrow,
      };
      eventMap.set(decl, result);
    }
    return result;
  };

  order.forEach((block) => queue.enqueue(block));
  while (!queue.empty()) {
    const top = queue.dequeue();
    if (top.order === undefined) {
      throw new Error(`Unreachable block was visited!`);
    }
    const curState =
      (top.succs &&
        top.succs.reduce<AnticipatedDecls | null>((blockState, succ) => {
          const succState = blockStates[(succ as PREBlock).order!];
          if (succState) {
            if (!blockState) {
              blockState = cloneAnticipatedDecls(succState);
            } else {
              mergeAnticipatedDecls(blockState, succState);
            }
          }
          return blockState;
        }, null)) ||
      anticipatedDecls();

    if (top.events) {
      for (let i = top.events.length; i--; ) {
        const event = top.events[i];
        if (event.mayThrow && top.exsucc) {
          const succState = blockStates[(top.exsucc as PREBlock).order!];
          if (succState) {
            mergeAnticipatedDecls(curState, succState);
          }
        }
        switch (event.type) {
          case "ref": {
            let candidates = curState.get(event.decl);
            if (!candidates) {
              candidates = anticipatedState(event.node);
              curState.set(event.decl, candidates);
            }
            candidates.ant.add(event);
            candidates.live = true;
            break;
          }
          case "mod": {
            curState.forEach((candidates, decls) => {
              if (
                some(
                  decls,
                  (decl) =>
                    decl.type === "VariableDeclarator" &&
                    decl.node.kind === "var" &&
                    candidates.live &&
                    (!event.callees ||
                      event.callees.some((callee) =>
                        functionMayModify(state, callee, decl)
                      ))
                )
              ) {
                candidates.ant.add(getMod(event, decls, candidates.node));
                candidates.live = false;
              }
            });
            break;
          }
          case "def": {
            let candidates = curState.get(event.decl);
            const isUpdate =
              event.node.type === "UpdateExpression" ||
              (event.node.type === "AssignmentExpression" &&
                event.node.operator !== "=");
            if (!candidates) {
              const target =
                event.node.type === "AssignmentExpression"
                  ? event.node.left
                  : event.node.type === "UpdateExpression"
                  ? (event.node.argument as mctree.AssignmentExpression["left"])
                  : event.node.id.type === "BinaryExpression"
                  ? event.node.id.left
                  : event.node.id;
              candidates = anticipatedState(target);
              curState.set(event.decl, candidates);
            }
            if (isUpdate || candidates.live) {
              candidates.ant.add(event);
            }
            candidates.live = isUpdate;
            break;
          }
        }
      }
    }

    curState.forEach((antState) => {
      antState.head = top;
      antState.members.set(top, antState.live);
      if (!antState.live && candidateBoundary(antState).size === 0) {
        // we found a group that's isolated from the rest
        // of the function. Don't merge it with earlier
        // refs and defs, because we can take it or leave
        // it based on its own cost.
        antState.isIsolated = true;
      }
    });

    const oldState = blockStates[top.order!];
    if (oldState && equalStates(oldState, curState)) {
      continue;
    }
    blockStates[top.order!] = curState;
    if (logging) {
      log(`Updated block ${top.order!}`);
      logAntDecls(curState);
    }
    if (top.preds) {
      top.preds.forEach((pred) => queue.enqueue(pred));
    }
  }

  const candidateDecls = anticipatedDecls();
  blockStates.forEach((blockState, i) => {
    blockState &&
      blockState.forEach((events, decl) => {
        const cost = candidateCost(events);
        if (cost >= 0) return;
        const existing = candidateDecls.get(decl);
        if (
          !existing ||
          existing.isIsolated ||
          candidateCost(existing) > cost
        ) {
          const boundary = candidateBoundary(events);
          if (
            !Array.from(boundary).every((block) => {
              if (block !== events.head && block.events) {
                if (events.node.type === "Literal") {
                  return false;
                }
                let i = block.events.length;
                while (i--) {
                  const event = block.events[i];
                  if (event.type === "def" || event.type === "mod") {
                    events.ant.add({
                      type: "mod",
                      node: event.node,
                      decl,
                      id: events.node,
                      mayThrow: false,
                    });
                    events.members.set(block, false);
                    return true;
                  }
                }
              }
              const node = block.node;
              if (!node) return false;
              events.ant.add({
                type: "mod",
                node: node.type === "FunctionDeclaration" ? node.body! : node,
                before: true,
                decl,
                id: events.node,
                mayThrow: false,
              });
              events.members.set(block, false);
              return true;
            })
          ) {
            return;
          }
          events.live = false;
          if (existing && existing.isIsolated) {
            delete existing.isIsolated;
            mergeAnticipatedState(events, existing);
          } else if (candidateCost(events) !== cost) {
            throw new Error(`cost of block ${i} changed`);
          }
          candidateDecls.set(decl, events);
        }
      });
  });
  if (candidateDecls.size) {
    return candidateDecls;
  }
  return null;
}

/*
 * Determine the cost of fixing a def under a statement.
 *
 * eg:
 *
 *   if (foo()) {
 *      bar(X.y);
 *   } else {
 *      baz(X.y);
 *   }
 *
 * Here, we could pull out X.y as a local, but if foo might modify
 * X.y, we have nowhere to insert the temporary. But we can rewrite
 * it as:
 *
 *   var tmp = foo();
 *   if (tmp) {
 *      bar(X.y);
 *   } else {
 *      baz(X.y);
 *   }
 *
 * and now we can insert a temporary before the if, but it costs
 * 4 bytes to do so.
 *
 * We can do the same for switch statements unless (ugh!)
 * the cases might modify the decl too.
 *
 * eg
 *
 *   switch (foo()) {
 *     case bar(): ...
 *   }
 *
 */
function _isFixableStmt(node: mctree.Node): false | number {
  switch (node.type) {
    case "IfStatement":
      return 4;
    case "SwitchStatement":
      if (
        node.cases.every(
          (c) =>
            !c.test ||
            c.test.type === "Literal" ||
            c.test.type === "Identifier" ||
            c.test.type === "InstanceOfCase" ||
            (c.test.type === "UnaryExpression" && c.test.operator === ":")
        )
      ) {
        return 4;
      }
      break;
  }
  return false;
}

function applyReplacements(
  func: mctree.FunctionDeclaration,
  nodeMap: Map<mctree.Node, Event[]>,
  declMap: Map<EventDecl, string>
) {
  const ident = (name: string, node: mctree.Node) => {
    return withLoc({ type: "Identifier", name }, node);
  };
  const pendingMap = new Map<mctree.Node, Set<ModEvent>>();
  const stmtStack: mctree.Node[] = [func];
  traverseAst(
    func,
    (node) => {
      if (isStatement(node)) {
        stmtStack.push(node);
      }
    },
    (node) => {
      const stmt = stmtStack[stmtStack.length - 1];
      if (stmt === node) stmtStack.pop();
      const events = nodeMap.get(node);
      if (events) {
        const ret = events.reduce<mctree.Node | null>((ret, event) => {
          if (event.type === "ref") {
            if (ret) {
              throw new Error(
                `ref found when there was already a replacement for this node`
              );
            }
            if (
              node.type !== "Identifier" &&
              node.type !== "MemberExpression" &&
              node.type !== "Literal"
            ) {
              throw new Error(
                `Ref found, but wrong type of node: ${node.type}`
              );
            }
            const name = declMap.get(event.decl);
            if (!name) {
              throw new AwaitedError(
                formatAstLongLines(node).then(
                  (targetStr) => `No replacement found for "${targetStr}"`
                )
              );
            }
            return ident(name, node);
          }
          if (event.type === "def") {
            if (ret) {
              throw new Error(
                `def found when there was already a replacement for this node`
              );
            }
            if (
              node.type !== "AssignmentExpression" &&
              node.type !== "UpdateExpression"
            ) {
              throw new Error(
                `Def found, but wrong type of node: ${node.type}`
              );
            }
            const target =
              node.type === "AssignmentExpression"
                ? node.left
                : (node.argument as mctree.AssignmentExpression["left"]);
            const name = declMap.get(event.decl);
            if (!name) {
              throw new AwaitedError(
                formatAstLongLines(target).then(
                  (targetStr) => `No replacement found for "${targetStr}"`
                )
              );
            }
            const id = ident(name, target);
            const assign = withLoc(
              {
                type: "AssignmentExpression",
                left: target,
                right: { ...id },
                operator: "=",
              },
              node
            );
            if (node.type === "AssignmentExpression") {
              node.left = id;
            } else {
              node.argument = id;
            }
            return withLoc(
              { type: "SequenceExpression", expressions: [node, assign] },
              node
            );
          }
          if (event.type === "mod") {
            if (!event.decl) {
              throw new Error(`Unexpected null decl on mod event`);
            }
            let pending = pendingMap.get(stmt);
            if (!pending) {
              pendingMap.set(stmt, (pending = new Set()));
            }
            pending.add(event);
          } else {
            throw new Error(`Unexpected ${event.type} found`);
          }
          return ret;
        }, null);
        if (ret) {
          return ret;
        }
      }
      const pending = pendingMap.get(node);
      if (node.type === "SequenceExpression") {
        if (pending) {
          throw new Error(`Unexpected pending list at SequenceExpression`);
        }
        for (let i = node.expressions.length; i--; ) {
          const ni = node.expressions[i];
          if (ni.type === "SequenceExpression") {
            node.expressions.splice(i, 1, ...ni.expressions);
          }
        }
      }
      const applyPending = (results: mctree.Node[], locNode: mctree.Node) => {
        const target =
          results.length === 1 && results[0].type === "BlockStatement"
            ? results[0]
            : null;
        pendingMap.delete(node);
        pending!.forEach((event) => {
          const decl = event.decl!;
          const name = declMap.get(decl);
          if (!name) {
            throw new AwaitedError(
              declFullName(decl).then(
                (declStr) => `No replacement found for "${declStr}"`
              )
            );
          }
          if (!event.id) {
            throw new AwaitedError(
              declFullName(decl).then(
                (declStr) => `Missing id for mod event for "${declStr}"`
              )
            );
          }
          const rhs = withLocDeep(event.id, locNode, locNode);
          rhs.end = rhs.start;
          if (rhs.loc) {
            rhs.loc.end = rhs.loc.start;
          }
          const insertion = withLoc(
            {
              type: "ExpressionStatement",
              expression: withLoc(
                {
                  type: "AssignmentExpression",
                  left: ident(name, rhs),
                  right: rhs,
                  operator: "=",
                },
                rhs
              ),
            },
            rhs
          );
          if (event.type === "mod" && event.before) {
            if (target) {
              target.body.unshift(insertion);
            } else {
              results.unshift(insertion);
            }
          } else {
            results.push(insertion);
          }
        });
        return results.length === 1 ? null : results;
      };
      if (
        node.type === "ExpressionStatement" &&
        node.expression.type === "SequenceExpression"
      ) {
        const results: mctree.Node[] = [];
        node.expression.expressions.forEach((expression) => {
          results.push({ ...node, expression });
        });
        if (!pending) {
          return results;
        }
        return applyPending(results, node);
      }
      if (pending) {
        return applyPending([node], node);
      }
      return null;
    }
  );
}
