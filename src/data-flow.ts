import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, isLocal, isStateNode, lookupNext } from "./api";
import { getNodeValue, isExpression } from "./ast";
import { BaseEvent, Block, buildReducedGraph } from "./control-flow";
import {
  findCallees,
  findCalleesByNode,
  findCalleesForNew,
} from "./function-info";
import {
  FunctionStateNode,
  LookupDefinition,
  ProgramStateAnalysis,
  StateNodeDecl,
  VariableStateNode,
} from "./optimizer-types";
import { declIsLocal } from "./type-flow/type-flow-util";
import { every, GenericQueue, some } from "./util";

/*
 * This is the set of nodes that are of interest to data flow.
 *  - Identifiers (of non locals)
 *  - MemberExpressions (any)
 *  - Literals (of interest to PRE, and copy propagation)
 */
export type RefNode =
  | mctree.Identifier
  | mctree.MemberExpression
  | mctree.Literal;

export type MemberDecl = {
  type: "MemberDecl";
  node: mctree.MemberExpression;
  base: StateNodeDecl | StateNodeDecl[];
  path: mctree.MemberExpression[];
};

/*
 * The "declaration" for a Ref or Def
 * This is simply a canonical object (or array of such) which
 * can be used as a key to a Map or Set, in order to identify
 * Refs and Defs to the same thing.
 */
export type EventDecl =
  | StateNodeDecl
  | StateNodeDecl[]
  | mctree.Literal
  | MemberDecl
  | {
      type: "Unknown";
      node: mctree.MemberExpression | mctree.Identifier | mctree.ThisExpression;
    };

/*
 * An occurance of a use of a node of interest to data flow
 */
export interface RefEvent extends BaseEvent {
  type: "ref";
  node: RefNode;
  decl: EventDecl;
}

/*
 * An indicator that a local went out of scope
 */
export interface KillEvent extends BaseEvent {
  type: "kil";
  node: mctree.Node;
  decl: StateNodeDecl | StateNodeDecl[];
}

/*
 * An assignment to, or declaration of, a node of interest
 * to data flow
 */
export interface DefEvent extends BaseEvent {
  type: "def";
  node:
    | mctree.AssignmentExpression
    | mctree.UpdateExpression
    | mctree.VariableDeclarator;
  decl: EventDecl;
  rhs?: EventDecl;
  containedEvents?: Array<RefEvent | ModEvent>;
}

/*
 * Something that could modify some or all of the
 * PRE candidates indirectly. eg a call.
 */
export interface ModEvent extends BaseEvent {
  type: "mod";
  node: mctree.Node;
  decl?: EventDecl | undefined | null;
  // before is true if the effects happen just before node
  // rather than as a result of node
  before?: boolean;
  // while propagating, we insert mod events at region
  // boundaries for each "live" candidate. The id field
  // identifies the candidate in that case.
  id?: RefNode;
  // list of callees (assuming this was a call/new)
  // so we can determine whether it affects id
  callees?: FunctionStateNode[] | null;
  // For typeflow, the callee's decl, so we can be
  // more precise about callees.
  calleeDecl?: EventDecl | undefined;
  calleeObj?: EventDecl | undefined;
}

export enum FlowKind {
  LEFT_EQ_RIGHT_DECL,
  LEFT_NE_RIGHT_DECL,
  LEFT_EQ_RIGHT_NODE,
  LEFT_NE_RIGHT_NODE,
  LEFT_TRUTHY,
  LEFT_FALSEY,
  INSTANCEOF,
  NOTINSTANCE,
}

/*
 * A control flow event.
 * The truthiness of the condition determines
 * which successor to go to.
 */
