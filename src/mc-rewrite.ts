// @ts-ignore
import MonkeyC from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  getApiMapping,
  hasProperty,
  isStateNode,
  traverseAst,
  LiteralIntegerRe,
} from "src/api";
import { pushUnique } from "src/util";
import {
  Node as ESTreeNode,
  NodeAll as ESTreeAll,
  UnaryExpression as ESTreeUnaryExpression,
  Identifier as ESTreeIdentifier,
  ModuleDeclaration as ESTreeModuleDeclaration,
  ClassDeclaration as ESTreeClassDeclaration,
  FunctionDeclaration as ESTreeFunctionDeclaration,
  Literal as ESTreeLiteral,
  BlockStatement as ESTreeBlockStatement,
  ImportStatement as ESTreeImportStatement,
  AsExpression as ESTreeAsExpression,
} from "src/estree-types";
declare global {
  type StateNodeDecl = StateNode | ESTreeLiteral | string;
  type StateNodeDecls = {
    [key: string]: StateNodeDecl[];
  };
  type ProgramStateNode = {
    type: "Program";
    node: null | undefined;
    name: "$";
    fullName: "$";
    decls?: StateNodeDecls;
    stack?: null | undefined;
  };
  type ModuleStateNode = {
    type: "ModuleDeclaration";
    name: string;
    fullName: string;
    node: ESTreeModuleDeclaration;
    stack?: ProgramStateStack;
    decls?: StateNodeDecls;
  };
  type ClassStateNode = {
    type: "ClassDeclaration";
    name: string;
    fullName: string;
    node: ESTreeClassDeclaration;
    decls?: StateNodeDecls;
    stack?: ProgramStateStack;
    superClass: ClassStateNode[] | true;
  };
  type FunctionStateNode = {
    type: "FunctionDeclaration";
    name: string;
    fullName: string;
    node: ESTreeFunctionDeclaration;
    // decls?: { [key: string]: (StateNode | string)[] };
    stack?: ProgramStateStack;
    decls?: undefined;
  };
  type BlockStateNode = {
    type: "BlockStatement";
    name?: null | undefined;
    fullName?: null | undefined;
    node: ESTreeBlockStatement;
    decls?: StateNodeDecls;
    stack?: null | undefined;
  };
  type StateNode =
    | ProgramStateNode
    | FunctionStateNode
    | BlockStateNode
    | ClassStateNode
    | ModuleStateNode;
  type ProgramStateStack = StateNode[];
  type ProgramState = {
    allFunctions?: FunctionStateNode[];
    allClasses?: ClassStateNode[];
    stack?: ProgramStateStack;
    shouldExclude?: (node: any) => any;
    pre?: (node: ESTreeNode) => null | false | (keyof ESTreeAll)[];
    post?: (node: ESTreeNode) => null | false | ESTreeNode;
    lookup?: (
      node: ESTreeNode,
      name?: string,
      stack?: ProgramStateStack
    ) => [string, StateNodeDecl[]];
    traverse?: (node: ESTreeNode) => void | boolean | ESTreeNode;
    exposed?: { [key: string]: true };
    calledFunctions?: { [key: string]: unknown[] };
    localsStack?: {
      node?: ESTreeNode;
      map?: { [key: string]: true | string };
      inners?: { [key: string]: true };
    }[];
    index?: { [key: string]: unknown[] };
    constants?: { [key: string]: ESTreeLiteral };
  };
}

type ImportItem = { node: ESTreeImportStatement; stack: ProgramStateStack };
function processImports(
  allImports: ImportItem[],
  lookup: ProgramState["lookup"]
) {
  allImports.forEach(({ node, stack }) => {
    const [name, module] = lookup(
      node.id,
      "as" in node && node.as && node.as.name,
      stack
    );
    if (name && module) {
      const [parent] = stack.slice(-1);
      if (!parent.decls) parent.decls = {};
      if (!hasProperty(parent.decls, name)) parent.decls[name] = [];
      module.forEach((m) => {
        if (isStateNode(m) && m.type == "ModuleDeclaration") {
          pushUnique(parent.decls[name], m);
        }
      });
    }
  });
}

