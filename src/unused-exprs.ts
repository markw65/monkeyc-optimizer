import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { variableDeclarationName } from "./api";
import { hasProperty, traverseAst } from "./ast";
import { unused } from "./inliner";
import { ProgramStateOptimizer, VariableStateNode } from "./optimizer-types";

export function cleanupUnusedVars(
  state: ProgramStateOptimizer,
  node: mctree.BlockStatement | mctree.ForStatement
) {
  const parent = state.stack.slice(-1).pop()!.sn;
  if (parent.node !== node) {
    return false;
  }
  if (parent.type !== "BlockStatement") {
    throw new Error(
      `Unexpected parent type '${parent.type}' for local declaration`
    );
  }
  if (!parent.decls) return false;
  let toRemove: Record<string, VariableStateNode | null> | null = null;
  Object.values(parent.decls).forEach((decls) => {
    if (
      decls.length === 1 &&
      decls[0].type === "VariableDeclarator" &&
      !decls[0].used
    ) {
      if (!toRemove) toRemove = {};
      toRemove[decls[0].name] = decls[0];
    }
  });
  if (!toRemove) return false;
  const varDeclarations = new Map<
    mctree.VariableDeclaration,
    { parent: mctree.Statement[]; indices: number[] }
  >();
  const stack: mctree.Statement[][] = [];
  let changes = false;
  traverseAst(
    node,
    (node) => {
      switch (node.type) {
        case "SwitchCase":
          stack.push(node.consequent);
          break;
        case "BlockStatement":
          stack.push(node.body);
          break;
      }
    },
    (node) => {
      switch (node.type) {
        case "SwitchCase":
        case "BlockStatement":
          stack.pop();
          break;
        case "VariableDeclaration": {
          node.declarations.forEach((decl, i) => {
            const name = variableDeclarationName(decl.id);
            if (hasProperty(toRemove, name)) {
              const info = varDeclarations.get(node);
              if (info) {
                info.indices.push(i);
              } else {
                varDeclarations.set(node, {
                  parent: stack[stack.length - 1],
                  indices: [i],
                });
              }
            }
          });
          break;
        }
        case "ExpressionStatement":
          if (node.expression.type === "AssignmentExpression") {
            if (
              node.expression.left.type === "Identifier" &&
              hasProperty(toRemove, node.expression.left.name)
            ) {
              changes = true;
              return unused(state, node.expression.right);
            }
          } else if (
            node.expression.type === "UpdateExpression" &&
            node.expression.argument.type === "Identifier" &&
            hasProperty(toRemove, node.expression.argument.name)
          ) {
            return false;
          }
          break;
        case "SequenceExpression": {
          for (let i = node.expressions.length; i--; ) {
            const expr = node.expressions[i];
            if (expr.type === "AssignmentExpression") {
              if (
                expr.left.type === "Identifier" &&
                hasProperty(toRemove, expr.left.name)
              ) {
                const rep = unused(state, expr.right);
                if (!rep.length) {
                  changes = true;
                  node.expressions.splice(i, 1);
                } else {
                  // Sequence expressions can only be assignments
                  // or update expressions. Even calls aren't allowed
                  toRemove[expr.left.name] = null;
                  expr.operator = "=";
                }
              }
            } else if (
              expr.type === "UpdateExpression" &&
              expr.argument.type === "Identifier" &&
              hasProperty(toRemove, expr.argument.name)
            ) {
              changes = true;
              node.expressions.splice(i, 1);
            }
          }
          break;
        }
      }
      return null;
    }
  );
  varDeclarations.forEach((info, decl) => {
    let index = -1;
    for (let ii = info.indices.length, j = decl.declarations.length; ii--; ) {
      const i = info.indices[ii];
      const vdecl = decl.declarations[i];
      const name = variableDeclarationName(vdecl.id);
      if (hasProperty(toRemove, name)) {
        const rep = vdecl.init ? unused(state, vdecl.init) : [];
        if (rep.length) {
          if (
            (state.sdkVersion || 0) < 4001007 &&
            rep.find(
              (s) =>
                s.type === "ExpressionStatement" &&
                (s.expression.type === "NewExpression" ||
                  (s.expression.type === "MemberExpression" &&
                    !s.expression.computed &&
                    s.expression.object.type === "NewExpression"))
            )
          ) {
            // prior to 4.1.7 vanilla new expressions were discarded,
            // so don't create top level new expressions.
            continue;
          }
          if (parent.node.type === "ForStatement") {
            // declarations whose inits have side effects
            // can't be deleted from for statements.
            continue;
          }
          changes = true;
          if (index < 0) {
            index = info.parent.findIndex((s) => s === decl);
            if (index < 0) {
              throw new Error(
                `Failed to find variable declaration for ${variableDeclarationName(
                  vdecl.id
                )}`
              );
            }
          }
          if (j > i + 1) {
            const tail = {
              ...decl,
              declarations: decl.declarations.slice(i + 1, j),
            };
            if (decl.loc && vdecl.loc) {
              tail.loc = { ...decl.loc, start: vdecl.loc.end };
              tail.start = vdecl.end;
            }
            rep.push(tail);
          }
          if (decl.loc && vdecl.loc) {
            decl.loc = { ...decl.loc, end: vdecl.loc.start };
            decl.end = vdecl.start;
          }
          decl.declarations.splice(i);
          info.parent.splice(index + 1, 0, ...rep);
          j = i;
          continue;
        }
        if (toRemove[name]) {
          changes = true;
          j--;
          decl.declarations.splice(i, 1);
          if (i === j && decl.loc && vdecl.loc) {
            decl.loc = { ...decl.loc, end: vdecl.loc.start };
            decl.end = vdecl.start;
          }
        } else {
          delete vdecl.init;
        }
      }
    }
  });
  return changes;
}