export interface FlowEventDecl extends BaseEvent {
  type: "flw";
  node: mctree.BinaryExpression | mctree.UnaryExpression;
  decl?: undefined;
  kind: FlowKind.LEFT_EQ_RIGHT_DECL | FlowKind.LEFT_NE_RIGHT_DECL;
  left: EventDecl;
  right_decl: EventDecl;
  right_node?: undefined;
}
export interface FlowEventNode extends BaseEvent {
  type: "flw";
  node: mctree.BinaryExpression | mctree.UnaryExpression;
  decl?: undefined;
  kind: FlowKind.LEFT_EQ_RIGHT_NODE | FlowKind.LEFT_NE_RIGHT_NODE;
  left: EventDecl;
  right_decl?: undefined;
  right_node: mctree.Expression;
}
export interface FlowEventTruthy extends BaseEvent {
  type: "flw";
  node: mctree.Node;
  decl?: undefined;
  kind: FlowKind.LEFT_TRUTHY | FlowKind.LEFT_FALSEY;
  left: EventDecl;
  right_decl?: undefined;
  right_node?: undefined;
}
export interface FlowEventInstanceof extends BaseEvent {
  type: "flw";
  node: mctree.InstanceofExpression | mctree.UnaryExpression;
  decl?: undefined;
  kind: FlowKind.INSTANCEOF | FlowKind.NOTINSTANCE;
  left: EventDecl;
  right_decl: EventDecl;
  right_node?: undefined;
}

export type FlowEvent =
  | FlowEventDecl
  | FlowEventNode
  | FlowEventTruthy
  | FlowEventInstanceof;

export interface ExnEvent extends BaseEvent {
  type: "exn";
  node: mctree.Node;
}

export type Event =
  | RefEvent
  | KillEvent
  | DefEvent
  | ModEvent
  | FlowEvent
  | ExnEvent;

export interface DataFlowBlock extends Block<Event> {
  order?: number;
}

export function declFullName(decl: EventDecl): string {
  if (Array.isArray(decl)) {
    decl = decl[0];
  }
  if (decl.type === "Literal") {
    return decl.raw || decl.value?.toString() || "null";
  }
  if (isStateNode(decl)) return decl.fullName || "<unknown>";
  switch (decl.type) {
    case "Identifier":
      return decl.name;
    case "BinaryExpression":
      return decl.left.name;
    case "EnumStringMember":
      return decl.init
        ? `${decl.id.name}:${formatAst(decl.init)}`
        : decl.id.name;
    case "MemberDecl":
      return `${declFullName(decl.base)}->${decl.path.join(".")}`;
    case "Unknown":
      return `Unknown:${formatAst(decl.node)}`;
    default:
      unhandledType(decl);
  }
}

export function declName(decl: EventDecl) {
  if (Array.isArray(decl)) {
    decl = decl[0];
  }
  if (decl.type === "Literal") {
    return (decl.raw || decl.value?.toString() || "null").replace(
      /[^\w]/g,
      "_"
    );
  }
  if (isStateNode(decl)) return decl.name;
  switch (decl.type) {
    case "BinaryExpression":
      return decl.left.name;
    case "EnumStringMember":
      return decl.id.name;
    default:
      throw new Error(`Unexpected EventDecl type: ${decl.type}`);
  }
}

export function unhandledType(node: never): never {
  throw new Error(
    `Unhandled expression type: ${(node as { type: string | number }).type}`
  );
}

