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
import { pushUnique, sameArrays } from "./util";

export { visitReferences } from "./visitor";

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
      const vs = fixup.split(".").reduce((state: StateNodeDecl, part) => {
        const decls = isStateNode(state) && state.decls?.[part];
        if (!Array.isArray(decls) || decls.length != 1 || !decls[0]) {
          throw `Failed to find and fix negative constant ${fixup}`;
        }
        return decls[0];
      }, result);
      const value = isStateNode(vs) ? vs.node! : vs;
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

type DeclKind = "decls" | "type_decls";

function checkOne(
  ns: StateNodeDecl,
  decls: DeclKind,
  name: string
): StateNodeDecl[] | null {
  if (isStateNode(ns)) {
    if (hasProperty(ns[decls], name)) {
      return ns[decls]![name];
    }
    if (
      ns.type == "ClassDeclaration" &&
      ns.superClass &&
      ns.superClass !== true
    ) {
      const found = ns.superClass
        .map((cls) => checkOne(cls, decls, name))
        .filter((n): n is NonNullable<typeof n> => n != null)
        .flat(1);
      return found.length ? found : null;
    }
  }
  return null;
}

function sameStateNodeDecl(a: StateNodeDecl | null, b: StateNodeDecl | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!isStateNode(a) || a.type !== b.type) return false;
  return (
    a.node === b.node ||
    a.type === "Program" ||
    (a.type === "ModuleDeclaration" && a.fullName === b.fullName)
  );
}

function sameLookupDefinition(a: LookupDefinition, b: LookupDefinition) {
  return (
    // sameStateNodeDecl(a.parent, b.parent) &&
    sameArrays(a.results, b.results, (ar, br) => sameStateNodeDecl(ar, br))
  );
}

export function sameLookupResult(a: LookupDefinition[], b: LookupDefinition[]) {
  return sameArrays(a, b, sameLookupDefinition);
}

function resolveUsing(
  using: ImportUsing,
  state: ProgramStateLive,
  stack: ProgramStateStack
) {
  const { usings, ...base } = stack[0];
  const [, results] = lookup(
    state,
    "decls",
    using.node.id,
    null,
    [base],
    false
  );
  if (
    results &&
    results.length == 1 &&
    results[0].results.length == 1 &&
    results[0].results[0].type == "ModuleDeclaration"
  ) {
    using.module = results[0].results[0];
  }
}
/**
 *
 * @param state    - The ProgramState
 * @param decls    - The field to use to look things up. either "decls" or "type_decls"
 * @param node     - The node to lookup
 * @param name     - Overrides the name of the node.
 * @param stack    - if provided, use this stack, rather than the current
 *                   state.stack for the lookup
 * @param nonlocal - when true, a plain identifier will be looked up as a
 *                   non-local. This is needed when looking up a callee.
 *                   If the callee is a MemberExpression, the flag is ignored.
 * @returns
 */
