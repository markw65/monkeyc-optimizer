import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  formatAst,
  getApiFunctionInfo,
  getApiMapping,
  hasProperty,
  isLookupCandidate,
  isStateNode,
  markInvokeClassMethod,
  variableDeclarationName,
  visitReferences,
} from "./api";
import { cloneDeep, getNodeValue, traverseAst, withLoc } from "./ast";
import {
  findCallees,
  findCalleesForNew,
  recordCalledFuncs,
  recordModifiedDecls,
  recordModifiedName,
  recordModifiedUnknown,
} from "./function-info";
import {
  diagnostic,
  inlinableSubExpression,
  InlineContext,
  inlineFunction,
  shouldInline,
  unused,
} from "./inliner";
import { JungleResourceMap } from "./jungles";
import {
  BuildConfig,
  ClassStateNode,
  FilesToOptimizeMap,
  FunctionStateNode,
  LookupDefinition,
  ModuleStateNode,
  ProgramState,
  ProgramStateAnalysis,
  ProgramStateOptimizer,
  StateNodeAttributes,
} from "./optimizer-types";
import { pragmaChecker } from "./pragma-checker";
import { sizeBasedPRE } from "./pre";
import { xmlUtil } from "./sdk-util";
import { cleanupUnusedVars } from "./unused-exprs";
import { pushUnique } from "./util";
import { renameVariable } from "./variable-renamer";

function collectClassInfo(state: ProgramStateAnalysis) {
  const toybox = state.stack[0].decls!["Toybox"][0] as ModuleStateNode;
  const lang = toybox.decls!["Lang"][0] as ModuleStateNode;
  const object = lang.decls!["Object"] as ClassStateNode[];
  state.allClasses.forEach((elm) => {
    if (elm.stack![elm.stack!.length - 1].type === "ClassDeclaration") {
      // nested classes don't get access to their contained
      // context. Put them in the global scope instead.
      elm.stack = elm.stack!.slice(0, 1);
    }
    if (elm.node.superClass) {
      const [name, lookupDefns] = state.lookup(
        elm.node.superClass,
        null,
        elm.stack
      );
      const superClass =
        lookupDefns &&
        lookupDefns
          .map((lookupDefn) => lookupDefn.results)
          .flat()
          .filter(
            (c): c is ClassStateNode =>
              isStateNode(c) && c.type === "ClassDeclaration"
          );
      // set it "true" if there is a superClass, but we can't find it.
      elm.superClass = superClass && superClass.length ? superClass : true;
      if (name && elm.superClass !== true) {
        /*
         * The runtime behavior of monkeyc is strange. Lookups
         * of the name of the superclass, either bare, or via self.<name>
         * always find the superclass, even if there's a member variable
         * or method of the same name. So its ok to just overwrite
         * elm.decls[name] here.
         *
         * ie
         *
         * class A { function foo() as Number { return 1; } }
         * class B { function foo() as String { return "B"; } }
         * class C extends A {
         *   var A as B = new B();
         *   function initialize() {
         *     A.initialize(); // class A's initialize
         *     A.foo(); // returns 1
         *     self.A.foo(); // still returns 1
         *   }
         * }
         *
         * The typechecker seems to get confused in some circumstances
         * though (ie it doesn't always use the same rules)
         */
        if (!elm.decls) elm.decls = {};
        elm.decls[name] = elm.superClass;
      }
    } else if (elm !== object[0]) {
      elm.superClass = object;
    }
  });

  const markOverrides = (
    cls: ClassStateNode,
    scls: ClassStateNode[] | true
  ) => {
    if (scls === true) return;
    scls.forEach((c) => {
      c.decls &&
        Object.values(c.decls).forEach((funcs) => {
          funcs.forEach((f) => {
            if (
              f.type === "FunctionDeclaration" &&
              hasProperty(cls.decls, f.name)
            ) {
              f.node.hasOverride = true;
            }
          });
        });
      if (c.superClass) markOverrides(cls, c.superClass);
    });
  };

  state.allClasses.forEach((elm) => {
    if (elm.superClass) markOverrides(elm, elm.superClass);
    if (elm.hasInvoke && elm.decls) {
      Object.values(elm.decls).forEach((funcs) => {
        funcs.forEach((f) => {
          if (
            f.type === "FunctionDeclaration" &&
            !(f.attributes & StateNodeAttributes.STATIC)
          ) {
            markInvokeClassMethod(f);
          }
        });
      });
    }
  });
}

export function getFileSources(fnMap: FilesToOptimizeMap) {
  return Promise.all(
    Object.entries(fnMap).map(([name, value]) => {
      return (
        value.monkeyCSource ||
        fs
          .readFile(name)
          .then(
            (data) =>
              (value.monkeyCSource = data.toString().replace(/\r\n/g, "\n"))
          )
      );
    })
  ).then(() => {
    return;
  });
}

export function getFileASTs(fnMap: FilesToOptimizeMap) {
  return getFileSources(fnMap).then(() =>
    Object.entries(fnMap).reduce((ok, [name, value]) => {
      if (!value.ast) {
        try {
          value.ast = MonkeyC.parsers.monkeyc.parse(
            value.monkeyCSource!,
            null,
            {
              filepath: name,
            }
          ) as mctree.Program;
        } catch (e) {
          ok = false;
          if (e instanceof Error) {
            value.parserError = e;
          } else {
            value.parserError = new Error("An unknown parser error occurred");
          }
        }
      }
      return ok;
    }, true)
  );
}

