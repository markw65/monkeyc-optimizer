import { hasProperty } from "../ast";
import { unhandledType } from "../data-flow";
import {
  ClassStateNode,
  EnumStateNode,
  FunctionStateNode,
  ModuleStateNode,
  TypedefStateNode,
} from "../optimizer-types";
import { forEach, some } from "../util";
import { tupleForEach, tupleReduce } from "./array-type";
import { couldBe } from "./could-be";
import { intersection } from "./intersection-type";
import { subtypeOf } from "./sub-type";
import {
  ClassType,
  ExactOrUnion,
  SingleValue,
  SingletonTypeTagsConst,
  TypeTag,
  UnionData,
  UnionDataKey,
  UnionDataTypeTagsConst,
  UnionType,
  ValuePairs,
  ValueTypeTagsConst,
  cloneType,
  forEachUnionComponent,
  getUnionComponent,
  hasUnionData,
  typeFromObjectLiteralKey,
} from "./types";

const MaxWidenDepth = 4;
export function union(to: ExactOrUnion, from: ExactOrUnion) {
  const result = cloneType(to);
  unionHelper(result, from, -Infinity);
  return result;
}

export function unionInto(to: ExactOrUnion, from: ExactOrUnion) {
  return unionHelper(to, from, -Infinity);
}

export function unionHelper(
  to: ExactOrUnion,
  from: ExactOrUnion,
  widenDepth: number
) {
  if (to == null || from == null) {
    throw new Error("Null");
  }
  if (from.type === 0 || to === from) return false;
  if (to.type === 0) {
    to.type = from.type;
    (to as ExactOrUnion).value = from.value;
    return true;
  }

  const newTags = to.type | from.type;

  if (!(from.type & ~SingletonTypeTagsConst)) {
    // - Adding singletons never affects the data.
    if (newTags === to.type) return false;
    to.type = newTags;
    return true;
  }

  if (newTags === to.type) {
    if (to.value === from.value || to.value == null) {
      return false;
    }
    if (from.value == null) {
      clearValuesUnder(to, from.type);
      return true;
    }

    return mergeMultiple(to, from, widenDepth);
  }

  if (to.value != null) {
    if (from.value == null) {
      clearValuesUnder(to, from.type);
      return true;
    }

    // always returns true because type changed.
    mergeMultiple(to, from, widenDepth);
    return true;
  }

  if (from.value == null) {
    to.type = newTags;
    return true;
  }

  const tmp = cloneType(from);
  clearValuesUnder(tmp, to.type);
  to.type = tmp.type;
  to.value = tmp.value;
  return true;
}

function mergeMultiple(
  to: ExactOrUnion,
  from: ExactOrUnion,
  widenDepth: number
) {
  const newTags = to.type | from.type;
  let anyChanged = newTags !== to.type;
  let mask = 0;
  const result: Record<number, SingleValue> = {};
  forEachUnionComponent(to, newTags, (ac) => {
    const fromv = getUnionComponent(from, ac.type);
    if (ac.value != null) {
      if (fromv != null) {
        const [value, changed] =
          ac.value === fromv
            ? [fromv, false]
            : mergeSingle(
                {
                  type: ac.type,
                  avalue: ac.value,
                  bvalue: fromv,
                } as ValuePairs,
                widenDepth
              );
        if (changed) anyChanged = true;
        if (value) {
          mask |= ac.type;
          result[ac.type] = value;
        }
      } else if (!(from.type & ac.type)) {
        // from doesn't contribute to this tag,
        // so just keep it. No change.
        mask |= ac.type;
        result[ac.type] = ac.value;
      } else {
        // We dropped the data for this tag, so
        // things changed.
        anyChanged = true;
      }
    } else if (fromv && !(to.type & ac.type)) {
      // to doesn't contribute to this tag,
      // so just keep from's component.
      // this is new, so it changed.
      anyChanged = true;
      mask |= ac.type;
      result[ac.type] = fromv;
    }
  });

  if (!anyChanged) return false;
  to.type = newTags;
  if (!mask) {
    delete to.value;
    return true;
  }
  if (hasUnionData(newTags)) {
    to.value = result as UnionData;
    to.value.mask = mask;
    return true;
  }
  if (mask & (mask - 1)) {
    throw new Error("Union incorrectly produced a UnionData");
  }
  to.value = result[mask];
  return true;
}

