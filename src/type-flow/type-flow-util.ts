import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  formatAstLongLines,
  getSuperClasses,
  hasProperty,
  isLocal,
  isStateNode,
  lookupNext,
  variableDeclarationName,
} from "../api";
import {
  Event,
  EventDecl,
  ImpEvent,
  DataFlowBlock as TypeFlowBlock,
  declFullName,
} from "../data-flow";
import {
  ClassStateNode,
  ProgramStateAnalysis,
  StateNode,
  VariableStateNode,
} from "../optimizer-types";
import { AwaitedError, forEach, log, map, some } from "../util";
import { InterpState } from "./interp";
import { intersection } from "./intersection-type";
import { subtypeOf } from "./sub-type";
import {
  ExactOrUnion,
  TypeTag,
  getStateNodeDeclsWithExactFromType,
  typeFromTypeStateNodes,
} from "./types";
import { unionInto } from "./union-type";

export { TypeFlowBlock };

export function isTypeStateKey(decl: EventDecl): decl is TypeStateKey {
  return (
    Array.isArray(decl) ||
    (decl.type !== "MemberDecl" && decl.type !== "Unknown")
  );
}

export function declIsLocal(
  decl: EventDecl
): decl is VariableStateNode | VariableStateNode[] | mctree.TypedIdentifier {
  return some(
    decl,
    (d) =>
      d.type === "BinaryExpression" ||
      d.type === "Identifier" ||
      (d.type === "VariableDeclarator" && isLocal(d))
  );
}

export function declIsNonLocal(
  decl: EventDecl
): decl is VariableStateNode | VariableStateNode[] {
  return some(decl, (d) => d.type === "VariableDeclarator" && !isLocal(d));
}

export function localDeclName(decl: EventDecl) {
  if (Array.isArray(decl)) decl = decl[0];
  switch (decl.type) {
    case "Identifier":
      return decl.name;
    case "BinaryExpression":
      return decl.left.name;
    case "VariableDeclarator":
      return variableDeclarationName(decl.node.id);
  }
  throw new AwaitedError(
    declFullName(decl).then((declStr) => `Invalid local decl: ${declStr}`)
  );
}

export type TypeStateKey = Exclude<
  EventDecl,
  { type: "MemberDecl" | "Unknown" }
>;