export async function analyze(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document,
  config: BuildConfig
) {
  let hasTests = false;
  let markApi = true;
  const preState: ProgramState = {
    fnMap,
    config,
    allFunctions: {},
    allClasses: [],
    shouldExclude(node: mctree.Node) {
      if (
        "attrs" in node &&
        node.attrs &&
        "attributes" in node.attrs &&
        node.attrs.attributes &&
        node.loc?.source
      ) {
        const excludeAnnotations = fnMap[node.loc.source].excludeAnnotations;
        if (excludeAnnotations) {
          return node.attrs.attributes.elements.reduce(
            (drop: boolean, attr) => {
              if (attr.type != "UnaryExpression") return drop;
              if (attr.argument.type != "Identifier") return drop;
              if (hasProperty(excludeAnnotations, attr.argument.name)) {
                return true;
              }
              if (attr.argument.name == "test") {
                hasTests = true;
              }
              return drop;
            },
            false
          );
        }
      }
      return false;
    },
    pre(node, state) {
      switch (node.type) {
        case "FunctionDeclaration":
        case "ModuleDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          scope.stack = state.stackClone().slice(0, -1);
          if (scope.type == "FunctionDeclaration") {
            if (markApi) {
              node.body = null;
              scope.info = getApiFunctionInfo(scope);
              delete scope.stack;
            }
            const allFuncs = state.allFunctions!;
            if (!hasProperty(allFuncs, scope.name)) {
              allFuncs[scope.name] = [scope];
            } else {
              allFuncs[scope.name].push(scope);
            }
          } else if (scope.type === "ClassDeclaration") {
            state.allClasses!.push(scope as ClassStateNode);
          }
          break;
        }
      }
      return null;
    },
  };

  await getApiMapping(preState, resourcesMap, manifestXML);
  markApi = false;

  const state = preState as ProgramStateAnalysis;

  await getFileASTs(fnMap);
  Object.entries(fnMap).forEach(([name, value]) => {
    const { ast, parserError } = value;
    if (!ast) {
      throw parserError || new Error(`Failed to parse ${name}`);
    }
    hasTests = false;
    collectNamespaces(ast, state);
    value.hasTests = hasTests;
  });

  delete state.shouldExclude;
  delete state.pre;

  collectClassInfo(state);

  state.exposed = state.nextExposed;
  state.nextExposed = {};
  return state;
}

export function reportMissingSymbols(
  state: ProgramStateAnalysis,
  config?: BuildConfig
) {
  const diagnosticType =
    config?.checkInvalidSymbols !== "OFF"
      ? config?.checkInvalidSymbols || "WARNING"
      : null;
  const compiler2DiagnosticType =
    config?.checkCompilerLookupRules !== "OFF"
      ? config?.checkCompilerLookupRules || "WARNING"
      : null;
  if (
    diagnosticType &&
    !config?.compilerOptions?.includes("--Eno-invalid-symbol")
  ) {
    const checkTypes =
      config?.typeCheckLevel && config.typeCheckLevel !== "Off";
    const report = (ast: mctree.Program) => {
      visitReferences(state, ast, null, false, (node, results, error) => {
        if (node.type === "BinaryExpression" && node.operator === "has") {
          // Its not an error to check whether a property exists...
          return undefined;
        }
        if (!error) {
          if (
            state.sdkVersion === 4001006 &&
            compiler2DiagnosticType &&
            node.type === "MemberExpression" &&
            (node.object.type === "Identifier" ||
              node.object.type === "MemberExpression") &&
            results.some((result) => {
              const parent = result.parent;
              if (!parent || parent.type !== "ClassDeclaration") {
                return false;
              }
              return result.results.some((sn) => {
                switch (sn.type) {
                  case "VariableDeclarator":
                  case "FunctionDeclaration":
                    return (
                      sn.attributes &
                      (StateNodeAttributes.PRIVATE |
                        StateNodeAttributes.PROTECTED)
                    );
                }
                return false;
              });
            })
          ) {
            diagnostic(
              state,
              node.loc,
              `The expression ${formatAst(
                node
              )} will fail at runtime using sdk-4.1.6`,
              compiler2DiagnosticType
            );
          }
          return undefined;
        }
        let nodeStr;
        if (state.inType) {
          if (!checkTypes || (nodeStr = formatAst(node)).match(/^Void|Null$/)) {
            return undefined;
          }
        }
        diagnostic(
          state,
          node.loc,
          `Undefined symbol ${nodeStr || formatAst(node)}`,
          diagnosticType
        );
        return false;
      });
    };
    Object.values(state.fnMap).forEach((v) => v.ast && report(v.ast));
    state.rezAst && report(state.rezAst);
  }
}

function compareLiteralLike(a: mctree.Node, b: mctree.Node) {
  while (a.type === "BinaryExpression") a = a.left;
  while (b.type === "BinaryExpression") b = b.left;

  return a.type === "Literal" && b.type === "Literal" && a.value === b.value;
}

export function getLiteralFromDecls(lookupDefns: LookupDefinition[]) {
  if (!lookupDefns.length) return null;
  let result: null | mctree.Literal | mctree.AsExpression = null;
  if (
    lookupDefns.every((lookupDefn) =>
      lookupDefn.results.every((d) => {
        if (
          d.type === "EnumStringMember" ||
          (d.type === "VariableDeclarator" && d.node.kind === "const")
        ) {
          const init = getLiteralNode(
            d.type === "EnumStringMember" ? d.init : d.node.init
          );
          if (!init) return false;
          if (!result) {
            result = init;
            return true;
          } else {
            return compareLiteralLike(init, result);
          }
        }
        return false;
      })
    )
  ) {
    return result as null | mctree.Literal | mctree.AsExpression;
  }
  return null;
}

