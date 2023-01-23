import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  collectNamespaces,
  isLookupCandidate,
  lookupNext,
  sameLookupResult,
} from "./api";
import {
  LookupDefinition,
  LookupResult,
  ProgramStateAnalysis,
} from "./optimizer-types";
import { findObjectDeclsByProperty } from "./type-flow";
import { TypeMap } from "./type-flow/interp";

export function visitorNode(node: mctree.Node): mctree.Node {
  if (node.type === "Identifier") {
    return node;
  }

  if (node.type === "MemberExpression") {
    return node.property.type === "UnaryExpression" &&
      node.property.operator === ":"
      ? node.property.argument
      : node.property;
  }

  if (
    node.type === "BinaryExpression" &&
    node.operator === "has" &&
    node.right.type === "UnaryExpression" &&
    node.right.operator === ":"
  ) {
    return node.right.argument;
  }

  return node;
}

export function visitReferences(
  state: ProgramStateAnalysis,
  ast: mctree.Program,
  name: string | null,
  defn: LookupDefinition[] | null | false,
  callback: (
    node: mctree.Node,
    results: LookupDefinition[],
    error: boolean
  ) => undefined | false,
  includeDefs = false,
  filter: ((node: mctree.Node) => boolean) | null = null,
  typeMap: TypeMap | null = null
) {
  const lookup = (node: mctree.Node, nonLocal = false): LookupResult => {
    const results = nonLocal ? state.lookupNonlocal(node) : state.lookup(node);
    if (results[1] || !typeMap) return results;
    if (node.type === "MemberExpression" && !node.computed) {
      const objectType = typeMap.get(node.object);
      if (!objectType) return results;
      const decls = findObjectDeclsByProperty(state, objectType, node);
      if (decls) {
        const next = lookupNext(
          state,
          [{ parent: null, results: decls }],
          "decls",
          node.property
        );
        if (next) {
          return [node.property.name, next];
        }
      }
    }
    return results;
  };

  const checkResults = (
    [name, results]: ReturnType<ProgramStateAnalysis["lookup"]>,
    node: mctree.Node
  ) => {
    if (name && results) {
      if (!defn || sameLookupResult(results, defn)) {
        if (callback(node, results, false) === false) {
          return [];
        }
      }
    } else if (defn === false) {
      if (callback(node, [], results === null) === false) {
        return [];
      }
    }
    return null;
  };
  state.pre = (node) => {
    if (filter && !filter(node)) return [];
    switch (node.type) {
      case "AttributeList":
        return [];
      case "UnaryExpression":
        // a bare symbol isn't a reference
        if (node.operator === ":") return [];
        break;
      case "BinaryExpression":
        /*
         * `expr has :symbol` can be treated as a reference
         * to expr.symbol.
         */
        if (node.operator === "has") {
          if (
            node.right.type === "UnaryExpression" &&
            node.right.operator === ":"
          ) {
            if (!name || node.right.argument.name === name) {
              return checkResults(
                lookup({
                  type: "MemberExpression",
                  object: node.left,
                  property: node.right.argument,
                  computed: false,
                }),
                node
              );
            }
          }
        }
        break;

      case "CallExpression":
        // A call expression whose callee is an identifier is looked
        // up as a non-local. ie even if there's a same named local,
        // it will be ignored, and the lookup will start as if the
        // call had been written self.foo() rather than foo().
        if (node.callee.type === "Identifier") {
          if (!name || node.callee.name === name) {
            /* ignore return value */
            checkResults(lookup(node.callee, true), node.callee);
          }
          return ["arguments"];
        }
        break;

      case "Identifier":
        if (!name || node.name === name) {
          return checkResults(lookup(node), node);
        }
        break;

      case "MemberExpression": {
        const property = isLookupCandidate(node);
        if (property) {
          if (!name || property.name === name) {
            return checkResults(lookup(node), node) || ["object"];
          }
          return ["object"];
        }
        break;
      }
      case "MethodDefinition": {
        if (!state.inType) {
          throw new Error("Method definition outside of type!");
        }
        if (node.params) {
          node.params.forEach((param) => {
            if (param.type === "BinaryExpression") {
              state.traverse(param.right);
            }
          });
        }
        return ["returnType"];
      }

      case "ModuleDeclaration":
        if (includeDefs) break;
        return ["body"];
      case "ClassDeclaration":
        if (includeDefs) break;
        return ["body", "superClass"];
      case "FunctionDeclaration":
        if (includeDefs) break;
        return ["params", "returnType", "body"];
      case "TypedefDeclaration":
        if (includeDefs) break;
        return ["ts"];

      case "VariableDeclarator":
        if (includeDefs) break;
        return ["init"];
      case "EnumDeclaration":
        if (includeDefs) break;
        return [];
      case "CatchClause":
        if (includeDefs) break;
        if (node.param && node.param.type !== "Identifier") {
          state.traverse(node.param.right);
        }
        return ["body"];
    }
    return null;
  };
  collectNamespaces(ast, state);
  delete state.pre;
}
