import { getSuperClasses, hasProperty } from "../api";
import { unhandledType } from "../data-flow";
import { some } from "../util";
import {
  EnumTagsConst,
  ExactOrUnion,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  ObjectLikeTagsConst,
  SingletonTypeTagsConst,
  tupleForEach,
  TypeTag,
  typeTagName,
  UnionDataTypeTagsConst,
  ValuePairs,
  ValueTypeTagsConst,
} from "./types";

/*
 * Determine whether a value conforming to a's type could also
 * be a value conforming to b's type.
 *
 * This is symmetric, and a subtypeOf b, or b subtypeOf a implies
 * a couldBe b.
 */
export function couldBeHelper(
  a: ExactOrUnion,
  b: ExactOrUnion,
  shallow: boolean
): boolean {
  const common = a.type & b.type & ~TypeTag.Typedef;
  if (common) {
    if (a.value == null || b.value == null || a.value === b.value) {
      return true;
    }
    if (common & SingletonTypeTagsConst) {
      // Singletons never have data, so if both types have singletons in common,
      // the result is true.
      return true;
    }
    if (common & ValueTypeTagsConst && common & UnionDataTypeTagsConst) {
      // if we have both ValueTypeTags and UnionDataTypeTags, then the
      // ValueTypeTags have no associated data, so couldBe is true.
      return true;
    }
    let result = false;
    forEachUnionComponent(a, common, (ac) => {
      if (ac.value == null) {
        result = true;
        return false;
      }
      const bvalue = getUnionComponent(b, ac.type);
      if (
        bvalue == null ||
        ac.value === bvalue ||
        couldBeValue(
          { type: ac.type, avalue: ac.value, bvalue } as ValuePairs,
          shallow
        )
      ) {
        result = true;
        return false;
      }
      return true;
    });
    if (result) return true;
  }
  if (
    (a.type & TypeTag.Enum && b.type & (EnumTagsConst | TypeTag.Enum)) ||
    (b.type & TypeTag.Enum && a.type & (EnumTagsConst | TypeTag.Enum))
  ) {
    return true;
  }
  if (
    a.type & TypeTag.Object &&
    b.type & ObjectLikeTagsConst &&
    getObjectValue(a) == null
  ) {
    /*
     * converting Number, String etc to and from Object is ok,
     * because they *are* subtypes of Object. But converting
     * them from `Object<something>` is not, because `something`
     * will never be Number, String, etc.
     *
     * So we only add Object when the other side has an unqualified
     * object type.
     */
    return true;
  }
  if (
    b.type & TypeTag.Object &&
    a.type & ObjectLikeTagsConst &&
    getObjectValue(b) == null
  ) {
    return true;
  }

  const checkTypedef = (t: ExactOrUnion, other: ExactOrUnion) => {
    const typedef = getUnionComponent(t, TypeTag.Typedef);
    return (
      typedef &&
      some(typedef, (td) => {
        if (!td.resolvedType) {
          throw new Error(`No resolved type for ${td.fullName} in 'couldBe'`);
        }
        return couldBe(td.resolvedType, other);
      })
    );
  };
  if (a.type & TypeTag.Typedef && checkTypedef(a, b)) {
    return true;
  }
  if (b.type & TypeTag.Typedef && checkTypedef(b, a)) {
    return true;
  }
  return false;
}

export function couldBe(a: ExactOrUnion, b: ExactOrUnion): boolean {
  return couldBeHelper(a, b, false);
}

export function couldBeWeak(a: ExactOrUnion, b: ExactOrUnion) {
  if (a.type === TypeTag.Never || b.type === TypeTag.Never) return true;
  return couldBe(a, b);
}

//
export function couldBeShallow(a: ExactOrUnion, b: ExactOrUnion) {
  return couldBeHelper(a, b, true);
}

function couldBeValue(pair: ValuePairs, shallow: boolean) {
  switch (pair.type) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
    case TypeTag.Typedef:
      throw new Error(`Unexpected TypeTag '${typeTagName(pair.type)}'`);
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.String:
    case TypeTag.Char:
    case TypeTag.Symbol:
      return pair.avalue === pair.bvalue;
    // todo: Array<Number> couldBe Array<String> because they could both be
    // empty.
    case TypeTag.Array: {
      if (shallow) return true;
      let result = false;
      tupleForEach(
        pair.avalue,
        (av) => {
          tupleForEach(
            pair.bvalue,
            (bv) => {
              result =
                av.length === bv.length &&
                bv.every((b, i) => couldBe(av[i], b));
              return result === false;
            },
            (bv) => {
              result = av.every((a) => couldBe(a, bv));
              return result === false;
            }
          );
          return result === false;
        },
        (av) => {
          tupleForEach(
            pair.bvalue,
            (bv) => {
              result = bv.every((b) => couldBe(av, b));
              return result === false;
            },
            (bv) => (result = couldBe(av, bv)) === false
          );
          return result === false;
        }
      );
      return result;
    }
    // todo: as above, arbitrary Dictionaries *couldBe* each other because they
    // could both be empty.
    case TypeTag.Dictionary: {
      if (shallow) return true;
      // ObjectLiteral types differ from tuples. As we see above, if a tuple
      // contains a type X, and the other array cannot contain that type,
      // couldBe has to return false.
      // But the keys of an ObjectLiteral type aren't always present, and in
      // particular it might be the empty Dictionary. So couldBe must return true.
      if (!pair.avalue.value || !pair.bvalue.value) {
        return true;
      }
      return (
        couldBe(pair.avalue.key, pair.bvalue.key) &&
        couldBe(pair.avalue.value, pair.bvalue.value)
      );
    }
    case TypeTag.Method: {
      return (
        pair.avalue.args.length === pair.bvalue.args.length &&
        couldBe(pair.avalue.result, pair.bvalue.result) &&
        pair.avalue.args.every((arg, i) => couldBe(arg, pair.bvalue.args[i]))
      );
    }
    case TypeTag.Module:
    case TypeTag.Function: {
      // quadratic :-(
      return some(pair.avalue, (sna) =>
        some(pair.bvalue, (snb) => sna === snb)
      );
    }
    case TypeTag.Class: {
      return some(pair.avalue, (sna) => {
        const superA = getSuperClasses(sna);
        return some(pair.bvalue, (snb) => {
          if (sna === snb || (superA && superA.has(snb))) {
            return true;
          }
          const superB = getSuperClasses(snb);
          return superB ? superB.has(sna) : false;
        });
      });
    }

    case TypeTag.Object: {
      return (
        couldBe(pair.avalue.klass, pair.bvalue.klass) &&
        (shallow || couldBeObj(pair.avalue.obj, pair.bvalue.obj))
      );
    }

    case TypeTag.Enum: {
      return (
        (!pair.avalue.value ||
          !pair.bvalue.value ||
          couldBe(pair.avalue.value, pair.bvalue.value)) &&
        some(pair.avalue.enum, (sna) =>
          some(pair.bvalue.enum, (snb) => sna === snb)
        )
      );
    }
    default:
      unhandledType(pair);
  }
}

function couldBeObj(
  a: Record<string, ExactOrUnion> | undefined,
  b: Record<string, ExactOrUnion> | undefined
) {
  if (!a || !b) return true;
  return Object.entries(a).every(([key, value]) => {
    if (!hasProperty(b, key)) return true;
    return couldBe(value, b[key]);
  });
}
