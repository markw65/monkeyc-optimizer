import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  collectNamespaces,
  isLookupCandidate,
  lookupResultContains,
  lookupWithType,
} from "./api";
import {
  LookupDefinition,
  ProgramStateAnalysis,
  StateNodeDecl,
} from "./optimizer-types";
import { TypeMap } from "./type-flow/interp";
import { ClassStateNode } from "./optimizer-types";

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

  if (node.type === "NewExpression") {
    return visitorNode(node.callee);
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
  typeMap: TypeMap | null = null,
  findSingleDefinition = false
) {
  const lookup = (node: mctree.Node, nonLocal = false) =>
    lookupWithType(state, node, typeMap, nonLocal);
  const checkResults = (
    [name, results]: ReturnType<ProgramStateAnalysis["lookup"]>,
    node: mctree.Node
  ) => {
    if (name && results) {
      if (!defn || lookupResultContains(results, defn)) {
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
  const visitDef = (
    node: mctree.TypedIdentifier,
    def?: mctree.Node,
    decls: "decls" | "type_decls" = "decls"
  ) => {
    const id = node.type === "BinaryExpression" ? node.left : node;
    if (filter && !filter(id)) return;
    let [scope, parent] = state.stack.slice(-2).reverse();
    let results: StateNodeDecl[] | undefined;
    if (def) {
      if (scope.sn.node !== def) {
        parent = scope;
      }
      results = parent.sn[decls]?.[id.name];
      if (!results) return;
      const thisDefn = results.find(
        (decl: StateNodeDecl & { node?: unknown }) => decl.node === def
      );
      if (!thisDefn) {
        return;
      }
      if (findSingleDefinition) {
        results = [thisDefn];
      }
    } else {
      if (!parent) {
        return;
      }
      results = [scope.sn];
    }
    checkResults([id.name, [{ parent: parent.sn, results }]], id);
  };
  const { pre, post } = state;
  try {
    state.pre = function (node) {
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
          } else if (this.inType && node.operator === "as") {
            return ["right"];
          }
          break;

        case "CallExpression":
          // A call expression whose callee is an identifier is looked
          // up as a non-local. ie even if there's a same named local,
          // it will be ignored, and the lookup will start as if the
          // call had been written self.foo() rather than foo().
          if (node.callee.type === "Identifier") {
            if (
              (!name || node.callee.name === name) &&
              (!filter || filter(node.callee))
            ) {
              /* ignore return value */
              checkResults(lookup(node.callee, true), node.callee);
            }
            return ["arguments"];
          }
          break;
        case "NewExpression": {
          const [name, results] = lookup(node.callee, true);
          if (!results) break;
          const initializers = new Map<ClassStateNode, StateNodeDecl[]>();
          results.forEach((result) => {
            result.results.forEach((klass) => {
              if (klass.type !== "ClassDeclaration") return;
              const inits = klass.decls?.["initialize"];
              inits?.forEach((init) => {
                if (init.type === "FunctionDeclaration") {
                  const existing = initializers.get(klass);
                  if (existing) {
                    existing.push(init);
                  } else {
                    initializers.set(klass, [init]);
                  }
                }
              });
            });
          });
          if (initializers.size) {
            checkResults(
              [
                name,
                Array.from(initializers).map(([parent, results]) => ({
                  parent,
                  results,
                })),
              ],
              node
            );
          }
          break;
        }

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
          if (!this.inType) {
            throw new Error("Method definition outside of type!");
          }
          if (node.params) {
            node.params.forEach((param) => {
              if (param.type === "BinaryExpression") {
                this.traverse(param.right);
              }
            });
          }
          return ["returnType"];
        }

        case "ModuleDeclaration":
          if (includeDefs) {
            visitDef(node.id);
          }
          return ["body"];
        case "ClassDeclaration":
          if (includeDefs) {
            visitDef(node.id, node);
          }
          return ["body", "superClass"];
        case "FunctionDeclaration":
          if (includeDefs) {
            visitDef(node.id, node);
          }
          return ["params", "returnType", "body"];
        case "TypedefDeclaration":
          if (includeDefs) {
            visitDef(node.id, node, "type_decls");
          }
          return ["ts"];

        case "VariableDeclarator":
          if (includeDefs) {
            visitDef(node.id, node);
          }
          if (node.id.type === "BinaryExpression") {
            this.traverse(node.id.right);
          }
          return ["init"];
        case "EnumDeclaration":
          if (includeDefs) {
            if (node.id) {
              visitDef(node.id, node, "type_decls");
            }
            break;
          }
          return [];
        case "EnumStringMember": {
          if (!filter || filter(node.id)) {
            checkResults(
              [node.id.name, [{ parent: this.top().sn, results: [node] }]],
              node
            );
          }
          break;
        }
        case "CatchClause":
          if (includeDefs) break;
          if (node.param && node.param.type !== "Identifier") {
            this.traverse(node.param.right);
          }
          return ["body"];
      }
      return null;
    };
    delete state.post;
    collectNamespaces(ast, state);
  } finally {
    state.pre = pre;
    state.post = post;
  }
}