export function buildDataFlowGraph(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  wantsLiteral: (literal: mctree.Literal) => boolean,
  trackInsertionPoints: boolean,
  wantsAllRefs: boolean
) {
  const uniqueDeclMap = new Map<StateNodeDecl, StateNodeDecl[]>();
  const lookupDefToDecl = (results: LookupDefinition[]) => {
    const decls =
      results.reduce<StateNodeDecl | StateNodeDecl[] | null>(
        (decls, result) =>
          result.results.reduce<StateNodeDecl | StateNodeDecl[] | null>(
            (decls, result) => {
              if (
                !wantsAllRefs &&
                (result.type !== "VariableDeclarator" || isLocal(result))
              ) {
                return decls;
              }
              if (!decls) return result;
              if (Array.isArray(decls)) {
                decls.push(result);
                return decls;
              } else {
                return [decls, result];
              }
            },
            decls
          ),
        null
      ) || null;
    if (!Array.isArray(decls)) return decls;
    // We use EventDecl as a Map key, so we need to
    // uniquify it. Note that from any given function,
    // if state.lookup finds a set of non locals, it will
    // always find the same set, so we can use the first
    // such as the unique identifier.
    const canon = uniqueDeclMap.get(decls[0]);
    if (!canon) {
      uniqueDeclMap.set(decls[0], decls);
      return decls;
    }
    if (
      canon.length !== decls.length ||
      !canon.every((v, i) => v === decls[i])
    ) {
      throw new Error(
        `Canonical representation of ${declFullName(canon)} did not match`
      );
    }
    return canon;
  };
  const findDecl = (node: mctree.Node): EventDecl | null => {
    const path: mctree.MemberExpression[] = [];
    while (
      node.type === "MemberExpression" &&
      (wantsAllRefs || !node.computed)
    ) {
      path.unshift(node);
      node = node.object;
    }
    if (node.type !== "Identifier" && node.type !== "ThisExpression") {
      return null;
    }
    let [, results] = state.lookup(node);
    if (!results) {
      return wantsAllRefs ? { type: "Unknown", node: path.pop()! } : null;
    }
    while (true) {
      const next = path[0];
      if (!next || next.computed) {
        break;
      }
      const nextResult = lookupNext(state, results, "decls", next.property);
      if (!nextResult) break;
      results = nextResult;
      node = path.shift()!;
    }
    const decl = lookupDefToDecl(results);
    if (decl && path.length) {
      if (
        wantsAllRefs &&
        every(
          decl,
          (d) =>
            d.type === "VariableDeclarator" ||
            d.type === "BinaryExpression" ||
            d.type === "Identifier"
        )
      ) {
        return {
          type: "MemberDecl",
          node: node as mctree.MemberExpression,
          base: decl as VariableStateNode | VariableStateNode[],
          path,
        };
      }
      return null;
    }
    return decl;
  };
  const literals = new Map<mctree.Literal["value"], mctree.Literal>();
  const identifiers = new Set<string>();
  const liveDefs = new Map<EventDecl | null, Set<mctree.Node>>();
  const liveStmts = new Map<mctree.Node, Map<EventDecl | null, number>>();
  const liveDef = trackInsertionPoints
    ? (def: EventDecl | null, stmt: mctree.Node) => {
        let curNodes = liveDefs.get(def);
        if (!curNodes) {
          liveDefs.set(def, (curNodes = new Set<mctree.Node>()));
        }
        curNodes.add(stmt);
        let defs = liveStmts.get(stmt);
        if (!defs) {
          liveStmts.set(stmt, (defs = new Map<EventDecl | null, number>()));
        }
        defs.set(def, (defs.get(def) || 0) + 1);
      }
    : () => {
        /* do nothing */
      };
  return {
    identifiers,
    graph: buildReducedGraph<Event>(
      state,
      func,
      wantsAllRefs,
      (node, stmt, mayThrow, getContainedEvents): Event | Event[] | null => {
        if (mayThrow === 1) {
          return wantsAllRefs ? getFlowEvent(node, stmt, findDecl) : null;
        }
        const defs = liveStmts.get(node);
        if (defs) {
          liveStmts.delete(node);
          defs.forEach((count, def) => {
            if (count > 1) {
              defs.set(def, count--);
              return;
            }
            const v = liveDefs.get(def);
            if (!v || !v.has(node)) {
              throw new Error(
                `No stmt in liveDef for ${def ? declFullName(def) : "null"}`
              );
            }
            v.delete(node);
            if (!v.size) {
              liveDefs.delete(def);
            }
          });
        }
        if (wantsAllRefs) {
          const scope = state.top().sn;
          if (
            scope.node === node &&
            scope.type === "BlockStatement" &&
            scope.decls &&
            state.stack.length - 2 !== func.stack?.length
          ) {
            return Object.values(scope.decls)
              .map((value): KillEvent | null => {
                const decl = lookupDefToDecl([
                  { parent: null, results: value },
                ]);
                return decl && { type: "kil", decl, node, mayThrow: false };
              })
              .filter((e): e is KillEvent => e != null);
          }
        }
        switch (node.type) {
          case "BinaryExpression":
          case "UnaryExpression":
          case "SizedArrayExpression":
          case "ArrayExpression":
          case "ObjectExpression":
          case "ThisExpression":
          case "LogicalExpression":
          case "ConditionalExpression":
          case "SequenceExpression":
          case "ParenthesizedExpression":
            break;
          case "Literal":
            if (wantsLiteral(node)) {
              const result = getNodeValue(node);
              const key =
                result[1] +
                (result[0].value === null
                  ? ""
                  : "-" + result[0].value.toString());
              let decl = literals.get(key);
              if (!decl) {
                decl = node;
                literals.set(key, decl);
              }
              return {
                type: "ref",
                node,
                decl: decl,
                mayThrow,
              } as RefEvent;
            }
            break;
          case "Identifier":
            identifiers.add(node.name);
          // fall through
          case "MemberExpression": {
            const decls = findDecl(node);
            if (!decls) break;
            if (
              trackInsertionPoints &&
              some(decls, (decl) => {
                if (decl.type === "VariableDeclarator") {
                  const defStmts =
                    (decl.node.kind === "var" && liveDefs.get(null)) ||
                    liveDefs.get(decl);
                  if (defStmts) {
                    return true;
                    /*
                      // hold off on this for now. we need to communicate
                      // which defs need to be fixed, which involves yet-another
                      // table.

                      if (defStmts.size !== 1) break;
                      const fixable = isFixableStmt([...defStmts][0]);
                      if (fixable === false) break;
                      cost += fixable;
                    */
                  }
                }
                return false;
              })
            ) {
              break;
            }
            return {
              type: "ref",
              node,
              decl: decls,
              mayThrow,
            };
          }
          case "VariableDeclarator": {
            const decl = findDecl(
              node.id.type === "BinaryExpression" ? node.id.left : node.id
            );
            if (decl) {
              liveDef(decl, stmt);
              const def: DefEvent = {
                type: "def",
                node,
                decl,
                mayThrow,
              };
              if (
                wantsAllRefs &&
                (node.init?.type === "Identifier" ||
                  node.init?.type === "MemberExpression")
              ) {
                const rhs = findDecl(node.init);
                if (rhs) def.rhs = rhs;
              }
              if (declIsLocal(decl)) {
                const contained = getContainedEvents().filter(
                  (e): e is RefEvent | ModEvent =>
                    e.type === "ref" || e.type === "mod"
                );
                if (contained.length) {
                  def.containedEvents = contained;
                }
              }
              return def;
            }
            break;
          }
          case "AssignmentExpression": {
            const decl = findDecl(node.left);
            if (decl) {
              liveDef(decl, stmt);
              const def: DefEvent = {
                type: "def",
                node,
                decl,
                mayThrow,
              };
              if (wantsAllRefs) {
                if (
                  (node.right.type === "Identifier" ||
                    node.right.type === "MemberExpression") &&
                  node.operator === "="
                ) {
                  const rhs = findDecl(node.right);
                  if (rhs) def.rhs = rhs;
                }
                if (declIsLocal(decl)) {
                  const contained = getContainedEvents().filter(
                    (e): e is RefEvent | ModEvent =>
                      e.type === "ref" || e.type === "mod"
                  );
                  if (contained.length) {
                    def.containedEvents = contained;
                  }
                }
              }
              return def;
            } else if (wantsAllRefs) {
              return { type: "mod", node, mayThrow };
            }
            break;
          }
          case "UpdateExpression": {
            const decl = findDecl(node.argument);
            if (decl) {
              liveDef(decl, stmt);
              return {
                type: "def",
                node,
                decl,
                mayThrow,
              };
            } else if (wantsAllRefs) {
              return { type: "mod", node, mayThrow };
            }
            break;
          }
          case "NewExpression": {
            const [, results] = state.lookup(node.callee);
            const callees = results ? findCalleesForNew(results) : null;
            liveDef(null, stmt);
            return { type: "mod", node, mayThrow, callees };
          }
          case "CallExpression": {
            liveDef(null, stmt);
            if (wantsAllRefs) {
              const calleeDecl = findDecl(node.callee);
              if (calleeDecl) {
                const mod: ModEvent = {
                  type: "mod",
                  node,
                  mayThrow,
                  calleeDecl,
                };
                if (
                  !Array.isArray(calleeDecl) &&
                  calleeDecl.type === "MemberDecl"
                ) {
                  if (calleeDecl.path.length > 1) {
                    const calleeObj = { ...calleeDecl };
                    calleeObj.path = calleeObj.path.slice(0, -1);
                    mod.calleeObj = calleeObj;
                  } else {
                    mod.calleeObj = calleeDecl.base;
                  }
                } else if (node.callee.type === "MemberExpression") {
                  const calleeObj = findDecl(node.callee.object);
                  if (calleeObj) {
                    mod.calleeObj = calleeObj;
                  }
                }
                return mod;
              }
            }
            const [, results] = state.lookupNonlocal(node.callee);
            const callees = results
              ? findCallees(results)
              : findCalleesByNode(state, node.callee);
            return { type: "mod", node, mayThrow, callees };
          }
          default:
            if (!isExpression(node)) break;
            unhandledType(node);
        }
        if (mayThrow) {
          return { type: "exn", node, mayThrow };
        }
        return null;
      }
    ),
  };
}