export function getLiteralNode(
  node: mctree.Node | null | undefined
): null | mctree.Literal | mctree.AsExpression {
  if (node == null) return null;
  if (node.type == "Literal") return node;
  if (node.type == "BinaryExpression" && node.operator == "as") {
    return getLiteralNode(node.left) && node;
  }
  if (node.type == "UnaryExpression") {
    if (node.argument.type != "Literal") return null;
    switch (node.operator) {
      case "-": {
        const [arg, type] = getNodeValue(node.argument);
        if (type === "Number" || type === "Long") {
          return replacementLiteral(node, -arg.value, type);
        }
      }
    }
  }
  return null;
}

function fullTypeName(state: ProgramStateAnalysis, tsp: mctree.TypeSpecPart) {
  if (typeof tsp.name === "string") {
    return tsp.name;
  }
  const [, results] = state.lookupType(tsp.name);
  if (results && results.length === 1 && results[0].results.length === 1) {
    const result = results[0].results[0];
    if (isStateNode(result)) {
      return result.fullName;
    }
  }
  return null;
}

function isBooleanExpression(
  state: ProgramStateAnalysis,
  node: mctree.Node
): boolean {
  switch (node.type) {
    case "Literal":
      return typeof node.value === "boolean";
    case "BinaryExpression":
      switch (node.operator) {
        case "==":
        case "!=":
        case "<=":
        case ">=":
        case "<":
        case ">":
          return true;
        case "as":
          return node.right.ts.length === 1 &&
            node.right.ts[0].type === "TypeSpecPart" &&
            node.right.ts[0].name &&
            fullTypeName(state, node.right.ts[0]) === "$.Toybox.Lang.Boolean"
            ? true
            : false;
      }
      return false;
    case "LogicalExpression":
      return (
        isBooleanExpression(state, node.left) &&
        isBooleanExpression(state, node.right)
      );
    case "UnaryExpression":
      return node.operator === "!" && isBooleanExpression(state, node.argument);
  }
  return false;
}

type MCLiteralTypes =
  | "Number"
  | "Long"
  | "Boolean"
  | "Float"
  | "Double"
  | "String"
  | "Char"
  | "Null";

type LiteralArg = mctree.Literal["value"];

function roundToFloat(value: number) {
  return new Float32Array([value as number])[0];
}

function replacementLiteral(
  arg: mctree.Node,
  value: bigint | number | boolean | string | null,
  type: MCLiteralTypes
): mctree.Literal {
  if (value === null) {
    type = "Null";
  } else if (typeof value === "boolean") {
    type = "Boolean";
  } else if (type === "Number") {
    value = Number(BigInt.asIntN(32, BigInt(value)));
  } else if (type === "Long") {
    value = BigInt.asIntN(64, BigInt(value));
  } else if (type === "Float") {
    value = roundToFloat(Number(value));
  }
  let raw =
    type === "String"
      ? JSON.stringify(value)
      : type === "Char"
      ? value === "'"
        ? "'\\''"
        : "'" + JSON.stringify(value).slice(1, -1) + "'"
      : value == null
      ? "null"
      : value.toString();
  if (type === "Long") {
    raw += "l";
  } else if (type === "Double") {
    raw += "d";
  } else if (type === "Float" && LiteralIntegerRe.test(raw)) {
    raw += "f";
  }
  const { start, end, loc } = arg;
  return {
    type: "Literal",
    value,
    raw,
    start,
    end,
    loc,
  };
}

type OpDesc = [MCLiteralTypes, (a: LiteralArg) => LiteralArg];
type OpInfo = {
  typeFn: (left: MCLiteralTypes, right: MCLiteralTypes) => OpDesc | null;
  valueFn: (left: LiteralArg, right: LiteralArg) => LiteralArg;
};

function classify(arg: MCLiteralTypes) {
  switch (arg) {
    case "Number":
      return { big: false, int: true };
    case "Long":
      return { big: true, int: true };
    case "Float":
      return { big: false, int: false };
    case "Double":
      return { big: true, int: false };
  }
  return null;
}

function common_arith_types(
  left: MCLiteralTypes,
  right: MCLiteralTypes
): OpDesc | null {
  const l = classify(left);
  if (!l) return null;
  const r = classify(right);
  if (!r) return null;
  if (l.big || r.big) {
    return l.int && r.int
      ? ["Long", (v: LiteralArg) => BigInt.asIntN(64, BigInt(v!))]
      : ["Double", (v: LiteralArg) => Number(v)];
  } else {
    return l.int && r.int
      ? ["Number", (v: LiteralArg) => BigInt.asIntN(32, BigInt(v!))]
      : ["Float", (v: LiteralArg) => roundToFloat(Number(v))];
  }
}

function common_bitwise_types(
  left: MCLiteralTypes,
  right: MCLiteralTypes
): OpDesc | null {
  if (left === "Boolean" && right === "Boolean") {
    return ["Boolean", (v: LiteralArg) => (v ? true : false)];
  }
  const l = classify(left);
  if (!l) return null;
  const r = classify(right);
  if (!r) return null;
  if (!l.int || !r.int) return null;
  return l.big || r.big
    ? ["Long", (v: LiteralArg) => BigInt.asIntN(64, BigInt(v!))]
    : ["Number", (v: LiteralArg) => Number(BigInt.asIntN(32, BigInt(v!)))];
}

function plus_types(
  left: MCLiteralTypes,
  right: MCLiteralTypes
): OpDesc | null {
  if (left === "String" || right === "String") {
    // Boolean + String is an error, and
    // Float/Double + String is legal, but its hard to predict
    // the way the float will be formatted (and it won't match
    // what javascript would do by default)
    if (/Float|Double|Boolean/.test(left + right)) {
      return null;
    }
    return ["String", String];
  }
  if (left === "Char" || right === "Char") {
    if (left === right) {
      // adding two chars produces a string
      return ["String", String];
    }
    if (/Number|Long/.test(left + right)) {
      return ["Char", (v: LiteralArg) => v];
    }
  }
  return common_arith_types(left, right);
}

