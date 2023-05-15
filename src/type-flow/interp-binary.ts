import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { couldBeWeak } from "./could-be";
import { roundToFloat } from "./interp";
import { subtypeOf } from "./sub-type";
import {
  castType,
  ClassType,
  ExactOrUnion,
  ExactTypes,
  hasValue,
  isExact,
  isSingleton,
  mustBeFalse,
  mustBeTrue,
  SingletonTypeTagsConst,
  TruthyTypes,
  TypeTag,
  UnionTypeTags,
  ValueTypes,
} from "./types";
import { unionInto } from "./union-type";

/*
 * Compute the possible type tags of the result of an arithmetic
 * operation on left and right.
 *
 * allowed gives the set of allowed input types.
 *
 *   + => Number | Long | Float | Double | String | Char | Null
 *   - => Number | Long | Float | Double
 */
function common_types(
  left: ExactOrUnion,
  right: ExactOrUnion,
  allowed: TypeTag
) {
  const types = left.type | right.type;
  let mask =
    TypeTag.True |
    TypeTag.False |
    TypeTag.Number |
    TypeTag.Long |
    TypeTag.Float |
    TypeTag.Double;
  if (types & allowed & TypeTag.String) {
    mask |=
      TypeTag.String |
      TypeTag.Char |
      TypeTag.Null |
      TypeTag.Dictionary |
      TypeTag.Array;
  } else if (types & allowed & TypeTag.Char) {
    mask |= TypeTag.Char;
  }
  mask &= allowed;
  const lt = left.type & mask;
  const rt = right.type & mask;
  let result = lt & TypeTag.String;
  if (lt & TypeTag.Null) result |= rt & TypeTag.String;
  if (lt & TypeTag.Boolean) {
    result |=
      (rt & TypeTag.Boolean) | TypeTag.Number | TypeTag.Long && TypeTag.Boolean;
  }
  if (lt & TypeTag.Number) {
    result |=
      rt & TypeTag.Boolean ? TypeTag.Boolean : rt & ~SingletonTypeTagsConst;
  }
  if (lt & TypeTag.Long) {
    if (rt & TypeTag.Boolean) {
      result |= TypeTag.Boolean;
    } else {
      if (rt & (TypeTag.Number | TypeTag.Long)) result |= TypeTag.Long;
      if (rt & (TypeTag.Float | TypeTag.Double)) result |= TypeTag.Double;
      result |= rt & (TypeTag.String | TypeTag.Char);
    }
  }
  if (lt & TypeTag.Float) {
    if (rt & (TypeTag.Number | TypeTag.Float)) result |= TypeTag.Float;
    if (rt & (TypeTag.Long | TypeTag.Double)) result |= TypeTag.Double;
    result |= rt & TypeTag.String;
  }
  if (lt & TypeTag.Double) {
    if (rt & (TypeTag.Number | TypeTag.Long | TypeTag.Float | TypeTag.Double)) {
      result |= TypeTag.Double;
    }
    result |= rt & TypeTag.String;
  }
  if (lt & TypeTag.Char) {
    if (rt & (TypeTag.Number | TypeTag.Long)) {
      result |= TypeTag.Char;
    }
    if (rt & (TypeTag.Char | TypeTag.String)) {
      result |= TypeTag.String;
    }
  }
  return {
    tag: result,
    castArgs: !(result & TypeTag.Char) ? result : false,
  } as const;
}

function compare_types(left: ExactOrUnion, right: ExactOrUnion) {
  const ret = common_types(
    left,
    right,
    TypeTag.Number | TypeTag.Long | TypeTag.Float | TypeTag.Double
  );
  return { tag: TypeTag.Boolean, castArgs: ret.castArgs };
}

type OpInfo = {
  allowed: UnionTypeTags;
  typeFn: (
    left: ExactOrUnion,
    right: ExactOrUnion,
    allowed: UnionTypeTags
  ) => { tag: UnionTypeTags; castArgs: UnionTypeTags | false };
  valueFn: (left: ValueTypes, right: ValueTypes) => ExactTypes | undefined;
};

