import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { FunctionStateNode } from "src/optimizer-types";
import { diagnostic, formatAst, getSuperClasses, hasProperty } from "../api";
import { reduce, some } from "../util";
import { InterpStackElem, InterpState, roundToFloat } from "./interp";
import { subtypeOf } from "./sub-type";
import {
  cloneType,
  display,
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
  args: ExactOrUnion[]
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
    istate.typeChecker &&
      diagnostic(
        istate.state,
        node,
        `'${formatAst(node.callee)}' is not callable`,
        istate.checkTypes
      );
    return { value: { type: TypeTag.Any }, node, embeddedEffects: true };
  }
  return checkCallArgs(istate, node, callee.value, args);
}

export function checkCallArgs(
  istate: InterpState,
  node: mctree.CallExpression,
  callees: FunctionStateNode | FunctionStateNode[],
  args: ExactOrUnion[]
) {
  return reduce(
    callees,
    (result, cur) => {
      const checker = istate.typeChecker;
      let argTypes: ExactOrUnion[] | null = null;
      let returnType: ExactOrUnion | null = null;
      let effects = true;
      let argEffects = true;
      if (node.callee.type === "MemberExpression") {
        const object = istate.typeMap?.get(node.callee.object) || {
          type: TypeTag.Any,
        };
        const info = sysCallInfo(cur);
        if (info) {
          const result = info(cur, object, () => args);
          if (result.argTypes) argTypes = result.argTypes;
          if (result.returnType) returnType = result.returnType;
          if (result.effectFree) effects = false;
          if (!result.argEffects) argEffects = false;
        }
      }
      if (cur.info === false) {
        argEffects = false;
      }
      if (checker && (cur === callees || !isOverride(cur, callees))) {
        const expectedArgs = (argTypes || cur.node.params).length;
        if (args.length !== expectedArgs) {
          diagnostic(
            istate.state,
            node,
            `${cur.fullName} expects ${expectedArgs} arguments, but got ${args.length}`,
            istate.checkTypes
          );
        }
        args.forEach((arg, i) => {
          let paramType;
          if (argTypes) {
            paramType = argTypes[i];
            if (!paramType) return;
          } else {
            const param = cur.node.params[i];
            if (param?.type !== "BinaryExpression") return;
            paramType = typeFromTypespec(istate.state, param.right, cur.stack);
          }
          if (checker(arg, paramType)) {
            if (
              istate.state.config?.covarianceWarnings &&
              effects &&
              argEffects
            ) {
              if (arg.type & TypeTag.Array) {
                const atype = getUnionComponent(arg, TypeTag.Array);
                if (atype) {
                  const ptype = getUnionComponent(paramType, TypeTag.Array);
                  if (!ptype || !subtypeOf(ptype, atype)) {
                    diagnostic(
                      istate.state,
                      node.arguments[i],
                      `Argument ${i + 1} to ${
                        cur.fullName
                      }: passing Array<${display(atype)}> to parameter Array${
                        ptype ? `<${display(ptype)}>` : ""
                      } is not type safe`,
                      istate.checkTypes
                    );
                  }
                }
              }
              if (arg.type & TypeTag.Dictionary) {
                const adata = getUnionComponent(arg, TypeTag.Dictionary);
                if (adata) {
                  const pdata = getUnionComponent(
                    paramType,
                    TypeTag.Dictionary
                  );
                  if (
                    !pdata ||
                    !subtypeOf(pdata.key, adata.key) ||
                    !subtypeOf(pdata.value, adata.value)
                  ) {
                    diagnostic(
                      istate.state,
                      node.arguments[i],
                      `Argument ${i + 1} to ${
                        cur.fullName
                      }: passing Dictionary<${display(adata.key)}, ${display(
                        adata.value
                      )}> to parameter Dictionary${
                        pdata
                          ? `<${display(pdata.key)}, ${display(pdata.value)}>`
                          : ""
                      } is not type safe`,
                      istate.checkTypes
                    );
                  }
                }
              }
            }
            return;
          }
          diagnostic(
            istate.state,
            node.arguments[i],
            `Argument ${i + 1} to ${cur.fullName} expected to be ${display(
              paramType
            )} but got ${display(arg)}`,
            istate.checkTypes
          );
        });
      }
      if (!returnType) {
        if (cur.node.returnType) {
          returnType = typeFromTypespec(
            istate.state,
            cur.node.returnType.argument,
            cur.stack
          );
        }
      }
      if (returnType) {
        unionInto(result.value, returnType);
      } else {
        result.value.type = TypeTag.Any;
        delete result.value.value;
      }
      if (effects) result.embeddedEffects = true;
      return result;
    },
    {
      value: { type: TypeTag.Never },
      node,
      embeddedEffects: false,
    } as InterpStackElem
  );
}

function isOverride(
  cur: FunctionStateNode,
  funcs: FunctionStateNode | FunctionStateNode[]
) {
  const cls = cur.stack?.[cur.stack.length - 1];
  if (cls?.type === "ClassDeclaration" && cls.superClasses) {
    const supers = getSuperClasses(cls);
    if (
      supers &&
      some(funcs, (func) => {
        if (func === cur) return false;
        const fcls = func.stack?.[func.stack.length - 1];
        return fcls ? supers.has(fcls) : false;
      })
    ) {
      return true;
    }
  }
  return false;
}

type SysCallHelperResult = {
  calleeObj?: ExactOrUnion;
  returnType?: ExactOrUnion;
  argTypes?: ExactOrUnion[];
  effectFree?: true;
  argEffects?: true;
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
  const methodInvoke: SysCallHelper = (
    callee: FunctionStateNode,
    calleeObj: ExactOrUnion,
    getArgs: () => Array<ExactOrUnion>
  ) => {
    const ret: SysCallHelperResult = { argEffects: true };
    if (calleeObj.type & TypeTag.Method) {
      const data = getUnionComponent(calleeObj, TypeTag.Method);
      if (data) {
        ret.returnType = data.result;
        ret.argTypes = data.args;
        return ret;
      }
    }
    ret.argTypes = getArgs();
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
    "$.Toybox.Lang.Method.invoke": methodInvoke,

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