function shift_mod_types(left: MCLiteralTypes, right: MCLiteralTypes) {
  const result = common_bitwise_types(left, right);
  if (result && result[0] === "Boolean") {
    return null;
  }
  return result;
}

function equalsFn(left: LiteralArg, right: LiteralArg) {
  const lt = typeof left;
  const rt = typeof right;
  return lt === "string" || rt === "string"
    ? // two string literals will compare unequal, becuase string
      // equality is object equality.
      false
    : (lt === "number" || lt === "bigint") &&
      (rt === "number" || rt === "bigint")
    ? // numeric types are compared for value equality
      left == right
    : // otherwise types and values must match
      left === right;
}

const operators: Record<
  mctree.BinaryOperator | "as" | "instanceof",
  OpInfo | null
> = {
  "+": {
    typeFn: plus_types,
    valueFn: (left, right) =>
      typeof left === "string" && typeof right !== "string"
        ? String.fromCharCode(left.charCodeAt(0) + Number(right))
        : typeof left !== "string" && typeof right === "string"
        ? String.fromCharCode(right.charCodeAt(0) + Number(left))
        : (left as number) + (right as number),
  },
  "-": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) - (right as number),
  },
  "*": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) * (right as number),
  },
  "/": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) / (right as number),
  },
  "%": {
    typeFn: shift_mod_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) % (right as number),
  },
  "&": {
    typeFn: common_bitwise_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) & (right as number),
  },
  "|": {
    typeFn: common_bitwise_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) | (right as number),
  },
  "^": {
    typeFn: common_bitwise_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) ^ (right as number),
  },
  "<<": {
    typeFn: shift_mod_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      typeof right === "bigint"
        ? (left as bigint) << (right as bigint & 127n)
        : (left as number) << (right as number & 63),
  },
  ">>": {
    typeFn: shift_mod_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      typeof right === "bigint"
        ? (left as bigint) >> (right as bigint & 127n)
        : (left as number) >> (right as number & 63),
  },
  "==": {
    typeFn: () => ["Boolean", (v: LiteralArg) => v],
    valueFn: equalsFn,
  },
  "!=": {
    typeFn: () => ["Boolean", (v: LiteralArg) => v],
    valueFn: (left, right) => !equalsFn(left, right),
  },
  "<=": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) <= (right as number),
  },
  ">=": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) >= (right as number),
  },
  "<": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) < (right as number),
  },
  ">": {
    typeFn: common_arith_types,
    valueFn: (left: LiteralArg, right: LiteralArg) =>
      (left as number) > (right as number),
  },
  as: null,
  instanceof: null,
  has: null,
};

function optimizeNode(state: ProgramStateAnalysis, node: mctree.Node) {
  switch (node.type) {
    case "UnaryExpression": {
      const [arg, type] = getNodeValue(node.argument);
      if (arg === null) break;
      switch (node.operator) {
        case "+":
          if (
            type === "Number" ||
            type === "Long" ||
            type === "Float" ||
            type === "Double" ||
            type === "Char" ||
            type === "String"
          ) {
            return arg;
          }
          break;
        case "-":
          if (
            type === "Number" ||
            type === "Long" ||
            type === "Float" ||
            type === "Double"
          ) {
            return replacementLiteral(node, -arg.value, type);
          }
          break;
        case "!":
        case "~":
          {
            if (type === "Number" || type === "Long") {
              return replacementLiteral(node, ~BigInt(arg.value), type);
            }

            if (type === "Boolean" && node.operator == "!") {
              return replacementLiteral(node, !arg.value, type);
            }
          }
          break;
      }
      break;
    }
    case "BinaryExpression": {
      const op = operators[node.operator];
      if (op) {
        const [left, left_type] = getNodeValue(node.left);
        const [right, right_type] = getNodeValue(node.right);
        if (!left || !right) break;
        const type = op.typeFn(left_type, right_type);
        if (!type) break;
        const value = op.valueFn(type[1](left.value), type[1](right.value));
        if (value === null) break;
        return replacementLiteral(node, value, type[0]);
      }
      break;
    }
    case "LogicalExpression": {
      const [left, left_type] = getNodeValue(node.left);
      if (!left) break;
      const falsy =
        left.value === false ||
        left.value === null ||
        ((left_type === "Number" || left_type === "Long") &&
          (left.value === 0 || left.value === 0n));
      if (falsy === (node.operator === "&&" || node.operator === "and")) {
        return left;
      }
      if (
        left_type !== "Boolean" &&
        left_type !== "Number" &&
        left_type !== "Long"
      ) {
        break;
      }
      const [right, right_type] = getNodeValue(node.right);
      if (right && right_type === left_type) {
        if (
          left_type === "Boolean" ||
          node.operator === "||" ||
          node.operator === "or"
        ) {
          return right;
        }
        if (node.operator !== "&&" && node.operator !== "and") {
          throw new Error(`Unexpected operator "${node.operator}"`);
        }
        return { ...node, type: "BinaryExpression", operator: "&" } as const;
      }
      if (left_type === "Boolean") {
        if (isBooleanExpression(state, node.right)) {
          return node.right;
        }
      }
      break;
    }
    case "FunctionDeclaration":
      if (node.body && evaluateFunction(state, node, null) !== false) {
        node.optimizable = true;
      }
      break;
  }
  return null;
}

