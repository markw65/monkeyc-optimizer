import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  formatAst,
  getApiMapping,
  hasProperty,
  isStateNode,
  variableDeclarationName,
} from "./api";
import { traverseAst, withLoc } from "./ast";
import {
  diagnostic,
  InlineContext,
  inlineFunction,
  shouldInline,
  unused,
} from "./inliner";
import {
  ProgramStateAnalysis,
  ModuleStateNode,
  ClassStateNode,
  FilesToOptimizeMap,
  BuildConfig,
  ProgramState,
  LookupDefinition,
  ProgramStateOptimizer,
  FunctionStateNode,
} from "./optimizer-types";
import { sizeBasedPRE } from "./pre";
import { pushUnique } from "./util";
import { renameVariable } from "./variable-renamer";
import { visitReferences } from "./visitor";

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
              isStateNode(f) &&
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
  barrelList?: string[],
  config?: BuildConfig
) {
  let hasTests = false;
  let markApi = true;
  const preState: ProgramState = {
    fnMap,
    config,
    allFunctions: [],
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
          if (markApi) {
            node.body = null;
            break;
          }
        // falls through
        case "ModuleDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          scope.stack = state.stackClone().slice(0, -1);
          if (scope.type == "FunctionDeclaration") {
            scope.isStatic =
              scope.stack.slice(-1)[0].type !== "ClassDeclaration" ||
              (scope.node.attrs &&
                scope.node.attrs.access &&
                scope.node.attrs.access.includes("static"));
            state.allFunctions!.push(scope);
          } else if (scope.type === "ClassDeclaration") {
            state.allClasses!.push(scope as ClassStateNode);
          }
          break;
        }
      }
      return null;
    },
  };

  await getApiMapping(preState, barrelList);
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
  delete state.post;

  collectClassInfo(state);

  const diagnosticType =
    config?.checkInvalidSymbols !== "OFF"
      ? config?.checkInvalidSymbols || "WARNING"
      : null;
  if (
    diagnosticType &&
    !config?.compilerOptions?.includes("--Eno-invalid-symbol")
  ) {
    const checkTypes =
      config?.typeCheckLevel && config.typeCheckLevel !== "Off";
    Object.entries(fnMap).forEach(([, v]) => {
      visitReferences(state, v.ast!, null, false, (node, results, error) => {
        if (!error) return undefined;
        const nodeStr = formatAst(node);
        if (state.inType) {
          if (!checkTypes || nodeStr.match(/^Void|Null$/)) {
            return undefined;
          }
        }
        diagnostic(
          state,
          node.loc,
          `Undefined symbol ${nodeStr}`,
          diagnosticType
        );
        return false;
      });
    });
  }

  return state;
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
      case "-":
        if (typeof node.argument.value == "number") {
          return {
            ...node.argument,
            value: -node.argument.value,
            raw: "-" + node.argument.value,
            enumType: node.enumType,
          };
        }
    }
  }
  return null;
}

