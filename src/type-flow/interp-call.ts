import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { FunctionStateNode } from "src/optimizer-types";
import { hasProperty } from "../api";
import { reduce } from "../util";
import { InterpStackElem, InterpState, roundToFloat } from "./interp";
import { subtypeOf } from "./sub-type";
import {
  cloneType,
  ExactOrUnion,
  getUnionComponent,
  hasValue,
  isExact,
  setUnionComponent,
  typeFromTypespec,
  typeFromTypeStateNodes,
  TypeTag,
} from "./types";
import { unionInto } from "./union-type";
export function evaluateCall(
  istate: InterpState,
  node: mctree.CallExpression,
  callee: ExactOrUnion,
  _args: ExactOrUnion[]
): InterpStackElem {
  while (!hasValue(callee) || callee.type !== TypeTag.Function) {
    const name =
      node.callee.type === "Identifier"
        ? node.callee
        : node.callee.type === "MemberExpression" && !node.callee.computed
        ? node.callee.property
        : null;
    if (name) {
      const decls = istate.state.allFunctions[name.name];
      if (decls) {
        callee = typeFromTypeStateNodes(istate.state, decls);
        if (hasValue(callee) && callee.type === TypeTag.Function) {
          break;
        }
      }
    }
    return { value: { type: TypeTag.Any }, node, embeddedEffects: true };
  }
  return reduce(
    callee.value,
    (result, cur) => {
      if (cur.node.returnType) {
        const returnType = typeFromTypespec(
          istate.state,
          cur.node.returnType.argument,
          cur.stack
        );
        unionInto(result.value, returnType);
      } else {
        result.value.type = TypeTag.Any;
        delete result.value.value;
      }
      return result;
    },
    {
      value: { type: TypeTag.Never },
      node,
      embeddedEffects: true,
    } as InterpStackElem
  );
}

type SysCallHelperResult = {
  calleeObj?: ExactOrUnion;
  returnType?: ExactOrUnion;
  argTypes?: ExactOrUnion[];
  effectFree?: true;
};

type SysCallHelper = (
  func: FunctionStateNode,
  calleeObj: ExactOrUnion,
  getArgs: () => Array<ExactOrUnion>
) => SysCallHelperResult;

let systemCallInfo: Record<string, SysCallHelper> | null = null;

export function sysCallInfo(func: FunctionStateNode) {
  const info = getSystemCallTable();
  if (hasProperty(info, func.fullName)) {
    return info[func.fullName];
  }
  return null;
}

