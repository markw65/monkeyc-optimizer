import { unhandledType } from "../data-flow";
import { LineNumber } from "./linenum";

export enum Opcodes {
  nop,
  incsp,
  popv,
  addv,
  subv,
  mulv,
  divv,
  andv,
  orv,
  modv,
  shlv,
  shrv,
  xorv,
  getv,
  putv,
  invokem,
  agetv,
  aputv,
  lgetv,
  lputv,
  newa,
  newc,
  return,
  ret,
  news,
  goto,
  eq,
  lt,
  lte,
  gt,
  gte,
  ne,
  isnull,
  isa,
  canhazplz,
  jsr,
  ts,
  ipush,
  fpush,
  spush,
  bt,
  bf,
  frpush,
  bpush,
  npush,
  invv,
  dup,
  newd,
  getm,
  lpush,
  dpush,
  throw,
  cpush,
  argc,
  newba,
}

interface BaseOpcode {
  op: Opcodes;
  offset: number;
  size: number;
  lineNum?: LineNumber;
  arg?: unknown;
}

export interface Incsp extends BaseOpcode {
  op: Opcodes.incsp;
  arg: number;
}

export interface Argless extends BaseOpcode {
  arg?: never;
}

export interface ByteArg extends BaseOpcode {
  arg: number;
}

export interface ShortArg extends BaseOpcode {
  arg: number;
}

export interface WordArg extends BaseOpcode {
  arg: number;
}

export interface FloatArg extends BaseOpcode {
  arg: number;
}

export interface LongArg extends BaseOpcode {
  arg: bigint;
}

export interface DoubleArg extends BaseOpcode {
  arg: number;
}

export interface Nop extends Argless {
  op: Opcodes.nop;
}

export interface Popv extends Argless {
  op: Opcodes.popv;
}

export interface Addv extends Argless {
  op: Opcodes.addv;
}

export interface Subv extends Argless {
  op: Opcodes.subv;
}

export interface Mulv extends Argless {
  op: Opcodes.mulv;
}

export interface Divv extends Argless {
  op: Opcodes.divv;
}

export interface Andv extends Argless {
  op: Opcodes.andv;
}

export interface Orv extends Argless {
  op: Opcodes.orv;
}

export interface Modv extends Argless {
  op: Opcodes.modv;
}

// shlv and shrv don't really have a byte
// argument, but garmin's tools think they
// do. The assembler doesn't let you specify
// the arg though, so its always zero, which
// is a nop bytecode.
// Removing the nop works in the simulator
// and the devices I've tested on, but
// causes garmin's tools to report that its
// an invalid binary. So we have to just
// live with it.
export interface Shlv extends Argless {
  op: Opcodes.shlv;
}

export interface Shrv extends Argless {
  op: Opcodes.shrv;
}

export interface Xorv extends Argless {
  op: Opcodes.xorv;
}

export interface Getv extends Argless {
  op: Opcodes.getv;
}

export interface Putv extends Argless {
  op: Opcodes.putv;
}

export interface Invokem extends ByteArg {
  op: Opcodes.invokem;
}

export interface Agetv extends Argless {
  op: Opcodes.agetv;
}

export interface Aputv extends Argless {
  op: Opcodes.aputv;
}

/*
 * Information about which "user" local a particular Lgetv or Lputv refers to.
 * On input, this info is acquired from the debug.xml file, so can't be entirely
 * trusted (eg in theory debug.xml could say that two Lgetvs belong to different
 * ranges, but in fact both are fed by the same Lputv - so must be the same). In
 * addition, some Lgetvs and Lputvs are entirely left out.
 *
 * The final minimize locals pass will determine the actual groups (and assuming
 * a single name per group, will preserve those names, while adding names to
 * unnamed locals)
 */
export type LocalRange = {
  name: string;
  id: number;
  isParam?: true | undefined;
};

export interface LocalInst extends ByteArg {
  range?: LocalRange;
}

// get local value
export interface Lgetv extends LocalInst {
  op: Opcodes.lgetv;
}

// put local value
export interface Lputv extends LocalInst {
  op: Opcodes.lputv;
}

// new array with arg elements
export interface Newa extends Argless {
  op: Opcodes.newa;
}

// new class instance
export interface Newc extends Argless {
  op: Opcodes.newc;
}

// return from function
export interface Return extends Argless {
  op: Opcodes.return;
}

// return from jsr (used for try/catch???)
export interface Ret extends Argless {
  op: Opcodes.ret;
}

// new string from label arg
export interface News extends WordArg {
  op: Opcodes.news;
}

export interface Goto extends ShortArg {
  op: Opcodes.goto;
}

export interface Bt extends ShortArg {
  op: Opcodes.bt;
}

export interface Bf extends ShortArg {
  op: Opcodes.bf;
}

