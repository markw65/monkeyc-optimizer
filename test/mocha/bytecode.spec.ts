import { assert } from "chai";
import {
  Block,
  Context,
  findFunctions,
  FuncEntry,
} from "../../src/readprg/bytecode";
import { ExceptionsMap } from "../../src/readprg/exceptions";
import {
  Bytecode,
  isCondBranch,
  Opcodes,
  opcodeSize,
} from "../../src/readprg/opcodes";
import { optimizeFunc } from "../../src/readprg/optimize";
import { SymbolTable } from "../../src/readprg/symbols";
import { xmlUtil } from "../../src/sdk-util";

type PreBytecode = {
  op: Opcodes;
  arg?: Bytecode["arg"] | string;
  label?: string;
};

export function bytecodeTests() {
  const andSequence = [
    { op: Opcodes.lgetv, arg: 0 },
    { op: Opcodes.npush },
    { op: Opcodes.ne },
    { op: Opcodes.bf, arg: "eithernull" },
    { op: Opcodes.lgetv, arg: 1 },
    { op: Opcodes.npush },
    { op: Opcodes.ne },
    { op: Opcodes.bf, arg: "eithernull" },
    { op: Opcodes.bpush, arg: 1 },
    { op: Opcodes.return },
    { label: "eithernull", op: Opcodes.bpush, arg: 0 },
    { op: Opcodes.return },
  ];
  const orSequence = [
    { op: Opcodes.lgetv, arg: 0 },
    { op: Opcodes.npush },
    { op: Opcodes.ne },
    { op: Opcodes.bt, arg: "notbothnull" },
    { op: Opcodes.lgetv, arg: 1 },
    { op: Opcodes.npush },
    { op: Opcodes.ne },
    { op: Opcodes.bt, arg: "notbothnull" },
    { op: Opcodes.bpush, arg: 0 },
    { op: Opcodes.return },
    { label: "notbothnull", op: Opcodes.bpush, arg: 1 },
    { op: Opcodes.return },
  ];
  it("check && optimization, normal layout", () =>
    checkSequence(
      [
        { op: Opcodes.lgetv, arg: 0 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.dup, arg: 0 },
        { op: Opcodes.bf, arg: "firstnull" },
        { op: Opcodes.lgetv, arg: 1 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.andv },
        { label: "firstnull", op: Opcodes.bf, arg: "eithernull" },
        { op: Opcodes.bpush, arg: 1 },
        { op: Opcodes.return },
        { label: "eithernull", op: Opcodes.bpush, arg: 0 },
        { op: Opcodes.return },
      ],
      andSequence
    ));
  it("check && optimization, reverse layout", () =>
    checkSequence(
      [
        { op: Opcodes.lgetv, arg: 0 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.dup, arg: 0 },
        { op: Opcodes.bt, arg: "notnull" },
        { label: "firstnull", op: Opcodes.bf, arg: "eithernull" },
        { op: Opcodes.bpush, arg: 1 },
        { op: Opcodes.return },
        { label: "notnull", op: Opcodes.lgetv, arg: 1 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.andv },
        { op: Opcodes.goto, arg: "firstnull" },
        { label: "eithernull", op: Opcodes.bpush, arg: 0 },
        { op: Opcodes.return },
      ],
      andSequence
    ));
  it("check || optimization, normal layout", () =>
    checkSequence(
      [
        { op: Opcodes.lgetv, arg: 0 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.dup, arg: 0 },
        { op: Opcodes.bt, arg: "firstnonnull" },
        { op: Opcodes.lgetv, arg: 1 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.orv },
        { label: "firstnonnull", op: Opcodes.bt, arg: "notbothnull" },
        { op: Opcodes.bpush, arg: 0 },
        { op: Opcodes.return },
        { label: "notbothnull", op: Opcodes.bpush, arg: 1 },
        { op: Opcodes.return },
      ],
      orSequence
    ));
  it("check || optimization, reverse layout", () =>
    checkSequence(
      [
        { op: Opcodes.lgetv, arg: 0 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.dup, arg: 0 },
        { op: Opcodes.bf, arg: "isnull" },
        { label: "firstnonnull", op: Opcodes.bt, arg: "notbothnull" },
        { op: Opcodes.bpush, arg: 0 },
        { op: Opcodes.return },
        { label: "isnull", op: Opcodes.lgetv, arg: 1 },
        { op: Opcodes.npush },
        { op: Opcodes.ne },
        { op: Opcodes.orv },
        { op: Opcodes.goto, arg: "firstnonnull" },
        { label: "notbothnull", op: Opcodes.bpush, arg: 1 },
        { op: Opcodes.return },
      ],
      orSequence
    ));
}

