import { getSuperClasses, hasProperty } from "../api";
import { unhandledType } from "../data-flow";
import {
  ClassStateNode,
  EnumStateNode,
  FunctionStateNode,
  ModuleStateNode,
} from "../optimizer-types";
import { forEach, reduce, some } from "../util";
import { tupleMap, tupleReduce } from "./array-type";
import { couldBe } from "./could-be";
import { roundToFloat } from "./interp";
import {
  ActiveTypeMap,
  CharType,
  ClassType,
  DoubleType,
  EnumTagsConst,
  EnumType,
  ExactOrUnion,
  ExactTypes,
  FloatType,
  LongType,
  NeverType,
  NumberType,
  ObjectLikeTagsConst,
  SingleValue,
  TypeTag,
  ValuePairs,
  cloneType,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  guardRecursiveTypedef,
  hasUnionData,
  isExact,
  typeFromEnumValue,
  typeTagName,
} from "./types";
import { clearValuesUnder, unionInto } from "./union-type";

export function expandTypedef(t: ExactOrUnion) {
  const decls = getUnionComponent(t, TypeTag.Typedef);
  const tExpanded = cloneType(t);
  clearValuesUnder(tExpanded, TypeTag.Typedef, true);
  forEach(decls, (decl) => unionInto(tExpanded, decl.resolvedType!));

  return tExpanded;
}

/*
 * We treat an enum as a more specialized form of its values. So if
 * we're intersecting an enum with something that could have values
 * related to the enum, we need to refine the enum's value
 */
function intersectEnum(
  activeTypeMap: ActiveTypeMap | null,
  t: ExactOrUnion,
  e: ExactOrUnion
) {
  const enumData = getUnionComponent(e, TypeTag.Enum);
  const e2 = cloneType(e);
  const i = intersection(t, typeFromEnumValue(enumData));
  if (e2.value != null) {
    clearValuesUnder(e2, TypeTag.Enum, true);
  } else {
    e2.type &= ~TypeTag.Enum;
  }
  const rest = intersection(t, e2);
  if (i.type === TypeTag.Never) {
    // There are no values. This would happen if eg
    // the enum is numbers only, and t cannot be a
    // number (eg its a string)
    return rest;
  }

  const result = enumData
    ? ({ type: TypeTag.Enum, value: { ...enumData, value: i } } as EnumType)
    : cloneType(i);
  unionInto(result, rest);
  return result;
}

const activeTypeMap: ActiveTypeMap = new Map();
export function intersection(a: ExactOrUnion, b: ExactOrUnion): ExactOrUnion {
  if (a.type & TypeTag.Typedef && a.value != null) {
    const result = guardRecursiveTypedef(activeTypeMap, a, b, intersection);
    return result === true ? a : result;
  }
  if (b.type & TypeTag.Typedef && b.value != null) {
    return intersection(a, expandTypedef(b));
  }
  let common = a.type & b.type & ~TypeTag.Typedef;
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
    common |= b.type & ObjectLikeTagsConst;
  }
  if (
    b.type & TypeTag.Object &&
    a.type & ObjectLikeTagsConst &&
    getObjectValue(b) == null
  ) {
    common |= a.type & ObjectLikeTagsConst;
  }
  if (
    a.type & TypeTag.Enum &&
    b.type & EnumTagsConst &&
    !(b.type & TypeTag.Enum)
  ) {
    return intersectEnum(activeTypeMap, b, a);
  }
  if (
    b.type & TypeTag.Enum &&
    a.type & EnumTagsConst &&
    !(a.type & TypeTag.Enum)
  ) {
    return intersectEnum(activeTypeMap, a, b);
  }

  if (!common) {
    return { type: TypeTag.Never };
  }

  if (a.value == null) {
    if (b.value == null) {
      return { type: common };
    }
    const result = cloneType(b);
    clearValuesUnder(result, b.type & ~common, true);
    return result;
  }
  if (b.value == null) {
    const result = cloneType(a);
    clearValuesUnder(result, a.type & ~common, true);
    return result;
  }

  let mask = 0;
  const result: Record<number, SingleValue> = {};
  forEachUnionComponent(a, common, (ac) => {
    const bvalue = getUnionComponent(b, ac.type);
    if (ac.value == null) {
      if (!bvalue) return;
      result[ac.type] = bvalue;
      mask |= ac.type;
      return;
    }
    if (bvalue === null || ac.value === bvalue) {
      result[ac.type] = ac.value;
      mask |= ac.type;
      return;
    }
    const ivalue = intersectionValue(activeTypeMap, {
      type: ac.type,
      avalue: ac.value,
      bvalue,
    } as ValuePairs);
    if (ivalue != null) {
      result[ac.type] = ivalue;
      mask |= ac.type;
      return;
    } else {
      common -= ac.type;
    }
  });
  if (!mask) return { type: common };
  if (hasUnionData(common)) {
    return { type: common, value: { ...result, mask } };
  }
  if (mask & (mask - 1)) {
    throw new Error(
      `Mask with non-union data had more than one bit set: ${mask}`
    );
  }
  return { type: common, value: result[mask] } as ExactOrUnion;
}

