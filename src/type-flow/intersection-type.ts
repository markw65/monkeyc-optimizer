import { getSuperClasses, hasProperty } from "../api";
import { unhandledType } from "../data-flow";
import {
  ClassStateNode,
  FunctionStateNode,
  ModuleStateNode,
} from "../optimizer-types";
import { some, forEach, reduce } from "../util";
import { couldBe } from "./could-be";
import { roundToFloat } from "./interp";
import {
  ArrayValueType,
  ClassType,
  cloneType,
  DictionaryValueType,
  DoubleType,
  EnumTagsConst,
  EnumType,
  EnumValueType,
  ExactOrUnion,
  ExactTypes,
  FloatType,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  hasUnionData,
  isExact,
  LongType,
  NeverType,
  NumberType,
  ObjectLikeTagsConst,
  ObjectValueType,
  SingleValue,
  StateDeclValueType,
  TypeTag,
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
function intersectEnum(t: ExactOrUnion, e: ExactOrUnion) {
  const enumData = getUnionComponent(e, TypeTag.Enum);
  const e2 = cloneType(e);
  const i = intersection(
    t,
    !enumData
      ? { type: EnumTagsConst }
      : enumData.value
      ? enumData.value
      : enumData.enum?.resolvedType || { type: EnumTagsConst }
  );
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

export function intersection(a: ExactOrUnion, b: ExactOrUnion): ExactOrUnion {
  if (a.type & TypeTag.Typedef && a.value != null) {
    return intersection(expandTypedef(a), b);
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
    return intersectEnum(b, a);
  }
  if (
    b.type & TypeTag.Enum &&
    a.type & EnumTagsConst &&
    !(a.type & TypeTag.Enum)
  ) {
    return intersectEnum(a, b);
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
  forEachUnionComponent(a, common, (bit, avalue) => {
    const bvalue = getUnionComponent(b, bit);
    if (avalue == null) {
      if (!bvalue) return;
      result[bit] = bvalue;
      mask |= bit;
      return;
    }
    if (bvalue === null) {
      result[bit] = avalue;
      mask |= bit;
      return;
    }
    const ivalue = intersectionValue(bit, avalue, bvalue);
    if (ivalue != null) {
      result[bit] = ivalue;
      mask |= bit;
      return;
    } else {
      common -= bit;
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
  bit: ExactTypes["type"],
  avalue: SingleValue,
  bvalue: SingleValue
): SingleValue | null {
  switch (bit) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
    case TypeTag.Typedef:
      throw new Error(`Unexpected TypeTag '${TypeTag[bit]}'`);
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.String:
    case TypeTag.Char:
    case TypeTag.Symbol:
      return avalue === bvalue ? avalue : null;
    case TypeTag.Array: {
      const atype = intersection(
        avalue as ArrayValueType,
        bvalue as ArrayValueType
      );
      return atype.type === TypeTag.Never ? null : atype;
    }
    case TypeTag.Dictionary: {
      const adict = avalue as DictionaryValueType;
      const bdict = bvalue as DictionaryValueType;
      const dkey = intersection(adict.key, bdict.key);
      const dvalue = intersection(adict.value, bdict.value);
      return dkey.type !== TypeTag.Never && dvalue.type !== TypeTag.Never
        ? { key: dkey, value: dvalue }
        : null;
    }
    case TypeTag.Module:
    case TypeTag.Function: {
      const asd = avalue as StateDeclValueType;
      const bsd = bvalue as StateDeclValueType;
      // quadratic :-(
      const common: Array<ModuleStateNode | FunctionStateNode> = [];
      forEach(
        asd,
        (sna) =>
          some(bsd, (snb) => sna === snb) &&
          common.push(sna as ModuleStateNode | FunctionStateNode)
      );
      if (!common.length) return null;
      return (common.length === 1 ? common[0] : common) as SingleValue;
    }

    case TypeTag.Class: {
      const asd = avalue as NonNullable<ClassType["value"]>;
      const bsd = bvalue as NonNullable<ClassType["value"]>;
      const common: Array<ClassStateNode> = [];
      forEach(asd, (sna) => {
        const superA = getSuperClasses(sna);
        return some(bsd, (snb) => {
          if (sna === snb || (superA && superA.has(snb))) {
            common.push(sna);
          }
          const superB = getSuperClasses(snb);
          if (superB && superB.has(sna)) {
            common.push(snb);
          }
        });
      });
      if (!common.length) return null;
      return common.length === 1 ? common[0] : common;
    }

    case TypeTag.Object: {
      const aobj = avalue as ObjectValueType;
      const bobj = bvalue as ObjectValueType;
      const klass = intersection(aobj.klass, bobj.klass);
      const obj = intersectObj(aobj.obj, bobj.obj);
      return klass.type !== TypeTag.Class || klass.value == null
        ? null
        : obj
        ? { klass: klass as ClassType, obj }
        : { klass: klass as ClassType };
    }

    case TypeTag.Enum: {
      const aenum = avalue as EnumValueType;
      const benum = bvalue as EnumValueType;
      if (aenum.enum !== benum.enum && aenum.enum && benum.enum) {
        return null;
      }
      const enumDecl = aenum.enum || benum.enum;
      if (aenum.value != null) {
        if (benum.value != null) {
          const value = intersection(aenum.value, benum.value);
          const e: EnumValueType = { enum: enumDecl, value };
          return e;
        }
        return aenum.value;
      }
      return benum;
    }
    default:
      unhandledType(bit);
  }
}

function intersectObj(
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
    const br = restrictByEquality(
      a,
      (bvalue && (bvalue.value || bvalue.enum?.resolvedType)) || {
        type: EnumTagsConst,
      }
    );
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
      if (b.type & TypeTag.False && (a.value == null || a.value === 0)) {
        extra_bits |= TypeTag.False;
      }
      if (b.type & TypeTag.True && (a.value == null || a.value === 1)) {
        extra_bits |= TypeTag.True;
      }
      let value_bits = b.type & (TypeTag.Numeric | TypeTag.Char);
      if (
        a.value != null &&
        value_bits & TypeTag.Float &&
        roundToFloat(Number(a.value)) != a.value
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
      let value_bits = b.type & TypeTag.Numeric;
      if (a.value != null) {
        if (
          value_bits & TypeTag.Number &&
          BigInt.asIntN(32, a.value) != a.value
        ) {
          value_bits -= TypeTag.Number;
        }
        if (
          value_bits & TypeTag.Float &&
          BigInt(roundToFloat(Number(a.value))) != a.value
        ) {
          value_bits -= TypeTag.Float;
        }
        if (value_bits & TypeTag.Double && BigInt(Number(a.value)) != a.value) {
          value_bits -= TypeTag.Double;
        }
      }
      let v: ExactOrUnion = {
        type: value_bits,
      };
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Long ? BigInt(a.value) : Number(a.value);
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
      let value_bits = TypeTag.Numeric;
      if (a.value != null) {
        if (!Number.isInteger(a.value)) {
          value_bits -= TypeTag.Number | TypeTag.Long;
        } else {
          if (Number(BigInt.asIntN(32, BigInt(a.value))) !== a.value) {
            value_bits -= TypeTag.Number;
          }
        }
      }
      value_bits &= b.type;
      let v: ExactOrUnion = {
        type: value_bits,
      } as NumberType | FloatType | LongType | DoubleType | NeverType;
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Long ? BigInt(a.value) : Number(a.value);
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
      const value_bits = b.type & (TypeTag.Number | TypeTag.Char);
      let v: ExactOrUnion = {
        type: value_bits,
      };
      if (value_bits && !(value_bits & (value_bits - 1))) {
        if (a.value != null) {
          v.value =
            value_bits === TypeTag.Number ? a.value.charCodeAt(0) : a.value;
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
    case TypeTag.Module:
    case TypeTag.Function:
    case TypeTag.Class:
    case TypeTag.Symbol:
      return intersection(a, b);
    case TypeTag.Enum: {
      return restrictByEquality(
        (a.value && (a.value.value || a.value.enum?.resolvedType)) || {
          type: EnumTagsConst,
        },
        b
      );
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
  if (a.value == null && (b.type & bits) == b.type) {
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
 * Given that a == b, reutnr what we can deduce about b's
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
  if (a.type == TypeTag.Never) return a;
  if (isExact(a)) {
    return restrictExactTypesByEquality(a, b);
  }

  return restrictByEqualityByComponent(a, b);
}
