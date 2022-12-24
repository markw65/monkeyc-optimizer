import { assert } from "chai";
import { ProgramStateAnalysis } from "../../src/optimizer-types";
import { couldBe } from "../../src/type-flow/could-be";
import { ExactOrUnion, display, TypeTag } from "../../src/type-flow/types";
import { assertNonNull, find_type_by_name } from "./test-utils";

export function couldBeTests(statefn: () => ProgramStateAnalysis | null) {
  describe("union/couldBe tests", () => {
    function check(a: ExactOrUnion, b: ExactOrUnion, couldBeResult: boolean) {
      assert.strictEqual(
        couldBe(a, b),
        couldBeResult,
        `Expected couldBe(${display(a)}, ${display(
          b
        )}) to equal ${couldBeResult}`
      );
    }

    it("No top level typedefs", () => {
      const state = statefn();
      assertNonNull(state);
      const recurse_type = find_type_by_name(state, "Recurse");
      const recurse2_type = find_type_by_name(state, "Recurse2");
      assert.isTrue(
        (recurse_type.type & TypeTag.Typedef) == 0,
        `Typedef bit should not be set in ${recurse_type.type.toString(16)}`
      );
      assert.isTrue(
        (recurse2_type.type & TypeTag.Typedef) == 0,
        `Typedef bit should not be set in ${recurse2_type.type.toString(16)}`
      );
      assert.strictEqual(
        display(recurse_type),
        "Number or String or Array<Recurse>"
      );
      assert.strictEqual(display(recurse2_type), "Number or String");
    });

    it("Mixed union data works", () => {
      const state = statefn();
      assertNonNull(state);
      const mixed_type = find_type_by_name(state, "Mixed");
      assert.strictEqual(
        display(mixed_type),
        "Number or String or Array<Number or String> or Dictionary<String, Number> or Toybox.WatchUi.Menu or Toybox.WatchUi.Menu2"
      );
    });

    it("couldBe respects recursive types", () => {
      const state = statefn();
      assertNonNull(state);
      const recurse_type = find_type_by_name(state, "Recurse");
      check({ type: TypeTag.Number }, recurse_type, true);
      check({ type: TypeTag.String }, recurse_type, true);
      check({ type: TypeTag.Array }, recurse_type, true);
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
  });
}