function intersectionValue(
  activeTypeMap: ActiveTypeMap | null,
  pair: ValuePairs
): SingleValue | null {
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
      return pair.avalue === pair.bvalue ? pair.avalue : null;
    case TypeTag.Array:
      return tupleMap(
        pair.avalue,
        (av) =>
          tupleMap(
            pair.bvalue,
            (bv) => {
              if (av.length !== bv.length) return null;
              const isect = av.map((t, i) => intersection(t, bv[i]));
              return isect.some((t) => t.type === TypeTag.Never) ? null : isect;
            },
            (bv) => {
              const isect = av.map((t) => intersection(bv, t));
              return isect.some((t) => t.type === TypeTag.Never) ? null : isect;
            },
            (bv) => (bv.length === 0 ? null : bv)
          ),
        (av) =>
          tupleMap(
            pair.bvalue,
            (bv) => {
              const isect = bv.map((t) => intersection(av, t));
              return isect.some((t) => t.type === TypeTag.Never) ? null : isect;
            },
            (bv) => {
              const atype = intersection(av, bv);
              return atype.type === TypeTag.Never ? null : atype;
            },
            (bv) => (bv.length === 0 ? null : bv)
          ),
        (av) => {
          const result = av.flat(1);
          return result.length === 0 ? null : tupleReduce(result);
        }
      );

    case TypeTag.Dictionary: {
      if (!pair.avalue.value) {
        if (!pair.bvalue.value) {
          const result = new Map(pair.avalue);
          pair.bvalue.forEach((bv, key) => {
            const av = result.get(key);
            if (av) {
              bv = intersection(bv, av);
            }
            result.set(key, bv);
          });
          return result;
        } else {
          return pair.bvalue;
        }
      } else if (!pair.bvalue.value) {
        return pair.avalue;
      }
      const dkey = intersection(pair.avalue.key, pair.bvalue.key);
      const dvalue = intersection(pair.avalue.value, pair.bvalue.value);
      return dkey.type !== TypeTag.Never && dvalue.type !== TypeTag.Never
        ? { key: dkey, value: dvalue }
        : null;
    }
    case TypeTag.Method: {
      if (pair.avalue.args.length !== pair.bvalue.args.length) return null;
      const mresult = intersection(pair.avalue.result, pair.bvalue.result);
      if (mresult.type === TypeTag.Never) return null;
      const margs = pair.avalue.args.map((aarg, i) => {
        aarg = cloneType(aarg);
        unionInto(aarg, pair.bvalue.args[i]);
        return aarg;
      });
      if (margs.some((arg) => arg.type === TypeTag.Never)) return null;
      return { result: mresult, args: margs };
    }
    case TypeTag.Module:
    case TypeTag.Function: {
      // quadratic :-(
      const common = new Set<ModuleStateNode | FunctionStateNode>();
      forEach(
        pair.avalue,
        (sna) =>
          some(pair.bvalue, (snb) => sna === snb) &&
          common.add(sna as ModuleStateNode | FunctionStateNode)
      );
      if (!common.size) return null;
      const arr = Array.from(common);
      return (arr.length === 1 ? arr[0] : arr) as SingleValue;
    }

    case TypeTag.Class: {
      const common = new Set<ClassStateNode>();
      forEach(pair.avalue, (sna) => {
        const superA = getSuperClasses(sna);
        forEach(pair.bvalue, (snb) => {
          if (sna === snb || (superA && superA.has(snb))) {
            common.add(sna);
          }
          const superB = getSuperClasses(snb);
          if (superB && superB.has(sna)) {
            common.add(snb);
          }
        });
      });
      if (!common.size) return null;
      const arr = Array.from(common);
      return arr.length === 1 ? arr[0] : arr;
    }

    case TypeTag.Object: {
      const klass = intersection(pair.avalue.klass, pair.bvalue.klass);
      const obj = intersectObj(activeTypeMap, pair.avalue.obj, pair.bvalue.obj);
      return klass.type !== TypeTag.Class || klass.value == null
        ? null
        : obj
        ? { klass: klass as ClassType, obj }
        : { klass: klass as ClassType };
    }

    case TypeTag.Enum: {
      let enumDecl: typeof pair.avalue.enum | undefined;
      if (Array.isArray(pair.avalue.enum)) {
        const s = new Set(pair.avalue.enum);
        const enums: EnumStateNode[] = [];
        forEach(pair.bvalue.enum, (b) => s.has(b) && enums.push(b));
        if (enums.length) {
          enumDecl = enums.length === 1 ? enums[0] : enums;
        }
      } else {
        some(pair.bvalue.enum, (b) => b === pair.avalue.enum) &&
          (enumDecl = pair.bvalue.enum);
      }
      if (!enumDecl) return null;
      const enumValue =
        pair.avalue.value != null
          ? pair.bvalue.value != null
            ? intersection(pair.avalue.value, pair.bvalue.value)
            : pair.avalue.value
          : pair.bvalue.value;
      return { enum: enumDecl, value: enumValue };
    }
    default:
      unhandledType(pair);
  }
}

