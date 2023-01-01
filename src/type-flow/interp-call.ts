import { ProgramStateAnalysis } from "../optimizer-types";
import { reduce } from "../util";
import { ExactOrUnion, hasValue, typeFromTypespec, TypeTag } from "./types";
import { unionInto } from "./union-type";

export function evaluateCall(
  state: ProgramStateAnalysis,
  callee: ExactOrUnion,
  _args: ExactOrUnion[]
) {
  if (!hasValue(callee) || callee.type !== TypeTag.Function) {
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
