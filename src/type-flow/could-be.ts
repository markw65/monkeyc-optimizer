import { unhandledType } from "../data-flow";
import { some } from "../util";
import {
  ArrayValueType,
  ClassType,
  DictionaryValueType,
  EnumTagsConst,
  EnumValueType,
  ExactOrUnion,
  ExactTypes,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  MethodValueType,
  ObjectLikeTagsConst,
  ObjectValueType,
  SingleValue,
  StateDeclValueType,
  TypedefValueType,
  TypeTag,
  typeTagName,
  UnionDataTypeTagsConst,
  ValueTypeTagsConst,
} from "./types";
import { getSuperClasses, hasProperty } from "../api";

/*
 * Determine whether a value conforming to a's type could also
 * be a value conforming to b's type.
 *
 * This is symmetric, and a subtypeOf b, or b subtypeOf a implies
 * a couldBe b.
 */
export function couldBe(a: ExactOrUnion, b: ExactOrUnion): boolean {
  const common = a.type & b.type & ~TypeTag.Typedef;
  if (common) {
    if (a.value == null || b.value == null || a.value === b.value) {
      return true;
    }
    if (common & ValueTypeTagsConst && common & UnionDataTypeTagsConst) {
      // if we have both ValueTypeTags and UnionDataTypeTags, then the
      // ValueTypeTags have no associated data, so couldBe is true.
      return true;
    }
    let result = false;
    forEachUnionComponent(a, common, (bit, avalue) => {
      if (avalue == null) {
        result = true;
        return false;
      }
      const bvalue = getUnionComponent(b, bit);
      if (
        bvalue == null ||
        avalue === bvalue ||
        couldBeValue(bit, avalue, bvalue)
      ) {
        result = true;
        return false;
      }
      return true;
    });
    if (result) return true;
  }
  if (
    (a.type & TypeTag.Enum && b.type & EnumTagsConst) ||
    (b.type & TypeTag.Enum && a.type & EnumTagsConst)
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

  const checkTypdef = (t: ExactOrUnion, other: ExactOrUnion) => {
    const typedef = getUnionComponent(t, TypeTag.Typedef) as
      | TypedefValueType
      | undefined;
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
  if (a.type & TypeTag.Typedef && checkTypdef(a, b)) {
    return true;
  }
  if (b.type & TypeTag.Typedef && checkTypdef(b, a)) {
    return true;
  }
  return false;
}

function couldBeValue(
  bit: ExactTypes["type"],
  avalue: SingleValue,
  bvalue: SingleValue
) {
  switch (bit) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
    case TypeTag.Typedef:
      throw new Error(`Unexpected TypeTag '${typeTagName(bit)}'`);
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.String:
    case TypeTag.Char:
    case TypeTag.Symbol:
      return avalue === bvalue;
    case TypeTag.Array:
      return couldBe(avalue as ArrayValueType, bvalue as ArrayValueType);
    case TypeTag.Dictionary: {
      const adict = avalue as DictionaryValueType;
      const bdict = bvalue as DictionaryValueType;
      return couldBe(adict.key, bdict.key) && couldBe(adict.value, bdict.value);
    }
    case TypeTag.Method: {
      const ameth = avalue as MethodValueType;
      const bmeth = bvalue as MethodValueType;
      return (
        ameth.args.length === bmeth.args.length &&
        couldBe(ameth.result, bmeth.result) &&
        ameth.args.every((arg, i) => couldBe(arg, bmeth.args[i]))
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
      return some(asd, (sna) => {
        const superA = getSuperClasses(sna);
        return some(bsd, (snb) => {
          if (sna === snb || (superA && superA.has(snb))) {
            return true;
          }
          const superB = getSuperClasses(snb);
          return superB && superB.has(sna);
        });
      });
    }

    case TypeTag.Object: {
      const aobj = avalue as ObjectValueType;
      const bobj = bvalue as ObjectValueType;
      return couldBe(aobj.klass, bobj.klass) && couldBeObj(aobj.obj, bobj.obj);
    }

    case TypeTag.Enum: {
      const aenum = avalue as EnumValueType;
      const benum = bvalue as EnumValueType;
      return (
        aenum.enum === benum.enum &&
        (!aenum.value || !benum.value || couldBe(aenum.value, benum.value))
      );
    }
    default:
      unhandledType(bit);
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