function collectClassInfo(state: ProgramState) {
  state.allClasses.forEach((elm) => {
    if (elm.node.superClass) {
      const [, classes] = state.lookup(elm.node.superClass, null, elm.stack);
      const superClass =
        classes &&
        classes.filter(
          (c): c is ClassStateNode =>
            isStateNode(c) && c.type === "ClassDeclaration"
        );
      // set it "true" if there is a superClass, but we can't find it.
      elm.superClass = superClass && superClass.length ? superClass : true;
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

async function analyze(fnMap: FilesToOptimizeMap) {
  let excludeAnnotations: ExcludeAnnotationsMap;
  let hasTests = false;
  const allImports: ImportItem[] = [];
  const state: ProgramState = {
    allFunctions: [],
    allClasses: [],
    shouldExclude(node: ESTreeNode) {
      if ("attrs" in node && node.attrs && node.attrs.attrs) {
        return node.attrs.attrs.reduce((drop, attr) => {
          if (attr.type != "UnaryExpression") return drop;
          if (attr.argument.type != "Identifier") return drop;
          if (hasProperty(excludeAnnotations, attr.argument.name)) {
            return true;
          }
          if (attr.argument.name == "test") {
            hasTests = true;
          }
          return drop;
        }, false);
      }
      return null;
    },
    post(node) {
      switch (node.type) {
        case "FunctionDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          const stack = state.stack.slice(0, -1);
          scope.stack = stack;
          if (scope.type == "FunctionDeclaration") {
            state.allFunctions.push(scope);
          } else {
            state.allClasses.push(scope as ClassStateNode);
          }
          return null;
        }
        case "Using":
        case "ImportModule":
          allImports.push({ node, stack: state.stack.slice() });
          return null;
      }
    },
  };

  await getApiMapping(state);

  // Mark all functions from api.mir as "special" by
  // setting their bodies to null. In api.mir, they're
  // all empty, which makes it look like they're
  // do-nothing functions.
  const markApi = (node: StateNodeDecl) => {
    if (typeof node === "string") return;
    if (node.type == "FunctionDeclaration") {
      node.node.body = null;
    }
    if ("decls" in node) {
      Object.values(node.decls).forEach((v) => v.forEach(markApi));
    }
  };
  markApi(state.stack[0]);

  const getAst = (
    source: string,
    monkeyCSource: string,
    exclude: ExcludeAnnotationsMap
  ) => {
    excludeAnnotations = exclude;
    const ast = MonkeyC.parsers.monkeyc.parse(monkeyCSource, {
      grammarSource: source,
    });
    ast.source = source;
    ast.monkeyCSource = monkeyCSource;
    hasTests = false;
    collectNamespaces(ast, state);
    return { ast, hasTests };
  };
  const files = await Promise.all(
    Object.entries(fnMap).map(([name, { excludeAnnotations }]) =>
      fs.readFile(name).then((data) => ({
        name,
        ...getAst(
          name,
          data.toString().replace(/\r\n/g, "\n"),
          excludeAnnotations
        ),
      }))
    )
  );

  delete state.shouldExclude;
  delete state.post;

  processImports(allImports, state.lookup);
  collectClassInfo(state);

  return { files, state };
}

export function getLiteralNode(
  node: ESTreeNode | StateNodeDecl | StateNodeDecl[]
): null | ESTreeLiteral | ESTreeAsExpression {
  if (Array.isArray(node)) {
    if (!node.length) return null;
    if (node.length === 1) return getLiteralNode(node[0]);
    let result: null | ESTreeLiteral = null;
    if (
      node.every((n) => {
        const lit = getLiteralNode(n);
        if (!lit || !("value" in lit)) return false;
        if (!result) {
          result = lit;
        } else {
          if (lit.value !== result.value) return false;
        }
        return true;
      })
    ) {
      return result;
    }
    return null;
  }
  if (typeof node === "string") return null;
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

function getNodeValue(node: ESTreeNode): [ESTreeLiteral | null, string | null] {
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
    const match = LiteralIntegerRe.exec(node.raw);
    if (match) {
      type = match[2] == "l" ? "Long" : "Number";
    } else if (node.raw.endsWith("d")) {
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

function optimizeNode(node: ESTreeNode) {
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
              value: -arg.value,
              raw: (-arg.value).toString() + (type === "Long" ? "l" : ""),
            };
          }
          break;
        case "!":
        case "~":
          {
            let value;
            if (type === "Number" || type === "Long") {
              value = -arg.value - 1;
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
        "<<": (left: number, right: number, type: string) =>
          type === "Number" ? left << right : null,
        ">>": (left: number, right: number, type: string) =>
          type === "Number" ? left >> right : null,
      };
      const op = operators[node.operator as keyof typeof operators];
      if (op) {
        const [left, left_type] = getNodeValue(node.left);
        const [right, right_type] = getNodeValue(node.right);
        if (!left || !right) break;
        if (
          left_type != right_type ||
          (left_type != "Number" && left_type != "Long")
        ) {
          break;
        }
        const value = op(
          left.value as number,
          right.value as number,
          left_type
        );
        if (value === null) break;
        return {
          ...left,
          value,
          raw: value.toString() + (left_type === "Long" ? "l" : ""),
        };
      }
      break;
    }
    case "FunctionDeclaration":
      if (node.body && evaluateFunction(node, null) !== false) {
        node.optimizable = true;
      }
      break;
  }
  return null;
}

function evaluateFunction(
  func: ESTreeFunctionDeclaration,
  args: ESTreeNode[] | null
) {
  if (args && args.length != func.params.length) {
    return false;
  }
  const paramValues =
    args && Object.fromEntries(func.params.map((p, i) => [p.name, args[i]]));
  let ret: ESTreeNode | null = null;
  const body = args ? JSON.parse(JSON.stringify(func.body)) : func.body;
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
      args &&
        ((node) => {
          switch (node.type) {
            case "ReturnStatement":
              ret = node.argument;
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
              const repl = optimizeNode(node);
              if (repl && repl.type === "Literal") return repl;
              throw new Error("Didn't optimize");
            }
          }
        })
    );
    return ret;
  } catch (e) {
    return false;
  }
}

