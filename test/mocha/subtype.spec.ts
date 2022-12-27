import { assert } from "chai";
import { ProgramStateAnalysis } from "../../src/optimizer-types";
import { subtypeOf } from "../../src/type-flow/sub-type";
import {
  ExactOrUnion,
  display,
  TypeTag,
  ObjectLikeTagsConst,
} from "../../src/type-flow/types";
import { assertNonNull, find_type_by_name } from "./test-utils";

export function subtypeOfTests(statefn: () => ProgramStateAnalysis | null) {
  describe("subtypeOf tests", () => {
    function check(a: ExactOrUnion, b: ExactOrUnion, subtypeOfResult: boolean) {
      assert.strictEqual(
        subtypeOf(a, b),
        subtypeOfResult,
        `Expected subtypeOf(${display(a)}, ${display(
          b
        )}) to equal ${subtypeOfResult}`
      );
    }

    it("subtypeOf object-like vs Object", () => {
      const state = statefn();
      assertNonNull(state);
      const menu_type = find_type_by_name(state, "Toybox.WatchUi.Menu");
      assertNonNull(menu_type);
      assert.strictEqual(menu_type.type, TypeTag.Object);

      check({ type: TypeTag.Number }, { type: TypeTag.Object }, true);
      check({ type: TypeTag.Number }, menu_type, false);
      check({ type: ObjectLikeTagsConst }, { type: TypeTag.Object }, true);
      check({ type: ObjectLikeTagsConst }, menu_type, false);
      check({ type: TypeTag.Null }, { type: TypeTag.Object }, false);
      check({ type: TypeTag.Null }, menu_type, false);
    });

    it("subtypeOf respects recursive types", () => {
      const state = statefn();
      assertNonNull(state);
      const recurse_type = find_type_by_name(state, "Recurse");
      check({ type: TypeTag.Number }, recurse_type, true);
      check({ type: TypeTag.String }, recurse_type, true);
      check({ type: TypeTag.Array }, recurse_type, false);
      check(
        { type: TypeTag.Array, value: { type: TypeTag.Number } },
        recurse_type,
        true
      );
      check(
        {
          type: TypeTag.Array,
          value: { type: TypeTag.Array, value: { type: TypeTag.Number } },
        },
        recurse_type,
        true
      );

      check({ type: TypeTag.Boolean }, recurse_type, false);
      check(
        {
          type: TypeTag.Array,
          value: { type: TypeTag.Array, value: { type: TypeTag.Boolean } },
        },
        recurse_type,
        false
      );
    });
    it("Number <= Number | Boolean", () => {
      check(
        { type: TypeTag.Number },
        { type: TypeTag.Number | TypeTag.Boolean },
        true
      );
    });

    it("!(Number <= Number<5> | Boolean)", () => {
      check(
        { type: TypeTag.Number },
        { type: TypeTag.Number | TypeTag.Boolean, value: 5 },
        false
      );
    });
    it("Number<5> <= Number | Boolean)", () => {
      check(
        { type: TypeTag.Number, value: 5 },
        { type: TypeTag.Number | TypeTag.Boolean },
        true
      );
    });
    it("Number<5> <= Number<5> | Boolean)", () => {
      check(
        { type: TypeTag.Number, value: 5 },
        { type: TypeTag.Number | TypeTag.Boolean, value: 5 },
        true
      );
    });
  });
}