function equalsCheck(left: ValueTypes, right: ValueTypes): boolean | undefined {
  // compare numbers for equality without regard for type;
  // otherwise if its Number vs Char, compare the char-code with the number;
  // otherwise if its Number vs Boolean, 1/0 compare equal to true/false
  // otherwise if the types are different, the result is
  //   - unknown if its Object vs any normal type (because eg Number is also Object)
  //   - currently unknown if its Object vs Null (because we can't trust api.mir to
  //     always include Null in the possible return types)
  // otherwise if its a singleton type (Null, True, False)
  //   the result is true;
  // otherwise if its a Char or Symbol, compare for equality
  // otherwise its unknown (we don't track object identity).

  // Note that each type can only have a single bit set. This is important!

  const lrBits = left.type | right.type;
  return left.type & TypeTag.Numeric && right.type & TypeTag.Numeric
    ? // eslint-disable-next-line eqeqeq
      left.value == right.value
    : // Char vs Numeric is true iff the number is the char-code of the char
    left.type === TypeTag.Char && right.type & TypeTag.Numeric
    ? left.value.charCodeAt(0) === Number(right.value)
    : right.type === TypeTag.Char && left.type & TypeTag.Numeric
    ? Number(left.value) === right.value.charCodeAt(0)
    : left.type === TypeTag.Char && right.type & TypeTag.Boolean
    ? left.value.charCodeAt(0) === (right.value ? 1 : 0)
    : right.type === TypeTag.Char && left.type & TypeTag.Boolean
    ? right.value.charCodeAt(0) === (left.value ? 1 : 0)
    : left.type === TypeTag.Number && right.type & TypeTag.Boolean
    ? left.value === (right.value ? 1 : 0)
    : right.type === TypeTag.Number && left.type & TypeTag.Boolean
    ? right.value === (left.value ? 1 : 0)
    : left.type !== right.type
    ? lrBits & TypeTag.Null
      ? lrBits & (TypeTag.Object | TypeTag.Array | TypeTag.Dictionary)
        ? undefined
        : false
      : lrBits & (TypeTag.Module | TypeTag.Function | TypeTag.Class)
      ? false
      : undefined
    : left.type === TypeTag.Char || left.type === TypeTag.Symbol
    ? left.value === right.value
    : isSingleton(left)
    ? true
    : undefined;
}

let operators: Record<mctree.BinaryOperator, OpInfo | null> | null = null;