function lookup(
  state: ProgramStateLive,
  decls: DeclKind,
  node: mctree.Node,
  name?: string | null | undefined,
  maybeStack?: ProgramStateStack,
  nonlocal?: boolean
): LookupResult {
  const stack = maybeStack || state.stack;
  switch (node.type) {
    case "MemberExpression": {
      if (node.property.type != "Identifier" || node.computed) break;
      const propName = node.property.name;
      let result;
      if (node.object.type === "ThisExpression") {
        [, result] = lookup(state, decls, node.property, name, stack, true);
      } else {
        const [, results] = lookup(
          state,
          decls,
          node.object,
          name,
          stack,
          false
        );
        if (!results) break;

        result = results.reduce<LookupDefinition[] | null>(
          (current, lookupDef) => {
            const items = lookupDef.results
              .map((module) => {
                const res = checkOne(module, decls, propName);
                return res ? { parent: module, results: res } : null;
              })
              .filter((r): r is NonNullable<typeof r> => r != null);
            if (!items.length) return current;
            return current ? current.concat(items) : items;
          },
          null
        );
      }
      if (result) {
        return [name || propName, result];
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
          return [
            name || (si.name as string),
            [{ parent: i ? stack[i - 1] : null, results: [si] }],
          ];
        }
      }
      break;
    }
    case "Identifier": {
      if (node.name == "$") {
        return [name || node.name, [{ parent: null, results: [stack[0]] }]];
      }
      let result: LookupResult | undefined;
      for (let i = stack.length; i--; ) {
        const si = stack[i];
        if (
          !nonlocal ||
          si.type == "ModuleDeclaration" ||
          si.type == "ClassDeclaration" ||
          si.type == "Program"
        ) {
          if (!result) {
            const results = checkOne(si, decls, node.name);
            if (results) {
              result = [name || node.name, [{ parent: si, results }]];
              if (
                si.type === "BlockStatement" ||
                si.type === "FunctionDeclaration"
              ) {
                // Locals are always highest priority. If its not a local
                // we have to keep going to see if something got imported,
                // in which case *that* will take priority.
                return result;
              }
            }
          }
          if (hasProperty(si.usings, node.name)) {
            const using = si.usings[node.name];
            if (!using.module) {
              resolveUsing(using, state, stack);
            }
            if (!using.module) break;
            return [
              name || node.name,
              [{ parent: si, results: [using.module] }],
            ];
          }
          if (decls === "type_decls" && si.imports) {
            for (let i = si.imports.length; i--; ) {
              const using = si.imports[i];
              if (!using.module) {
                resolveUsing(using, state, stack);
              }
              if (using.module) {
                const results = checkOne(using.module, decls, node.name);
                if (results) {
                  return [name || node.name, [{ parent: si, results }]];
                }
              }
            }
          }
        }
      }
      if (result) return result;
      break;
    }
  }
  return [null, null];
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
  state.removeNodeComments = (node: mctree.Node, ast: mctree.Program) => {
    if (node.start && node.end && ast.comments && ast.comments.length) {
      let low = 0,
        high = ast.comments.length;
      while (high > low) {
        const mid = (low + high) >> 1;
        if (ast.comments[mid].start! < node.start) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      while (high < ast.comments.length && ast.comments[high].end! < node.end) {
        high++;
      }
      if (high > low) {
        ast.comments.splice(low, high - low);
      }
    }
  };

  state.lookup = (node, name, stack) =>
    lookup(state, state.inType ? "type_decls" : "decls", node, name, stack);

  state.lookupNonlocal = (node, name, stack) =>
    lookup(state, "decls", node, name, stack, true);

  state.lookupValue = (node, name, stack) =>
    lookup(state, "decls", node, name, stack);

  state.lookupType = (node, name, stack) =>
    lookup(state, "type_decls", node, name, stack);

  state.stackClone = () => state.stack.map((elm) => ({ ...elm }));

  state.inType = false;

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
              state.stack[0].node = node;
              break;
            case "TypeSpecList":
              state.inType = true;
              break;
            case "ImportModule":
            case "Using": {
              const [parent] = state.stack.slice(-1);
              if (!parent.usings) {
                parent.usings = {};
              }
              const name =
                (node.type === "Using" && node.as && node.as.name) ||
                (node.id.type === "Identifier"
                  ? node.id.name
                  : node.id.property.name);
              const using = { node };
              parent.usings[name] = using;
              if (node.type == "ImportModule") {
                if (!parent.imports) {
                  parent.imports = [using];
                } else {
                  const index = parent.imports.findIndex(
                    (using) =>
                      (using.node.id.type === "Identifier"
                        ? using.node.id.name
                        : using.node.id.property.name) === name
                  );
                  if (index >= 0) parent.imports.splice(index, 1);
                  parent.imports.push(using);
                }
              }
              break;
            }
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
              const name = "id" in node ? node.id && node.id.name : undefined;
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
                    (d): d is StateNode =>
                      isStateNode(d) && d[what] == elm[what]
                  );
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
                if (
                  node.type == "ModuleDeclaration" ||
                  node.type == "ClassDeclaration"
                ) {
                  if (!parent.type_decls) parent.type_decls = {};
                  if (!hasProperty(parent.type_decls, name)) {
                    parent.type_decls[name] = [];
                  }
                  parent.type_decls[name].push(elm);
                }
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
              state.inType = true;
              const name = node.id!.name;
              const [parent] = state.stack.slice(-1);
              if (!parent.type_decls) parent.type_decls = {};
              if (!hasProperty(parent.type_decls, name)) {
                parent.type_decls[name] = [];
              } else if (
                parent.type_decls[name].find(
                  (n) => (isStateNode(n) ? n.node : n) == node
                )
              ) {
                break;
              }
              parent.type_decls[name].push(
                node.type === "EnumDeclaration"
                  ? node
                  : {
                      type: "TypedefDeclaration",
                      node,
                      name,
                      fullName: parent.fullName + "." + name,
                    }
              );
              break;
            }
            case "VariableDeclaration": {
              const [parent] = state.stack.slice(-1);
              if (!parent.decls) parent.decls = {};
              const decls = parent.decls;
              const stack = state.stackClone();
              node.declarations.forEach((decl) => {
                const name = variableDeclarationName(decl.id);
                if (!hasProperty(decls, name)) {
                  decls[name] = [];
                } else if (
                  decls[name].find((n) => (isStateNode(n) ? n.node : n) == decl)
                ) {
                  return;
                }
                decl.kind = node.kind;
                pushUnique(decls[name], {
                  type: "VariableDeclarator",
                  node: decl,
                  name,
                  fullName: parent.fullName + "." + name,
                  stack,
                });
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
              state.inType = false;
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
            const type = node.type;
            if (state.post) ret = state.post(node, state);
            switch (type) {
              case "TypeSpecList":
              case "TypedefDeclaration":
              case "EnumDeclaration":
                state.inType = false;
                break;
              case "EnumStringBody":
                state.inType = true;
                break;
            }
            const [parent] = state.stack.slice(-1);
            if (parent.node === node) {
              delete parent.usings;
              delete parent.imports;
              if (node.type != "Program") {
                state.stack.pop();
              }
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
  post?: (
    node: mctree.Node
  ) => void | null | false | mctree.Node | mctree.Node[]
): false | void | null | mctree.Node | mctree.Node[] {
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
              if (!state) state = {};
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
          ...values.filter((obj, i) => deletions[i] !== true).flat(1)
        );
      }
    } else if (isMCTreeNode(value)) {
      const repl = traverseAst(value, pre, post);
      if (repl === false) {
        delete node[key as keyof mctree.Node];
      } else if (repl != null) {
        if (Array.isArray(repl)) {
          throw new Error("Array returned by traverseAst in Node context");
        }
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
  /*
   * The estree printer sometimes looks at the parent node without
   * checking that there *is* a parent node (eg it assumes all
   * BinaryExpressions have a parent node, and crashes if they don't).
   * To avoid issues, wrap nodes in an ParenthesizedExpression.
   * The printer knows that parentless ParenthesizedExpressions
   * should be ignored.
   */
  switch (node.type) {
    case "Program":
    case "BlockStatement":
    case "ExpressionStatement":
      break;
    default: {
      const e: mctree.ParenthesizedExpression = {
        type: "ParenthesizedExpression",
        expression: node as mctree.ExpressionStatement["expression"],
      };
      node = e;
    }
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
        "name" in node && typeof node.name === "string" ? node.name : undefined
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
