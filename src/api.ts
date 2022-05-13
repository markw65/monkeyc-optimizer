// @ts-ignore
import MonkeyC from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import Prettier from "prettier/standalone.js";
import { getLiteralNode } from "src/mc-rewrite";
import { negativeFixups } from "src/negative-fixups";
import { getSdkPath } from "src/sdk-util";
import { pushUnique } from "src/util";
import {
  Program,
  Node as ESTreeNode,
  NodeAll as ESTreeAll,
  Literal as ESTreeLiteral,
  NodeSubFields,
} from "src/estree-types";

export const LiteralIntegerRe = /^(0x[0-9a-f]+|\d+)(l)?$/i;
/*
 * This is an unfortunate hack. I want to be able to extract things
 * like the types of all of a Class's variables (in particular the type
 * of each member of Activity.Info), and also map things like enum names
 * to their values (eg to take font names, and color names to their values).
 * The only place I can find this information is in api.mir, which is totally
 * undocumented. The same could be said of compiler.json and simulator.json,
 * but those are at least in a standard format.
 */

// Extract all enum values from api.mir
export async function getApiMapping(
  state?: ProgramState
): Promise<ProgramStateNode | null> {
  // get the path to the currently active sdk
  const parser = MonkeyC.parsers.monkeyc;

  const sdk = await getSdkPath();

  const api = (await fs.readFile(`${sdk}bin/api.mir`))
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/^\s*\[.*?\]\s*$/gm, "")
    //.replace(/(COLOR_TRANSPARENT|LAYOUT_[HV]ALIGN_\w+) = (\d+)/gm, "$1 = -$2")
    .replace(/^(\s*type)\s/gm, "$1def ");

  try {
    const result = collectNamespaces(parser.parse(api, {}), state);
    negativeFixups.forEach((fixup) => {
      const value = fixup.split(".").reduce((state: StateNode, part) => {
        const decls = state.decls[part];
        if (!Array.isArray(decls) || decls.length != 1 || !decls[0]) {
          throw `Failed to find and fix negative constant ${fixup}`;
        }
        return decls[0];
      }, result);
      if (typeof value === "string" || value.type != "Literal") {
        throw `Negative constant ${fixup} was not a Literal`;
      }
      if (value.value > 0) {
        value.value = -value.value;
        value.raw = "-" + value.raw;
      } else {
        console.log(`Negative fixup ${fixup} was already negative!`);
      }
    });
    return result;
  } catch (e) {
    console.error(e.toString());
    return null;
  }
}

export function hasProperty(obj: unknown, prop: string) {
  return obj && Object.prototype.hasOwnProperty.call(obj, prop);
}

export function isStateNode(node: StateNodeDecl): node is StateNode {
  return hasProperty(node, "node");
}