function getSystemCallTable(): Record<string, SysCallHelper> {
  if (systemCallInfo) return systemCallInfo;

  const arrayAdd: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>
  ) => {
    const ret: SysCallHelperResult = {};
    if (calleeObj.type & TypeTag.Array) {
      const adata = getUnionComponent(calleeObj, TypeTag.Array);
      if (adata) {
        ret.returnType = { type: TypeTag.Array, value: adata };
        const args = getArgs();
        if (args.length === 1) {
          const arg = args[0];
          if (callee.name === "add") {
            if (!subtypeOf(arg, adata)) {
              const newAData = cloneType(adata);
              unionInto(newAData, arg);
              const newObj = cloneType(calleeObj);
              setUnionComponent(newObj, TypeTag.Array, newAData);
              ret.calleeObj = newObj;
              ret.argTypes = [adata];
            }
          } else {
            if (!subtypeOf(arg, ret.returnType)) {
              ret.argTypes = [ret.returnType];
              const newObj = cloneType(calleeObj);
              unionInto(newObj, arg);
              ret.calleeObj = newObj;
            }
          }
        }
      }
    }
    return ret;
  };
  const arrayRet: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    _getArgs: () => Array<ExactOrUnion>
  ) => {
    const ret: SysCallHelperResult = { effectFree: true };
    if (calleeObj.type & TypeTag.Array) {
      const adata = getUnionComponent(calleeObj, TypeTag.Array);
      if (adata) {
        ret.returnType = { type: TypeTag.Array, value: adata };
      }
    }
    return ret;
  };

  const dictionaryGet: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>
  ) => {
    const ret: SysCallHelperResult = { effectFree: true };
    if (calleeObj.type & TypeTag.Dictionary) {
      const ddata = getUnionComponent(calleeObj, TypeTag.Dictionary);
      if (ddata) {
        ret.returnType = ddata.value;
        const args = getArgs();
        if (args.length === 1) {
          ret.argTypes = [ddata.key];
        }
      }
    }
    return ret;
  };
  const dictionaryValues: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion
  ) => {
    const ret: SysCallHelperResult = { effectFree: true };
    if (calleeObj.type & TypeTag.Dictionary) {
      const ddata = getUnionComponent(calleeObj, TypeTag.Dictionary);
      if (ddata) {
        ret.returnType = { type: TypeTag.Array, value: ddata.value };
      }
    }
    return ret;
  };
  const dictionaryKeys: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion
  ) => {
    const ret: SysCallHelperResult = { effectFree: true };
    if (calleeObj.type & TypeTag.Dictionary) {
      const ddata = getUnionComponent(calleeObj, TypeTag.Dictionary);
      if (ddata) {
        ret.returnType = { type: TypeTag.Array, value: ddata.key };
      }
    }
    return ret;
  };
  const dictionaryPut: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>
  ) => {
    const ret: SysCallHelperResult = {};
    if (calleeObj.type & TypeTag.Dictionary) {
      const ddata = getUnionComponent(calleeObj, TypeTag.Dictionary);
      if (ddata) {
        const args = getArgs();
        if (args.length === 2) {
          const key = args[0];
          const value = args[1];
          const stKey = subtypeOf(key, ddata.key);
          const stValue = subtypeOf(value, ddata.value);
          if (!stKey || !stValue) {
            ret.argTypes = [ddata.key, ddata.value];
            const newDData = { ...ddata };
            if (!stKey) {
              newDData.key = cloneType(newDData.key);
              unionInto(newDData.key, key);
            }
            if (!stValue) {
              newDData.value = cloneType(newDData.value);
              unionInto(newDData.value, value);
            }
            const newObj = cloneType(calleeObj);
            setUnionComponent(newObj, TypeTag.Dictionary, newDData);
            ret.calleeObj = newObj;
          }
        }
      }
    }
    return ret;
  };
  const nop: SysCallHelper = () => ({ effectFree: true });
  const mod: SysCallHelper = () => ({});

  const rounder = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>
  ) => {
    const results: SysCallHelperResult = {};
    const fn = Math[callee.name as "ceil" | "round" | "floor"];
    results.effectFree = true;
    const [arg] = getArgs();
    if (hasValue(arg)) {
      if (arg.type === TypeTag.Float || arg.type === TypeTag.Double) {
        arg.value = fn(arg.value);
        if (arg.type === TypeTag.Float) {
          arg.value = roundToFloat(arg.value);
        }
      }
    }
    results.returnType = subtypeOf(arg, { type: TypeTag.Numeric })
      ? arg
      : { type: TypeTag.Numeric };
    return results;
  };
  const mathHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>,
    helper?: string | ((arg1: number, arg2: number) => number)
  ) => {
    const results: SysCallHelperResult = {};
    const fn =
      helper && typeof helper === "function"
        ? helper
        : hasProperty(Math, helper || callee.name) &&
          Math[(helper || callee.name) as keyof typeof Math];
    if (fn && typeof fn === "function") {
      results.effectFree = true;
      const args = getArgs();
      const flags = args.reduce(
        (flags, arg) => {
          if (arg.type & (TypeTag.Long | TypeTag.Double)) {
            if (arg.type & (TypeTag.Number | TypeTag.Float)) {
              flags.mayBeDouble = true;
            } else {
              flags.mustBeDouble = true;
            }
          }
          return flags;
        },
        { mustBeDouble: false, mayBeDouble: false }
      );
      const returnType = {
        type: flags.mustBeDouble
          ? TypeTag.Double
          : flags.mayBeDouble
          ? TypeTag.Decimal
          : TypeTag.Float,
      };
      results.returnType = returnType;
      if (
        isExact(returnType) &&
        args.every((arg) => hasValue(arg) && arg.type & TypeTag.Numeric)
      ) {
        const numericArgs = args.map((arg) => Number(arg.value));
        const result = fn.call(Math, ...numericArgs);
        if (!isNaN(result)) {
          returnType.value = flags.mustBeDouble ? result : roundToFloat(result);
        }
      }
    }

    return results;
  };

  return (systemCallInfo = {
    "$.Toybox.Lang.Array.add": arrayAdd,
    "$.Toybox.Lang.Array.addAll": arrayAdd,
    "$.Toybox.Lang.Array.remove": mod,
    "$.Toybox.Lang.Array.removeAll": mod,
    "$.Toybox.Lang.Array.indexOf": nop,
    "$.Toybox.Lang.Array.reverse": arrayRet,
    "$.Toybox.Lang.Array.size": nop,
    "$.Toybox.Lang.Array.slice": arrayRet,
    "$.Toybox.Lang.Array.toString": nop,

    "$.Toybox.Lang.Dictionary.get": dictionaryGet,
    "$.Toybox.Lang.Dictionary.hasKey": nop,
    "$.Toybox.Lang.Dictionary.isEmpty": nop,
    "$.Toybox.Lang.Dictionary.keys": dictionaryKeys,
    "$.Toybox.Lang.Dictionary.put": dictionaryPut,
    "$.Toybox.Lang.Dictionary.remove": mod,
    "$.Toybox.Lang.Dictionary.size": nop,
    "$.Toybox.Lang.Dictionary.toString": nop,
    "$.Toybox.Lang.Dictionary.values": dictionaryValues,

    "$.Toybox.Math.acos": mathHelper,
    "$.Toybox.Math.asin": mathHelper,
    "$.Toybox.Math.atan": mathHelper,
    "$.Toybox.Math.atan2": mathHelper,
    "$.Toybox.Math.ceil": rounder,
    "$.Toybox.Math.cos": mathHelper,
    "$.Toybox.Math.floor": rounder,
    "$.Toybox.Math.ln": (callee, calleeObj, getArgs) =>
      mathHelper(callee, calleeObj, getArgs, "log"),
    "$.Toybox.Math.log": (callee, calleeObj, getArgs) =>
      mathHelper(
        callee,
        calleeObj,
        getArgs,
        (x, base) => Math.log(x) / Math.log(base)
      ),
    "$.Toybox.Math.pow": mathHelper,
    "$.Toybox.Math.round": rounder,
    "$.Toybox.Math.sin": mathHelper,
    "$.Toybox.Math.sqrt": mathHelper,
    "$.Toybox.Math.tan": mathHelper,

    "$.Toybox.Math.toDegrees": (callee, calleeObj, getArgs) =>
      mathHelper(callee, calleeObj, getArgs, (arg) => (arg * 180) / Math.PI),
    "$.Toybox.Math.toRadians": (callee, calleeObj, getArgs) =>
      mathHelper(callee, calleeObj, getArgs, (arg) => (arg * Math.PI) / 180),
    "$.Toybox.Math.mean": nop,
    "$.Toybox.Math.mode": nop,
    "$.Toybox.Math.stdev": nop,
    "$.Toybox.Math.variance": nop,
    "$.Toybox.Math.srand": mod,
    "$.Toybox.Math.rand": mod,
  });
}
