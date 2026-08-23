import { bytecodeTests } from "./bytecode.spec";
import { costModelTests } from "./cost-model.spec";
import { deadStoreTests } from "./dead-store.spec";
import { typeTests } from "./types.spec";

describe("MonkeyC Optimizer Tests", () => {
  describe("Types tests", typeTests);
  describe("Dead store tests", deadStoreTests);
  describe("PRE cost model tests", costModelTests);
});

describe("Post Build Optimizer Tests", () => {
  describe("Byte code tests", bytecodeTests);
});