export function collectNamespaces(
  ast: Program,
  state: ProgramState
): ProgramStateNode {
  state = state || {};
  if (!state.index) state.index = {};
  if (!state.stack) {
    state.stack = [
      { type: "Program", name: "$", fullName: "$", node: undefined },
    ];
  }
  const checkOne = (ns: StateNodeDecl, name: string) => {
    if (isStateNode(ns) && hasProperty(ns.decls, name)) {
      return ns.decls[name];
    }
    return null;
  };
  state.lookup = (node, name, stack) => {
    stack || (stack = state.stack);
    switch (node.type) {
      case "MemberExpression": {
        if (node.property.type != "Identifier" || node.computed) break;
        const [, module] = state.lookup(node.object, name, stack);
        if (module && module.length === 1) {
          const result = checkOne(module[0], node.property.name);
          if (result) {
            return [name || node.property.name, result];
          }
        }
        break;
      }
      case "ThisExpression":
        return [name, stack.slice(-1)];
      case "Identifier": {
        if (node.name == "$") {
          return [name || node.name, [stack[0]]];
        }
        for (let i = stack.length; i--; ) {
          const result = checkOne(stack[i], node.name);
          if (result) {
            return [name || node.name, result];
          }
        }
        break;
      }
    }
    return [null, null];
  };

  state.traverse = (root) =>
    traverseAst(
      root,
      (node) => {
        try {
          if (state.shouldExclude && state.shouldExclude(node)) {
            // don't visit any children, but do call post
            return [];
          }
          switch (node.type) {
            case "Program":
              if (state.stack.length != 1) {
                throw new Error("Unexpected stack length for Program node");
              }
              break;
            case "BlockStatement": {
              const [parent] = state.stack.slice(-1);
              if (
                parent.type != "FunctionDeclaration" &&
                parent.type != "BlockStatement"
              ) {
                break;
              }
              // fall through
            }
            case "ClassDeclaration":
            case "FunctionDeclaration":
            case "ModuleDeclaration": {
              const [parent] = state.stack.slice(-1);
              const name = "id" in node && node.id && node.id.name;
              const fullName = state.stack
                .map((e) => e.name)
                .concat(name)
                .filter((e) => e != null)
                .join(".");
              const elm = {
                type: node.type,
                name,
                fullName,
                node,
              } as StateNode;
              state.stack.push(elm);
              if (name) {
                if (!parent.decls) parent.decls = {};
                if (hasProperty(parent.decls, elm.name)) {
                  const what =
                    node.type == "ModuleDeclaration" ? "type" : "node";
                  const e = parent.decls[name].find(
                    (d) => isStateNode(d) && d[what] == elm[what]
                  ) as StateNode | null;
                  if (e != null) {
                    e.node = node;
                    state.stack.splice(-1, 1, e);
                    break;
                  }
                } else {
                  parent.decls[elm.name] = [];
                }
                parent.decls[elm.name].push(elm);
              }
              break;
            }
            // an EnumDeclaration doesn't create a scope, but
            // it does create a type (if it has a name)
            case "EnumDeclaration": {
              if (!node.id) break;
              const [parent] = state.stack.slice(-1);
              const name = (parent.fullName + "." + node.id.name).replace(
                /^\$\./,
                ""
              );
              node.body.members.forEach(
                (m) => (("init" in m ? m.init : m).enumType = name)
              );
            }
            // fall through
            case "TypedefDeclaration": {
              const [parent] = state.stack.slice(-1);
              if (!parent.decls) parent.decls = {};
              if (!hasProperty(parent.decls, node.id.name)) {
                parent.decls[node.id.name] = [];
              }
              pushUnique(
                parent.decls[node.id.name],
                "ts" in node ? formatAst(node.ts.argument) : node.id.name
              );
              break;
            }
            case "VariableDeclaration": {
              const [parent] = state.stack.slice(-1);
              if (!parent.decls) parent.decls = {};
              node.declarations.forEach((decl) => {
                if (!hasProperty(parent.decls, decl.id.name)) {
                  parent.decls[decl.id.name] = [];
                }
                if (node.kind == "const") {
                  pushUnique(parent.decls[decl.id.name], decl.init);
                  if (!hasProperty(state.index, decl.id.name)) {
                    state.index[decl.id.name] = [];
                  }
                  pushUnique(state.index[decl.id.name], parent);
                } else if (decl.id.ts) {
                  pushUnique(
                    parent.decls[decl.id.name],
                    formatAst(decl.id.ts.argument)
                  );
                }
              });
              break;
            }
            case "EnumStringBody": {
              const [parent] = state.stack.slice(-1);
              const values = parent.decls || (parent.decls = {});
              let prev = -1;
              node.members.forEach((m) => {
                let name, init;
                if (m.type == "EnumStringMember") {
                  name = m.id.name;
                  init = getLiteralNode(m.init);
                  if (!init) {
                    throw new Error("Unexpected enum initializer");
                  }
                  if (init != m.init) {
                    m.init = init;
                  }
                  if (
                    init.type == "Literal" &&
                    LiteralIntegerRe.test(init.raw)
                  ) {
                    prev = init.value as number;
                  }
                } else {
                  name = m.name;
                  prev += 1;
                  if (!state.constants) {
                    state.constants = {};
                  }
                  const key = m.enumType ? `${m.enumType}:${prev}` : prev;
                  init = state.constants[key];
                  if (!init) {
                    init = state.constants[key] = {
                      type: "Literal",
                      value: prev,
                      raw: prev.toString(),
                      enumType: m.enumType,
                    };
                  }
                }
                if (!hasProperty(values, name)) {
                  values[name] = [];
                }
                pushUnique(values[name], init);
                if (!hasProperty(state.index, name)) {
                  state.index[name] = [];
                }
                pushUnique(state.index[name], parent);
              });
              break;
            }
          }
          if (state.pre) return state.pre(node);
        } catch (e) {
          handleException(state, node, e);
        }
        return null;
      },
      (node) => {
        try {
          let ret;
          if (state.shouldExclude && state.shouldExclude(node)) {
            // delete the node.
            return false;
          }
          if (state.post) ret = state.post(node);
          if (state.stack.slice(-1).pop().node === node) {
            state.stack.pop();
          }
          return ret;
        } catch (e) {
          handleException(state, node, e);
        }
      }
    );
  state.traverse(ast);
  if (state.stack.length != 1) {
    throw new Error("Invalid AST!");
  }
  if (state.stack[0].type != "Program") {
    throw new Error("Bottom of stack was not a Program!");
  }
  return state.stack[0];
}