function evaluateFunction(
  state: ProgramStateAnalysis,
  func: mctree.FunctionDeclaration,
  args: mctree.Node[] | null
) {
  if (!func.body || (args && args.length != func.params.length)) {
    return false;
  }
  const paramValues =
    args &&
    Object.fromEntries(
      func.params.map((p, i) => [variableDeclarationName(p), args[i]])
    );
  let ret: mctree.Node | null = null;
  const body = args ? cloneDeep(func.body) : func.body;
  try {
    traverseAst(
      body,
      (node) => {
        switch (node.type) {
          case "BlockStatement":
          case "ReturnStatement":
          case "UnaryExpression":
          case "BinaryExpression":
          case "Literal":
          case "Identifier":
            return;
          default:
            throw new Error("Bad node type");
        }
      },
      !args
        ? undefined
        : (node) => {
            switch (node.type) {
              case "ReturnStatement":
                ret = node.argument || null;
                return null;
              case "BlockStatement":
              case "Literal":
                return null;
              case "Identifier":
                if (hasProperty(paramValues, node.name)) {
                  return paramValues[node.name];
                }
              // fall through;
              default: {
                const repl = optimizeNode(state, node);
                if (repl && repl.type === "Literal") return repl;
                throw new Error("Didn't optimize");
              }
            }
          }
    );
    return ret;
  } catch (e) {
    return false;
  }
}

type MCTreeSome = { [k in keyof mctree.NodeAll]?: unknown };

function markFunctionCalled(
  state: ProgramStateOptimizer,
  func: mctree.FunctionDeclaration
) {
  if (!hasProperty(state.calledFunctions, func.id.name)) {
    state.calledFunctions[func.id.name] = [func];
    return;
  }
  pushUnique(state.calledFunctions[func.id.name], func);
}

