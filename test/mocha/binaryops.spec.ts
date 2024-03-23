import { assert, expect } from "chai";
import {
  evaluateBinaryTypes,
  evaluateLogicalTypes,
} from "../../src/type-flow/interp-binary";
import {
  TruthyTypes,
  TypeTag,
  mustBeFalse,
  mustBeTrue,
} from "../../src/type-flow/types";
import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { evaluateUnaryTypes } from "src/type-flow/interp";

export function binaryOperatorTests() {
  describe("Invalid inputs to", () => {
    const check = (
      op: mctree.BinaryOperator | mctree.LogicalOperator,
      t1: TypeTag,
      t2: TypeTag,
      type_ex: TypeTag,
      mismatch_ex: [TypeTag, TypeTag][] | undefined
    ) => {
      const { type, mismatch } =
        op === "&&" || op === "and" || op === "||" || op === "or"
          ? evaluateLogicalTypes(op, { type: t1 }, { type: t2 })
          : evaluateBinaryTypes(op, { type: t1 }, { type: t2 });
      expect(type.type).to.equal(type_ex);
      assert(mismatch);
      expect(Array.from(mismatch).map((m) => m.reverse())).to.deep.equal(
        mismatch_ex
      );
    };
    const neverValid =
      TypeTag.Function |
      TypeTag.Method |
      TypeTag.Module |
      TypeTag.Class |
      TypeTag.Typedef |
      TypeTag.Symbol;
    const validBits = TypeTag.Any & ~TypeTag.Object & ~TypeTag.Enum;

    describe("'+' without String", () => {
      const alwaysFail =
        neverValid |
        TypeTag.Null |
        TypeTag.Boolean |
        TypeTag.Array |
        TypeTag.Dictionary;

      it("invalid bits on left, everything but String on right", () =>
        check("+", alwaysFail, ~TypeTag.String & validBits, TypeTag.Never, [
          [alwaysFail, ~TypeTag.String & validBits],
        ]));
      it("everything but String on left, invalid bits on right", () =>
        check("+", ~TypeTag.String & validBits, alwaysFail, TypeTag.Never, [
          [~TypeTag.String & validBits, alwaysFail],
        ]));
      it("every exact type vs invalid bits, both ways", () => {
        let i =
          validBits &
          ~(TypeTag.Enum | TypeTag.Typedef | TypeTag.Object | TypeTag.String);
        while (i) {
          const bit = i & (i ^ (i - 1));
          check("+", alwaysFail, bit, TypeTag.Never, [[alwaysFail, bit]]);
          check("+", bit, alwaysFail, TypeTag.Never, [[bit, alwaysFail]]);
          i -= bit;
        }
      });
    });

    describe("'+' with String", () => {
      const alwaysFail = neverValid & ~TypeTag.Method & ~TypeTag.Symbol;
      it("invalid bits on left, everything on right", () =>
        check("+", alwaysFail, validBits, TypeTag.Never, [
          [alwaysFail, validBits],
        ]));
      it("everything on left, invalid bits on right", () =>
        check("+", validBits, alwaysFail, TypeTag.Never, [
          [validBits & ~TypeTag.Method & ~TypeTag.Symbol, alwaysFail],
        ]));
      it("every exact type vs invalid bits, both ways", () => {
        let i = validBits & ~(TypeTag.Enum | TypeTag.Typedef | TypeTag.Object);
        while (i) {
          const bit = i & (i ^ (i - 1));
          check("+", alwaysFail, bit, TypeTag.Never, [[alwaysFail, bit]]);
          check("+", bit, alwaysFail, TypeTag.Never, [[bit, alwaysFail]]);
          i -= bit;
        }
      });
      it("(Null | Float | Number) vs (String | Boolean | Char)", () => {
        check(
          "+",
          TypeTag.Null | TypeTag.Float | TypeTag.Number,
          TypeTag.String | TypeTag.Boolean | TypeTag.Char,
          TypeTag.String | TypeTag.Char,
          [
            [TypeTag.Null | TypeTag.Float, TypeTag.Boolean | TypeTag.Char],
            [TypeTag.Number, TypeTag.Boolean],
          ]
        );
      });
    });

    const regularArith = (op: mctree.BinaryOperator, allowed: TypeTag) => {
      describe(`'${op}'`, () => {
        const alwaysFail =
          TypeTag.Any & ~(TypeTag.Object | TypeTag.Enum | allowed);
        it("invalid bits on left, everything on right", () =>
          check(op, alwaysFail, validBits, TypeTag.Never, [
            [alwaysFail, validBits],
          ]));
        it("everything on left, invalid bits on right", () =>
          check(op, validBits, alwaysFail, TypeTag.Never, [
            [validBits, alwaysFail],
          ]));
        it("every exact type vs invalid bits, both ways", () => {
          let i =
            validBits & ~(TypeTag.Enum | TypeTag.Typedef | TypeTag.Object);
          while (i) {
            const bit = i & (i ^ (i - 1));
            check(op, alwaysFail, bit, TypeTag.Never, [[alwaysFail, bit]]);
            check(op, bit, alwaysFail, TypeTag.Never, [[bit, alwaysFail]]);
            i -= bit;
          }
          check(op, alwaysFail, TypeTag.Boolean, TypeTag.Never, [
            [alwaysFail, TypeTag.Boolean],
          ]);
          check(op, TypeTag.Boolean, alwaysFail, TypeTag.Never, [
            [TypeTag.Boolean, alwaysFail],
          ]);
        });
      });
    };
    regularArith("-", TypeTag.Numeric);
    regularArith("*", TypeTag.Numeric);
    regularArith("/", TypeTag.Numeric);
    regularArith("%", TypeTag.Number | TypeTag.Long);
    regularArith("&", TypeTag.Boolean | TypeTag.Number | TypeTag.Long);
    regularArith("|", TypeTag.Boolean | TypeTag.Number | TypeTag.Long);
    regularArith("^", TypeTag.Boolean | TypeTag.Number | TypeTag.Long);
    regularArith("<<", TypeTag.Number | TypeTag.Long);
    regularArith(">>", TypeTag.Number | TypeTag.Long);
    regularArith("<", TypeTag.Numeric | TypeTag.Char);
    regularArith("<=", TypeTag.Numeric | TypeTag.Char);
    regularArith(">=", TypeTag.Numeric | TypeTag.Char);
    regularArith(">", TypeTag.Numeric | TypeTag.Char);
    // "==" and "!=" are valid regardless of input types, so there's nothing to test here.

    describe(`'&&' / 'and'`, () => {
      const alwaysFail =
        TypeTag.Any &
        ~(
          TypeTag.Boolean |
          TypeTag.Number |
          TypeTag.Long |
          TypeTag.Object |
          TypeTag.Enum
        );
      it("invalid bits on left, everything on right", () =>
        check("&&", alwaysFail, validBits, TypeTag.Null, [
          [alwaysFail, validBits],
        ]));
      it("everything on left, invalid bits on right", () =>
        check("&&", validBits, alwaysFail, TypeTag.Null | TypeTag.False, [
          [validBits, alwaysFail],
        ]));
      it("every exact type vs invalid bits, both ways", () => {
        let i = validBits & ~(TypeTag.Enum | TypeTag.Typedef | TypeTag.Object);
        while (i) {
          const bit = i & (i ^ (i - 1));
          check("&&", alwaysFail, bit, TypeTag.Null, [[alwaysFail, bit]]);
          if (!mustBeFalse({ type: bit })) {
            check("&&", bit, alwaysFail, TypeTag.Never, [[bit, alwaysFail]]);
          }
          i -= bit;
        }
        check("&&", alwaysFail, TypeTag.Boolean, TypeTag.Null, [
          [alwaysFail, TypeTag.Boolean],
        ]);
        check("&&", TypeTag.Boolean, alwaysFail, TypeTag.False, [
          [TypeTag.Boolean, alwaysFail],
        ]);
      });
    });
    describe(`'||' / 'or'`, () => {
      const alwaysFail =
        TypeTag.Any &
        ~(
          TypeTag.Boolean |
          TypeTag.Number |
          TypeTag.Long |
          TypeTag.Object |
          TypeTag.Enum
        );
      it("invalid bits on left, everything on right", () =>
        check("||", alwaysFail, validBits, alwaysFail & TruthyTypes, [
          [alwaysFail, validBits],
        ]));
      it("everything on left, invalid bits on right", () =>
        check("||", validBits, alwaysFail, validBits & TruthyTypes, [
          [validBits, alwaysFail],
        ]));
      it("every exact type vs invalid bits, both ways", () => {
        let i = validBits & ~(TypeTag.Enum | TypeTag.Typedef | TypeTag.Object);
        while (i) {
          const bit = i & (i ^ (i - 1));
          check("||", alwaysFail, bit, alwaysFail & TruthyTypes, [
            [alwaysFail, bit],
          ]);
          if (!mustBeTrue({ type: bit })) {
            check("||", bit, alwaysFail, TypeTag.Never, [[bit, alwaysFail]]);
          }
          i -= bit;
        }
        check("||", alwaysFail, TypeTag.Boolean, alwaysFail & TruthyTypes, [
          [alwaysFail, TypeTag.Boolean],
        ]);
        check("||", TypeTag.Boolean, alwaysFail, TypeTag.True, [
          [TypeTag.Boolean, alwaysFail],
        ]);
      });
    });
  });

  describe("Logical operators", () => {
    it("Boolean && Object", () => {
      expect(
        evaluateLogicalTypes(
          "&&",
          { type: TypeTag.Boolean },
          { type: TypeTag.Object | TypeTag.Null }
        ).type
      ).to.deep.equal({ type: TypeTag.Boolean });
    });
    it("!Object", () => {
      expect(
        evaluateUnaryTypes("!", { type: TypeTag.Object | TypeTag.Null }).type
      ).to.deep.equal({
        type: TypeTag.Boolean | TypeTag.Number | TypeTag.Long,
      });
    });
  });
}