// jump and push pc (used for try/catch???)
export interface Jsr extends ShortArg {
  op: Opcodes.jsr;
}

export interface Eq extends Argless {
  op: Opcodes.eq;
}

export interface Lt extends Argless {
  op: Opcodes.lt;
}

export interface Lte extends Argless {
  op: Opcodes.lte;
}

export interface Gt extends Argless {
  op: Opcodes.gt;
}

export interface Gte extends Argless {
  op: Opcodes.gte;
}

export interface Ne extends Argless {
  op: Opcodes.ne;
}

export interface Isnull extends Argless {
  op: Opcodes.isnull;
}

export interface Isa extends Argless {
  op: Opcodes.isa;
}

export interface Canhazplz extends Argless {
  op: Opcodes.canhazplz;
}

export interface Ts extends Argless {
  op: Opcodes.ts;
}

// push Number
export interface Ipush extends WordArg {
  op: Opcodes.ipush;
}

// push Float
export interface Fpush extends FloatArg {
  op: Opcodes.fpush;
}

// push Symbol
export interface Spush extends WordArg {
  op: Opcodes.spush;
}

// push the last thing looked up by getv (really?)
export interface Frpush extends Argless {
  op: Opcodes.frpush;
}

// push Boolean
export interface Bpush extends ByteArg {
  op: Opcodes.bpush;
}

// push Null
export interface Npush extends Argless {
  op: Opcodes.npush;
}

// invert top of stack (bitwise not for numbers)
export interface Invv extends Argless {
  op: Opcodes.invv;
}

// duplicate nth item on the stack
export interface Dup extends ByteArg {
  op: Opcodes.dup;
}

// new dictionary
export interface Newd extends Argless {
  op: Opcodes.newd;
}

// get module from symbol
export interface Getm extends Argless {
  op: Opcodes.getm;
}

// push Long
export interface Lpush extends LongArg {
  op: Opcodes.lpush;
}

// push Double
export interface Dpush extends DoubleArg {
  op: Opcodes.dpush;
}

export interface Throw extends Argless {
  op: Opcodes.throw;
}

export interface Cpush extends WordArg {
  op: Opcodes.cpush;
}

// new byte array
export interface Newba extends Argless {
  op: Opcodes.newba;
}

// report the number of args to the current function
export interface Argc extends ByteArg {
  op: Opcodes.argc;
}

export type Bytecode =
  | Nop
  | Incsp
  | Popv
  | Addv
  | Subv
  | Mulv
  | Divv
  | Andv
  | Orv
  | Modv
  | Shlv
  | Shrv
  | Xorv
  | Getv
  | Putv
  | Invokem
  | Agetv
  | Aputv
  | Lgetv
  | Lputv
  | Newa
  | Newc
  | Return
  | Ret
  | News
  | Goto
  | Eq
  | Lt
  | Lte
  | Gt
  | Gte
  | Ne
  | Isnull
  | Isa
  | Canhazplz
  | Jsr
  | Ts
  | Ipush
  | Fpush
  | Spush
  | Bt
  | Bf
  | Frpush
  | Bpush
  | Npush
  | Invv
  | Dup
  | Newd
  | Getm
  | Lpush
  | Dpush
  | Throw
  | Cpush
  | Argc
  | Newba;

