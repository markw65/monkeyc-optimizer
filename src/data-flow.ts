import { mctree } from "@markw65/prettier-plugin-monkeyc";
import * as PriorityQueue from "priorityqueuejs";
import { formatAst, isStateNode } from "./api";
import { getNodeValue, isExpression } from "./ast";
import { BaseEvent, Block, buildReducedGraph } from "./control-flow";
import { findCallees, findCalleesForNew } from "./function-info";
import {
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNodeDecl,
} from "./optimizer-types";
import { some } from "./util";

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

/*
 * The "declaration" for a Ref or Def
 * This is simply a canonical object (or array of such) which
 * can be used as a key to a Map or Set, in order to identify
 * Refs and Defs to the same thing.
 */
export type EventDecl = StateNodeDecl | StateNodeDecl[] | mctree.Literal;

/*
 * An occurance of a use of a node of interest to data flow
 */
export interface RefEvent extends BaseEvent {
  type: "ref";
  node: RefNode;
  decl: EventDecl;
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
}

export interface ExnEvent extends BaseEvent {
  type: "exn";
  node: mctree.Node;
}

export type Event = RefEvent | DefEvent | ModEvent | ExnEvent;

export interface DataFlowBlock extends Block<Event> {
  order?: number;
}

export function declFullName(decl: EventDecl) {
  if (Array.isArray(decl)) {
    decl = decl[0];
  }
  if (decl.type === "Literal") {
    return decl.raw || decl.value?.toString() || "null";
  }
  if (isStateNode(decl)) return decl.fullName;
  switch (decl.type) {
    case "EnumDeclaration":
      return decl.id?.name || "enum";
    case "BinaryExpression":
      return decl.left.name;
    case "EnumStringMember":
      return decl.init
        ? `${decl.id.name}:${formatAst(decl.init)}`
        : decl.id.name;
    default:
      throw new Error(`Unexpected EventDecl type: ${decl.type}`);
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
    case "EnumDeclaration":
      return decl.id?.name || "enum";
    case "BinaryExpression":
      return decl.left.name;
    case "EnumStringMember":
      return decl.id.name;
    default:
      throw new Error(`Unexpected EventDecl type: ${decl.type}`);
  }
}

export function unhandledExpression(node: never) {
  throw new Error(`Unhandled expression type: ${(node as mctree.Node).type}`);
}

export function buildDataFlowGraph(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  wantsLiteral: (literal: mctree.Literal) => boolean,
  trackInsertionPoints: boolean,
  wantsAllRefs: boolean
) {
  const uniqueDeclMap = new Map<StateNodeDecl, StateNodeDecl[]>();
  const findDecl = (node: mctree.Node): EventDecl | null => {
    if (
      node.type === "Identifier" ||
      (node.type === "MemberExpression" && !node.computed)
    ) {
      const [, results] = state.lookup(node);
      const decls =
        (results &&
          results.reduce<StateNodeDecl | StateNodeDecl[] | null>(
            (decls, result) =>
              wantsAllRefs || result.parent?.type !== "BlockStatement"
                ? result.results.reduce<StateNodeDecl | StateNodeDecl[] | null>(
                    (decls, result) => {
                      if (
                        !wantsAllRefs &&
                        result.type !== "VariableDeclarator"
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
                  )
                : decls,
            null
          )) ||
        null;
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
        canon.length != decls.length ||
        !canon.every((v, i) => v === decls[i])
      ) {
        throw new Error(
          `Canonical representation of ${declFullName(canon)} did not match`
        );
      }
      return canon;
    }
    return null;
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
    graph: buildReducedGraph(
      state,
      func,
      (node, stmt, mayThrow): Event | null => {
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
              return {
                type: "def",
                node,
                decl,
                mayThrow,
              };
            }
            break;
          }
          case "AssignmentExpression": {
            const decl = findDecl(node.left);
            if (decl) {
              liveDef(decl, stmt);
              return {
                type: "def",
                node,
                decl,
                mayThrow,
              };
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
            const [, results] = state.lookup(node.callee);
            const callees = results ? findCallees(results) : null;
            return { type: "mod", node, mayThrow, callees };
          }
          default:
            if (!isExpression(node)) break;
            unhandledExpression(node);
        }
        if (mayThrow) {
          return { type: "exn", node, mayThrow };
        }
        return null;
      }
    ),
  };
}

export class DataflowQueue {
  private enqueued = new Set<DataFlowBlock>();
  private queue = new PriorityQueue<DataFlowBlock>(
    (b, a) => (a.order || 0) - (b.order || 0)
  );
  enqueue(block: DataFlowBlock) {
    if (!this.enqueued.has(block)) {
      this.enqueued.add(block);
      this.queue.enq(block);
    }
  }
  dequeue() {
    const block = this.queue.deq();
    this.enqueued.delete(block);
    return block;
  }
  empty() {
    return this.queue.isEmpty();
  }
}
