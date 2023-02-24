import { mctree } from "@markw65/prettier-plugin-monkeyc";
import assert from "node:assert";
import { variableDeclarationName } from "../api";
import {
  isExpression,
  isStatement,
  traverseAst,
  withLoc,
  withLocDeep,
} from "../ast";
import { getPostOrder } from "../control-flow";
import {
  FunctionStateNode,
  ProgramStateAnalysis,
  ProgramStateStack,
  VariableStateNode,
} from "../optimizer-types";
import { buildConflictGraph } from "../type-flow";
import { renameIdentifier } from "../variable-renamer";
import { isTypeStateKey, tsKey, TypeStateKey } from "./type-flow-util";

export function minimizeLocals(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  const result = buildConflictGraph(state, func);
  if (!result) return;
  const {
    graph,
    localConflicts,
    locals: localSet,
    identifiers,
    logThisRun,
  } = result;
  if (!localConflicts) return;

  type LocalKey = VariableStateNode | mctree.TypedIdentifier;
  const colors = new Map<TypeStateKey, number>();
  const locals = Array.from(localSet)
    .sort(
      (a, b) =>
        (localConflicts.get(a)?.size ?? 0) - (localConflicts.get(b)?.size ?? 0)
    )
    .filter(
      (key: TypeStateKey & { type?: string }): key is LocalKey =>
        key.type === "VariableDeclarator" ||
        key.type === "Identifier" ||
        key.type === "BinaryExpression"
    );
  const merge: Array<LocalKey[]> = [];
  locals.forEach((local) => {
    let inUse = 0n;
    localConflicts.get(local)?.forEach((conflict) => {
      const color = colors.get(conflict);
      if (color != null) {
        inUse |= 1n << BigInt(color);
      }
    });
    let lowest = 0;
    while (inUse & 1n) {
      lowest++;
      inUse >>= 1n;
    }
    colors.set(local, lowest);
    if (!merge[lowest]) {
      merge[lowest] = [local];
    } else {
      merge[lowest].push(local);
    }
  });
  const didMerge = merge.some((merged) => merged.length > 1);
  if (didMerge !== (merge.length !== locals.length)) {
    throw new Error("WTF?");
  }
  if (!didMerge) return;
  if (logThisRun) {
    console.log(`>>> Merging locals in ${func.fullName}`);
    merge.forEach(
      (merged) =>
        merged.length > 1 &&
        console.log(` - merging ${merged.map((k) => tsKey(k)).join(" | ")}`)
    );
  }

  type LocalInfo = {
    decl: LocalKey;
    stack: ProgramStateStack;
    depth: number;
    name: string;
  };
  const remap = new Map<LocalKey, LocalInfo>();
  merge.forEach((merged) => {
    if (merged.length === 1) return;
    const info = merged.reduce<LocalInfo | null>(
      (cur, decl): LocalInfo | null => {
        if (decl.type === "Identifier" || decl.type === "BinaryExpression") {
          return {
            decl,
            stack: func.stack!,
            depth: func.stack!.length,
            name: variableDeclarationName(decl),
          };
        }
        if (cur === null) {
          return {
            decl,
            stack: decl.stack,
            depth: decl.stack.length,
            name: decl.name,
          };
        }
        let depth =
          cur.depth < decl.stack.length ? cur.depth : decl.stack.length;
        while (true) {
          if (cur.stack[depth - 1].sn === decl.stack[depth - 1].sn) {
            break;
          }
          depth--;
        }
        if (cur.stack.length > decl.stack.length) {
          return { decl, stack: decl.stack, depth, name: decl.name };
        }
        cur.depth = depth;
        return cur;
      },
      null
    );
    assert(info);
    merged.forEach((decl) => remap.set(decl, info));
    if (info.decl.type === "VariableDeclarator") {
      let name = info.name;
      if (
        locals.some(
          (local) =>
            local !== info.decl &&
            local.type === "VariableDeclarator" &&
            local.name === name
        )
      ) {
        // There's a variable in another scope with the same name, so
        // produce a new one.
        let i = 0;
        do {
          name = `${info.decl.name}_${i++}`;
        } while (identifiers.has(name));
        identifiers.add(name);
        info.name = name;
      }
      let depth = info.depth - 1;
      let sn = info.stack[depth].sn;
      while (true) {
        assert(sn.type === "BlockStatement");
        if (sn.node.type !== "ForStatement") {
          break;
        }
        sn = info.stack[--depth].sn;
      }
      const varDecl: mctree.VariableDeclarator = {
        type: "VariableDeclarator",
        kind: "var",
        id: { type: "Identifier", name },
      };
      if (
        sn.node.body.length &&
        sn.node.body[0].type === "VariableDeclaration"
      ) {
        sn.node.body[0].declarations.unshift(
          withLocDeep(varDecl, sn.node.body[0], false, true)
        );
      } else {
        sn.node.body.unshift(
          withLocDeep(
            {
              type: "VariableDeclaration",
              declarations: [varDecl],
              kind: "var",
            },
            sn.node,
            false,
            true
          )
        );
      }
    }
  });

  const order = getPostOrder(graph);
  const nodeMap = new Map<mctree.Node, LocalInfo>();
  order.forEach((block) =>
    block.events?.forEach((event) => {
      if (
        (event.type !== "ref" && event.type !== "def") ||
        !isTypeStateKey(event.decl) ||
        !localSet.has(event.decl)
      ) {
        return;
      }
      const rep = remap.get(event.decl as LocalKey);
      if (!rep) return;
      nodeMap.set(event.node, rep);
    })
  );

  traverseAst(func.node.body!, null, (node) => {
    const info = nodeMap.get(node);
    switch (node.type) {
      case "Identifier":
        if (info && info.name !== node.name) {
          renameIdentifier(node, info.name);
        }
        return null;
      case "AssignmentExpression":
        if (info) {
          assert(node.left.type === "Identifier");
          if (
            node.right.type === "Identifier" &&
            node.right.name === info.name
          ) {
            return withLoc(
              { type: "Literal", value: null, raw: "null" },
              node,
              node
            );
          }
          if (node.left.name !== info.name) {
            renameIdentifier(node.left, info.name);
          }
          return null;
        }
        break;
      case "UpdateExpression":
        if (info) {
          assert(node.argument.type === "Identifier");
          if (node.argument.name !== info.name) {
            renameIdentifier(node.argument, info.name);
          }
          return null;
        }
        break;
      case "VariableDeclarator":
        if (info) {
          if (!node.init) {
            return false; // delete this entry
          }
          if (node.init.type === "Identifier" && node.init.name === info.name) {
            // this would create a self assignment, so just drop it
            return false;
          }
          // VariableDeclarations aren't allowed to have
          // AssignmentExpressions in them, but we'll fix that
          // via variableCleanup
          return withLoc(
            {
              type: "AssignmentExpression",
              operator: "=",
              left: withLoc(
                {
                  type: "Identifier",
                  name: info.name,
                  original: variableDeclarationName(node.id),
                },
                node.id,
                node.id
              ),
              right: node.init,
            },
            node,
            node
          );
        }
        break;
    }
    assert(!info);
    return variableCleanup(node);
  });
  return;
}

