import MonkeyC from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  getApiMapping,
  hasProperty,
  traverseAst,
  LiteralIntegerRe,
} from "./api.js";

function collectClassInfo(state) {
  state.allClasses.forEach((elm) => {
    if (elm.node.superClass) {
      const [, classes] = state.lookup(elm.node.superClass, null, elm.stack);
      if (classes) {
        elm.superClass = classes.filter((c) => c.type == "ClassDeclaration");
      }
      // set it "true" if there is a superClass, but we can't find it.
      if (!elm.superClass || !elm.superClass.length) elm.superClass = true;
    }
  });

  const markOverrides = (cls, scls) => {
    if (scls === true) return;
    scls.forEach((c) => {
      Object.values(c.decls).forEach((f) => {
        if (f.type == "FunctionDeclaration") {
          if (hasProperty(cls.decls, f.name)) {
            f.hasOverride = true;
          }
        }
      });
      if (c.superClass) markOverrides(cls, c.superClass);
    });
  };

  state.allClasses.forEach((elm) => {
    if (elm.superClass) markOverrides(elm, elm.superClass);
  });
}

async function analyze(fileNames, buildConfig) {
  const excludeAnnotations =
    buildConfig && buildConfig.excludeAnnotations
      ? Object.fromEntries(buildConfig.excludeAnnotations.map((a) => [a, true]))
      : {};

  const shouldExclude = (node) => {
    if (node.attrs && node.attrs.attrs) {
      if (
        node.attrs.attrs.filter((attr) => {
          if (attr.type != "UnaryExpression") return false;
          if (attr.argument.type != "Identifier") return false;
          return hasProperty(excludeAnnotations, attr.argument.name);
        }).length
      ) {
        return true;
      }
    }
  };
  const state = {
    allFunctions: [],
    allClasses: [],
    pre(node) {
      if (shouldExclude(node)) {
        // don't visit any children, but do call post
        return [];
      }
    },
    post(node) {
      if (shouldExclude(node)) {
        // delete the node.
        return false;
      }
      switch (node.type) {
        case "FunctionDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          const stack = state.stack.slice(0, -1);
          scope.stack = stack;
          (node.type == "FunctionDeclaration"
            ? state.allFunctions
            : state.allClasses
          ).push(scope);
        }
      }
    },
  };

  await getApiMapping(state);

  // Mark all functions from api.mir as "special" by
  // setting their bodies to null. In api.mir, they're
  // all empty, which makes it look like they're
  // do-nothing functions.
  const markApi = (node) => {
    if (node.type == "FunctionDeclaration") {
      node.node.body = null;
    }
    if (node.decls) {
      Object.values(node.decls).forEach(markApi);
    }
  };
  markApi(state.stack[0]);

  const files = await Promise.all(
    fileNames.map(async (name) => ({
      name,
      monkeyCSource: (await fs.readFile(name))
        .toString()
        .replace(/\r\n/g, "\n"),
    }))
  );

  files.forEach((f) => {
    f.ast = MonkeyC.parsers.monkeyc.parse(f.monkeyCSource, {
      grammarSource: f.name,
    });
    f.ast.monkeyCSource = f.monkeyCSource;
    delete f.monkeyCSource;
    collectNamespaces(f.ast, state);
  });

  delete state.pre;
  delete state.post;

  collectClassInfo(state);

  return { files, state };
}

