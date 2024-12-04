import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { subtypeOf } from "./sub-type";
import { ArrayType, ExactOrUnion, TypeTag, reducedType } from "./types";
import { couldBe } from "./could-be";
import { InterpState, evaluate } from "./interp";

export type ArrayTypeData = NonNullable<ArrayType["value"]>;

export function tupleForEach(
  t: ArrayTypeData,
  tupleFn: (v: ExactOrUnion[]) => unknown,
  arrayFn: (v: ExactOrUnion) => unknown
) {
  if (t instanceof Set) {
    for (const v of t) {
      if ((Array.isArray(v) ? tupleFn(v) : arrayFn(v)) === false) {
        break;
      }
    }
  } else {
    if (Array.isArray(t)) {
      tupleFn(t);
    } else {
      arrayFn(t);
    }
  }
}

export function tupleMap<T, U, V>(
  t: ArrayTypeData,
  tupleFn: (v: ExactOrUnion[]) => U | null,
  arrayFn: (v: ExactOrUnion) => V | null,
  reduceFn: (v: Array<U | V>) => T
) {
  const result =
    t instanceof Set
      ? Array.from(t).map((v) => (Array.isArray(v) ? tupleFn(v) : arrayFn(v)))
      : [Array.isArray(t) ? tupleFn(t) : arrayFn(t)];

  return reduceFn(result.filter((v): v is U | V => v != null));
}

export function tupleReduce(v: Array<ExactOrUnion | ExactOrUnion[]>) {
  return v.length === 1 ? v[0] : new Set(v);
}

export function reducedArrayType(t: ArrayTypeData) {
  if (t instanceof Set) {
    return reducedType(Array.from(t).map((v) => reducedType(v)));
  }
  return reducedType(t);
}

export function restrictArrayData(
  constraint: ArrayTypeData,
  tracked: ArrayTypeData
) {
  const trackedType = { type: TypeTag.Array, value: tracked } as const;
  const result = (
    constraint instanceof Set ? Array.from(constraint) : [constraint]
  ).filter((value) => couldBe({ type: TypeTag.Array, value }, trackedType));
  return result.length === 0
    ? constraint
    : result.length === 1
    ? result[0]
    : new Set(result);
}

export function checkArrayCovariance(arg: ArrayTypeData, param: ArrayTypeData) {
  let ok = true;
  tupleForEach(
    arg,
    (av) => {
      tupleForEach(
        param,
        (pv) => {
          // it's ok if this av isn't a subtype of pv
          if (av.length !== pv.length) return true;
          if (!av.every((a, i) => subtypeOf(a, pv[i]))) return true;
          // Not ok if pv isn't a subtype of av (ie, they have to be equal)
          if (!av.every((a, i) => subtypeOf(pv[i], a))) {
            ok = false;
          }
          return ok !== false;
        },
        () => {
          // never safe to pass a tuple to a non-tuple parameter
          ok = false;
          return false;
        }
      );
      return ok !== false;
    },
    (av) => {
      tupleForEach(
        param,
        () => {
          // Array<Any> is never a subtype of a tuple, so we can ignore
          // this case.
          return ok !== false;
        },
        (pv) => {
          if (subtypeOf(av, pv) && !subtypeOf(pv, av)) {
            ok = false;
          }
          return ok !== false;
        }
      );
      return ok !== false;
    }
  );
  return ok;
}

export function safeReferenceArg(
  istate: InterpState,
  arg: mctree.Expression
): boolean {
  if (
    arg.type === "Literal" ||
    arg.type === "ArrayExpression" ||
    arg.type === "ObjectExpression" ||
    arg.type === "NewExpression" ||
    (arg.type === "BinaryExpression" &&
      arg.operator === "as" &&
      safeReferenceArg(istate, arg.left)) ||
    (arg.type === "ConditionalExpression" &&
      safeReferenceArg(istate, arg.consequent) &&
      safeReferenceArg(istate, arg.alternate))
  ) {
    return true;
  }

  const type = istate.typeMap?.get(arg) ?? evaluate(istate, arg).value;
  if (type && !couldBe({ type: TypeTag.Array | TypeTag.Dictionary }, type)) {
    return true;
  }

  return false;
}
