import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { subtypeOf } from "./sub-type";
import { ArrayType, ExactOrUnion, reducedType } from "./types";

export function tupleForEach(
  t: NonNullable<ArrayType["value"]>,
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
  t: NonNullable<ArrayType["value"]>,
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

export function reducedArrayType(
  t: Set<ExactOrUnion[] | ExactOrUnion> | ExactOrUnion[] | ExactOrUnion
) {
  if (t instanceof Set) {
    return reducedType(Array.from(t).map((v) => reducedType(v)));
  }
  return reducedType(t);
}

export function checkArrayCovariance(
  arg: NonNullable<ArrayType["value"]>,
  param: NonNullable<ArrayType["value"]>
) {
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

export function safeReferenceArg(arg: mctree.Expression) {
  return (
    arg.type === "ArrayExpression" ||
    arg.type === "ObjectExpression" ||
    arg.type === "NewExpression"
  );
}
