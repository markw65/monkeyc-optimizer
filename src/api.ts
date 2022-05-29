import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import * as Prettier from "prettier";
import { getLiteralNode } from "./mc-rewrite";
import { negativeFixups } from "./negative-fixups";
import { getSdkPath } from "./sdk-util";
import { pushUnique } from "./util";

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
    const result = collectNamespaces(
      parser.parse(api, null, {
        filepath: "api.mir",
      }) as mctree.Program,
      state
    );
    negativeFixups.forEach((fixup) => {
      const value = fixup.split(".").reduce((state: StateNodeDecl, part) => {
        const decls = isStateNode(state) && state.decls?.[part];
        if (!Array.isArray(decls) || decls.length != 1 || !decls[0]) {
          throw `Failed to find and fix negative constant ${fixup}`;
        }
        return decls[0];
      }, result);
      if (
        value.type !== "EnumStringMember" &&
        (value.type !== "VariableDeclarator" || value.kind != "const")
      ) {
        throw `Negative constant ${fixup} did not refer to a constant`;
      }
      const init = value.init;
      if (!init || init.type !== "Literal") {
        throw `Negative constant ${fixup} was not a Literal`;
      }
      if (typeof init.value !== "number") {
        console.log(`Negative fixup ${fixup} was already not a number!`);
      } else if (init.value > 0) {
        init.value = -init.value;
        init.raw = "-" + init.raw;
      } else {
        console.log(`Negative fixup ${fixup} was already negative!`);
      }
    });
    return result;
  } catch (e) {
    console.error(`${e}`);
    return null;
  }
}

// We can use hasProperty to remove undefined/null (as a side effect),
// but we shouldn't apply it to things the compiler already knows are
// non null because them the compiler will incorrectly infer never in the
// false case.
export function hasProperty<
  T extends null extends T ? unknown : undefined extends T ? unknown : never
>(obj: T, prop: string): obj is NonNullable<T>;
export function hasProperty<T>(obj: T, prop: string): boolean;
export function hasProperty(obj: unknown, prop: string): boolean {
  return obj ? Object.prototype.hasOwnProperty.call(obj, prop) : false;
}

export function isStateNode(node: StateNodeDecl): node is StateNode {
  return hasProperty(node, "node");
}

export function variableDeclarationName(node: mctree.TypedIdentifier) {
  return ("left" in node ? node.left : node).name;
}