function checkSequence(incodes: PreBytecode[], outcodes: PreBytecode[]) {
  const context = createContext(incodes);
  const functions = findFunctions(context);
  assert(functions.size === 1);
  functions.forEach((func) => {
    optimizeFunc(func, context);
    compareFunc(func, processBytecode(outcodes));
  });
}

function compareFunc(func: FuncEntry, bytecodes: Map<number, Bytecode>) {
  const start = func.blocks.get(func.offset);
  assert(start);
  const visited: Set<Block> = new Set();
  const visit = (block: Block, offset: number) => {
    if (visited.has(block)) return;
    visited.add(block);
    let target: number | undefined;
    block.bytecodes.forEach((bc, i) => {
      if (bc.op !== Opcodes.goto) {
        const expected = bytecodes.get(offset);
        assert(expected);
        switch (expected.op) {
          case Opcodes.bt:
          case Opcodes.bf:
            assert(block.taken);
            assert.isTrue(isCondBranch(bc.op));
            assert.strictEqual(block.bytecodes.length, i + 1);
            if (bc.op === expected.op) {
              target = expected.arg;
              offset += bc.size;
            } else {
              target = offset + bc.size;
              offset = expected.arg;
            }
            break;

          case Opcodes.jsr:
            assert(block.taken);
            assert.strictEqual(bc.op, expected.op);
            assert.strictEqual(block.bytecodes.length, i + 1);
            target = expected.arg;
            offset += bc.size;
            break;
          default:
            assert.strictEqual(bc.op, expected.op);
            assert.strictEqual(bc.arg, expected.arg);
            offset += bc.size;
        }
      }
    });

    if (block.next) {
      visit(func.blocks.get(block.next)!, offset);
    }
    if (block.taken) {
      assert(target != null);
      visit(func.blocks.get(block.taken)!, target);
    }
  };
  visit(start, 0);
}

function processBytecode(incodes: PreBytecode[]) {
  const bytecodes: Map<number, Bytecode> = new Map();
  const labels: Map<string, number> = new Map();
  const fixups: Map<Bytecode, string> = new Map();
  incodes.reduce((offset, bc) => {
    if (bc.label) labels.set(bc.label, offset);
    const size = opcodeSize(bc.op);
    const arg = typeof bc.arg === "string" ? 0 : bc.arg;
    const bytecode = { op: bc.op, arg, size, offset } as Bytecode;
    if (typeof bc.arg === "string") {
      fixups.set(bytecode, bc.arg);
    }
    bytecodes.set(offset, bytecode);
    offset += size;
    return offset;
  }, 0);
  fixups.forEach((label, bc) => {
    const offset = labels.get(label);
    assert(offset != null);
    bc.arg = offset;
  });
  return bytecodes;
}

function createContext(incodes: PreBytecode[]): Context {
  const symbolTable = new SymbolTable();
  symbolTable.methods.set(0, { name: "test", id: 1 });
  const exceptionsMap: ExceptionsMap = new Map();
  const debugXml = xmlUtil.parseXml("<debugInfo></<debugInfo>");
  return {
    bytecodes: Array.from(processBytecode(incodes).values()),
    symbolTable,
    exceptionsMap,
    filepath: "<testprg>",
    sections: {},
    lineTable: new Map(),
    debugXml,
  };
}