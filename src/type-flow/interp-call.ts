import { ProgramStateAnalysis } from "../optimizer-types";
import { reduce } from "../util";
import {
  ExactOrUnion,
  hasValue,
  typeFromTypespec,
  typeFromTypeStateNodes,
  TypeTag,
} from "./types";
import { unionInto } from "./union-type";
import { mctree } from "@markw65/prettier-plugin-monkeyc";
export function evaluateCall(
  state: ProgramStateAnalysis,
  node: mctree.CallExpression,
  callee: ExactOrUnion,
  _args: ExactOrUnion[]
) {
  while (!hasValue(callee) || callee.type !== TypeTag.Function) {
    const name =
      node.callee.type === "Identifier"
        ? node.callee
        : node.callee.type === "MemberExpression" && !node.callee.computed
        ? node.callee.property
        : null;
    if (name) {
      const decls = state.allFunctions[name.name];
      if (decls) {
        callee = typeFromTypeStateNodes(state, decls);
        if (hasValue(callee) && callee.type === TypeTag.Function) {
          break;
        }
      }
    }
    return { type: TypeTag.Any };
  }
  return reduce(
    callee.value,
    (result, cur) => {
      if (cur.node.returnType) {
        const returnType = typeFromTypespec(
          state,
          cur.node.returnType.argument,
          cur.stack
        );
        unionInto(result, returnType);
      } else {
        result.type = TypeTag.Any;
        delete result.value;
      }
      return result;
    },
    { type: TypeTag.Never } as ExactOrUnion
  );
}