function getNodeValue(
  node: mctree.Node
): [mctree.Literal | null, string | null] {
  if (
    node.type == "BinaryExpression" &&
    node.operator == "as" &&
    node.right.type == "TypeSpecList" &&
    node.right.ts.length == 1 &&
    typeof node.right.ts[0] == "string"
  ) {
    // this is a cast we inserted to retain the type of an enum
    // any arithmetic on it will revert to "Number", or "Long",
    // so just ignore it.
    return getNodeValue(node.left);
  }
  if (node.type != "Literal") {
    return [null, null];
  }
  let type = node.value === null ? "Null" : typeof node.value;
  if (type === "number") {
    const match = node.raw && LiteralIntegerRe.exec(node.raw);
    if (match) {
      type = match[2] == "l" ? "Long" : "Number";
    } else if (node.raw && node.raw.endsWith("d")) {
      type = "Double";
    } else {
      type = "Float";
    }
  } else if (type === "string") {
    type = "String";
  } else if (type === "boolean") {
    type = "Boolean";
  } else {
    type = "Unknown";
  }
  return [node, type];
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

function optimizeNode(state: ProgramStateAnalysis, node: mctree.Node) {
  switch (node.type) {
    case "UnaryExpression": {
      const [arg, type] = getNodeValue(node.argument);
      if (arg === null) break;
      switch (node.operator) {
        case "+":
          if (type === "Number" || type === "Long") {
            return arg;
          }
          break;
        case "-":
          if (type === "Number" || type === "Long") {
            return {
              ...arg,
              value: -arg.value!,
              raw: (-arg.value!).toString() + (type === "Long" ? "l" : ""),
            };
          }
          break;
        case "!":
        case "~":
          {
            let value;
            if (type === "Number" || type === "Long") {
              value = -arg.value! - 1;
            } else if (type === "Boolean" && node.operator == "!") {
              value = !arg.value;
            }
            if (value !== undefined) {
              return {
                ...arg,
                value,
                raw: value.toString() + (type === "Long" ? "l" : ""),
              };
            }
          }
          break;
      }
      break;
    }
    case "BinaryExpression": {
      const operators = {
        "+": (left: number, right: number) => left + right,
        "-": (left: number, right: number) => left - right,
        "*": (left: number, right: number) => left * right,
        "/": (left: number, right: number) => Math.trunc(left / right),
        "%": (left: number, right: number) => left % right,
        "&": (left: number, right: number, type: string) =>
          type === "Number" ? left & right : null,
        "|": (left: number, right: number, type: string) =>
          type === "Number" ? left | right : null,
        "^": (left: number, right: number, type: string) =>
          type === "Number" ? left ^ right : null,
        "<<": (left: number, right: number, type: string) =>
          type === "Number" ? left << right : null,
        ">>": (left: number, right: number, type: string) =>
          type === "Number" ? left >> right : null,
        "==": (left: mctree.Literal["value"], right: mctree.Literal["value"]) =>
          left == right,
        "!=": (left: mctree.Literal["value"], right: mctree.Literal["value"]) =>
          left != right,
        "<=": (left: number, right: number) => left <= right,
        ">=": (left: number, right: number) => left >= right,
        "<": (left: number, right: number) => left < right,
        ">": (left: number, right: number) => left > right,
        as: null,
        instanceof: null,
        has: null,
      } as const;
      const op = operators[node.operator];
      if (op) {
        const [left, left_type] = getNodeValue(node.left);
        const [right, right_type] = getNodeValue(node.right);
        if (!left || !right) break;
        let value = null;
        if (
          left_type != right_type ||
          (left_type != "Number" && left_type != "Long")
        ) {
          if (node.operator !== "==" && node.operator !== "!=") {
            break;
          }
          value = operators[node.operator](left.value, right.value);
        } else {
          value = op(left.value as number, right.value as number, left_type);
        }
        if (value === null) break;
        return {
          ...left,
          value,
          raw: value.toString() + (left_type === "Long" ? "l" : ""),
        };
      }
      break;
    }
    case "LogicalExpression": {
      const [left, left_type] = getNodeValue(node.left);
      if (!left) break;
      const falsy =
        left.value === false ||
        left.value === null ||
        (left.value === 0 && (left_type === "Number" || left_type === "Long"));
      if (falsy === (node.operator === "&&")) {
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
        if (left_type === "Boolean" || node.operator === "||") {
          return right;
        }
        if (node.operator !== "&&") {
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
  const body = args
    ? (JSON.parse(JSON.stringify(func.body)) as typeof func.body)
    : func.body;
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
  barrelList?: string[],
  config?: BuildConfig
) {
  const state = {
    ...(await analyze(fnMap, barrelList, config)),
    localsStack: [{}],
    exposed: {},
    calledFunctions: {},
  } as ProgramStateOptimizer;

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
            node.test = { type: "Literal", value: result };
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
        return false;
      case "ForStatement": {
        const map = topLocals().map;
        if (map) {
          state.localsStack.push({ node, map: { ...map } });
        }
        break;
      }
      case "VariableDeclarator": {
        const locals = topLocals();
        const { map } = locals;
        if (map) {
          const declName = variableDeclarationName(node.id);
          const name = renameVariable(state, locals, declName);
          if (name) {
            if (node.id.type === "Identifier") {
              node.id.name = name;
            } else {
              node.id.left.name = name;
            }
          } else {
            map[declName] = true;
          }
        }
        return ["init"];
      }
      case "CatchClause":
        if (node.param) {
          state.localsStack.push({ node, map: { ...(topLocals().map || {}) } });
          const locals = topLocals();
          const map = locals.map!;
          const declName = variableDeclarationName(node.param);
          const name = renameVariable(state, locals, declName);
          if (name) {
            if (node.param.type === "Identifier") {
              node.param.name = name;
            } else {
              node.param.left.name = name;
            }
          } else {
            map[declName] = true;
          }
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
          // If we produce a Symbol, for a given name,
          // its possible that someone uses that symbol
          // indirectly, so we can't remove any enums or
          // constants with that name (we can still replace
          // uses of those constants though).
          state.exposed[node.argument.name] = true;
          // In any case, we can't replace *this* use of the
          // symbol with its value...
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
          }
        }
        if (hasProperty(state.index, node.name)) {
          if (!lookupAndReplace(node)) {
            state.exposed[node.name] = true;
          }
        }
        return [];
      }
      case "MemberExpression":
        if (node.property.type === "Identifier" && !node.computed) {
          if (hasProperty(state.index, node.property.name)) {
            if (lookupAndReplace(node)) {
              return false;
            } else {
              state.exposed[node.property.name] = true;
            }
          }
          // Don't optimize the property.
          return ["object"];
        }
        break;
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
        const [parent] = state.stack.slice(-2);
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
      case "BlockStatement":
        if (node.body.length === 1 && node.body[0].type === "BlockStatement") {
          node.body.splice(0, 1, ...node.body[0].body);
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
        } else if (
          node.type === "IfStatement" &&
          node.alternate &&
          node.alternate.type === "BlockStatement" &&
          !node.alternate.body.length
        ) {
          delete node.alternate;
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

      case "CallExpression": {
        return replace(optimizeCall(state, node, null), node);
      }

      case "AssignmentExpression":
        if (
          node.operator === "=" &&
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          node.left.name === node.right.name
        ) {
          return { type: "Literal", value: null, raw: "null" };
        }
        break;

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
            if (decl.init && decl.init.type === "CallExpression") {
              const inlined = replace(
                optimizeCall(state, decl.init, decl),
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
          if (node.expression.right.type === "CallExpression") {
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
                optimizeCall(state, node.expression.right, node.expression),
                node.expression.right
              );
            }
          }
        } else {
          const ret = unused(node.expression, true);
          if (ret) {
            return ret
              .map((r) => replace(r, r))
              .flat(1)
              .filter((s): s is Exclude<typeof s, false | null> => !!s);
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
  state.exposed = {};
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });
  delete state.pre;
  delete state.post;
  state.allFunctions.forEach((fn) => sizeBasedPRE(state, fn));

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
              !hasProperty(state.exposed, name)
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
            !hasProperty(state.index, name) || hasProperty(state.exposed, name)
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
  Object.values(fnMap).forEach((f) => {
    traverseAst(f.ast!, undefined, (node) => {
      const ret = cleanup(node);
      if (ret === false) {
        state.removeNodeComments(node, f.ast!);
      }
      return ret;
    });
  });
  return state.diagnostics;
}

function optimizeCall(
  state: ProgramStateOptimizer,
  node: mctree.CallExpression,
  context: InlineContext | null
) {
  const [name, results] = state.lookupNonlocal(node.callee);
  const callees =
    results &&
    results
      .map((r) => r.results)
      .flat()
      .filter((c): c is FunctionStateNode => c.type === "FunctionDeclaration");

  if (!callees || !callees.length) {
    const n =
      name ||
      ("name" in node.callee && node.callee.name) ||
      ("property" in node.callee &&
        node.callee.property &&
        "name" in node.callee.property &&
        node.callee.property.name);
    if (n) {
      state.exposed[n] = true;
    } else {
      // There are unnamed CallExpressions, such as new [size]
      // So there's nothing to do here.
    }
    return null;
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
