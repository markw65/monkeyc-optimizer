import { assert } from "chai";
import { ProgramStateAnalysis } from "../../src/optimizer-types";
import {
  display,
  ExactOrUnion,
  mustBeFalse,
  mustBeTrue,
  TypeTag,
} from "../../src/type-flow/types";
import { binaryOperatorTests } from "./binaryops.spec";
import { couldBeTests } from "./coudbe.spec";
import { intersectionTests } from "./intersection.spec";
import { subtypeOfTests } from "./subtype.spec";
import { create_program_analysis } from "./test-utils";

export function typeTests() {
  const check = (v: ExactOrUnion, method: (v: ExactOrUnion) => boolean) => {
    assert.isTrue(
      method(v),
      `Failed to assert that ${method.name}(${display(v)}) isTrue`
    );
  };

  describe("mustBeTrue/mustBeFalse tests", () => {
    it("things that must be true", () => {
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
      neither({ type: TypeTag.Object });
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

  describe("Type manipulation tests", () => {
    let state: ProgramStateAnalysis | null = null;
    before(() =>
      create_program_analysis(
        `
        import Toybox.Lang;
        import Toybox.WatchUi;
        typedef Recurse as Number or Array<Recurse> or String or Recurse;
        typedef Recurse2 as Number or String or Recurse2;
        typedef Mixed as Number or String or Menu or Menu2 or Array<String> or Array<Number> or Dictionary<String,Number>;
        enum NumberEnum { FOO, BAR, BAZ = 100 }
        `,
        "test.mc",
        {
          trustDeclaredTypes: true,
          propagateTypes: true,
          checkTypes: "WARNING",
        }
      ).then((s) => (state = s))
    );

    intersectionTests(() => state);
    couldBeTests(() => state);
    subtypeOfTests(() => state);
  });

  describe("Binary operator tests", binaryOperatorTests);
}
