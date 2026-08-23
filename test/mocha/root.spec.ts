import { bytecodeTests } from "./bytecode.spec";
import { deadStoreTests } from "./dead-store.spec";
import { typeTests } from "./types.spec";

describe("MonkeyC Optimizer Tests", () => {
  describe("Types tests", typeTests);
  describe("Dead store tests", deadStoreTests);
});

describe("Post Build Optimizer Tests", () => {
  describe("Byte code tests", bytecodeTests);
});