export function tsKey(key: TypeStateKey) {
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
  }).join("|")}`;
}

export function sourceLocation(loc: mctree.SourceLocation | null | undefined) {
  return loc
    ? `${loc.source || "??"}:${loc.start.line}:${loc.start.column}`
    : "??";
}

export function printBlockHeader(block: TypeFlowBlock) {
  log(
    block.order,
    `(${block.node?.loc?.source || "??"}:${
      block.node?.loc?.start.line || "??"
    })`,
    `Preds: ${(block.preds || [])
      .map((block) => (block as TypeFlowBlock).order)
      .join(", ")}`
  );
}

function printImp(event: ImpEvent) {
  switch (event.node.type) {
    case "ImportModule":
    case "Using":
      return formatAstLongLines(event.node.id).then(
        (id) => `${event.node.type} ${id}`
      );
    case "ModuleDeclaration":
    case "Program":
      return event.node.type;
  }
}

export function describeEvent(event: Event) {
  if (event.type === "exn") return Promise.resolve("exn:");
  return Promise.resolve(
    event.type === "imp"
      ? printImp(event)
      : event.type === "flw" ||
        event.type === "mod" ||
        (!Array.isArray(event.decl) &&
          (event.decl.type === "MemberDecl" || event.decl.type === "Unknown"))
      ? formatAstLongLines(event.node)
      : event.decl
      ? declFullName(event.decl)
      : "??"
  ).then((desc) => `${event.type}: ${desc}`);
}

export function printBlockEvents(
  block: TypeFlowBlock,
  extra?: (event: Event) => string
) {
  log("Events:");
  forEach(block.events, (event) =>
    log(
      describeEvent(event).then(
        (eventStr) => `    ${eventStr} ${extra ? extra(event) : ""}`
      )
    )
  );
}

export function printBlockTrailer(block: TypeFlowBlock) {
  log(
    `Succs: ${(block.succs || [])
      .map((block) => (block as TypeFlowBlock).order)
      .join(", ")} ExSucc: ${
      block.exsucc ? (block.exsucc as TypeFlowBlock).order : ""
    }`
  );
}

/*
 * We have an object, and a MemberExpression object.<name>
 *  - decls are the StateNodes associated with the known type
 *    of object.
 *  - possible are all the StateNodes that declare <name>
 *
 * We want to find all the elements of possible which are
 * "compatible" with decls, which tells us the set of things
 * that object.<name> could correspond to, and also what that
 * tells us about object.
 *
 * The return value is two arrays of StateNode. The first
 * gives the refined type of object, and the second is the
 * array of StateNodes that could declare <name>
 */
function filterDecls(
  state: ProgramStateAnalysis,
  decls: { sn: StateNode; exact: boolean }[],
  next: mctree.Identifier
): [StateNode[], StateNode[]] | [null, null] {
  const possible =
    hasProperty(state.allDeclarations, next.name) &&
    state.allDeclarations[next.name];
  if (!possible) return [null, null];

  const result = decls.reduce<
    [Set<StateNode>, Set<StateNode>, Set<ClassStateNode>] | null
  >((cur, { sn: decl, exact }) => {
    let declSups: Set<StateNode> | null | undefined;
    const getDeclSups = () =>
      declSups !== undefined
        ? declSups
        : decl.type === "ClassDeclaration"
        ? (declSups = getSuperClasses(decl))
        : null;
    const found = possible.reduce((flag, poss) => {
      if (
        decl === poss ||
        (!exact &&
          poss.type === "ClassDeclaration" &&
          getSuperClasses(poss)?.has(decl))
      ) {
        // poss extends decl, so decl must actually be a poss
        // eg we know obj is an Object, and we call obj.toNumber
        // so possible includes all the classes that declare toNumber
        // so we can refine obj's type to the union of those types
        if (!cur) {
          cur = [new Set(), new Set(), new Set()];
        }
        cur[0].add(poss);
        cur[1].add(poss);
        if (cur[2].size && decl === poss && decl.type === "ClassDeclaration") {
          const posSupers = getSuperClasses(decl);
          if (posSupers) {
            cur[2].forEach((s) => posSupers.has(s) && cur![2].delete(s));
          }
        }
        return true;
      } else if (poss.type === "ClassDeclaration" && getDeclSups()?.has(poss)) {
        // decl extends poss, so decl remains unchanged
        // eg we know obj is Menu2, we call obj.toString
        // Menu2 doesn't define toString, but Object does
        // so poss is Object. But we still know that
        // obj is Menu2
        if (!cur) {
          cur = [new Set(), new Set(), new Set()];
        }
        cur[0].add(decl);
        const supers = Array.from(cur[2]);
        if (!supers.some((s) => getSuperClasses(s)?.has(poss))) {
          const posSupers = getSuperClasses(poss);
          posSupers &&
            supers.forEach((s) => posSupers.has(s) && cur![2].delete(s));
          cur[2].add(poss);
        }
        return true;
      }
      return flag;
    }, false);
    if (!found) {
      // If we didn't find the property in any of the
      // standard places, the runtime might still find
      // it by searching up the Module stack (and up
      // the module stack from any super classes)
      //
      // eg
      //
      //  obj = Application.getApp();
      //  obj.Properties.whatever
      //
      // Properties doesn't exist on AppBase, but AppBase
      // is declared in Application, and Application
      // does declare Properties. So Application.Properties
      // is (one of) the declarations we should find; but we
      // must not refine obj's type to include Application.
      let d = [decl];
      do {
        d.forEach((d) => {
          const stack = d.stack!;
          possible.forEach((poss) => {
            for (let i = stack.length; i--; ) {
              const sn = stack[i].sn;
              if (sn.decls === poss.decls) {
                if (!cur) {
                  cur = [new Set(), new Set(), new Set()];
                }
                cur[0].add(decl);
                cur[1].add(poss);
                break;
              }
              if (hasProperty(sn.decls, next.name)) {
                break;
              }
            }
          });
        });
        d = d.flatMap((d) => {
          if (
            d.type !== "ClassDeclaration" ||
            !d.superClass ||
            d.superClass === true
          ) {
            return [];
          }
          return d.superClass;
        });
      } while (d.length);
    }
    return cur;
  }, null);
  if (!result) return [null, null];
  result[2].forEach((c) => result[1].add(c));
  return [Array.from(result[0]), Array.from(result[1])];
}

export function findObjectDeclsByProperty(
  state: ProgramStateAnalysis,
  object: ExactOrUnion,
  next: mctree.Identifier
) {
  const decls = getStateNodeDeclsWithExactFromType(state, object);
  if (!decls) return [null, null] as const;

  return filterDecls(state, decls, next);
}

export function refineObjectTypeByDecls(
  istate: InterpState,
  object: ExactOrUnion,
  trueDecls: StateNode[]
) {
  const refinedType = typeFromTypeStateNodes(istate.state, trueDecls);
  return intersection(object, refinedType);
}

export function findNextObjectType(
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
  const [objDecls, trueDecls] = findObjectDeclsByProperty(
    istate.state,
    object,
    next.property
  );
  if (!objDecls) return null;
  const property = findNextObjectType(istate, trueDecls, next);
  if (!property) return null;
  const type = refineObjectTypeByDecls(istate, object, objDecls);
  const mayThrow = !subtypeOf(object, type);
  return { mayThrow, object: type, property };
}