function isESTreeNode(node: unknown): node is ESTreeNode {
  return node && typeof node === "object" && "type" in node;
}

/*
 * Traverse the ast rooted at node, calling pre before
 * visiting each node, and post after.
 *
 *  - if pre returns false, the node is not traversed, and
 *    post is not called;
 *  - if pre returns a list of child nodes, only those will
 *    be traversed
 *  - otherwise all child nodes are traversed
 *
 *  - if post returns false, the node it was called on is
 *    removed.
 */
export function traverseAst(
  node: ESTreeNode,
  pre?: (node: ESTreeNode) => void | null | false | (keyof ESTreeAll)[],
  post?: (node: ESTreeNode) => void | null | false | ESTreeNode
): false | void | null | ESTreeNode {
  const nodes = pre && pre(node);
  if (nodes === false) return;
  for (const key of nodes || Object.keys(node)) {
    const value = (node as ESTreeAll)[key as keyof ESTreeAll];
    if (!value) continue;
    if (Array.isArray(value)) {
      const values = value as Array<unknown>;
      const deletions = values.reduce<null | { [key: number]: true }>(
        (state, obj, i) => {
          if (isESTreeNode(obj)) {
            const repl = traverseAst(obj, pre, post);
            if (repl === false) {
              if (!state) state = {};
              state[i] = true;
            } else if (repl != null) {
              values[i] = repl;
            }
          }
          return state;
        },
        null
      );
      if (deletions) {
        values.splice(
          0,
          values.length,
          ...values.filter((obj, i) => deletions[i] !== true)
        );
      }
    } else if (isESTreeNode(value)) {
      const repl = traverseAst(value, pre, post);
      if (repl === false) {
        delete node[key as keyof ESTreeNode];
      } else if (repl != null) {
        (node as unknown as Record<string, unknown>)[key] = repl;
      }
    }
  }
  return post && post(node);
}

export function formatAst(
  node: ESTreeNode,
  options?: { [key: string]: unknown }
) {
  const monkeyCSource = "monkeyCSource" in node && node.monkeyCSource + "\n";
  if ("comments" in node && !monkeyCSource) {
    // Prettier inserts comments by using the source location to
    // find the original comment, rather than using the contents
    // of the comment as reported by the comment nodes themselves.
    // If all we've got is the ast, rather than the actual
    // source code, this goes horribly wrong, so just drop all
    // the comments.
    delete node.comments;
  }
  // If we *do* have the original source, pass that in ahead of the
  // json. The parser knows to just treat the last line of the input
  // as the ast itself, and the printers will find what they're
  // looking for in the source.
  const source = (monkeyCSource || "") + JSON.stringify(node);
  return Prettier.format(source, {
    ...(options || {}),
    parser: "monkeyc-json",
    plugins: [MonkeyC],
    endOfLine: "lf",
  });
}

function handleException(
  state: ProgramState,
  node: ESTreeNode,
  exception: unknown
): never {
  let message;
  try {
    const fullName = state.stack
      .map((e) => e.name)
      .concat("name" in node && node.name)
      .filter((e) => e != null)
      .join(".");
    const location =
      node.loc && node.loc.source
        ? `${node.loc.source}:${node.start || 0}:${node.end || 0}`
        : "<unknown>";
    message = `Got exception \`${exception.toString()}' while processing node ${fullName}:${
      node.type
    } from ${location}`;
  } catch {
    throw exception;
  }
  throw new Error(message);
}