export function collectNamespaces(
  ast: mctree.Program,
  stateIn?: ProgramState
): ProgramStateNode {
  const state = (stateIn || {}) as ProgramStateLive;
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
  state.removeNodeComments = (node: mctree.Node, ast: mctree.Program) => {
    if (node.start && node.end && ast.comments && ast.comments.length) {
      let low = 0,
        high = ast.comments.length;
      while (true) {
        const mid = (low + high) >> 1;
        if (mid == low) {
          if (ast.comments[mid].start! < node.start) {
            return;
          }
          break;
        }
        if (ast.comments[mid].start! < node.start) {
          low = mid;
        } else {
          high = mid;
        }
      }
      for (
        high = low;
        high < ast.comments.length && ast.comments[high].end! < node.end;
        high++
      ) {}
      if (high > low) {
        ast.comments.splice(low, high - low);
      }
    }
  };

  state.lookup = (node, name, stack) => {
    stack || (stack = state.stack);
    switch (node.type) {
      case "MemberExpression": {
        if (node.property.type != "Identifier" || node.computed) break;
        const [, module, where] = state.lookup(node.object, name, stack);
        if (module && module.length === 1) {
          const result = checkOne(module[0], node.property.name);
          if (result) {
            return [
              name || node.property.name,
              result,
              where.concat(module[0] as StateNode),
            ];
          }
        }
        break;
      }
      case "ThisExpression": {
        for (let i = stack.length; i--; ) {
          const si = stack[i];
          if (
            si.type == "ModuleDeclaration" ||
            si.type == "ClassDeclaration" ||
            !i
          ) {
            return [name || (si.name as string), [si], stack.slice(0, i)];
          }
        }
        break;
      }
      case "Identifier": {
        if (node.name == "$") {
          return [name || node.name, [stack[0]], []];
        }
        for (let i = stack.length; i--; ) {
          const result = checkOne(stack[i], node.name);
          if (result) {
            return [name || node.name, result, stack.slice(0, i + 1)];
          }
        }
        break;
      }
    }
    return [null, null, null];
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
              const name = "id" in node ? node.id && node.id.name : null;
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
                if (hasProperty(parent.decls, name)) {
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
                  parent.decls[name] = [];
                }
                if (
                  node.type === "FunctionDeclaration" &&
                  node.params &&
                  node.params.length
                ) {
                  const decls: StateNodeDecls = (elm.decls = {});
                  node.params.forEach(
                    (p) => (decls[variableDeclarationName(p)] = [p])
                  );
                }
                parent.decls[name].push(elm);
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
              const name = node.id!.name;
              const [parent] = state.stack.slice(-1);
              if (!parent.decls) parent.decls = {};
              if (!hasProperty(parent.decls, name)) {
                parent.decls[name] = [];
              }
              pushUnique(parent.decls[name], node);
              break;
            }
            case "VariableDeclaration": {
              const [parent] = state.stack.slice(-1);
              if (!parent.decls) parent.decls = {};
              const decls = parent.decls;
              node.declarations.forEach((decl) => {
                const name = variableDeclarationName(decl.id);
                if (!hasProperty(decls, name)) {
                  decls[name] = [];
                }
                decl.kind = node.kind;
                pushUnique(decls[name], decl);
                if (node.kind == "const") {
                  if (!hasProperty(state.index, name)) {
                    state.index[name] = [];
                  }
                  pushUnique(state.index[name], parent);
                }
              });
              break;
            }
            case "EnumStringBody": {
              const [parent] = state.stack.slice(-1);
              const values = parent.decls || (parent.decls = {});
              let prev = -1;
              node.members.forEach((m, i) => {
                if (m.type == "Identifier") {
                  prev += 1;
                  m = node.members[i] = {
                    type: "EnumStringMember",
                    loc: m.loc,
                    start: m.start,
                    end: m.end,
                    id: m,
                    init: {
                      type: "Literal",
                      value: prev,
                      raw: prev.toString(),
                      enumType: m.enumType,
                      loc: m.loc,
                      start: m.start,
                      end: m.end,
                    },
                  };
                }
                const name = m.id.name;
                const init = getLiteralNode(m.init);
                if (!init) {
                  throw new Error("Unexpected enum initializer");
                }
                if (init != m.init) {
                  m.init = init;
                }
                if (
                  init.type == "Literal" &&
                  init.raw &&
                  LiteralIntegerRe.test(init.raw)
                ) {
                  prev = init.value as number;
                }
                if (!hasProperty(values, name)) {
                  values[name] = [];
                }
                pushUnique(values[name], m);
                if (!hasProperty(state.index, name)) {
                  state.index[name] = [];
                }
                pushUnique(state.index[name], parent);
              });
              break;
            }
          }
          if (state.pre) return state.pre(node, state);
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
            ret = false as const;
          } else {
            if (state.post) ret = state.post(node, state);
            if (state.stack.slice(-1).pop()?.node === node) {
              state.stack.pop();
            }
          }
          if (ret === false) {
            state.removeNodeComments(node, ast);
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

function isMCTreeNode(node: unknown): node is mctree.Node {
  return node ? typeof node === "object" && "type" in node : false;
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
  node: mctree.Node,
  pre?:
    | null
    | ((node: mctree.Node) => void | null | false | (keyof mctree.NodeAll)[]),
  post?: (node: mctree.Node) => void | null | false | mctree.Node
): false | void | null | mctree.Node {
  const nodes = pre && pre(node);
  if (nodes === false) return;
  for (const key of nodes || Object.keys(node)) {
    const value = (node as mctree.NodeAll)[key as keyof mctree.NodeAll];
    if (!value) continue;
    if (Array.isArray(value)) {
      const values = value as Array<unknown>;
      const deletions = values.reduce<null | { [key: number]: true }>(
        (state, obj, i) => {
          if (isMCTreeNode(obj)) {
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
    } else if (isMCTreeNode(value)) {
      const repl = traverseAst(value, pre, post);
      if (repl === false) {
        delete node[key as keyof mctree.Node];
      } else if (repl != null) {
        (node as unknown as Record<string, unknown>)[key] = repl;
      }
    }
  }
  return post && post(node);
}

export function formatAst(
  node: mctree.Node,
  monkeyCSource: string | null = null
) {
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
  const source = (monkeyCSource || "") + "\n" + JSON.stringify(node);
  return Prettier.format(source, {
    parser: "monkeyc-json",
    plugins: [MonkeyC],
    endOfLine: "lf",
  });
}

function handleException(
  state: ProgramStateLive,
  node: mctree.Node,
  exception: unknown
): never {
  try {
    const fullName = state.stack
      .map((e) => e.name)
      .concat(
        "name" in node && typeof node.name === "string" ? node.name : null
      )
      .filter((e) => e != null)
      .join(".");
    const location =
      node.loc && node.loc.source
        ? `${node.loc.source}:${node.start || 0}:${node.end || 0}`
        : "<unknown>";
    const message = `Got exception \`${
      exception instanceof Error
        ? exception.message
        : Object.prototype.toString.call(exception)
    }' while processing node ${fullName}:${node.type} from ${location}`;
    if (exception instanceof Error) {
      exception.message = message;
    } else {
      exception = new Error(message);
    }
  } finally {
    throw exception;
  }
}