function getFlowEvent(
  node: mctree.Node,
  stmt: mctree.Node,
  findDecl: (node: mctree.Node) => EventDecl | null
): FlowEvent | null {
  switch (node.type) {
    case "BinaryExpression":
      if (node.operator === "instanceof") {
        const left = findDecl(node.left);
        const right = findDecl(node.right);
        if (left && right) {
          return {
            type: "flw",
            node,
            kind: FlowKind.INSTANCEOF,
            left,
            right_decl: right,
            mayThrow: false,
          };
        }
      } else if (node.operator === "!=" || node.operator === "==") {
        const left = findDecl(node.left);
        const right = findDecl(node.right);
        if (left && right) {
          return {
            type: "flw",
            node,
            kind:
              node.operator === "=="
                ? FlowKind.LEFT_EQ_RIGHT_DECL
                : FlowKind.LEFT_NE_RIGHT_DECL,
            left,
            right_decl: right,
            mayThrow: false,
          };
        }
        if (left && !right) {
          return {
            type: "flw",
            node,
            kind:
              node.operator === "=="
                ? FlowKind.LEFT_EQ_RIGHT_NODE
                : FlowKind.LEFT_NE_RIGHT_NODE,
            left,
            right_node: node.right,
            mayThrow: false,
          };
        }
        if (!left && right) {
          return {
            type: "flw",
            node,
            kind:
              node.operator === "=="
                ? FlowKind.LEFT_EQ_RIGHT_NODE
                : FlowKind.LEFT_NE_RIGHT_NODE,
            left: right,
            right_node: node.left,
            mayThrow: false,
          };
        }
      }
      return null;
    case "UnaryExpression":
      if (node.operator === "!" || node.operator === "~") {
        const event = getFlowEvent(node.argument, stmt, findDecl);
        if (!event) return null;
        switch (event.kind) {
          case FlowKind.LEFT_EQ_RIGHT_DECL:
            event.kind = FlowKind.LEFT_NE_RIGHT_DECL;
            break;
          case FlowKind.LEFT_EQ_RIGHT_NODE:
            event.kind = FlowKind.LEFT_NE_RIGHT_NODE;
            break;
          case FlowKind.LEFT_NE_RIGHT_DECL:
            event.kind = FlowKind.LEFT_EQ_RIGHT_DECL;
            break;
          case FlowKind.LEFT_NE_RIGHT_NODE:
            event.kind = FlowKind.LEFT_EQ_RIGHT_NODE;
            break;
          case FlowKind.INSTANCEOF:
            event.kind = FlowKind.NOTINSTANCE;
            break;
          case FlowKind.NOTINSTANCE:
            event.kind = FlowKind.INSTANCEOF;
            break;
          default:
            return null;
        }
        event.node = node;
        return event;
      }
      return null;
    case "Identifier":
    case "MemberExpression": {
      const left = findDecl(node);
      if (left) {
        return {
          type: "flw",
          node,
          mayThrow: false,
          kind: FlowKind.LEFT_TRUTHY,
          left,
        };
      }
    }
  }
  return null;
}

export class DataflowQueue extends GenericQueue<DataFlowBlock> {
  constructor() {
    super((b, a) => (a.order || 0) - (b.order || 0));
  }
}
