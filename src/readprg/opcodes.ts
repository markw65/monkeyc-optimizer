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
  ipushz,
  ipush1, // ArgumentType.ARGUMENT_NUMBER),
  ipush2, // ArgumentType.ARGUMENT_NUMBER),
  ipush3, // ArgumentType.ARGUMENT_NUMBER),
  fpushz,
  lpushz,
  dpushz,
  btpush,
  bfpush,
  apush, // ArgumentType.ARGUMENT_LABEL),
  bapush, // ArgumentType.ARGUMENT_LABEL),
  hpush, // ArgumentType.ARGUMENT_LABEL),
  getselfv, // ArgumentType.ARGUMENT_SYMBOL),
  getself,
  getmv, // ArgumentType.ARGUMENT_SYMBOL, ArgumentType.ARGUMENT_SYMBOL),
  getlocalv, // ArgumentType.ARGUMENT_NUMBER, ArgumentType.ARGUMENT_SYMBOL),
  getsv, // ArgumentType.ARGUMENT_SYMBOL),
  invokemz,
  aputvdup,
  argcincsp, // ArgumentType.ARGUMENT_NUMBER, ArgumentType.ARGUMENT_NUMBER),
  isnotnull,
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

export interface ThreeByteArg extends BaseOpcode {
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

export interface Getselfv extends WordArg {
  op: Opcodes.getselfv;
}

export interface Putv extends Argless {
  op: Opcodes.putv;
}

export interface Invokem extends ByteArg {
  op: Opcodes.invokem;
}

export interface Invokemz extends Argless {
  op: Opcodes.invokemz;
}

export interface Agetv extends Argless {
  op: Opcodes.agetv;
}

export interface Aputv extends Argless {
  op: Opcodes.aputv;
}

export interface Aputvdup extends Argless {
  op: Opcodes.aputvdup;
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

export interface Getself extends Argless {
  op: Opcodes.getself;
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

export interface Apush extends WordArg {
  op: Opcodes.apush;
}

export interface Bapush extends WordArg {
  op: Opcodes.bapush;
}

export interface Hpush extends WordArg {
  op: Opcodes.hpush;
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

export interface Isnotnull extends Argless {
  op: Opcodes.isnotnull;
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

export interface Ipushz extends Argless {
  op: Opcodes.ipushz;
}

export interface Ipush1 extends ByteArg {
  op: Opcodes.ipush1;
}

export interface Ipush2 extends ShortArg {
  op: Opcodes.ipush2;
}

export interface Ipush3 extends ThreeByteArg {
  op: Opcodes.ipush3;
}

// push Float
export interface Fpush extends FloatArg {
  op: Opcodes.fpush;
}

export interface Fpushz extends Argless {
  op: Opcodes.fpushz;
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

export interface Btpush extends Argless {
  op: Opcodes.btpush;
}

export interface Bfpush extends Argless {
  op: Opcodes.bfpush;
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

export interface Getmv extends BaseOpcode {
  op: Opcodes.getmv;
  arg: { module: number; var: number };
}

export interface Getlocalv extends BaseOpcode {
  op: Opcodes.getlocalv;
  arg: { local: number; var: number };
  range?: LocalRange;
}

export interface Getsv extends WordArg {
  op: Opcodes.getsv;
}

// push Long
export interface Lpush extends LongArg {
  op: Opcodes.lpush;
}

export interface Lpushz extends Argless {
  op: Opcodes.lpushz;
}

// push Double
export interface Dpush extends DoubleArg {
  op: Opcodes.dpush;
}

export interface Dpushz extends Argless {
  op: Opcodes.dpushz;
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

export interface Argcincsp extends BaseOpcode {
  op: Opcodes.argcincsp;
  arg: { argc: number; incsp: number };
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
  | Newba
  | Ipushz
  | Ipush1
  | Ipush2
  | Ipush3
  | Fpushz
  | Lpushz
  | Dpushz
  | Btpush
  | Bfpush
  | Apush
  | Bapush
  | Hpush
  | Getselfv // lgetv 0; spush sym; getv
  | Getself // lgetv 0
  | Getmv // spush m; getm; spush v; getv
  | Getlocalv // lgetv loc; spush v; getv
  | Getsv // spush s; getv
  | Invokemz
  | Aputvdup
  | Argcincsp
  | Isnotnull;

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
      case Opcodes.ipushz:
      case Opcodes.fpushz:
      case Opcodes.lpushz:
      case Opcodes.dpushz:
      case Opcodes.invokemz:
      case Opcodes.btpush:
      case Opcodes.bfpush:
      case Opcodes.getself:
      case Opcodes.aputvdup:
      case Opcodes.isnotnull:
        return { op, offset, size: 1 };

