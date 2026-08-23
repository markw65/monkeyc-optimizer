import { expect } from "chai";
import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  V1_COST_MODEL,
  V2_COST_MODEL,
  preCostModelForDevice,
  resolvePreCostModel,
} from "../../src/cost-model";
import { defCost, refCost } from "../../src/pre";

function literal(value: mctree.Literal["value"], raw: string): mctree.Literal {
  return { type: "Literal", value, raw };
}

function identifier(name: string): mctree.Identifier {
  return { type: "Identifier", name };
}

function member(
  object: mctree.Expression,
  name: string
): mctree.MemberExpression {
  return {
    type: "MemberExpression",
    object,
    property: identifier(name),
    computed: false,
  } as mctree.MemberExpression;
}

export function costModelTests() {
  describe("literal costs, v1", () => {
    it("prices Number literals at 5", () => {
      expect(refCost(literal(123, "123"), V1_COST_MODEL)).to.equal(5);
    });
    it("prices hex literals containing the digit d as Numbers", () => {
      // these were misclassified as Doubles by the old raw.match(/d/i)
      expect(refCost(literal(0xd, "0xd"), V1_COST_MODEL)).to.equal(5);
      expect(refCost(literal(0xdead, "0xdead"), V1_COST_MODEL)).to.equal(5);
    });
    it("prices Float literals at 5", () => {
      expect(refCost(literal(1.5, "1.5"), V1_COST_MODEL)).to.equal(5);
    });
    it("prices Double literals at 9", () => {
      expect(refCost(literal(1.5, "1.5d"), V1_COST_MODEL)).to.equal(9);
    });
    it("prices Long literals at 9, however they arrive", () => {
      expect(refCost(literal(BigInt(123), "123l"), V1_COST_MODEL)).to.equal(9);
      // a Long that arrived as a plain number was misclassified before
      expect(refCost(literal(123, "123l"), V1_COST_MODEL)).to.equal(9);
      expect(refCost(literal(0x2a, "0x2Al"), V1_COST_MODEL)).to.equal(9);
    });
    it("prices String and Char literals at 5", () => {
      expect(refCost(literal("abc", '"abc"'), V1_COST_MODEL)).to.equal(5);
      expect(refCost(literal("a", "'a'"), V1_COST_MODEL)).to.equal(5);
    });
    it("prices Boolean and Null literals at 2", () => {
      expect(refCost(literal(true, "true"), V1_COST_MODEL)).to.equal(2);
      expect(refCost(literal(null, "null"), V1_COST_MODEL)).to.equal(2);
    });
  });

  describe("literal costs, v2", () => {
    it("prices every literal at localRef, so no literal is ever worth hoisting", () => {
      const literals = [
        literal(123, "123"),
        literal(1.5, "1.5"),
        literal(1.5, "1.5d"),
        literal(BigInt(123), "123l"),
        literal("abc", '"abc"'),
        literal(true, "true"),
        literal(null, "null"),
      ];
      literals.forEach((node) => {
        expect(refCost(node, V2_COST_MODEL)).to.equal(V2_COST_MODEL.localRef);
      });
    });
  });

  describe("non-literal costs", () => {
    it("prices non-local identifier reads at 8 in both models", () => {
      expect(refCost(identifier("foo"), V1_COST_MODEL)).to.equal(8);
      expect(refCost(identifier("foo"), V2_COST_MODEL)).to.equal(8);
    });
    it("prices member expressions by root and steps", () => {
      const a_b = member(identifier("A"), "B");
      expect(refCost(a_b, V1_COST_MODEL)).to.equal(14);
      const global_b = member(identifier("$"), "B");
      expect(refCost(global_b, V1_COST_MODEL)).to.equal(12);
      const this_b = member(
        { type: "ThisExpression", text: "self" } as mctree.Expression,
        "B"
      );
      expect(refCost(this_b, V1_COST_MODEL)).to.equal(8);
      const a_b_c = member(member(identifier("A"), "B"), "C");
      expect(refCost(a_b_c, V1_COST_MODEL)).to.equal(20);
    });
    it("prices a def 2 bytes over the corresponding ref", () => {
      const a_b = member(identifier("A"), "B");
      expect(defCost(a_b, V1_COST_MODEL)).to.equal(
        refCost(a_b, V1_COST_MODEL) + 2
      );
    });
  });

  describe("model selection", () => {
    it("selects v2 for devices with a codePageSize", () => {
      expect(preCostModelForDevice(4096)).to.equal("v2");
      expect(preCostModelForDevice(undefined)).to.equal("v1");
    });
    it("resolves the config's model, defaulting to v1", () => {
      expect(resolvePreCostModel({ preCostModel: "v2" })).to.equal(
        V2_COST_MODEL
      );
      expect(resolvePreCostModel({ preCostModel: "v1" })).to.equal(
        V1_COST_MODEL
      );
      expect(resolvePreCostModel({ preCostModel: "auto" })).to.equal(
        V1_COST_MODEL
      );
      expect(resolvePreCostModel({})).to.equal(V1_COST_MODEL);
      expect(resolvePreCostModel(undefined)).to.equal(V1_COST_MODEL);
    });
  });
}