function getLiteralNode(node) {
  if (Array.isArray(node)) {
    if (!node.length) return null;
    if (node.length === 1) return getLiteralNode(node[0]);
    let result;
    if (
      node.every((n) => {
        const lit = getLiteralNode(n);
        if (!lit) return false;
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
}

function getNodeValue(node) {
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

function optimizeNode(node) {
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
        "+": (left, right) => left + right,
        "-": (left, right) => left - right,
        "*": (left, right) => left * right,
        "/": (left, right) => Math.trunc(left / right),
        "%": (left, right) => left % right,
        "&": (left, right, type) => (type === "Number" ? left & right : null),
        "|": (left, right, type) => (type === "Number" ? left | right : null),
        "<<": (left, right, type) => (type === "Number" ? left << right : null),
        ">>": (left, right, type) => (type === "Number" ? left >> right : null),
      };
      const op = operators[node.operator];
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
        const value = op(left.value, right.value, left_type);
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
}

function evaluateFunction(func, args) {
  if (args && args.length != func.params.length) {
    return false;
  }
  const paramValues =
    args && Object.fromEntries(func.params.map((p, i) => [p.name, args[i]]));
  let ret = null;
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
            throw "Bad node type";
        }
      },
      args &&
        ((node) => {
          switch (node.type) {
            case "ReturnStatement":
              ret = node.argument;
              return;
            case "BlockStatement":
            case "Literal":
              return;
            case "Identifier":
              if (hasProperty(paramValues, node.name)) {
                return paramValues[node.name];
              }
            // fall through;
            default: {
              const repl = optimizeNode(node);
              if (repl && repl.type === "Literal") return repl;
              throw "Didn't optimize";
            }
          }
        })
    );
    return ret;
  } catch (e) {
    return false;
  }
}

export async function optimizeMonkeyC(fileNames, buildConfig) {
  const { files, state } = await analyze(fileNames, buildConfig);
  const replace = (node, obj) => {
    for (const k of Object.keys(node)) {
      delete node[k];
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
      node[k] = v;
    }
  };
  const lookupAndReplace = (node) => {
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
  const maybeCalled = (func) => {
    if (!func.body) {
      // this is an api.mir function. It can be called
      return true;
    }
    if (hasProperty(state.exposed, func.id.name)) return true;
    if (hasProperty(state.calledFunctions, func.id.name)) {
      return (
        state.calledFunctions[func.id.name].find((f) => f === func) !== null
      );
    }
  };
  /*
   * Does elm (a class) have a maybeCalled function called name,
   * anywhere in its superClass chain.
   */
  const checkInherited = (elm, name) =>
    elm.superClass === true ||
    elm.superClass.some(
      (sc) =>
        (hasProperty(sc.decls, name) &&
          sc.decls[name].some(
            (f) => f.type == "FunctionDeclaration" && maybeCalled(f)
          )) ||
        (sc.superClass && checkInherited(sc, name))
    );

  state.exposed = {};
  state.calledFunctions = {};
  state.pre = (node) => {
    switch (node.type) {
      case "EnumDeclaration":
        return false;
      case "VariableDeclarator":
        return ["init"];
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
              state.exposed[node.name] = true;
            }
          }
        }
        break;
      case "FunctionDeclaration": {
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
  };
  state.post = (node) => {
    const opt = optimizeNode(node);
    if (opt) {
      replace(node, opt);
      return;
    }
    if (node.type == "CallExpression") {
      const [name, callees] = state.lookup(node.callee);
      if (!callees || !callees.length) {
        const n =
          name ||
          node.callee.name ||
          (node.callee.property && node.callee.property.name);
        if (n) {
          state.exposed[n] = true;
        } else {
          throw "What?";
        }
        return;
      }
      if (callees.length == 1) {
        const callee = callees[0].node;
        if (
          callee.optimizable &&
          !callee.hasOverride &&
          node.arguments.every((n) => getNodeValue(n)[0] !== null)
        ) {
          const ret = evaluateFunction(callee, node.arguments);
          if (ret) {
            replace(node, ret);
            return;
          }
        }
      }
      if (!hasProperty(state.calledFunctions, name)) {
        state.calledFunctions[name] = [];
      }
      callees.forEach((c) => state.calledFunctions[name].push(c.node));
    }
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
              const name = m.name || m.id.name;
              return (
                hasProperty(state.index, name) &&
                !hasProperty(state.exposed, name)
              );
            })
          ) {
            node.enumType = [
              ...new Set(
                node.members.map((m) => {
                  if (!m.init) return "Number";
                  const [node, type] = getNodeValue(m.init);
                  if (!node) throw "Failed to get type for eliminated enum";
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
              throw "Missing enumType on optimized enum";
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
    });
  });

  return files;
}
