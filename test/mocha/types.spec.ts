import { assert } from "chai";
import { ProgramStateAnalysis } from "../../src/optimizer-types";
import { couldBe } from "../../src/type-flow/could-be";
import {
  display,
  ExactOrUnion,
  mustBeFalse,
  mustBeTrue,
  TypeTag,
} from "../../src/type-flow/types";
import { create_program_analysis, find_type_by_name } from "./test-utils";

function assertNonNull<T>(obj: T): asserts obj is NonNullable<T> {
  assert.isNotNull(obj);
}

export function typeTests() {
  const check = (v: ExactOrUnion, method: (v: ExactOrUnion) => boolean) => {
    assert.isTrue(
      method(v),
      `Failed to assert that ${method.name}(${display(v)}) isTrue`
    );
  };

  describe("mustBeTrue/mustBeFalse tests", () => {
    it("things that must be true", () => {
      check({ type: TypeTag.Object }, mustBeTrue);
      check({ type: TypeTag.Class }, mustBeTrue);
      check({ type: TypeTag.Function }, mustBeTrue);
      check({ type: TypeTag.Module }, mustBeTrue);
      check({ type: TypeTag.True }, mustBeTrue);
      check({ type: TypeTag.Number, value: 1 }, mustBeTrue);
      check({ type: TypeTag.Long, value: 100n }, mustBeTrue);
    });

    it("things that must be false", () => {
      check({ type: TypeTag.Null }, mustBeFalse);
      check({ type: TypeTag.False }, mustBeFalse);
      check({ type: TypeTag.Number, value: 0 }, mustBeFalse);
      check({ type: TypeTag.Long, value: 0n }, mustBeFalse);
    });

    function neither(v: ExactOrUnion) {
      assert.isFalse(
        mustBeTrue(v),
        `${display(v)} was true, but should be neither true nor false`
      );
      assert.isFalse(
        mustBeFalse(v),
        `${display(v)} was false, but should be neither true nor false`
      );
    }

    it("things that must be neither", () => {
      neither({ type: TypeTag.Number });
      neither({ type: TypeTag.Long });
      neither({ type: TypeTag.Float });
      neither({ type: TypeTag.Double });
      neither({ type: TypeTag.String });
      neither({ type: TypeTag.Char });
      neither({ type: TypeTag.Float, value: 0 });
      neither({ type: TypeTag.Double, value: 0 });
      neither({ type: TypeTag.String, value: "" });
      neither({ type: TypeTag.Char, value: "\0" });
    });
  });

  describe("Union/couldBe tests", async () => {
    let state: ProgramStateAnalysis | null = null;
    before(() =>
      create_program_analysis(
        `
        import Toybox.Lang;
        import Toybox.WatchUi;
        typedef Recurse as Number or Array<Recurse> or String or Recurse;
        typedef Recurse2 as Number or String or Recurse2;
        typedef Mixed as Number or String or Menu or Menu2 or Array<String> or Array<Number> or Dictionary<String,Number>;
        `,
        "test.mc",
        {
          trustDeclaredTypes: true,
          propagateTypes: true,
          checkTypes: "WARNING",
        }
      ).then((s) => (state = s))
    );

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
      assertNonNull(state);
      const mixed_type = find_type_by_name(state, "Mixed");
      assert.strictEqual(
        display(mixed_type),
        "Number or String or Array<Number or String> or Dictionary<String, Number> or Toybox.WatchUi.Menu or Toybox.WatchUi.Menu2"
      );
    });

    it("couldBe respects recursive types", () => {
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