export async function optimizeMonkeyC(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document,
  config: BuildConfig
) {
  const state = (await analyze(
    fnMap,
    resourcesMap,
    manifestXML,
    config
  )) as ProgramStateOptimizer;
  state.localsStack = [{}];
  state.calledFunctions = {};
  state.usedByName = {};

  const replace = (
    node: mctree.Node | false | null,
    old: mctree.Node
  ): mctree.Node | mctree.Node[] | false | null => {
    if (node === false || node === null) return node;
    const rep = state.traverse(node);
    if (rep === false || Array.isArray(rep)) return rep;
    return { ...(rep || node), loc: old.loc, start: old.start, end: old.end };
  };

  const inPlaceReplacement = (node: MCTreeSome, obj: MCTreeSome) => {
    const { start, end, loc } = node;
    for (const k of Object.keys(node)) {
      delete node[k as keyof MCTreeSome];
    }
    if (obj.enumType) {
      obj = {
        type: "BinaryExpression",
        operator: "as",
        left: { ...obj, start, end, loc },
        right: { type: "TypeSpecList", ts: [obj.enumType] },
      };
    }
    for (const [k, v] of Object.entries(obj)) {
      node[k as keyof MCTreeSome] = v;
    }
    node.loc = loc;
    node.start = start;
    node.end = end;
  };
  const lookupAndReplace = (node: mctree.Node) => {
    const [, objects] = state.lookup(node);
    if (!objects) {
      return false;
    }
    let obj = getLiteralFromDecls(objects);
    if (!obj) {
      return false;
    }
    while (obj.type === "BinaryExpression") {
      if (obj.left.type === "BinaryExpression" && obj.left.operator === "as") {
        obj = { ...obj, left: obj.left.left };
      } else {
        obj = { ...obj, left: { ...obj.left } };
        break;
      }
    }
    inPlaceReplacement(node, obj);
    return true;
  };

  const topLocals = () => state.localsStack[state.localsStack.length - 1];
  /*
   * Might this function be called from somewhere, including
   * callbacks from the api (eg getSettingsView, etc).
   */
  const maybeCalled = (func: mctree.FunctionDeclaration) => {
    if (!func.body) {
      // this is an api.mir function. It can be called
      return true;
    }
    if (hasProperty(state.exposed, func.id.name)) return true;
    if (
      func.attrs &&
      func.attrs.attributes &&
      func.attrs.attributes.elements.some((attr) => {
        if (attr.type != "UnaryExpression") return false;
        if (attr.argument.type != "Identifier") return false;
        return attr.argument.name == "test";
      })
    ) {
      return true;
    }

    if (hasProperty(state.calledFunctions, func.id.name)) {
      return (
        state.calledFunctions[func.id.name].find((f) => f === func) !== null
      );
    }

    return false;
  };
  /*
   * Does elm (a class) have a maybeCalled function called name,
   * anywhere in its superClass chain.
   */
  const checkInherited = (elm: ClassStateNode, name: string): boolean =>
    elm.superClass === true ||
    (elm.superClass != null &&
      elm.superClass.some(
        (sc) =>
          (hasProperty(sc.decls, name) &&
            sc.decls[name].some(
              (f) =>
                isStateNode(f) &&
                f.type == "FunctionDeclaration" &&
                maybeCalled(f.node)
            )) ||
          (sc.superClass && checkInherited(sc, name))
      ));

  const renamer = (
    idnode: mctree.TypedIdentifier | mctree.InstanceofIdentifier
  ) => {
    const ident = idnode.type === "Identifier" ? idnode : idnode.left;
    const locals = topLocals();
    const { map } = locals;
    if (map) {
      const declName = ident.name;
      const name = renameVariable(state, locals, declName);
      if (name) {
        const [, results] = state.lookupValue(ident);
        if (!results) {
          throw new Error(
            `Didn't find local ${declName} which needed renaming`
          );
        }
        if (results.length !== 1) {
          throw new Error(
            `Lookup of local ${declName} found more than one result`
          );
        }
        const parent = results[0].parent;
        if (!parent) {
          throw new Error(`No parent in lookup of local ${declName}`);
        }
        const decls = parent.decls;
        if (!decls || !hasProperty(decls, declName)) {
          throw new Error(`Missing decls in lookup of local ${declName}`);
        }
        if (hasProperty(decls, name)) {
          throw new Error(
            `While renaming ${declName} to ${name}, there was already a variable ${name}`
          );
        }
        if (decls[declName].length === 1) {
          decls[name] = decls[declName];
          delete decls[declName];
        } else {
          let i = decls[declName].length;
          while (i--) {
            const decl = decls[declName][i];
            if (
              decl === idnode ||
              (decl.type === "VariableDeclarator" && decl.node.id === idnode)
            ) {
              decls[declName].splice(i, 1);
              decls[name] = [decl];
              break;
            }
          }
          if (i < 0) {
            throw new Error(
              `While renaming ${declName} to ${name}: Didn't find original declaration`
            );
          }
        }
        ident.name = name;
      } else {
        map[declName] = true;
      }
    }
  };

  state.pre = (node) => {
    switch (node.type) {
      case "ConditionalExpression":
      case "IfStatement":
      case "DoWhileStatement":
      case "WhileStatement": {
        const test = (state.traverse(node.test) ||
          node.test) as typeof node.test;
        const [value, type] = getNodeValue(test);
        if (value) {
          let result = null;
          if (type === "Null") {
            result = false;
          } else if (
            type === "Boolean" ||
            type === "Number" ||
            type === "Long"
          ) {
            result = !!value.value;
          }
          if (result !== null) {
            node.test = {
              type: "Literal",
              value: result,
              raw: result.toString(),
            };
            if (
              node.type === "IfStatement" ||
              node.type === "ConditionalExpression"
            ) {
              return [result ? "consequent" : "alternate"];
            } else if (node.type === "WhileStatement") {
              return result === false ? [] : ["body"];
            } else if (node.type === "DoWhileStatement") {
              return ["body"];
            } else {
              throw new Error("Unexpected Node type");
            }
          }
        }
        return null;
      }
      case "EnumDeclaration":
        return [];
      case "ForStatement": {
        const map = topLocals().map;
        if (map) {
          state.localsStack.push({ node, map: { ...map } });
        }
        break;
      }
      case "VariableDeclarator": {
        renamer(node.id);
        return ["init"];
      }
      case "CatchClause":
        if (node.param) {
          state.localsStack.push({ node, map: { ...(topLocals().map || {}) } });
          renamer(node.param);
          return ["body"];
        }
        break;
      case "BinaryExpression":
        if (node.operator === "has") {
          if (
            node.right.type === "UnaryExpression" &&
            node.right.operator === ":"
          ) {
            // Using `expr has :symbol` doesn't "expose"
            // symbol. So skip the right operand.
            return ["left"];
          }
        }
        break;
      case "UnaryExpression":
        if (node.operator == ":") {
          // node.argument is not a normal identifier.
          // don't visit it.
          return [];
        }
        break;
      case "Identifier": {
        const map = topLocals().map;
        if (map) {
          if (hasProperty(map, node.name)) {
            const name = map[node.name];
            if (typeof name === "string") {
              node.name = name;
            }
            const [, results] = state.lookupValue(node);
            if (results) {
              if (results.length !== 1 || results[0].results.length !== 1) {
                throw new Error(
                  `Local ${node.name} had multiple lookup results`
                );
              }
              const parent = results[0].parent;
              if (!parent) {
                throw new Error(`Local ${node.name} had no parent`);
              }
              const decl = results[0].results[0];
              if (
                parent.type === "FunctionDeclaration" ||
                decl.type !== "VariableDeclarator"
              ) {
                // we can't optimize away function or catch parameters
                return [];
              }
              if (parent.type !== "BlockStatement") {
                throw new Error(
                  `Local ${node.name} was not declared at block scope(??)`
                );
              }
              decl.used = true;
            }
          }
        }
        if (hasProperty(state.index, node.name)) {
          if (!lookupAndReplace(node)) {
            state.usedByName[node.name] = true;
          }
        }
        return [];
      }
      case "MemberExpression": {
        const property = isLookupCandidate(node);
        if (property) {
          if (hasProperty(state.index, property.name)) {
            if (lookupAndReplace(node)) {
              return false;
            } else {
              state.usedByName[property.name] = true;
            }
          }
          // Don't optimize the property.
          return ["object"];
        }
        break;
      }
      case "AssignmentExpression":
      case "UpdateExpression": {
        const lhs =
          node.type === "AssignmentExpression" ? node.left : node.argument;
        if (lhs.type === "Identifier") {
          const map = topLocals().map;
          if (map) {
            if (hasProperty(map, lhs.name)) {
              const name = map[lhs.name];
              if (typeof name === "string") {
                lhs.name = name;
              }
            }
          }
        } else if (lhs.type === "MemberExpression") {
          state.traverse(lhs.object);
          if (lhs.computed) {
            state.traverse(lhs.property);
          }
        }
        return node.type === "AssignmentExpression" ? ["right"] : [];
      }
      case "BlockStatement": {
        const map = topLocals().map;
        if (map) {
          state.localsStack.push({
            node,
            map: { ...map },
          });
        }
        break;
      }
      case "FunctionDeclaration": {
        const map: Record<string, string | true> = {};
        node.params &&
          node.params.forEach((p) => (map[variableDeclarationName(p)] = true));
        state.localsStack.push({ node, map });
        const [parent, self] = state.stack.slice(-2);
        if (state.currentFunction) {
          throw new Error(
            `Nested functions: ${self.fullName} was activated during processing of ${state.currentFunction.fullName}`
          );
        }
        state.currentFunction = self as FunctionStateNode;
        if (parent.type == "ClassDeclaration" && !maybeCalled(node)) {
          let used = false;
          if (node.id.name == "initialize") {
            used = true;
          } else if (parent.superClass) {
            used = checkInherited(parent, node.id.name);
          }
          if (used) {
            markFunctionCalled(state, node);
          }
        }
      }
    }
    return null;
  };
  state.post = (node) => {
    const locals = topLocals();
    if (locals.node === node) {
      state.localsStack.pop();
    }
    const opt = optimizeNode(state, node);
    if (opt) {
      return replace(opt, node);
    }
    switch (node.type) {
      case "FunctionDeclaration":
        if (!state.currentFunction) {
          throw new Error(
            `Finished function ${
              state.stack.slice(-1)[0].fullName
            }, but it was not marked current`
          );
        }
        state.currentFunction.info = state.currentFunction.next_info;
        delete state.currentFunction.next_info;
        delete state.currentFunction;
        break;
      case "BlockStatement":
        if (node.body.length === 1 && node.body[0].type === "BlockStatement") {
          node.body.splice(0, 1, ...node.body[0].body);
        }
      // fall through
      case "ForStatement":
        if (locals.map) {
          cleanupUnusedVars(state, node);
        }
        break;

      case "ConditionalExpression":
      case "IfStatement":
        if (
          node.test.type === "Literal" &&
          typeof node.test.value === "boolean"
        ) {
          const rep = node.test.value ? node.consequent : node.alternate;
          if (!rep) return false;
          return replace(rep, rep);
        } else if (node.type === "IfStatement") {
          if (
            node.alternate &&
            node.alternate.type === "BlockStatement" &&
            !node.alternate.body.length
          ) {
            delete node.alternate;
          } else {
            const call = inlinableSubExpression(node.test);
            if (call) {
              return replace(optimizeCall(state, call, node), node.test);
            }
          }
        }
        break;
      case "WhileStatement":
        if (node.test.type === "Literal" && node.test.value === false) {
          return false;
        }
        break;
      case "DoWhileStatement":
        if (node.test.type === "Literal" && node.test.value === false) {
          return node.body;
        }
        break;

      case "ReturnStatement":
        if (node.argument && node.argument.type === "CallExpression") {
          return replace(
            optimizeCall(state, node.argument, node),
            node.argument
          );
        }
        break;

      case "BinaryExpression":
        if (
          node.operator === "has" &&
          node.right.type === "UnaryExpression" &&
          node.right.operator === ":"
        ) {
          const [, results] = state.lookup(node.left);
          if (
            results &&
            results.length === 1 &&
            results[0].results.length === 1
          ) {
            const obj = results[0].results[0];
            if (
              (obj.type === "ModuleDeclaration" ||
                obj.type === "Program" ||
                obj.type === "ClassDeclaration") &&
              obj.stack
            ) {
              const exists =
                hasProperty(obj.decls, node.right.argument.name) ||
                // This is overkill, since we've already looked up
                // node.left, but the actual lookup rules are complicated,
                // and embedded within state.lookup; so just defer to that.
                state.lookup({
                  type: "MemberExpression",
                  object: node.left,
                  property: node.right.argument,
                  computed: false,
                })[1];
              if (!exists) {
                return replace(
                  { type: "Literal", value: false, raw: "false" },
                  node
                );
              }
            }
          }
        }
        break;
      case "NewExpression":
        if (state.currentFunction) {
          const [, results] = state.lookup(node.callee);
          if (results) {
            recordCalledFuncs(
              state.currentFunction,
              findCalleesForNew(results)
            );
          } else {
            recordModifiedUnknown(state.currentFunction);
          }
        }
        break;

      case "CallExpression": {
        return replace(optimizeCall(state, node, null), node);
      }

      case "VariableDeclaration": {
        const locals = topLocals();
        if (
          locals.map &&
          locals.node &&
          locals.node.type === "BlockStatement"
        ) {
          let results: mctree.Statement[] | undefined;
          const declarations = node.declarations;
          let i = 0;
          let j = 0;
          while (i < node.declarations.length) {
            const decl = declarations[i++];
            if (!decl.init) continue;
            const call = inlinableSubExpression(decl.init);
            if (call) {
              const inlined = replace(
                optimizeCall(state, call, decl),
                decl.init
              );
              if (!inlined) continue;
              if (Array.isArray(inlined) || inlined.type != "BlockStatement") {
                throw new Error("Unexpected inlined result");
              }
              if (!results) {
                results = [];
              }
              delete decl.init;
              results.push(
                withLoc(
                  {
                    ...node,
                    declarations: declarations.slice(j, i),
                  },
                  j ? declarations[j] : null,
                  decl.id
                )
              );
              results.push(inlined);
              j = i;
            }
          }
          if (results) {
            if (j < i) {
              results.push({
                ...node,
                declarations: declarations.slice(j, i),
              });
            }
            return results;
          }
        }
        break;
      }

      case "ExpressionStatement":
        if (node.expression.type === "CallExpression") {
          return replace(
            optimizeCall(state, node.expression, node),
            node.expression
          );
        } else if (node.expression.type === "AssignmentExpression") {
          const call = inlinableSubExpression(node.expression.right);
          if (call) {
            let ok = false;
            if (node.expression.left.type === "Identifier") {
              if (hasProperty(topLocals().map, node.expression.left.type)) {
                ok = true;
              }
            }
            if (!ok && node.expression.operator == "=") {
              const [, result] = state.lookup(node.expression.left);
              ok = !!result;
            }
            if (ok) {
              return replace(
                optimizeCall(state, call, node.expression),
                node.expression.right
              );
            }
          }
        } else {
          const ret = unused(state, node.expression, true);
          if (ret) {
            return ret
              .map((r) => replace(r, r))
              .flat(1)
              .filter((s): s is Exclude<typeof s, false | null> => !!s);
          }
        }
        break;
      case "AssignmentExpression":
        if (
          node.operator === "=" &&
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          node.left.name === node.right.name
        ) {
          return { type: "Literal", value: null, raw: "null" };
        }
      // fall through;
      case "UpdateExpression":
        if (state.currentFunction) {
          const lhs =
            node.type === "AssignmentExpression" ? node.left : node.argument;
          const [, results] = state.lookup(lhs);
          if (results) {
            recordModifiedDecls(state.currentFunction, results);
          } else {
            const id = lhs.type === "Identifier" ? lhs : isLookupCandidate(lhs);
            if (id) {
              recordModifiedName(state.currentFunction, id.name);
            } else {
              recordModifiedUnknown(state.currentFunction);
            }
          }
        }
        break;
    }
    return null;
  };
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });
  state.calledFunctions = {};
  state.exposed = state.nextExposed;
  state.nextExposed = {};
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });
  state.exposed = state.nextExposed;
  state.nextExposed = {};
  delete state.pre;
  delete state.post;
  Object.values(state.allFunctions).forEach((fns) =>
    fns.forEach((fn) => sizeBasedPRE(state, fn))
  );

  const cleanup = (node: mctree.Node) => {
    switch (node.type) {
      case "ThisExpression":
        node.text = "self";
        break;
      case "EnumStringBody":
        if (
          node.members.every((m) => {
            const name = "name" in m ? m.name : m.id.name;
            return (
              hasProperty(state.index, name) &&
              !hasProperty(state.exposed, name) &&
              !hasProperty(state.usedByName, name)
            );
          })
        ) {
          node.enumType = [
            ...new Set(
              node.members.map((m) => {
                if (!("init" in m)) return "Number";
                const [node, type] = getNodeValue(m.init);
                if (!node) {
                  throw new Error("Failed to get type for eliminated enum");
                }
                return type;
              })
            ),
          ].join(" or ");
          node.members.splice(0);
        }
        break;
      case "EnumDeclaration":
        if (!node.body.members.length) {
          if (!node.id) return false;
          if (!node.body.enumType) {
            throw new Error("Missing enumType on optimized enum");
          }
          return {
            type: "TypedefDeclaration",
            id: node.id,
            ts: {
              type: "UnaryExpression",
              argument: {
                type: "TypeSpecList",
                ts: [
                  node.body.enumType,
                ] as unknown as mctree.TypeSpecList["ts"],
              },
              prefix: true,
              operator: " as",
            },
          } as const;
        }
        break;
      case "VariableDeclaration": {
        node.declarations = node.declarations.filter((d) => {
          const name = variableDeclarationName(d.id);
          return (
            !hasProperty(state.index, name) ||
            hasProperty(state.exposed, name) ||
            hasProperty(state.usedByName, name)
          );
        });
        if (!node.declarations.length) {
          return false;
        }
        break;
      }
      case "ClassElement":
        if (!node.item) {
          return false;
        }
        break;
      case "FunctionDeclaration":
        if (!maybeCalled(node)) {
          if (
            node.attrs &&
            node.attrs.attributes &&
            node.attrs.attributes.elements.some(
              (attr) =>
                attr.type === "UnaryExpression" && attr.argument.name === "keep"
            )
          ) {
            break;
          }

          return false;
        }
        break;
      case "ClassDeclaration":
      case "ModuleDeclaration":
        // none of the attributes means anything on classes and
        // modules, and the new compiler complains about some
        // of them. Just drop them all.
        if (node.attrs && node.attrs.access) {
          if (node.attrs.attributes) {
            delete node.attrs.access;
          } else {
            delete node.attrs;
          }
        }
    }
    return null;
  };
  Object.entries(fnMap).forEach(([, f]) => {
    traverseAst(f.ast!, undefined, (node) => {
      const ret = cleanup(node);
      if (ret === false) {
        state.removeNodeComments(node, f.ast!);
      }
      return ret;
    });
  });

  reportMissingSymbols(state, config);

  Object.entries(fnMap).forEach(([name, f]) => {
    if (state.config && state.config.checkBuildPragmas) {
      pragmaChecker(state, f.ast!, state.diagnostics?.[name]);
    }
  });

  return state.diagnostics;
}

