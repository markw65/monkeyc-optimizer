import {
  ProgramStateAnalysis,
  TypedefStateNode,
} from "../../src/optimizer-types";
import {
  display,
  EnumTagsConst,
  EnumType,
  ExactOrUnion,
  LastTypeTag,
  ObjectLikeTagsConst,
  TypeTag,
} from "../../src/type-flow/types";
import { assertNonNull, find_type_by_name, find_by_name } from "./test-utils";
import { intersection } from "../../src/type-flow/intersection-type";
import { assert } from "chai";
export function intersectionTests(statefn: () => ProgramStateAnalysis | null) {
  describe("intersection tests", () => {
    it("Non-data intersections", () => {
      for (let i = 1; i <= LastTypeTag; i <<= 1) {
        if (i === TypeTag.Typedef) continue;
        const ti = { type: i };
        for (let j = 1; j <= LastTypeTag; j <<= 1) {
          if (j === TypeTag.Typedef) continue;
          const tj = { type: j };
          const intersect = intersection(ti, tj);
          if (
            (ti.type & EnumTagsConst && tj.type & TypeTag.Enum) ||
            (tj.type & EnumTagsConst && ti.type & TypeTag.Enum)
          ) {
            assert.deepEqual(intersect, {
              type: TypeTag.Enum,
              value: {
                value: ti.type === TypeTag.Enum ? tj : ti,
              },
            });
          } else {
            if (i == j) {
              assert.deepEqual(intersect, ti);
            } else {
              if (
                (ti.type & ObjectLikeTagsConst && tj.type & TypeTag.Object) ||
                (tj.type & ObjectLikeTagsConst && ti.type & TypeTag.Object)
              ) {
                assert.strictEqual(
                  intersect.type,
                  (ti.type | tj.type) & ObjectLikeTagsConst
                );
              } else {
                assert.deepEqual(intersect, { type: TypeTag.Never });
              }
            }
          }
        }
      }
    });
    function check_intersect(
      t1: ExactOrUnion,
      t2: ExactOrUnion,
      expected: ExactOrUnion
    ) {
      const intersect = intersection(t1, t2);
      const estr = display(expected);
      const istr = display(intersect);
      assert.strictEqual(estr, istr, `expected ${istr} to be equal to ${estr}`);
    }
    it("Intersections with data", () => {
      check_intersect(
        { type: TypeTag.Number, value: 0 },
        { type: TypeTag.Number, value: 42 },
        { type: TypeTag.Never }
      );
      check_intersect(
        { type: TypeTag.Number, value: 42 },
        { type: TypeTag.Number, value: 0 },
        { type: TypeTag.Never }
      );
    });
    it("Enums vs their embedded types", () => {
      const state = statefn();
      assertNonNull(state);
      const enum_type = find_type_by_name(state, "NumberEnum") as EnumType;
      assertNonNull(enum_type?.value?.enum);
      check_intersect(
        enum_type,
        { type: TypeTag.Number, value: 42 },
        {
          type: TypeTag.Enum,
          value: {
            enum: enum_type.value.enum,
            value: { type: TypeTag.Number, value: 42 },
          },
        }
      );
      check_intersect(
        enum_type,
        { type: TypeTag.Number | TypeTag.Boolean, value: 42 },
        {
          type: TypeTag.Enum,
          value: {
            enum: enum_type.value.enum,
            value: { type: TypeTag.Number, value: 42 },
          },
        }
      );
    });
    it("Recursive intersections", () => {
      const state = statefn();
      assertNonNull(state);
      const recurse_type = find_type_by_name(state, "Recurse");
      const recurse2_type = find_type_by_name(state, "Recurse2");

      check_intersect(
        recurse2_type,
        { type: TypeTag.Number },
        { type: TypeTag.Number }
      );
      check_intersect(
        recurse2_type,
        { type: TypeTag.String },
        { type: TypeTag.String }
      );

      const recurseStateNode = find_by_name(
        state,
        "Recurse"
      ) as TypedefStateNode[];
      assert.strictEqual(recurseStateNode.length, 1);

      check_intersect(
        recurse_type,
        { type: TypeTag.Array },
        {
          type: TypeTag.Array,
          value: { type: TypeTag.Typedef, value: recurseStateNode[0] },
        }
      );
      check_intersect(
        recurse_type,
        { type: TypeTag.Array, value: { type: TypeTag.Number } },
        {
          type: TypeTag.Array,
          value: { type: TypeTag.Number },
        }
      );
    });
  });
}