function intersectObj(
  activeTypeMap: ActiveTypeMap | null,
  to: Record<string, ExactOrUnion> | undefined,
  from: Record<string, ExactOrUnion> | undefined
) {
  if (!to) return from;
  if (!from) return to;
  let result = to;
  Object.entries(from).forEach(([key, value]) => {
    if (!hasProperty(to, key)) {
      if (result === to) result = { ...result };
      result[key] = value;
      return;
    }
    if (result === to) result = { ...result };
    result[key] = intersection(to[key], value);
  });
  return result;
}

function fixupEnum(
  a: ExactOrUnion,
  b_restricted: ExactOrUnion,
  b: ExactOrUnion
): ExactOrUnion {
  if (b.type & TypeTag.Enum) {
    const bvalue = getUnionComponent(b, TypeTag.Enum);
    const br = restrictByEquality(a, typeFromEnumValue(bvalue));
    if (br.type) {
      b_restricted = cloneType(b_restricted);
      unionInto(
        b_restricted,
        bvalue
          ? {
              type: TypeTag.Enum,
              value: { ...bvalue, value: br },
            }
          : br
      );
    }
  }
  return b_restricted;
}

function restrictExactTypesByEquality(
  a: ExactTypes,
  b: ExactOrUnion
): ExactOrUnion {
  switch (a.type) {
    case TypeTag.Null:
      if (b.type & TypeTag.Null) {
        return a;
      }
      break;
    case TypeTag.False:
    case TypeTag.True: {
      // intersection correctly handles enums in b
      return intersection(b, {
        type: a.type | TypeTag.Number,
        value: a.type === TypeTag.False ? 0 : 1,
      });
    }
    case TypeTag.Number: {
      let extra_bits = 0;
      if (a.value == null || a.value === 0) {
        extra_bits |= TypeTag.False;
      }
      if (a.value == null || a.value === 1) {
        extra_bits |= TypeTag.True;
      }
      let value_bits = b.type & (TypeTag.Numeric | TypeTag.Char);
      if (b.type & TypeTag.Object && !getObjectValue(b)) {
        value_bits |= TypeTag.Numeric | TypeTag.Char;
      } else {
        extra_bits &= b.type;
      }
      // Some Numbers don't fit exactly in a Float
      // We can eliminate Float from b's type in those cases.
      if (
        a.value != null &&
        value_bits & TypeTag.Float &&
        roundToFloat(Number(a.value)) !== a.value
      ) {
        value_bits -= TypeTag.Float;
      }

      let v: ExactOrUnion = {
        type: value_bits | extra_bits,
      };
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Char
              ? String.fromCharCode(a.value)
              : value_bits === TypeTag.Long
              ? BigInt(a.value)
              : Number(a.value);
          if (b.value && !couldBe(v, b)) {
            v.type = TypeTag.Never;
            delete v.value;
          }
        } else if (b.value != null) {
          v = intersection(b, v);
        }
      }
      return fixupEnum(a, v, b);
    }

    case TypeTag.Long: {
      let value_bits = b.type & (TypeTag.Numeric | TypeTag.Char);
      if (b.type & TypeTag.Object && !getObjectValue(b)) {
        value_bits |= TypeTag.Numeric | TypeTag.Char;
      }
      if (a.value != null) {
        if (
          value_bits & TypeTag.Number &&
          BigInt.asIntN(32, a.value) !== a.value
        ) {
          value_bits -= TypeTag.Number;
        }
        if (
          value_bits & TypeTag.Char &&
          BigInt.asIntN(32, a.value) !== a.value
        ) {
          value_bits -= TypeTag.Char;
        }
        if (
          value_bits & TypeTag.Float &&
          BigInt(roundToFloat(Number(a.value))) !== a.value
        ) {
          value_bits -= TypeTag.Float;
        }
        if (
          value_bits & TypeTag.Double &&
          BigInt(Number(a.value)) !== a.value
        ) {
          value_bits -= TypeTag.Double;
        }
      }
      let v: ExactOrUnion = {
        type: value_bits,
      };
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Char
              ? String.fromCharCode(Number(a.value))
              : value_bits === TypeTag.Long
              ? BigInt(a.value)
              : Number(a.value);
          if (b.value && !couldBe(v, b)) {
            v.type = TypeTag.Never;
            delete v.value;
          }
        } else if (b.value != null) {
          v = intersection(b, v);
        }
      }
      return fixupEnum(a, v, b);
    }

    case TypeTag.Double:
    case TypeTag.Float: {
      let value_bits = b.type & (TypeTag.Numeric | TypeTag.Char);
      if (b.type & TypeTag.Object && !getObjectValue(b)) {
        value_bits |= TypeTag.Numeric | TypeTag.Char;
      }
      if (a.value != null) {
        if (!Number.isInteger(a.value)) {
          value_bits &= ~(TypeTag.Number | TypeTag.Long | TypeTag.Char);
        } else {
          if (Number(BigInt.asIntN(32, BigInt(a.value))) !== a.value) {
            value_bits &= ~(TypeTag.Number | TypeTag.Char);
          }
        }
      }
      let v: ExactOrUnion = {
        type: value_bits,
      } as
        | NumberType
        | FloatType
        | LongType
        | DoubleType
        | NeverType
        | CharType;
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Long
              ? BigInt(a.value)
              : value_bits === TypeTag.Char
              ? String.fromCharCode(Number(a.value))
              : a.value;
          if (b.value && !couldBe(v, b)) {
            v.type = TypeTag.Never;
            delete v.value;
          }
        } else if (b.value != null) {
          v = intersection(b, v);
        }
      }
      return fixupEnum(a, v, b);
    }

    case TypeTag.Char: {
      let extra_bits = 0;
      if (a.value == null || a.value.charCodeAt(0) === 0) {
        extra_bits |= TypeTag.False;
      }
      if (a.value == null || a.value.charCodeAt(0) === 1) {
        extra_bits |= TypeTag.True;
      }
      let value_bits = b.type & (TypeTag.Numeric | TypeTag.Char);
      if (b.type & TypeTag.Object && !getObjectValue(b)) {
        value_bits |= TypeTag.Numeric | TypeTag.Char;
      } else {
        extra_bits &= b.type;
      }
      let v: ExactOrUnion = {
        type: value_bits | extra_bits,
      };
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Long
              ? BigInt(a.value.charCodeAt(0))
              : value_bits & TypeTag.Numeric
              ? a.value.charCodeAt(0)
              : a.value;
          if (b.value && !couldBe(v, b)) {
            v.type = TypeTag.Never;
            delete v.value;
          }
        } else if (b.value != null) {
          v = intersection(b, v);
        }
      }
      return fixupEnum(a, v, b);
    }

    case TypeTag.Object:
    case TypeTag.String:
    case TypeTag.Array:
    case TypeTag.Dictionary:
    case TypeTag.Method:
    case TypeTag.Module:
    case TypeTag.Function:
    case TypeTag.Class:
    case TypeTag.Symbol:
      return intersection(a, b);
    case TypeTag.Enum: {
      return restrictByEquality(typeFromEnumValue(a.value), b);
    }

    case TypeTag.Typedef:
      return restrictByEquality(
        reduce(
          a.value,
          (cur, decl) => {
            unionInto(cur, decl.resolvedType!);
            return cur;
          },
          { type: TypeTag.Never }
        ),
        b
      );
    default:
      unhandledType(a);
  }
  return { type: TypeTag.Never };
}