function optimizeCall(
  state: ProgramStateOptimizer,
  node: mctree.CallExpression,
  context: InlineContext | null
) {
  const [name, results] = state.lookupNonlocal(node.callee);
  const callees = results ? findCallees(results) : null;
  if (!callees || !callees.length) {
    const n =
      name ||
      ("name" in node.callee && node.callee.name) ||
      ("property" in node.callee &&
        node.callee.property &&
        "name" in node.callee.property &&
        node.callee.property.name);
    if (n) {
      if (hasProperty(state.allFunctions, n)) {
        if (state.currentFunction) {
          recordCalledFuncs(state.currentFunction!, state.allFunctions[n]);
        }
        state.allFunctions[n].forEach((fn) =>
          markFunctionCalled(state, fn.node)
        );
      }
    } else if (state.currentFunction) {
      // I don't think this can happen: foo[x](args)
      // doesn't parse, so you can't even do things like
      // $.Toybox.Lang[:format]("fmt", [])
      recordModifiedUnknown(state.currentFunction);
    }
    return null;
  }
  if (state.currentFunction) {
    recordCalledFuncs(state.currentFunction, callees);
  }
  if (callees.length == 1 && callees[0].type === "FunctionDeclaration") {
    const callee = callees[0].node;
    if (
      !context &&
      callee.optimizable &&
      !callee.hasOverride &&
      node.arguments.every((n) => getNodeValue(n)[0] !== null)
    ) {
      const ret = evaluateFunction(state, callee, node.arguments);
      if (ret) {
        return ret;
      }
    }
    if (shouldInline(state, callees[0], node, context)) {
      const ret = inlineFunction(state, callees[0], node, context);
      if (ret) {
        return ret;
      }
    }
  }
  callees.forEach((c) => markFunctionCalled(state, c.node));
  return null;
}