export function parseCode(view: DataView, lineTable: Map<number, LineNumber>) {
  let current = 0;
  const parseOne = (): Bytecode => {
    const offset = current;
    const op = view.getUint8(current++) as Opcodes;
    switch (op) {
      case Opcodes.nop:
      case Opcodes.popv:
      case Opcodes.addv:
      case Opcodes.subv:
      case Opcodes.mulv:
      case Opcodes.divv:
      case Opcodes.andv:
      case Opcodes.orv:
      case Opcodes.modv:
      case Opcodes.xorv:
      case Opcodes.getv:
      case Opcodes.putv:
      case Opcodes.agetv:
      case Opcodes.aputv:
      case Opcodes.newc:
      case Opcodes.return:
      case Opcodes.ret:
      case Opcodes.eq:
      case Opcodes.lt:
      case Opcodes.lte:
      case Opcodes.gt:
      case Opcodes.gte:
      case Opcodes.ne:
        return { op, offset, size: 1 };
      case Opcodes.frpush:
      case Opcodes.canhazplz:
      case Opcodes.isa:
      case Opcodes.npush:
      case Opcodes.isnull:
      case Opcodes.invv:
      case Opcodes.getm:
      case Opcodes.throw:
      case Opcodes.newa:
      case Opcodes.newba:
      case Opcodes.newd:
      case Opcodes.shlv:
      case Opcodes.shrv:
        return { op, offset, size: 1 };

      case Opcodes.incsp:
      case Opcodes.invokem:
      case Opcodes.lgetv:
      case Opcodes.lputv:
      case Opcodes.bpush:
      case Opcodes.dup:
      case Opcodes.argc:
        return { op, arg: view.getUint8(current++), offset, size: 2 };
      case Opcodes.goto:
      case Opcodes.jsr:
      case Opcodes.bt:
      case Opcodes.bf:
        return {
          op,
          arg: offset + view.getInt16((current += 2) - 2) + 3,
          offset,
          size: 3,
        };
      case Opcodes.news:
      case Opcodes.ipush:
      case Opcodes.spush:
      case Opcodes.cpush:
        return { op, arg: view.getInt32((current += 4) - 4), offset, size: 5 };
      case Opcodes.lpush:
        return {
          op,
          arg: view.getBigInt64((current += 8) - 8),
          offset,
          size: 9,
        };
      case Opcodes.fpush:
        return {
          op,
          arg: view.getFloat32((current += 4) - 4),
          offset,
          size: 5,
        };
      case Opcodes.dpush:
        return {
          op,
          arg: view.getFloat64((current += 8) - 8),
          offset,
          size: 9,
        };
      case Opcodes.ts:
        throw new Error(`Unknown opcode ${op}`);
      default:
        unhandledType(op);
    }
  };
  const results: Bytecode[] = [];
  while (current < view.byteLength) {
    const nextOp = parseOne();
    const lineNum = lineTable.get(nextOp.offset | 0x10000000);
    if (lineNum) {
      nextOp.lineNum = lineNum;
    }
    results.push(nextOp);
  }
  results.push({ op: Opcodes.nop, size: 1, offset: current });
  return results;
}

export function opcodeSize(op: Opcodes) {
  switch (op) {
    case Opcodes.nop:
    case Opcodes.popv:
    case Opcodes.addv:
    case Opcodes.subv:
    case Opcodes.mulv:
    case Opcodes.divv:
    case Opcodes.andv:
    case Opcodes.orv:
    case Opcodes.modv:
    case Opcodes.xorv:
    case Opcodes.getv:
    case Opcodes.putv:
    case Opcodes.agetv:
    case Opcodes.aputv:
    case Opcodes.newc:
    case Opcodes.return:
    case Opcodes.ret:
    case Opcodes.eq:
    case Opcodes.lt:
    case Opcodes.lte:
    case Opcodes.gt:
    case Opcodes.gte:
    case Opcodes.ne:
    case Opcodes.frpush:
    case Opcodes.canhazplz:
    case Opcodes.isa:
    case Opcodes.npush:
    case Opcodes.isnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.throw:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
      return 1;
    case Opcodes.incsp:
    case Opcodes.invokem:
    case Opcodes.lgetv:
    case Opcodes.lputv:
    case Opcodes.bpush:
    case Opcodes.dup:
    case Opcodes.argc:
    case Opcodes.shlv:
    case Opcodes.shrv:
      return 2;
    case Opcodes.goto:
    case Opcodes.jsr:
    case Opcodes.bt:
    case Opcodes.bf:
      return 3;
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.fpush:
      return 5;
    case Opcodes.lpush:
    case Opcodes.dpush:
      return 9;
    case Opcodes.ts:
      throw new Error(`Unknown opcode ${op}`);
    default:
      unhandledType(op);
  }
}

export function emitBytecode(
  bytecode: Bytecode,
  view: DataView,
  offset: number,
  linktable: Map<number, number>,
  shift_hack: boolean
) {
  view.setUint8(offset++, bytecode.op);
  if (bytecode.arg == null) {
    if (
      shift_hack &&
      (bytecode.op === Opcodes.shlv || bytecode.op === Opcodes.shrv)
    ) {
      view.setUint8(offset++, Opcodes.nop);
    }
    return offset;
  }
  switch (bytecode.op) {
    case Opcodes.incsp:
    case Opcodes.invokem:
    case Opcodes.lgetv:
    case Opcodes.lputv:
    case Opcodes.bpush:
    case Opcodes.dup:
    case Opcodes.argc:
      view.setUint8(offset++, bytecode.arg);
      break;
    case Opcodes.goto:
    case Opcodes.jsr:
    case Opcodes.bt:
    case Opcodes.bf:
      linktable.set(offset, bytecode.arg);
      view.setInt16((offset += 2) - 2, 0);
      break;
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.spush:
    case Opcodes.cpush:
      view.setInt32((offset += 4) - 4, bytecode.arg);
      break;
    case Opcodes.lpush:
      view.setBigInt64((offset += 8) - 8, bytecode.arg);
      break;
    case Opcodes.fpush:
      view.setFloat32((offset += 4) - 4, bytecode.arg);
      break;
    case Opcodes.dpush:
      view.setFloat64((offset += 8) - 8, bytecode.arg);
      break;
    default:
      unhandledType(bytecode);
  }
  return offset;
}

