import { BuildConfig } from "./build-config";

/**
 * The byte costs used by sizeBasedPRE to decide whether hoisting
 * something into a local is worth it.
 *
 * Since API level 5.1, devices whose compiler.json contains
 * codePageSize are compiled with the v2 opcode set, which moves
 * literals into the data pool. On those devices a literal push
 * costs no more than a local slot read, so hoisting a literal
 * never pays for itself.
 *
 * There are two models:
 *  - "v1": the original opcode set. These are the costs that
 *    sizeBasedPRE has always used.
 *  - "v2": the codePageSize opcode set. The literal costs are set
 *    equal to localRef, so no literal ever looks profitable to
 *    hoist (measured; see github.com/markw65/monkeyc-optimizer
 *    issue #90). The non-literal costs are carried over from v1
 *    unchanged - they have not been re-measured for v2.
 */

export type PreCostModelId = "v1" | "v2";

export type LiteralCostKind =
  | "Null"
  | "Boolean"
  | "Number"
  | "Float"
  | "Long"
  | "Double"
  | "String"
  | "Char";

export type PreCostModel = {
  /** cost of reading a local variable slot */
  localRef: number;
  /** extra cost of a store, over a read of the same thing */
  defExtra: number;
  /** cost of pushing a literal, by its type */
  literal: Record<LiteralCostKind, number>;
  /** base cost of reading a non-local identifier, or one member access */
  nonLocalRef: number;
  /** cost of each additional member access step */
  memberStep: number;
  /** cost of a member expression's root when it is `$' */
  globalRoot: number;
  /** cost of a member expression's root when it is any other identifier */
  objectRoot: number;
};

export const V1_COST_MODEL: PreCostModel = {
  localRef: 2,
  defExtra: 2,
  literal: {
    Null: 2,
    Boolean: 2,
    Number: 5,
    Float: 5,
    Char: 5,
    String: 5,
    Long: 9,
    Double: 9,
  },
  nonLocalRef: 8,
  memberStep: 6,
  globalRoot: 4,
  objectRoot: 6,
};

export const V2_COST_MODEL: PreCostModel = {
  ...V1_COST_MODEL,
  literal: {
    Null: 2,
    Boolean: 2,
    Number: 2,
    Float: 2,
    Char: 2,
    String: 2,
    Long: 2,
    Double: 2,
  },
};

/**
 * The cost model to use for a device, from its compiler.json:
 * devices with a codePageSize use the v2 opcode set.
 */
export function preCostModelForDevice(
  codePageSize: number | undefined
): PreCostModelId {
  return codePageSize ? "v2" : "v1";
}

/**
 * The cost model for a build config whose preCostModel has already
 * been resolved per device ("auto" resolves during optimizer group
 * identification; if it gets here unresolved - eg a build that never
 * went through jungle resolution - fall back to v1, the original
 * behavior).
 */
export function resolvePreCostModel(
  config: BuildConfig | null | undefined
): PreCostModel {
  return config?.preCostModel === "v2" ? V2_COST_MODEL : V1_COST_MODEL;
}
