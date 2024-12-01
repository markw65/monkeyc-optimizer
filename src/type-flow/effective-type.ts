import { restrictArrayData } from "./array-type";
import { couldBe } from "./could-be";
import { deEnumerate } from "./interp";
import { expandTypedef } from "./intersection-type";
import {
  EnumTagsConst,
  ExactOrUnion,
  ObjectLikeTagsConst,
  TypeTag,
  cloneType,
  forEachUnionComponent,
  getObjectValue,
  getUnionComponent,
  typeFromEnumValue,
} from "./types";
import { clearValuesUnder, unionInto } from "./union-type";

/*
 * Given a constraint type (eg the declared type of a module scope variable),
 * and its current tracked type, construct the type that contains every
 * component of the constraint type that could-be the tracked type.
 *
 * eg
 *
 * getEffectiveTrackedType(
 *  Array<Number or String> or [String] or Number, [Number]
 * ) => Array<Number or String>
 *
 * because [Number] could-be Array<Number or String>, but could-not-be [String], or Number
 */
export function getEffectiveTrackedType(
  constraint: ExactOrUnion,
  tracked: ExactOrUnion
): ExactOrUnion {
  if (!(constraint.type & TypeTag.Enum) && tracked.type & TypeTag.Enum) {
    tracked = deEnumerate(tracked);
  }
  if (constraint.type & TypeTag.Typedef && constraint.value != null) {
    return getEffectiveTrackedType(expandTypedef(constraint), tracked);
  }
  if (tracked.type & TypeTag.Typedef && tracked.value != null) {
    return getEffectiveTrackedType(constraint, expandTypedef(tracked));
  }
  let common = constraint.type & tracked.type & ~TypeTag.Typedef;
  if (
    tracked.type & TypeTag.Object &&
    constraint.type & ObjectLikeTagsConst &&
    getObjectValue(tracked) == null
  ) {
    common |= constraint.type & ObjectLikeTagsConst;
  }
  if (
    tracked.type & TypeTag.Enum &&
    constraint.type & EnumTagsConst &&
    !(constraint.type & TypeTag.Enum)
  ) {
    common |=
      constraint.type &
      typeFromEnumValue(getUnionComponent(tracked, TypeTag.Enum)).type;
  }

  if (!common) {
    return { type: TypeTag.Never };
  }

  if (constraint.value == null) {
    return { type: common };
  }

  if (tracked.value == null) {
    const result = cloneType(constraint);
    clearValuesUnder(result, constraint.type & ~common, true);
    return result;
  }

  const result = { type: TypeTag.Never };
  forEachUnionComponent(constraint, common, (ac) => {
    common &= ~ac.type;
    if (couldBe(ac, tracked)) {
      if (ac.type === TypeTag.Array && ac.value) {
        const trackedData = getUnionComponent(tracked, ac.type);
        if (trackedData) {
          unionInto(result, {
            type: TypeTag.Array,
            value: restrictArrayData(ac.value, trackedData),
          });
          return;
        }
      }
      unionInto(result, ac);
    }
  });
  unionInto(result, { type: common });
  return result;
}
