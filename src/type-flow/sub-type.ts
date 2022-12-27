import { getSuperClasses, hasProperty } from "../api";
import { unhandledType } from "../data-flow";
import { every, some } from "../util";
import { expandTypedef } from "./intersection-type";
import {
  ArrayValueType,
  ClassType,
  cloneType,
  DictionaryValueType,
  EnumTagsConst,
  EnumValueType,
  ExactOrUnion,
  ExactTypes,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  ObjectLikeTagsConst,
  ObjectValueType,
  SingleValue,
  StateDeclValueType,
  TypeTag,
} from "./types";
import { clearValuesUnder } from "./union-type";

/*
 * Determine whether a is a subtype of b.
 */
export function subtypeOf(a: ExactOrUnion, b: ExactOrUnion): boolean {
  if (a.type & TypeTag.Typedef && a.value != null) {
    return subtypeOf(expandTypedef(a), b);
  }
  if (b.type & TypeTag.Typedef && b.value != null) {
    return subtypeOf(a, expandTypedef(b));
  }
  if (
    a.type & TypeTag.Enum &&
    !(b.type & TypeTag.Enum) &&
    b.type & EnumTagsConst
  ) {
    const value = getUnionComponent(a, TypeTag.Enum) as EnumValueType | null;
    if (
      !subtypeOf(
        (value != null && (value.value || value.enum?.resolvedType)) || {
          type: EnumTagsConst,
        },
        b
      )
    ) {
      return false;
    }
    if (a.type === TypeTag.Enum) return true;
    const a2 = cloneType(a);
    clearValuesUnder(a2, TypeTag.Enum, true);
    return subtypeOf(a2, b);
  }

  let common = a.type & b.type;
  if (common !== a.type) {
    if (b.type & TypeTag.Object && getObjectValue(b) == null) {
      common |= a.type & ObjectLikeTagsConst;
    }

    if (common !== a.type) return false;
  }
  if (b.value == null) return true;
  let result = true;
  forEachUnionComponent(b, common, (bit, bvalue) => {
    const avalue = getUnionComponent(a, bit);
    if (bvalue == null || avalue === bvalue) return true;
    if (avalue == null || !subtypeOfValue(bit, avalue, bvalue)) {
      result = false;
      return false;
    }
    return true;
  });
  return result;
}

function subtypeOfValue(
  bit: ExactTypes["type"],
  avalue: SingleValue,
  bvalue: SingleValue
) {
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
      return avalue === bvalue;
    case TypeTag.Array:
      return subtypeOf(avalue as ArrayValueType, bvalue as ArrayValueType);
    case TypeTag.Dictionary: {
      const adict = avalue as DictionaryValueType;
      const bdict = bvalue as DictionaryValueType;
      return (
        subtypeOf(adict.key, bdict.key) && subtypeOf(adict.value, bdict.value)
      );
    }
    case TypeTag.Module:
    case TypeTag.Function: {
      const asd = avalue as StateDeclValueType;
      const bsd = bvalue as StateDeclValueType;
      // quadratic :-(
      return some(asd, (sna) => some(bsd, (snb) => sna === snb));
    }
    case TypeTag.Class: {
      const asd = avalue as NonNullable<ClassType["value"]>;
      const bsd = bvalue as NonNullable<ClassType["value"]>;
      return every(asd, (sna) => {
        const superA = getSuperClasses(sna);
        return some(bsd, (snb) => {
          if (sna === snb || (superA && superA.has(snb))) {
            return true;
          }
          return false;
        });
      });
    }

    case TypeTag.Object: {
      const aobj = avalue as ObjectValueType;
      const bobj = bvalue as ObjectValueType;
      return (
        subtypeOf(aobj.klass, bobj.klass) && subtypeOfObj(aobj.obj, bobj.obj)
      );
    }

    case TypeTag.Enum: {
      const aenum = avalue as EnumValueType;
      const benum = bvalue as EnumValueType;
      return (
        aenum.enum === benum.enum &&
        (!aenum.value || !benum.value || subtypeOf(aenum.value, benum.value))
      );
    }
    default:
      unhandledType(bit);
  }
}

function subtypeOfObj(
  a: Record<string, ExactOrUnion> | undefined,
  b: Record<string, ExactOrUnion> | undefined
) {
  if (!a || !b) return true;
  return Object.entries(b).every(([key, value]) => {
    if (!hasProperty(a, key)) return false;
    return subtypeOf(a[key], value);
  });
}
