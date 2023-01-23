import { getSuperClasses, hasProperty } from "../api";
import { unhandledType } from "../data-flow";
import { every, some } from "../util";
import { expandTypedef } from "./intersection-type";
import {
  cloneType,
  EnumTagsConst,
  ExactOrUnion,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  ObjectLikeTagsConst,
  TypeTag,
  typeTagName,
  ValuePairs,
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
    const value = getUnionComponent(a, TypeTag.Enum);
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
  forEachUnionComponent(b, common, (bc) => {
    const avalue = getUnionComponent(a, bc.type);
    if (bc.value == null || avalue === bc.value) return true;
    if (
      avalue == null ||
      !subtypeOfValue({ type: bc.type, avalue, bvalue: bc.value } as ValuePairs)
    ) {
      result = false;
      return false;
    }
    return true;
  });
  return result;
}

function subtypeOfValue(pair: ValuePairs) {
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
    case TypeTag.Array:
      return subtypeOf(pair.avalue, pair.bvalue);
    case TypeTag.Dictionary: {
      const adict = pair.avalue;
      const bdict = pair.bvalue;
      return (
        subtypeOf(adict.key, bdict.key) && subtypeOf(adict.value, bdict.value)
      );
    }
    case TypeTag.Method: {
      return (
        pair.avalue.args.length === pair.bvalue.args.length &&
        subtypeOf(pair.avalue.result, pair.bvalue.result) &&
        pair.avalue.args.every((arg, i) => subtypeOf(pair.bvalue.args[i], arg))
      );
    }
    case TypeTag.Module:
    case TypeTag.Function: {
      const asd = pair.avalue;
      const bsd = pair.bvalue;
      // quadratic :-(
      return some(asd, (sna) => some(bsd, (snb) => sna === snb));
    }
    case TypeTag.Class: {
      const asd = pair.avalue;
      const bsd = pair.bvalue;
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
      const aobj = pair.avalue;
      const bobj = pair.bvalue;
      return (
        subtypeOf(aobj.klass, bobj.klass) && subtypeOfObj(aobj.obj, bobj.obj)
      );
    }

    case TypeTag.Enum: {
      const aenum = pair.avalue;
      const benum = pair.bvalue;
      return (
        aenum.enum === benum.enum &&
        (!aenum.value || !benum.value || subtypeOf(aenum.value, benum.value))
      );
    }
    default:
      unhandledType(pair);
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