type ESTreeSome = { [k in keyof ESTreeAll]?: unknown };

export async function optimizeMonkeyC(fnMap: FilesToOptimizeMap) {
  const { files, state } = await analyze(fnMap);
  const replace = (node: ESTreeSome, obj: ESTreeSome) => {
    for (const k of Object.keys(node)) {
      delete node[k as keyof ESTreeSome];
    }
    if (obj.enumType) {
      obj = {
        type: "BinaryExpression",
        operator: "as",
        left: obj,
        right: { type: "TypeSpecList", ts: [obj.enumType] },
      };
    }
    for (const [k, v] of Object.entries(obj)) {
      node[k as keyof ESTreeSome] = v;
    }
  };
  const lookupAndReplace = (node: ESTreeNode) => {
    const [, objects] = state.lookup(node);
    if (!objects) {
      return false;
    }
    const obj = getLiteralNode(objects);
    if (!obj) {
      return false;
    }
    replace(node, obj);
    return true;
  };

  /*
   * Might this function be called from somewhere, including
   * callbacks from the api (eg getSettingsView, etc).
   */
  const maybeCalled = (func: ESTreeFunctionDeclaration) => {
    if (!func.body) {
      // this is an api.mir function. It can be called
      return true;
    }
    if (hasProperty(state.exposed, func.id.name)) return true;
    if (
      func.attrs &&
      func.attrs.attrs &&
      func.attrs.attrs.some((attr) => {
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
    );

  state.localsStack = [{}];
  state.exposed = {};
  state.calledFunctions = {};
  state.pre = (node) => {
    switch (node.type) {
      case "ConditionalExpression":
      case "IfStatement":
      case "DoWhileStatement":
      case "WhileStatement":
        state.traverse(node.test);
        const [value, type] = getNodeValue(node.test);
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
            if (
              node.type === "IfStatement" ||
              node.type === "ConditionalExpression"
            ) {
              if (result === false) {
                node.consequent = null;
              } else {
                node.alternate = null;
              }
              node.test = null;
            } else if (node.type === "WhileStatement") {
              if (result === false) {
                node.body = null;
              }
            } else if (node.type === "DoWhileStatement") {
              if (result === false) {
                node.test = null;
              }
            } else {
              throw new Error("Unexpected Node type");
            }
          }
        }
        return null;

      case "EnumDeclaration":
        return false;
      case "ForStatement": {
        const map = state.localsStack.slice(-1).pop().map;
        if (map) {
          state.localsStack.push({ node, map: { ...map } });
        }
        break;
      }
      case "VariableDeclarator": {
        const locals = state.localsStack.slice(-1).pop();
        const { map } = locals;
        if (map) {
          if (hasProperty(map, node.id.name)) {
            // We already have a variable with this name in scope
            // Recent monkeyc compilers complain, so rename it
            let suffix = 0;
            let node_name = node.id.name;
            const match = node_name.match(/^pmcr_(.*)_(\d+)$/);
            if (match) {
              node_name = match[1];
              suffix = parseInt(match[2], 10) + 1;
            }
            if (!locals.inners) {
              // find all the names declared in this scope, to avoid
              // more conflicts
              locals.inners = {};
              traverseAst(locals.node, (node) => {
                if (node.type === "VariableDeclarator") {
                  locals.inners[node.id.name] = true;
                }
              });
            }
            let name;
            while (true) {
              name = `pmcr_${node_name}_${suffix}`;
              if (
                !hasProperty(map, name) &&
                !hasProperty(locals.inners, name)
              ) {
                // we also need to ensure that we don't hide the name of
                // an outer module, class, function, enum or variable,
                // since someone might want to access it from this scope.
                let ok = false;
                let i;
                for (i = state.stack.length; i--; ) {
                  const elm = state.stack[i];
                  if (ok) {
                    if (hasProperty(elm.decls, name)) {
                      break;
                    }
                  } else if (elm.node.type === "FunctionDeclaration") {
                    ok = true;
                  }
                }
                if (i < 0) {
                  break;
                }
              }
              suffix++;
            }
            map[node.id.name] = name;
            map[name] = true;
            node.id.name = name;
          } else {
            map[node.id.name] = true;
          }
        }
        return ["init"];
      }
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
          return false;
        }
        break;
      case "Identifier": {
        const map = state.localsStack.slice(-1).pop().map;
        if (map) {
          if (hasProperty(map, node.name)) {
            const name = map[node.name];
            if (name !== true) {
              node.name = name;
            }
          }
        }
        if (hasProperty(state.index, node.name)) {
          if (!lookupAndReplace(node)) {
            state.exposed[node.name] = true;
          }
        }
        return false;
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
        const map = state.localsStack.slice(-1).pop().map;
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
        node.params && node.params.forEach((p) => (map[p.name] = true));
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
            if (!hasProperty(state.calledFunctions, node.id.name)) {
              state.calledFunctions[node.id.name] = [];
            }
            state.calledFunctions[node.id.name].push(node);
          }
        }
      }
    }
    return null;
  };
  state.post = (node) => {
    if (state.localsStack.slice(-1).pop().node === node) {
      state.localsStack.pop();
    }
    const opt = optimizeNode(node);
    if (opt) {
      replace(node, opt);
      return null;
    }
    switch (node.type) {
      case "ConditionalExpression":
      case "IfStatement":
        if (node.test === null) {
          const rep = node.consequent || node.alternate;
          if (!rep) return false;
          replace(node, rep);
        }
        break;
      case "WhileStatement":
        if (!node.body) return false;
        break;
      case "DoWhileStatement":
        if (!node.test) return node.body;
        break;

      case "CallExpression": {
        const [name, callees] = state.lookup(node.callee);
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
        if (callees.length == 1) {
          const callee = isStateNode(callees[0]) && callees[0].node;
          if (
            callee.type == "FunctionDeclaration" &&
            callee.optimizable &&
            !callee.hasOverride &&
            node.arguments.every((n) => getNodeValue(n)[0] !== null)
          ) {
            const ret = evaluateFunction(callee, node.arguments);
            if (ret) {
              replace(node, ret);
              return null;
            }
          }
        }
        if (!hasProperty(state.calledFunctions, name)) {
          state.calledFunctions[name] = [];
        }
        callees.forEach(
          (c) => isStateNode(c) && state.calledFunctions[name].push(c.node)
        );
        break;
      }
    }
    return null;
  };
  files.forEach((f) => {
    collectNamespaces(f.ast, state);
  });
  files.forEach((f) => {
    traverseAst(f.ast, null, (node) => {
      switch (node.type) {
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
            if (!node.body["enumType"]) {
              throw new Error("Missing enumType on optimized enum");
            }
            replace(node, {
              type: "TypedefDeclaration",
              id: node.id,
              ts: {
                type: "UnaryExpression",
                argument: { type: "TypeSpecList", ts: [node.body.enumType] },
                prefix: true,
                operator: " as",
              },
            });
          }
          break;
        case "VariableDeclaration": {
          node.declarations = node.declarations.filter(
            (d) =>
              !hasProperty(state.index, d.id.name) ||
              hasProperty(state.exposed, d.id.name)
          );
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
      }
      return null;
    });
  });

  return files;
}