export function variableCleanup(node: mctree.Node) {
  switch (node.type) {
    case "ExpressionStatement":
      if (node.expression.type === "Literal") {
        return false;
      }
      break;
    case "VariableDeclaration":
      if (
        node.declarations.some(
          (decl: mctree.Node) => decl.type !== "VariableDeclarator"
        )
      ) {
        const results = [] as mctree.Statement[];
        node.declarations.forEach(
          (
            decl:
              | mctree.VariableDeclarator
              | mctree.Expression
              | mctree.Statement
          ) => {
            if (isStatement(decl)) {
              results.push(decl);
            } else if (isExpression(decl)) {
              results.push(
                withLoc(
                  { type: "ExpressionStatement", expression: decl },
                  decl,
                  decl
                )
              );
            } else if (decl.init) {
              results.push(
                withLoc(
                  {
                    type: "ExpressionStatement",
                    expression: withLoc(
                      {
                        type: "AssignmentExpression",
                        operator: "=",
                        left: withLoc(
                          {
                            type: "Identifier",
                            name: variableDeclarationName(decl.id),
                          },
                          decl.id,
                          decl.id
                        ),
                        right: decl.init,
                      },
                      decl,
                      decl
                    ),
                  },
                  decl,
                  decl
                )
              );
            }
          }
        );
        node.declarations = node.declarations.filter((decl) => {
          if (decl.type === "VariableDeclarator") {
            delete decl.init;
            return true;
          }
          return false;
        });
        if (node.declarations.length) {
          withLocDeep(node, node, false);
          results.unshift(node);
        }
        // if this was the init of a ForStatement, this will
        // replace its init with a BlockStatement, so we have to
        // fix that below.
        return results;
      }
      break;
    case "ForStatement":
      if (node.init) {
        if ((node.init as mctree.Node).type === "BlockStatement") {
          const result = node.init as mctree.Node as mctree.BlockStatement;
          delete node.init;
          result.body.push(node);
          if (node.loc && result.loc) {
            // result has the range of the original VariableDeclaration
            // but now we're moving that ahead of the 'for', so to keep
            // things straight, we need to set the for's start to be
            // where result ended, and result's end to be where the for
            // ends (since that block now encloses the for)
            node.start = result.end;
            node.loc.start = result.loc.end;
            result.end = node.end;
            result.loc.end = node.loc.end;
          }
          return result;
        }
        if (node.init.type === "Literal") {
          delete node.init;
        }
      }
      break;
    case "SequenceExpression":
      if (node.expressions.some((e) => e.type === "Literal")) {
        node.expressions = node.expressions.filter((e) => e.type !== "Literal");
      }
      break;
  }
  return null;
}