      case Opcodes.incsp:
      case Opcodes.invokem:
      case Opcodes.lgetv:
      case Opcodes.lputv:
      case Opcodes.bpush:
      case Opcodes.dup:
      case Opcodes.argc:
      case Opcodes.ipush1:
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
      case Opcodes.ipush2:
        return {
          op,
          arg: view.getInt16((current += 2) - 2),
          offset,
          size: 3,
        };
      case Opcodes.ipush3:
        return {
          op,
          arg: view.getInt32((current += 3) - 3) >> 8,
          offset,
          size: 4,
        };
      case Opcodes.news:
      case Opcodes.apush:
      case Opcodes.bapush:
      case Opcodes.hpush:
      case Opcodes.ipush:
      case Opcodes.spush:
      case Opcodes.cpush:
      case Opcodes.getsv:
      case Opcodes.getselfv:
        return { op, arg: view.getInt32((current += 4) - 4), offset, size: 5 };
      case Opcodes.getmv:
        return {
          op,
          arg: {
            module: view.getInt32((current += 4) - 4),
            var: view.getInt32((current += 4) - 4),
          },
          offset,
          size: 9,
        };
      case Opcodes.getlocalv:
        return {
          op,
          arg: {
            local: view.getUint8(current++),
            var: view.getInt32((current += 4) - 4),
          },
          offset,
          size: 6,
        };
      case Opcodes.argcincsp:
        return {
          op,
          arg: {
            argc: view.getUint8(current++),
            incsp: view.getUint8(current++),
          },
          offset,
          size: 3,
        };

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
    case Opcodes.ipushz:
    case Opcodes.fpushz:
    case Opcodes.lpushz:
    case Opcodes.dpushz:
    case Opcodes.invokemz:
    case Opcodes.btpush:
    case Opcodes.bfpush:
    case Opcodes.getself:
    case Opcodes.aputvdup:
    case Opcodes.isnotnull:
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
    case Opcodes.ipush1:
      return 2;
    case Opcodes.goto:
    case Opcodes.jsr:
    case Opcodes.bt:
    case Opcodes.bf:
    case Opcodes.ipush2:
    case Opcodes.argcincsp:
      return 3;
    case Opcodes.ipush3:
      return 4;
    case Opcodes.apush:
    case Opcodes.bapush:
    case Opcodes.hpush:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.fpush:
    case Opcodes.getsv:
    case Opcodes.getselfv:
      return 5;
    case Opcodes.getlocalv:
      return 6;
    case Opcodes.lpush:
    case Opcodes.dpush:
    case Opcodes.getmv:
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
    case Opcodes.ipush1:
      view.setUint8(offset++, bytecode.arg);
      break;
    case Opcodes.goto:
    case Opcodes.jsr:
    case Opcodes.bt:
    case Opcodes.bf:
      linktable.set(offset, bytecode.arg);
      view.setInt16((offset += 2) - 2, 0);
      break;
    case Opcodes.ipush2:
      view.setInt16((offset += 2) - 2, bytecode.arg);
      break;
    case Opcodes.ipush3:
      view.setInt32((offset += 3) - 3, bytecode.arg << 8);
      break;
    case Opcodes.apush:
    case Opcodes.bapush:
    case Opcodes.hpush:
    case Opcodes.getselfv:
    case Opcodes.getsv:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.spush:
    case Opcodes.cpush: {
      view.setInt32((offset += 4) - 4, bytecode.arg);
      break;
    }
    case Opcodes.getmv:
      view.setInt32((offset += 4) - 4, bytecode.arg.module);
      view.setInt32((offset += 4) - 4, bytecode.arg.var);
      break;
    case Opcodes.getlocalv:
      view.setUint8(offset++, bytecode.arg.local);
      view.setInt32((offset += 4) - 4, bytecode.arg.var);
      break;
    case Opcodes.argcincsp:
      view.setUint8(offset++, bytecode.arg.argc);
      view.setUint8(offset++, bytecode.arg.incsp);
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
    case Opcodes.argcincsp:
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
    case Opcodes.aputvdup: // array, index, value => array
      return { pop: 3, push: 1 };
    case Opcodes.newc:
    case Opcodes.isnull:
    case Opcodes.isnotnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
    case Opcodes.getsv:
      return { pop: 1, push: 1 };
    case Opcodes.apush:
    case Opcodes.bapush:
    case Opcodes.hpush:
    case Opcodes.getselfv:
    case Opcodes.getself:
    case Opcodes.getmv:
    case Opcodes.getlocalv:
    case Opcodes.frpush:
    case Opcodes.npush:
    case Opcodes.bpush:
    case Opcodes.btpush:
    case Opcodes.bfpush:
    case Opcodes.lgetv:
    case Opcodes.dup:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.ipushz:
    case Opcodes.ipush1:
    case Opcodes.ipush2:
    case Opcodes.ipush3:
    case Opcodes.fpush:
    case Opcodes.fpushz:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.lpush:
    case Opcodes.lpushz:
    case Opcodes.dpush:
    case Opcodes.dpushz:
      return { pop: 0, push: 1 };

