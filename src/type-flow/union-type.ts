import { hasProperty } from "../ast";
import { StateNode } from "../optimizer-types";
import { forEach, some } from "../util";
import {
  ArrayValueType,
  cloneType,
  DictionaryValueType,
  EnumValueType,
  ExactOrUnion,
  forEachUnionComponent,
  getUnionComponent,
  hasUnionData,
  ObjectValueType,
  SingleTonTypeTagsConst,
  SingleValue,
  StateDeclValueType,
  TypeTag,
  UnionData,
  UnionDataKey,
  UnionDataTypeTagsConst,
  UnionType,
  ValueTypeTagsConst,
} from "./types";

export function unionInto(to: ExactOrUnion, from: ExactOrUnion) {
  if (from.type === 0 || to === from) return false;
  if (to.type === 0) {
    to.type = from.type;
    (to as ExactOrUnion).value = from.value;
    return true;
  }

  const newTags = to.type | from.type;

  if (!(from.type & ~SingleTonTypeTagsConst)) {
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

    return mergeMultiple(to, from);
  }

  if (to.value != null) {
    if (from.value == null) {
      clearValuesUnder(to, from.type);
      return true;
    }

    // always returns true because type changed.
    mergeMultiple(to, from);
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

function mergeMultiple(to: ExactOrUnion, from: ExactOrUnion) {
  const newTags = to.type | from.type;
  let anyChanged = newTags !== to.type;
  let mask = 0;
  const result: Record<number, SingleValue> = {};
  forEachUnionComponent(to, newTags, (tag, tov) => {
    const fromv = getUnionComponent(from, tag);
    if (tov != null) {
      if (fromv != null) {
        const [value, changed] = mergeSingle(tag, tov, fromv);
        if (changed) anyChanged = true;
        if (value) {
          mask |= tag;
          result[tag] = value;
        }
      } else if (!(from.type & tag)) {
        // from doesn't contribute to this tag,
        // so just keep it. No change.
        mask |= tag;
        result[tag] = tov;
      } else {
        // We dropped the data for this tag, so
        // things changed.
        anyChanged = true;
      }
    } else if (fromv && !(to.type & tag)) {
      // to doesn't contribute to this tag,
      // so just keep from's component.
      // this is new, so it changed.
      anyChanged = true;
      mask |= tag;
      result[tag] = fromv;
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

function tryUnion(to: ExactOrUnion, from: ExactOrUnion): ExactOrUnion | null {
  to = cloneType(to);
  if (unionInto(to, from)) return to;
  return null;
}

function mergeSingle(
  type: TypeTag,
  to: SingleValue,
  from: SingleValue
): [SingleValue | null, boolean] {
  switch (type) {
    case TypeTag.Number:
    case TypeTag.Long:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.Char:
    case TypeTag.String:
    case TypeTag.Symbol:
      if (to === from) {
        return [to, false];
      }
      return [null, true];
    case TypeTag.Array: {
      const merged = tryUnion(to as ArrayValueType, from as ArrayValueType);
      return [merged || to, merged != null];
    }

    case TypeTag.Dictionary: {
      const { key, value } = to as DictionaryValueType;
      const keyChange = tryUnion(key, (from as DictionaryValueType).key);
      const valueChange = tryUnion(value, (from as DictionaryValueType).value);
      if (keyChange || valueChange) {
        return [{ key: keyChange || key, value: valueChange || value }, true];
      }
      return [to, false];
    }
    case TypeTag.Module:
    case TypeTag.Function:
    case TypeTag.Class:
    case TypeTag.Typedef:
      return mergeStateDecls(
        to as StateDeclValueType,
        from as StateDeclValueType
      );
    case TypeTag.Object: {
      const klass = (to as ObjectValueType).klass;
      const [obj, objChanged] = mergeObjectValues(
        (to as ObjectValueType).obj,
        (from as ObjectValueType).obj
      );
      const klassChanged = tryUnion(klass, (from as ObjectValueType).klass);
      if (klassChanged || objChanged) {
        if (obj) {
          return [{ klass: klassChanged, obj } as SingleValue, true];
        }
        return [{ klass: klassChanged } as SingleValue, true];
      }
      return [to, false];
    }
    case TypeTag.Enum: {
      const toE = to as EnumValueType;
      const fromE = from as EnumValueType;
      if (toE.enum !== fromE.enum) {
        return [null, true];
      }
      if (!toE.value) {
        return [toE, false];
      }
      if (!fromE.value) {
        delete toE.value;
        return [toE, true];
      }
      const toValue = tryUnion(toE.value, fromE.value);
      if (toValue) {
        const e: EnumValueType = { enum: toE.enum, value: toValue };
        return [e, true];
      }
      return [toE, false];
    }
  }
  throw new Error(`Unexpected type ${type}`);
}

function mergeObjectValues(
  to: Record<string, ExactOrUnion> | undefined,
  from: Record<string, ExactOrUnion> | undefined
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
    if (unionInto(rep, from[key])) {
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

function mergeStateDecls(
  to: StateDeclValueType,
  from: StateDeclValueType
): [StateDeclValueType, boolean] {
  let changed = false;
  let result: StateDeclValueType = to;
  forEach(from, (v) => {
    if (some(to, (t) => t === v)) {
      return;
    }
    if (Array.isArray(result)) {
      if (result === to) {
        result = [...result, v] as StateDeclValueType;
      } else {
        (result as StateNode[]).push(v);
      }
    } else {
      result = [to, v] as StateDeclValueType;
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
  tag &= ~SingleTonTypeTagsConst;
  if (!tag) {
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
