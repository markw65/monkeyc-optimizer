import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { couldBeWeak } from "./could-be";
import { deEnumerate, roundToFloat } from "./interp";
import { subtypeOf } from "./sub-type";
import {
  castType,
  ClassType,
  cloneType,
  ExactOrUnion,
  ExactTypes,
  hasNoData,
  hasValue,
  isExact,
  isSingleton,
  mustBeFalse,
  mustBeTrue,
  ObjectLikeTagsConst,
  TruthyTypes,
  TypeTag,
  UnionTypeTags,
  ValueTypes,
} from "./types";
import { unionInto } from "./union-type";

export type OpMatch = {
  // maps sets of right types to the corresponding sets of non-matching
  // left types.
  // So eg (Null | Float | Number) + (String | Boolean | Char) would have
  // Boolean | Char => Null | Float, Boolean => Number
  mismatch?: Map<TypeTag, TypeTag>;
};

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
): { tag: TypeTag; castArgs: TypeTag | false } & OpMatch {
  const types = left.type | right.type;
  let mask = (TypeTag.Boolean | TypeTag.Numeric) & allowed;
  if (types & allowed & TypeTag.String) {
    mask |=
      TypeTag.String |
      TypeTag.Boolean |
      TypeTag.Char |
      TypeTag.Null |
      TypeTag.Dictionary |
      TypeTag.Array |
      TypeTag.Symbol |
      TypeTag.Object |
      TypeTag.Enum |
      TypeTag.Method;
  } else if (types & allowed & TypeTag.Char) {
    mask |= TypeTag.Char;
  }
  const lt = left.type & mask;
  const rt = right.type & mask;
  let mismatch: Map<TypeTag, TypeTag> | undefined;
  let result = 0;
  const addMismatch = (left: TypeTag, right: TypeTag) => {
    if (!mismatch) mismatch = new Map();
    const bits = mismatch.get(right) ?? 0;
    mismatch.set(right, bits | left);
  };

  if (lt & TypeTag.String) {
    result |= rt && TypeTag.String;
    if (right.type & ~mask) {
      addMismatch(TypeTag.String, right.type & ~mask);
    }
  }

  if (lt & (TypeTag.Null | TypeTag.Array | TypeTag.Dictionary)) {
    result |= rt & TypeTag.String;
    if (right.type & ~TypeTag.String) {
      addMismatch(
        lt & (TypeTag.Null | TypeTag.Array | TypeTag.Dictionary),
        right.type & ~TypeTag.String
      );
    }
  }

  if (lt & TypeTag.Boolean) {
    result |=
      rt & (TypeTag.Boolean | TypeTag.Number | TypeTag.Long) && TypeTag.Boolean;
    result |= rt & TypeTag.String;
    const includes =
      (TypeTag.Boolean | TypeTag.Number | TypeTag.Long | TypeTag.String) & mask;
    if (right.type & ~includes) {
      addMismatch(lt & TypeTag.Boolean, right.type & ~includes);
    }
  }

  if (lt & TypeTag.Number) {
    const includes =
      (TypeTag.Boolean | TypeTag.Numeric | TypeTag.String | TypeTag.Char) &
      allowed;
    if (rt & allowed & TypeTag.Boolean) {
      result |= TypeTag.Boolean;
    }
    result |= rt & includes;
    if (right.type & ~includes) {
      addMismatch(TypeTag.Number, right.type & ~includes);
    }
  }

  if (lt & TypeTag.Long) {
    const includes =
      (TypeTag.Boolean | TypeTag.Numeric | TypeTag.String) & allowed;
    if (rt & allowed & TypeTag.Boolean) {
      result |= TypeTag.Boolean;
    }
    result |= rt & includes & ~(TypeTag.Number | TypeTag.Float);
    if (rt & TypeTag.Number) result |= TypeTag.Long;
    if (rt & TypeTag.Float) result |= TypeTag.Double;
    if (right.type & ~includes) {
      addMismatch(TypeTag.Long, right.type & ~includes);
    }
  }

  if (lt & TypeTag.Float) {
    const includes = (TypeTag.Numeric | TypeTag.String) & allowed;
    result |= rt & includes & ~(TypeTag.Number | TypeTag.Long);
    if (rt & TypeTag.Number) result |= TypeTag.Float;
    if (rt & TypeTag.Long) result |= TypeTag.Double;
    if (right.type & ~includes) {
      addMismatch(TypeTag.Float, right.type & ~includes);
    }
  }

  if (lt & TypeTag.Double) {
    const includes = (TypeTag.Numeric | TypeTag.String) & allowed;
    if (rt & TypeTag.Numeric) {
      result |= TypeTag.Double;
    }
    result |= rt & TypeTag.String;
    if (right.type & ~includes) {
      addMismatch(TypeTag.Double, right.type & ~includes);
    }
  }

  if (lt & TypeTag.Char) {
    if (rt & TypeTag.Number) {
      result |= TypeTag.Char;
    }
    if (rt & (TypeTag.Char | TypeTag.String)) {
      result |= TypeTag.String;
    }
    const includes =
      (TypeTag.Number | TypeTag.Long | TypeTag.Char | TypeTag.String) & allowed;
    if (right.type & ~includes) {
      addMismatch(TypeTag.Char, right.type & ~includes);
    }
  }

  if (left.type & ~mask) {
    addMismatch(left.type & ~mask, right.type);
  }

  return {
    tag: result,
    castArgs: !(result & TypeTag.Char) ? result : false,
    mismatch,
  } as const;
}