    case Opcodes.invokemz:
      return { pop: 1, push: 1 };
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
    case Opcodes.aputvdup:
      return Effects.ArrayLike;
    case Opcodes.newc:
      // calls the class <init> method, which can write to members - but only
      // members of the newly created class, so maybe we don't need this.
      return Effects.Global | Effects.ArrayLike;
    case Opcodes.invokem:
    case Opcodes.invokemz:
      return Effects.Call | Effects.Global | Effects.ArrayLike;
    case Opcodes.getv:
    case Opcodes.getselfv:
    case Opcodes.getmv:
    case Opcodes.getlocalv:
    case Opcodes.getsv:
    case Opcodes.agetv:
      // these all read global state, and some read local state
      // we might need to track that later
      return Effects.None;
    case Opcodes.lgetv:
      // reads local state
      return Effects.None;
    case Opcodes.nop:
    case Opcodes.ret:
    case Opcodes.incsp:
    case Opcodes.argc:
    case Opcodes.argcincsp:
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
    case Opcodes.getself:
    case Opcodes.isnull:
    case Opcodes.isnotnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
    case Opcodes.frpush:
    case Opcodes.npush:
    case Opcodes.apush:
    case Opcodes.bapush:
    case Opcodes.hpush:
    case Opcodes.bpush:
    case Opcodes.btpush:
    case Opcodes.bfpush:
    case Opcodes.dup:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.ipushz:
    case Opcodes.ipush1:
    case Opcodes.ipush2:
    case Opcodes.ipush3:
    case Opcodes.fpush:
    case Opcodes.fpushz:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.lpush:
    case Opcodes.lpushz:
    case Opcodes.dpush:
    case Opcodes.dpushz:
      return Effects.None;
    case Opcodes.ts:
      throw new Error(`Unknown opcode ${bytecode.op}`);
    default:
      unhandledType(bytecode);
  }
}

export function opReadsLocal(bytecode: Bytecode) {
  switch (bytecode.op) {
    case Opcodes.getselfv:
    case Opcodes.getself:
    case Opcodes.frpush:
      return 0;
    case Opcodes.getlocalv:
      return bytecode.arg.local;
    case Opcodes.lgetv:
      return bytecode.arg;

    case Opcodes.lputv:
    case Opcodes.putv:
    case Opcodes.aputv:
    case Opcodes.aputvdup:
    case Opcodes.newc:
    case Opcodes.invokem:
    case Opcodes.invokemz:
    case Opcodes.getv:
    case Opcodes.getmv:
    case Opcodes.getsv:
    case Opcodes.agetv:
    case Opcodes.nop:
    case Opcodes.ret:
    case Opcodes.incsp:
    case Opcodes.argc:
    case Opcodes.argcincsp:
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
    case Opcodes.isnull:
    case Opcodes.isnotnull:
    case Opcodes.invv:
    case Opcodes.getm:
    case Opcodes.newa:
    case Opcodes.newba:
    case Opcodes.newd:
    case Opcodes.npush:
    case Opcodes.apush:
    case Opcodes.bapush:
    case Opcodes.hpush:
    case Opcodes.bpush:
    case Opcodes.btpush:
    case Opcodes.bfpush:
    case Opcodes.dup:
    case Opcodes.news:
    case Opcodes.ipush:
    case Opcodes.ipushz:
    case Opcodes.ipush1:
    case Opcodes.ipush2:
    case Opcodes.ipush3:
    case Opcodes.fpush:
    case Opcodes.fpushz:
    case Opcodes.spush:
    case Opcodes.cpush:
    case Opcodes.lpush:
    case Opcodes.lpushz:
    case Opcodes.dpush:
    case Opcodes.dpushz:
      return null;
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