function mergeSingle(
  pair: ValuePairs,
  widenDepth: number
): [SingleValue | null, boolean] {
  function tryUnion(to: ExactOrUnion, from: ExactOrUnion): ExactOrUnion | null {
    to = cloneType(to);
    if (unionHelper(to, from, widenDepth + 1)) return to;
    return null;
  }

  switch (pair.type) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
      throw new Error("Unexpected TypeTag in mergeSingle");
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.Char:
    case TypeTag.String:
    case TypeTag.Symbol:
      // we already checked that they're not equal
      return [null, true];
    case TypeTag.Array: {
      if (widenDepth > MaxWidenDepth) {
        return [null, true];
      }
      const tupleTypes = new Map<number, ExactOrUnion[][]>();
      const arrayTypes: ExactOrUnion[] = [];
      // collect all the array and tuple types
      tupleForEach(
        pair.avalue,
        (v) => {
          const t = tupleTypes.get(v.length);
          if (t) {
            t.push(v);
          } else {
            tupleTypes.set(v.length, [v]);
          }
        },
        (v) => arrayTypes.push(v)
      );

      const extraTypes: Array<ExactOrUnion | ExactOrUnion[]> = [];
      tupleForEach(
        pair.bvalue,
        (v) => {
          const tuples = tupleTypes.get(v.length);
          if (
            !tuples?.some((t) =>
              t.every((at, i) => {
                const bt = v[i];
                return subtypeOf(at, bt) && subtypeOf(bt, at);
              })
            )
          ) {
            extraTypes.push(v);
          }
        },
        (v) => {
          if (!arrayTypes.some((at) => subtypeOf(at, v) && subtypeOf(v, at))) {
            extraTypes.push(v);
          }
        }
      );
      if (extraTypes.length) {
        if (widenDepth >= 0) {
          return [null, true];
        }
        const allTypes = (
          pair.avalue instanceof Set ? Array.from(pair.avalue) : [pair.avalue]
        ).concat(extraTypes);
        return [tupleReduce(allTypes), true];
      }
      return [pair.avalue, false];
    }

    case TypeTag.Dictionary: {
      if (widenDepth > MaxWidenDepth) {
        return [null, true];
      }
      const avalue = pair.avalue;
      const bvalue = pair.bvalue;
      if (!avalue.value) {
        if (!bvalue.value) {
          const result = new Map(avalue);
          let merged = false;
          result.forEach((av, key) => {
            const bv = bvalue.get(key);
            if (!bv) {
              result.delete(key);
              merged = true;
              return;
            }
            av = cloneType(av);
            if (unionHelper(av, bv, widenDepth + 1)) merged = true;
            result.set(key, av);
          });
          return [result, merged];
        } else {
          const result = new Map(avalue);
          let merged = false;
          result.forEach((av, key) => {
            const keyType = typeFromObjectLiteralKey(key);
            if (couldBe(keyType, bvalue.key)) {
              const bv = tryUnion(av, bvalue.value);
              if (bv) {
                result.set(key, bv);
                merged = true;
              }
            }
          });
          return [result, merged];
        }
      } else if (!bvalue.value) {
        const result = new Map(bvalue);
        let merged = false;
        result.forEach((bv, key) => {
          const keyType = typeFromObjectLiteralKey(key);
          if (couldBe(keyType, avalue.key)) {
            const av = tryUnion(bv, avalue.value);
            if (av) {
              result.set(key, av);
              merged = true;
            }
          }
        });
        return [result, merged];
      }
      const { key, value } = avalue;
      const keyChange = tryUnion(key, bvalue.key);
      const valueChange = tryUnion(value, bvalue.value);
      if (keyChange || valueChange) {
        return [{ key: keyChange || key, value: valueChange || value }, true];
      }
      return [pair.avalue, false];
    }
    case TypeTag.Method: {
      if (pair.avalue.args.length !== pair.bvalue.args.length)
        return [null, true];
      const resultChange = tryUnion(pair.avalue.result, pair.bvalue.result);
      const args = pair.avalue.args.map((arg, i) =>
        intersection(arg, pair.bvalue.args[i])
      );
      if (args.some((arg) => arg.type === TypeTag.Never)) {
        return [null, true];
      }
      const argsChanged = args.some(
        (arg, i) => !subtypeOf(pair.avalue.args[i], arg)
      );
      if (resultChange || argsChanged) {
        return [{ result: resultChange || pair.avalue.result, args }, true];
      }
      return [pair.avalue, false];
    }
    case TypeTag.Module:
      return mergeStateDecls(pair.avalue, pair.bvalue);
    case TypeTag.Function:
      return mergeStateDecls(pair.avalue, pair.bvalue);
    case TypeTag.Class:
      return mergeStateDecls(pair.avalue, pair.bvalue);
    case TypeTag.Typedef:
      return mergeStateDecls(pair.avalue, pair.bvalue);
    case TypeTag.Object: {
      let klass = pair.avalue.klass;
      const [obj, objChanged] = mergeObjectValues(
        pair.avalue.obj,
        pair.bvalue.obj,
        widenDepth
      );
      const klassChanged = tryUnion(klass, pair.bvalue.klass);
      if (klassChanged || objChanged) {
        klass = (klassChanged || klass) as ClassType;
        if (obj) {
          return [{ klass, obj } as SingleValue, true];
        }
        return [{ klass } as SingleValue, true];
      }
      return [pair.avalue, false];
    }
    case TypeTag.Enum: {
      const toE = pair.avalue;
      const fromE = pair.bvalue;
      let changed = false;
      let resultEnum = toE.enum;
      const s = new Set<EnumStateNode>(
        Array.isArray(toE.enum) ? toE.enum : [toE.enum]
      );
      const size = s.size;
      forEach(fromE.enum, (e) => s.add(e));
      if (size !== s.size) {
        resultEnum = Array.from(s);
        changed = true;
      }
      let resultValue = toE.value;
      if (resultValue) {
        if (fromE.value) {
          resultValue = cloneType(resultValue);
          if (unionHelper(resultValue, fromE.value, widenDepth + 1)) {
            changed = true;
          }
        } else {
          resultValue = undefined;
          changed = true;
        }
      }
      if (!changed) {
        return [toE, false];
      }
      return resultValue
        ? [{ enum: resultEnum, value: resultValue }, changed]
        : [{ enum: resultEnum }, changed];
    }
    default:
      unhandledType(pair);
  }
}

