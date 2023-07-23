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
import {
  intersection,
  restrictByEquality,
} from "../../src/type-flow/intersection-type";
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
            assert.deepEqual(intersect, ti.type === TypeTag.Enum ? tj : ti);
          } else {
            if (i === j) {
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
      check_intersect(
        { type: TypeTag.Number, value: 42 },
        { type: TypeTag.Any },
        { type: TypeTag.Number, value: 42 }
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
  function check_restrict(
    t1: ExactOrUnion,
    t2: ExactOrUnion,
    expected: ExactOrUnion
  ) {
    const result = restrictByEquality(t1, t2);
    const estr = display(expected);
    const istr = display(result);
    assert.strictEqual(istr, estr, `expected ${istr} to be equal to ${estr}`);
  }

  describe("restrictByEquality tests", () => {
    it("Out of range produces Never", () => {
      check_restrict(
        { type: TypeTag.Number, value: 5 },
        { type: TypeTag.Boolean },
        { type: TypeTag.Never }
      );
      check_restrict(
        { type: TypeTag.Number, value: 0x1ffffff },
        { type: TypeTag.Float },
        { type: TypeTag.Never }
      );
      check_restrict(
        { type: TypeTag.Long, value: 0x1ffffffn },
        { type: TypeTag.Float },
        { type: TypeTag.Never }
      );
    });

    it("Number only compares true against Numeric, Char or Boolean", () => {
      check_restrict(
        { type: TypeTag.Number, value: 5 },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Number, value: 1 },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.True }
      );
      check_restrict(
        { type: TypeTag.Number, value: 0 },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.False }
      );
      check_restrict(
        { type: TypeTag.Number },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.Boolean }
      );
    });

    it("Mixed tests", () => {
      check_restrict(
        { type: TypeTag.Number | TypeTag.Boolean },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.Boolean }
      );
      check_restrict(
        { type: TypeTag.Float | TypeTag.Long },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Float | TypeTag.Double },
        { type: TypeTag.Any },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Float, value: 4.5 },
        { type: TypeTag.Any },
        { type: TypeTag.Float | TypeTag.Double }
      );
      check_restrict(
        { type: TypeTag.Number, value: 0x1ffffff },
        { type: TypeTag.Any },
        { type: TypeTag.Number | TypeTag.Long | TypeTag.Double | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Long, value: 0x1ffffffn },
        { type: TypeTag.Any },
        { type: TypeTag.Number | TypeTag.Long | TypeTag.Double | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Any },
        { type: TypeTag.Number, value: 1 },
        { type: TypeTag.Number, value: 1 }
      );
      check_restrict(
        { type: TypeTag.Any },
        { type: TypeTag.Number | TypeTag.Float },
        { type: TypeTag.Number | TypeTag.Float }
      );
    });

    it("enum restrictions", () => {
      const state = statefn();
      assertNonNull(state);
      const number_enum = find_type_by_name(state, "NumberEnum") as EnumType;
      assert.strictEqual(number_enum.type, TypeTag.Enum);
      assertNonNull(number_enum.value?.enum);
      assertNonNull(number_enum.value.value);

      check_restrict(
        {
          type: TypeTag.Enum,
          value: {
            enum: number_enum.value.enum,
            value: { type: TypeTag.Number, value: 4 },
          },
        },
        {
          type: TypeTag.Number | TypeTag.Enum,
          value: {
            enum: number_enum.value.enum,
            value: { type: TypeTag.Number },
          },
        },
        {
          type: TypeTag.Number | TypeTag.Enum,
          value: {
            enum: number_enum.value.enum,
            value: { type: TypeTag.Number, value: 4 },
          },
        }
      );
      check_restrict({ type: TypeTag.Float, value: 4.5 }, number_enum, {
        type: TypeTag.Never,
      });

      const four_as_number_enum = {
        type: TypeTag.Enum,
        value: {
          enum: number_enum.value.enum,
          value: { type: TypeTag.Number, value: 4 },
        },
      } as const;
      check_restrict(
        { type: TypeTag.Float, value: 4 },
        number_enum,
        four_as_number_enum
      );
      check_restrict({ type: TypeTag.Any }, number_enum, number_enum);
      check_restrict(
        { type: TypeTag.Any },
        four_as_number_enum,
        four_as_number_enum
      );
    });

    it("Number vs Object restrictions", () => {
      check_restrict(
        { type: TypeTag.Number, value: 5 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Number, value: 1 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.True }
      );
      check_restrict(
        { type: TypeTag.Number, value: 0 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.False }
      );
      check_restrict(
        { type: TypeTag.Number },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char | TypeTag.Boolean }
      );
    });

    it("Long vs Object restrictions", () => {
      check_restrict(
        { type: TypeTag.Long, value: 5n },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Long, value: 1n },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Long, value: 0n },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Long },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
    });

    it("Float vs Object restrictions", () => {
      check_restrict(
        { type: TypeTag.Float, value: 5 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Float, value: 5.5 },
        { type: TypeTag.Object },
        { type: TypeTag.Float | TypeTag.Double }
      );
      check_restrict(
        { type: TypeTag.Float, value: 1 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Float, value: 0 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Float },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
    });

    it("Double vs Object restrictions", () => {
      check_restrict(
        { type: TypeTag.Double, value: 5 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Double, value: 5.5 },
        { type: TypeTag.Object },
        { type: TypeTag.Float | TypeTag.Double }
      );
      check_restrict(
        { type: TypeTag.Double, value: 1 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Double, value: 0 },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
      check_restrict(
        { type: TypeTag.Double },
        { type: TypeTag.Object },
        { type: TypeTag.Numeric | TypeTag.Char }
      );
    });
    it("Char restrictions", () => {
      check_restrict(
        { type: TypeTag.Number, value: 42 },
        { type: TypeTag.Char },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Long, value: 42n },
        { type: TypeTag.Char },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Float, value: 42 },
        { type: TypeTag.Char },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Double, value: 42 },
        { type: TypeTag.Char },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Number, value: 42 },
        { type: TypeTag.Char, value: "*" },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Long, value: 42n },
        { type: TypeTag.Char, value: "*" },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Float, value: 42 },
        { type: TypeTag.Char, value: "*" },
        { type: TypeTag.Char, value: "*" }
      );
      check_restrict(
        { type: TypeTag.Double, value: 42 },
        { type: TypeTag.Char, value: "*" },
        { type: TypeTag.Char, value: "*" }
      );
    });
  });
}