export function evaluateBinaryTypes(
  op: mctree.BinaryOperator | "instanceof",
  left: ExactOrUnion,
  right: ExactOrUnion
): ExactOrUnion {
  if (!operators) {
    operators = {
      "+": {
        allowed:
          TypeTag.Number |
          TypeTag.Long |
          TypeTag.Float |
          TypeTag.Double |
          TypeTag.String |
          TypeTag.Char |
          TypeTag.Array |
          TypeTag.Dictionary |
          TypeTag.Null,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type === TypeTag.Char &&
          right.type & (TypeTag.Number | TypeTag.Long)
            ? {
                type: TypeTag.Char,
                value: String.fromCharCode(
                  left.value.charCodeAt(0) + Number(right.value)
                ),
              }
            : left.type & (TypeTag.Number | TypeTag.Long) &&
              right.type === TypeTag.Char
            ? {
                type: TypeTag.Char,
                value: String.fromCharCode(
                  right.value.charCodeAt(0) + Number(left.value)
                ),
              }
            : ({
                type: left.type,
                value: (left.value as number) + (right.value as number),
              } as ValueTypes),
      },
      "-": {
        allowed: TypeTag.Number | TypeTag.Long | TypeTag.Float | TypeTag.Double,

        typeFn: common_types,
        valueFn: (left, right) =>
          ({
            type: left.type,
            value: (left.value as number) - (right.value as number),
          } as ValueTypes),
      },
      "*": {
        allowed: TypeTag.Number | TypeTag.Long | TypeTag.Float | TypeTag.Double,
        typeFn: common_types,
        valueFn: (left, right) =>
          ({
            type: left.type,
            value: (left.value as number) * (right.value as number),
          } as ValueTypes),
      },
      "/": {
        allowed: TypeTag.Number | TypeTag.Long | TypeTag.Float | TypeTag.Double,
        typeFn: common_types,
        valueFn: (left, right) =>
          Number(right.value) === 0
            ? { type: left.type }
            : left.type === TypeTag.Number
            ? ({
                type: left.type,
                value: Number(
                  BigInt(left.value) / BigInt(right.value as number)
                ),
              } as ValueTypes)
            : ({
                type: left.type,
                value: (left.value as number) / (right.value as number),
              } as ValueTypes),
      },
      "%": {
        allowed: TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          Number(right.value) === 0
            ? { type: left.type }
            : ({
                type: left.type,
                value: (left.value as number) % (right.value as number),
              } as ValueTypes),
      },
      "&": {
        allowed: TypeTag.Boolean | TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type & TypeTag.Boolean
            ? {
                type:
                  left.type === TypeTag.True && right.type === TypeTag.True
                    ? TypeTag.True
                    : TypeTag.False,
              }
            : ({
                type: left.type,
                value: (left.value as number) & (right.value as number),
              } as ValueTypes),
      },
      "|": {
        allowed: TypeTag.Boolean | TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type & TypeTag.Boolean
            ? {
                type:
                  left.type === TypeTag.True || right.type === TypeTag.True
                    ? TypeTag.True
                    : TypeTag.False,
              }
            : ({
                type: left.type,
                value: (left.value as number) | (right.value as number),
              } as ValueTypes),
      },
      "^": {
        allowed: TypeTag.Boolean | TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type & TypeTag.Boolean
            ? {
                type:
                  (left.type === TypeTag.True) !== (right.type === TypeTag.True)
                    ? TypeTag.True
                    : TypeTag.False,
              }
            : ({
                type: left.type,
                value: (left.value as number) ^ (right.value as number),
              } as ValueTypes),
      },
      "<<": {
        allowed: TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type === TypeTag.Long
            ? {
                type: TypeTag.Long,
                value: left.value << (right.value as bigint & 127n),
              }
            : {
                type: TypeTag.Number,
                value: (left.value as number) << ((right.value as number) & 63),
              },
      },
      ">>": {
        allowed: TypeTag.Number | TypeTag.Long,
        typeFn: common_types,
        valueFn: (left, right) =>
          left.type === TypeTag.Long
            ? {
                type: TypeTag.Long,
                value: left.value >> (right.value as bigint & 127n),
              }
            : {
                type: TypeTag.Number,
                value: (left.value as number) >> ((right.value as number) & 63),
              },
      },
      "==": {
        allowed: TypeTag.Any,
        typeFn: () => ({
          tag: TypeTag.Boolean,
          castArgs: false,
        }),
        valueFn: (left, right) => {
          const result = equalsCheck(left, right);
          return result === undefined
            ? result
            : { type: result ? TypeTag.True : TypeTag.False };
        },
      },
      "!=": {
        allowed: TypeTag.Any,
        typeFn: () => ({
          tag: TypeTag.Boolean,
          castArgs: false,
        }),
        valueFn: (left, right) => {
          const result = equalsCheck(left, right);
          return result === undefined
            ? result
            : { type: result ? TypeTag.False : TypeTag.True };
        },
      },
      "<=": {
        allowed: TypeTag.Any,
        typeFn: compare_types,
        valueFn: (left, right) => ({
          type:
            (left.value as number) <= (right.value as number)
              ? TypeTag.True
              : TypeTag.False,
        }),
      },
      ">=": {
        allowed: TypeTag.Any,
        typeFn: compare_types,
        valueFn: (left, right) => ({
          type:
            (left.value as number) >= (right.value as number)
              ? TypeTag.True
              : TypeTag.False,
        }),
      },
      "<": {
        allowed: TypeTag.Any,
        typeFn: compare_types,
        valueFn: (left, right) => ({
          type:
            (left.value as number) < (right.value as number)
              ? TypeTag.True
              : TypeTag.False,
        }),
      },
      ">": {
        allowed: TypeTag.Any,
        typeFn: compare_types,
        valueFn: (left, right) => ({
          type:
            (left.value as number) > (right.value as number)
              ? TypeTag.True
              : TypeTag.False,
        }),
      },
      has: {
        allowed: TypeTag.Any,
        typeFn: () => ({
          tag: TypeTag.Boolean,
          castArgs: false,
        }),
        valueFn: (_left, _right) => undefined,
      },
    };
  }

  if (op === "instanceof") {
    if (right.type & TypeTag.Class) {
      if (!isExact(right)) {
        return { type: TypeTag.Boolean };
      }
      right = { type: TypeTag.Object, value: { klass: right as ClassType } };
    }
    return {
      type: subtypeOf(left, right)
        ? TypeTag.True
        : !couldBeWeak(left, right)
        ? TypeTag.False
        : TypeTag.Boolean,
    };
  }

  const info = operators[op];
  if (!info) return { type: TypeTag.Any };
  const { tag, castArgs } = info.typeFn(left, right, info.allowed);
  const result_type = { type: tag };
  if (isExact(result_type) && castArgs !== false) {
    left = castType(left, castArgs);
    right = castType(right, castArgs);
  }
  if (hasValue(left) && hasValue(right)) {
    const value = info.valueFn(left, right);
    if (value) {
      if (value.type === TypeTag.Float && value.value != null) {
        value.value = roundToFloat(value.value);
      }
      return value;
    }
  }
  return result_type;
}

export function evaluateLogicalTypes(
  op: mctree.LogicalOperator,
  left: ExactOrUnion,
  right: ExactOrUnion
): ExactOrUnion {
  switch (op) {
    case "&&":
    case "and":
      if (mustBeFalse(left)) {
        return left;
      } else {
        const result = evaluateBinaryTypes("&", left, right);
        if ((left.type & TypeTag.Null) !== 0) {
          unionInto(result, { type: TypeTag.Null });
        }
        return result;
      }
    case "||":
    case "or":
      if (mustBeTrue(left)) {
        return left;
      } else {
        const result = evaluateBinaryTypes("|", left, right);
        if ((left.type & TruthyTypes) !== 0) {
          unionInto(result, { type: left.type & TruthyTypes });
        }
        return result;
      }
  }
}
