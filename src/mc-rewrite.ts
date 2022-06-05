import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  getApiMapping,
  hasProperty,
  isStateNode,
  traverseAst,
  variableDeclarationName,
} from "./api";
import {
  InlineContext,
  inlineFunction,
  InlineStatus,
  shouldInline,
  unused,
} from "./inliner";
import { pushUnique } from "./util";
import { renameVariable } from "./variable-renamer";

type ImportItem = { node: mctree.ImportStatement; stack: ProgramStateStack };
function processImports(
  allImports: ImportItem[],
  lookup: NonNullable<ProgramState["lookup"]>
) {
  allImports.forEach(({ node, stack }) => {
    const [name, module] = lookup(
      node.id,
      ("as" in node && node.as && node.as.name) || null,
      stack
    );
    if (name && module) {
      const [parent] = stack.slice(-1);
      if (!parent.decls) parent.decls = {};
      const decls = parent.decls;
      if (!hasProperty(decls, name)) decls[name] = [];
      module.forEach((m) => {
        if (isStateNode(m) && m.type == "ModuleDeclaration") {
          pushUnique(decls[name], m);
          if (!parent.type_decls) parent.type_decls = {};
          const tdecls = parent.type_decls;
          if (!hasProperty(tdecls, name)) tdecls[name] = [];
          pushUnique(tdecls[name], m);
          if (node.type == "ImportModule" && m.type_decls) {
            Object.entries(m.type_decls).forEach(([name, decls]) => {
              if (!hasProperty(tdecls, name)) tdecls[name] = [];
              decls.forEach((decl) => pushUnique(tdecls[name], decl));
            });
          }
        }
      });
    }
  });
}

function collectClassInfo(state: ProgramStateAnalysis) {
  state.allClasses.forEach((elm) => {
    if (elm.node.superClass) {
      const [name, classes] = state.lookup(
        elm.node.superClass,
        null,
        elm.stack
      );
      const superClass =
        classes &&
        classes.filter(
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
  ).then(() => {});
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

export async function analyze(fnMap: FilesToOptimizeMap) {
  let hasTests = false;
  const allImports: ImportItem[] = [];
  const preState: ProgramState = {
    fnMap,
    allFunctions: [],
    allClasses: [],
    shouldExclude(node: mctree.Node) {
      if (
        "attrs" in node &&
        node.attrs &&
        "attrs" in node.attrs &&
        node.attrs.attrs &&
        node.loc?.source
      ) {
        const excludeAnnotations = fnMap[node.loc.source].excludeAnnotations;
        if (excludeAnnotations) {
          return node.attrs.attrs.reduce((drop: boolean, attr) => {
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
      }
      return false;
    },
    post(node, state) {
      switch (node.type) {
        case "FunctionDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          const stack = state.stack.slice(0, -1);
          scope.stack = stack;
          if (scope.type == "FunctionDeclaration") {
            state.allFunctions!.push(scope);
          } else {
            state.allClasses!.push(scope as ClassStateNode);
          }
          return null;
        }
        case "Using":
        case "ImportModule":
          allImports.push({ node, stack: state.stack.slice() });
          return null;
        default:
          return null;
      }
    },
  };

  await getApiMapping(preState);

  const state = preState as ProgramStateAnalysis;

  // Mark all functions from api.mir as "special" by
  // setting their bodies to null. In api.mir, they're
  // all empty, which makes it look like they're
  // do-nothing functions.
  const markApi = (node: StateNodeDecl) => {
    if (node.type == "FunctionDeclaration") {
      node.node.body = null;
    }
    if (isStateNode(node) && node.decls) {
      Object.values(node.decls).forEach((v) => v.forEach(markApi));
    }
  };
  markApi(state.stack[0]);

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

  processImports(allImports, state.lookup);
  collectClassInfo(state);

  return state;
}

function compareLiteralLike(a: mctree.Node, b: mctree.Node) {
  while (a.type === "BinaryExpression") a = a.left;
  while (b.type === "BinaryExpression") b = b.left;

  return a.type === "Literal" && b.type === "Literal" && a.value === b.value;
}

export function getLiteralFromDecls(decls: StateNodeDecl[]) {
  if (!decls.length) return null;
  let result: null | mctree.Literal | mctree.AsExpression = null;
  if (
    decls.every((d) => {
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
  ) {
    return result;
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

function optimizeNode(node: mctree.Node) {
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
                const repl = optimizeNode(node);
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

export async function optimizeMonkeyC(fnMap: FilesToOptimizeMap) {
  const state = {
    ...(await analyze(fnMap)),
    localsStack: [{}],
    exposed: {},
    calledFunctions: {},
  } as ProgramStateOptimizer;

  const replace = (node: MCTreeSome, obj: MCTreeSome) => {
    for (const k of Object.keys(node)) {
      delete node[k as keyof MCTreeSome];
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
      node[k as keyof MCTreeSome] = v;
    }
  };
  const lookupAndReplace = (node: mctree.Node) => {
    const [, objects] = state.lookup(node);
    if (!objects) {
      return false;
    }
    const obj = getLiteralFromDecls(objects);
    if (!obj) {
      return false;
    }
    replace(node, obj);
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
      case "WhileStatement":
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
    if (topLocals().node === node) {
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
        if (
          node.test.type === "Literal" &&
          typeof node.test.value === "boolean"
        ) {
          const rep = node.test.value ? node.consequent : node.alternate;
          if (!rep) return false;
          replace(node, rep);
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
          return optimizeCall(state, node.argument, node);
        }
        break;

      case "CallExpression": {
        const ret = optimizeCall(state, node, null);
        if (ret) {
          replace(node, ret);
        }
        break;
      }

      case "ExpressionStatement":
        if (node.expression.type === "CallExpression") {
          return optimizeCall(state, node.expression, node);
        } else if (node.expression.type === "AssignmentExpression") {
          if (node.expression.right.type === "CallExpression") {
            return optimizeCall(state, node.expression.right, node.expression);
          }
        } else {
          const ret = unused(node.expression, true);
          if (ret) {
            return ret;
          }
        }
        break;
    }
    return null;
  };
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });
  delete state.pre;
  delete state.post;

  const cleanup = (node: mctree.Node) => {
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
}

function optimizeCall(
  state: ProgramStateOptimizer,
  node: mctree.CallExpression,
  context: InlineContext | null
) {
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
  if (callees.length == 1 && callees[0].type === "FunctionDeclaration") {
    const callee = callees[0].node;
    if (
      !context &&
      callee.optimizable &&
      !callee.hasOverride &&
      node.arguments.every((n) => getNodeValue(n)[0] !== null)
    ) {
      const ret = evaluateFunction(callee, node.arguments);
      if (ret) {
        return ret;
      }
    }
    const inlineStatus = shouldInline(state, callees[0], node.arguments);
    if (
      inlineStatus === InlineStatus.AsExpression ||
      (context && inlineStatus === InlineStatus.AsStatement)
    ) {
      const ret = inlineFunction(state, callees[0], node, context);
      if (ret) {
        return ret;
      }
    }
  }
  if (!hasProperty(state.calledFunctions, name)) {
    state.calledFunctions[name] = [];
  }
  callees.forEach(
    (c) => isStateNode(c) && pushUnique(state.calledFunctions[name], c.node)
  );
  return null;
}