function mergeObjectValues(
  to: Record<string, ExactOrUnion> | undefined,
  from: Record<string, ExactOrUnion> | undefined,
  widenDepth: number
) {
  if (!to) {
    return [to, false];
  }
  if (!from) {
    return [from, true];
  }
  let empty = true;
  let result = to;
  Object.entries(to).forEach(([key, value]) => {
    if (!hasProperty(from, key)) {
      if (result === to) result = { ...result };
      delete result[key];
      return;
    }
    const rep = cloneType(value);
    if (unionHelper(rep, from[key], widenDepth + 1)) {
      if (result === to) result = { ...result };
      result[key] = rep;
    }
    empty = false;
  });
  if (empty) {
    return [undefined, true];
  }
  return [result, result !== to];
}

function mergeStateDecls<
  T extends
    | ModuleStateNode
    | ClassStateNode
    | FunctionStateNode
    | TypedefStateNode
>(to: T | T[], from: T | T[]): [T | T[], boolean] {
  let changed = false;
  let result: T | T[] = to;
  forEach<T>(from, (v) => {
    if (some<T>(to, (t) => t === v)) {
      return;
    }
    if (Array.isArray(result)) {
      if (result === to) {
        result = [...result, v as T];
      } else {
        result.push(v);
      }
    } else {
      result = [to as T, v];
    }
    changed = true;
  });
  return [result, changed];
}

// precondition: hasUnionData
function nonUnionDataMask(tag: TypeTag) {
  if (tag & (tag - 1)) {
    // More than one bit set, but it doesn't have
    // UnionData, so it must either have a single bit
    // under UnionDataTypeTagsConst, or a single bit
    // under ValueTypeTagsConst.
    return tag & UnionDataTypeTagsConst || tag & ValueTypeTagsConst;
  }
  return tag;
}
/*
 * Remove any data associated with tag.
 * Add (or remove) tag to (or from) v.type, according
 * to clearTag.
 */
export function clearValuesUnder(
  v: ExactOrUnion,
  tag: TypeTag,
  clearTag = false
) {
  const newTag = clearTag ? v.type & ~tag : v.type | tag;
  // If the incoming type consists of singletons,
  // we can always merge it without affecting our data.
  tag &= ~SingletonTypeTagsConst;
  if (!tag || v.value == null) {
    v.type = newTag;
    return;
  }

  // We only keep data for ValueTypeTags if there is
  // only one of them. If the type being merged has
  // no data for one of them, the resulting type has
  // no data for any of them.
  if (tag & ValueTypeTagsConst) {
    tag |= ValueTypeTagsConst;
  }

  if (!hasUnionData(v.type)) {
    // get the single bit corresponding to v's data
    const dataMask = nonUnionDataMask(v.type);
    if (dataMask & tag) {
      // the merging type has no data for our
      // exact type; so delete all our data.
      // eg Number<1> or String => Number or String
      v.type = newTag;
      delete v.value;
      return;
    }
    if (dataMask & ValueTypeTagsConst) {
      // assert(tag & UnionDataTypeTags)

      // v had data corresponding to one of the
      // ValueTypeTags. But tag adds at least
      // one new bit. So drop the data.
      // eg Number<1> or Array => Number or Array
      delete v.value;
      v.type = newTag;
      return;
    }
    if (hasUnionData(newTag)) {
      // v had data corresponding to one of the
      // UnionDataTypeTags, and tag adds at least
      // one new bit. Keep the data, but move it into
      // a UnionData.
      // eg Array<Number> or Dictionary remains as is.
      const mask = v.type & UnionDataTypeTagsConst;
      (v as UnionType).value = {
        [mask]: v.value as SingleValue,
        mask,
      } as UnionData;
    }
    v.type = newTag;
    return;
  }
  v.type = newTag;
  const unionData = v.value as UnionData;
  let remain = unionData.mask & ~tag;
  if (!remain) {
    delete v.value;
    return;
  }
  const newData: UnionData = { mask: remain };
  while (remain) {
    const next = remain & (remain - 1);
    const bit = (remain - next) as UnionDataKey;
    (newData[bit] as SingleValue) = unionData[bit] as SingleValue;
    remain = next;
  }
  if (!hasUnionData(newTag)) {
    v.value = newData[(newTag & UnionDataTypeTagsConst) as UnionDataKey];
  } else {
    v.value = newData;
  }
}