function restrictByEqualityByComponent(
  a: ExactOrUnion,
  b: ExactOrUnion
): ExactOrUnion {
  let bits = a.type;
  if (a.value == null && (b.type & bits) === b.type) {
    // shortcut:
    // if b.type is contained in a.type, and a has no
    // specialization, the result is just b.
    return b;
  }
  let br: ExactOrUnion | null = null;
  do {
    const next = bits & (bits - 1);
    const bit = bits - next;

    const brt = restrictExactTypesByEquality(
      {
        type: bit,
        value: getUnionComponent(a, bit) || undefined,
      } as ExactTypes,
      b
    );
    if (brt.type !== TypeTag.Never) {
      if (!br) {
        br = cloneType(brt);
      } else {
        unionInto(br, brt);
      }
    }
    bits = next;
  } while (bits);
  if (!br) {
    return { type: TypeTag.Never };
  }
  return br;
}
/*
 * Given that a == b, return what we can deduce about b's
 * type.
 *
 * Note that this is similar to intersection. In many cases, it
 * is intersection. eg if a is the type (Null or "Hello" or Menu)
 * then we know b's type must be a subtype of intersection(a, b).
 *
 * But eg if it was a == 5, and a is known to be Char, String,
 * Number or Float, we can only eliminate String, because
 * 5.0 == 5, and 5.toChar() == 5.
 */
export function restrictByEquality(
  a: ExactOrUnion,
  b: ExactOrUnion
): ExactOrUnion {
  if (a.type === TypeTag.Never) return a;
  if (isExact(a)) {
    return restrictExactTypesByEquality(a, b);
  }

  return restrictByEqualityByComponent(a, b);
}
