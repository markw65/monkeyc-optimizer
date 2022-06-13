import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { collectNamespaces, sameLookupResult } from "./api";

export function visitReferences(
  state: ProgramStateAnalysis,
  ast: mctree.Program,
  name: string | null,
  defn: LookupDefinition[] | null,
  callback: (node: mctree.Node, results: LookupDefinition[]) => void
) {
  const checkResults = (
    [name, results]: ReturnType<ProgramStateAnalysis["lookup"]>,
    node: mctree.Node
  ) => {
    if (name && results && (!defn || sameLookupResult(results, defn))) {
      callback(node, results);
    }
  };
  state.pre = (node) => {
    switch (node.type) {
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
              checkResults(
                state.lookup({
                  type: "MemberExpression",
                  object: node.left,
                  property: node.right.argument,
                  computed: false,
                }),
                node.right.argument
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
            checkResults(state.lookupNonlocal(node.callee), node.callee);
          }
          return ["arguments"];
        }
        break;

      case "Identifier":
        if (!name || node.name === name) {
          checkResults(state.lookup(node), node);
        }
        break;

      case "MemberExpression":
        if (!node.computed && node.property.type === "Identifier") {
          if (!name || node.property.name === name) {
            checkResults(state.lookup(node), node);
          }
          return ["object"];
        }
        break;
    }
    return null;
  };
  collectNamespaces(ast, state);
  delete state.pre;
}
