import { unhandledType } from "../data-flow";
import { tupleMap, tupleReduce } from "./array-type";
import {
  ExactOrUnion,
  SingleValue,
  TypeTag,
  UnionDataTypeTagsConst,
  ValueTypeTagsConst,
  ValueTypes,
  cloneType,
  forEachUnionComponent,
  hasNoData,
  hasUnionData,
  typeTagName,
} from "./types";

export function inferenceType(
  a: ExactOrUnion,
  expandNull = false
): ExactOrUnion {
  if (expandNull && a.type === TypeTag.Null) {
    return { type: TypeTag.Null | TypeTag.Object };
  }
  const boolbits = a.type & TypeTag.Boolean;
  if (boolbits && boolbits !== TypeTag.Boolean) {
    a = cloneType(a);
    a.type |= TypeTag.Boolean;
  }
  if (a.value == null) return a;
  if (!hasNoData(a, ValueTypeTagsConst)) {
    return { type: a.type };
  }

  let mask = 0;
  const result: Record<number, SingleValue> = {};
  forEachUnionComponent(a, UnionDataTypeTagsConst, (ac) => {
    if (ac.value == null) return;
    const ivalue = inferenceTypeValue(ac as ValueTypes, expandNull);
    if (ivalue == null) return;
    result[ac.type] = ivalue;
    mask |= ac.type;
  });
  if (!mask) return { type: a.type };
  if (hasUnionData(mask)) {
    return { type: a.type, value: { ...result, mask } };
  }
  return { type: a.type, value: result[mask] } as ExactOrUnion;
}

function inferenceTypeValue(
  t: ValueTypes,
  expandNull: boolean
): SingleValue | null {
  switch (t.type) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.String:
    case TypeTag.Char:
    case TypeTag.Symbol:
      throw new Error(`Unexpected TypeTag '${typeTagName(t.type)}'`);
    case TypeTag.Array:
      return tupleMap(
        t.value,
        (bv) => bv.map((t) => inferenceType(t, expandNull)),
        (bv) => inferenceType(bv, expandNull),
        tupleReduce
      );

    case TypeTag.Dictionary: {
      if (t.value.value != null) {
        return {
          key: inferenceType(t.value.key, expandNull),
          value: inferenceType(t.value.value, expandNull),
        };
      } else {
        return new Map(
          Array.from(t.value).map(([key, value]) => [
            key,
            inferenceType(value, expandNull),
          ])
        );
      }
    }
    case TypeTag.Method:
    case TypeTag.Class:
    case TypeTag.Object:
    case TypeTag.Enum:
    case TypeTag.Typedef:
    case TypeTag.Module:
    case TypeTag.Function:
      return t.value;

    default:
      unhandledType(t);
  }
}