function compare_types(left: ExactOrUnion, right: ExactOrUnion) {
  const { tag, ...rest } = common_types(
    left,
    right,
    TypeTag.Number |
      TypeTag.Long |
      TypeTag.Float |
      TypeTag.Double |
      TypeTag.Char
  );
  return {
    tag: tag === TypeTag.Never ? tag : TypeTag.Boolean,
    ...rest,
  };
}

type OpInfo = {
  allowed: UnionTypeTags;
  typeFn: (
    left: ExactOrUnion,
    right: ExactOrUnion,
    allowed: UnionTypeTags
  ) => { tag: UnionTypeTags; castArgs: UnionTypeTags | false } & OpMatch;
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
): {
  type: ExactOrUnion;
} & OpMatch {
  left = deEnumerate(left);
  right = deEnumerate(right);
  if (left.type & TypeTag.Object && hasNoData(left, TypeTag.Object)) {
    left = cloneType(left);
    left.type |= ObjectLikeTagsConst;
  }
  if (right.type & TypeTag.Object && hasNoData(right, TypeTag.Object)) {
    right = cloneType(right);
    right.type |= ObjectLikeTagsConst;
  }
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
        return { type: { type: TypeTag.Boolean } };
      }
      right = { type: TypeTag.Object, value: { klass: right as ClassType } };
    }
    return {
      type: {
        type: subtypeOf(left, right)
          ? TypeTag.True
          : !couldBeWeak(left, right)
          ? TypeTag.False
          : TypeTag.Boolean,
      },
    };
  }

  const info = operators[op];
  if (!info) return { type: { type: TypeTag.Any } };
  const { tag, castArgs, ...rest } = info.typeFn(left, right, info.allowed);
  const result_type = { type: tag };
  if (isExact(result_type) && castArgs !== false) {
    left = castType(left, castArgs);
    right = castType(right, castArgs);
  }
  if (hasValue(left) && hasValue(right) && !rest.mismatch?.size) {
    const value = info.valueFn(left, right);
    if (value) {
      if (value.type === TypeTag.Float && value.value != null) {
        value.value = roundToFloat(value.value);
      }
      return { type: value };
    }
  }
  return { type: result_type, ...rest };
}

export function evaluateLogicalTypes(
  op: mctree.LogicalOperator,
  left: ExactOrUnion,
  right: ExactOrUnion
): { type: ExactOrUnion } & OpMatch {
  switch (op) {
    case "&&":
    case "and":
      if (mustBeFalse(left)) {
        return { type: left };
      } else {
        const result = evaluateBinaryTypes("&", left, right);
        const falsy = left.type & (TypeTag.Null | TypeTag.False);
        if (falsy !== 0) {
          unionInto(result.type, { type: falsy });
        }
        return result;
      }
    case "||":
    case "or":
      if (mustBeTrue(left)) {
        return { type: left };
      } else {
        const result = evaluateBinaryTypes("|", left, right);
        if ((left.type & TruthyTypes) !== 0) {
          unionInto(result.type, { type: left.type & TruthyTypes });
        }
        return result;
      }
  }
}
