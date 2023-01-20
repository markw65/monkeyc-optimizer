import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  formatAst,
  isLocal,
  isStateNode,
  variableDeclarationName,
} from "../api";
import {
  DataFlowBlock as TypeFlowBlock,
  declFullName,
  Event,
  EventDecl,
} from "../data-flow";
import { VariableStateNode } from "../optimizer-types";
import { forEach, map, some } from "../util";

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
  throw new Error(`Invalid local decl: ${declFullName(decl)}`);
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

export function describeEvent(event: Event) {
  if (event.type === "exn") return "exn:";
  return `${event.type}: ${
    event.type === "flw" ||
    event.type === "mod" ||
    (!Array.isArray(event.decl) &&
      (event.decl.type === "MemberDecl" || event.decl.type === "Unknown"))
      ? formatAst(event.node)
      : event.decl
      ? declFullName(event.decl)
      : "??"
  }`;
}

export function printBlockEvents(
  block: TypeFlowBlock,
  extra?: (event: Event) => string
) {
  console.log("Events:");
  forEach(block.events, (event) =>
    console.log(`    ${describeEvent(event)} ${extra?.(event)}`)
  );
}

export function printBlockTrailer(block: TypeFlowBlock) {
  console.log(
    `Succs: ${(block.succs || [])
      .map((block) => (block as TypeFlowBlock).order)
      .join(", ")} ExSucc: ${
      block.exsucc ? (block.exsucc as TypeFlowBlock).order : ""
    }`
  );
}
