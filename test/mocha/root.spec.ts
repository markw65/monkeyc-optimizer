import { bytecodeTests } from "./bytecode.spec";
import { typeTests } from "./types.spec";

describe("MonkeyC Optimizer Tests", () => {
  describe("Types tests", typeTests);
});

describe("Post Build Optimizer Tests", () => {
  describe("Byte code tests", bytecodeTests);
});
