import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { hasProperty, traverseAst, variableDeclarationName } from "./api";

export function renameVariable(
  state: ProgramStateAnalysis,
  locals: NonNullable<ProgramStateAnalysis["localsStack"]>[number],
  declName: string
) {
  const map = locals.map!;
  if (!hasProperty(map, declName)) return null;
  let suffix = 0;
  let node_name = declName;
  const match = node_name.match(/^pmcr_(.*)_(\d+)$/);
  if (match) {
    node_name = match[1];
    suffix = parseInt(match[2], 10) + 1;
  }
  if (!locals.inners) {
    // find all the names declared in this scope, to avoid
    // more conflicts
    locals.inners = {};
    const inners = locals.inners;
    traverseAst(locals.node!, (node) => {
      if (node.type === "VariableDeclarator") {
        inners[variableDeclarationName(node.id)] = true;
      }
    });
  }
  let name;
  while (true) {
    name = `pmcr_${node_name}_${suffix}`;
    if (!hasProperty(map, name) && !hasProperty(locals.inners, name)) {
      // we also need to ensure that we don't hide the name of
      // an outer module, class, function, enum or variable,
      // since someone might want to access it from this scope.
      let ok = false;
      let i;
      for (i = state.stack.length; i--; ) {
        const elm = state.stack[i];
        if (ok) {
          if (hasProperty(elm.decls, name)) {
            break;
          }
        } else if (elm.node && elm.node.type === "FunctionDeclaration") {
          ok = true;
        }
      }
      if (i < 0) {
        break;
      }
    }
    suffix++;
  }

  map[declName] = name;
  map[name] = true;
  return name;
}