export function getOpInfo(bytecode: Bytecode) {
  switch (bytecode.op) {
    case Opcodes.nop:
    case Opcodes.ret:
    case Opcodes.incsp:
    case Opcodes.argc:
    case Opcodes.goto:
    case Opcodes.jsr:
      return { pop: 0, push: 0 };
    case Opcodes.popv:
    case Opcodes.return:
    case Opcodes.throw:
    case Opcodes.bt:
    case Opcodes.bf:
    case Opcodes.lputv:
      return { pop: 1, push: 0 };
    case Opcodes.addv:
    case Opcodes.subv:
    case Opcodes.mulv:
    case Opcodes.divv:
    case Opcodes.andv:
    case Opcodes.orv:
    case Opcodes.modv:
    case Opcodes.shlv:
    case Opcodes.shrv:
    case Opcodes.xorv:
    case Opcodes.eq:
    case Opcodes.lt:
    case Opcodes.lte:
    case Opcodes.gt:
    case Opcodes.gte:
    case Opcodes.ne:
    case Opcodes.canhazplz:
    case Opcodes.isa:
      return { pop: 2, push: 1 };
    case Opcodes.getv: // thing, symbol
    case Opcodes.agetv: // array, index
      return { pop: 2, push: 1 };
    case Opcodes.putv: // thing, symbol, value
    case Opcodes.aputv: // array, index, value
      return { pop: 3, push: 0 };
    case Opcodes.newc:
    case Opcodes.isnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
      return { pop: 1, push: 1 };
    case Opcodes.frpush:
    case Opcodes.npush:
    case Opcodes.bpush:
    case Opcodes.lgetv:
    case Opcodes.dup:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.fpush:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.lpush:
    case Opcodes.dpush:
      return { pop: 0, push: 1 };

    case Opcodes.invokem:
      return { pop: bytecode.arg + 1, push: 1 };

    case Opcodes.ts:
      throw new Error(`Unknown opcode ${bytecode.op}`);
    default:
      unhandledType(bytecode);
  }
}

export const enum Effects {
  None = 0,
  Local = 1,
  Global = 2,
  ArrayLike = 4,
  Call = 8,
}

export function getOpEffects(bytecode: Bytecode) {
  switch (bytecode.op) {
    case Opcodes.lputv:
      return Effects.Local;
    case Opcodes.putv:
      return Effects.Global;
    case Opcodes.aputv:
      return Effects.ArrayLike;
    case Opcodes.newc:
      // calls the class <init> method, which can write to members - but only
      // members of the newly created class, so maybe we don't need this.
      return Effects.Global | Effects.ArrayLike;
    case Opcodes.invokem:
      return Effects.Call | Effects.Global | Effects.ArrayLike;

    case Opcodes.nop:
    case Opcodes.ret:
    case Opcodes.incsp:
    case Opcodes.argc:
    case Opcodes.goto:
    case Opcodes.jsr:
    case Opcodes.popv:
    case Opcodes.return:
    case Opcodes.throw:
    case Opcodes.bt:
    case Opcodes.bf:
    case Opcodes.addv:
    case Opcodes.subv:
    case Opcodes.mulv:
    case Opcodes.divv:
    case Opcodes.andv:
    case Opcodes.orv:
    case Opcodes.modv:
    case Opcodes.shlv:
    case Opcodes.shrv:
    case Opcodes.xorv:
    case Opcodes.eq:
    case Opcodes.lt:
    case Opcodes.lte:
    case Opcodes.gt:
    case Opcodes.gte:
    case Opcodes.ne:
    case Opcodes.canhazplz:
    case Opcodes.isa:
    case Opcodes.getv:
    case Opcodes.agetv:
    case Opcodes.isnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
    case Opcodes.frpush:
    case Opcodes.npush:
    case Opcodes.bpush:
    case Opcodes.lgetv:
    case Opcodes.dup:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.fpush:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.lpush:
    case Opcodes.dpush:
      return Effects.None;
    case Opcodes.ts:
      throw new Error(`Unknown opcode ${bytecode.op}`);
    default:
      unhandledType(bytecode);
  }
}

export function isBoolOp(op: Opcodes) {
  switch (op) {
    case Opcodes.isnull:
    case Opcodes.eq:
    case Opcodes.ne:
    case Opcodes.lt:
    case Opcodes.lte:
    case Opcodes.gt:
    case Opcodes.gte:
    case Opcodes.isa:
    case Opcodes.canhazplz:
      return true;
  }
  return false;
}

export function isCondBranch(op: Opcodes) {
  switch (op) {
    case Opcodes.bt:
    case Opcodes.bf:
      return true;
  }
  return false;
}
