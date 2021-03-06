import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
  serializeMonkeyC,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import * as Prettier from "prettier";
import { hasProperty, traverseAst } from "./ast";
import { diagnostic } from "./inliner";
import { getLiteralNode } from "./mc-rewrite";
import { negativeFixups } from "./negative-fixups";
import {
  LookupDefinition,
  ProgramState,
  ProgramStateLive,
  ProgramStateNode,
  StateNode,
  StateNodeDecl,
  ClassStateNode,
  ModuleStateNode,
  ProgramStateStack,
  LookupResult,
  StateNodeDecls,
  ImportUsing,
  FunctionInfo,
  FunctionStateNode,
} from "./optimizer-types";
import { getSdkPath } from "./sdk-util";
import { pushUnique, sameArrays } from "./util";

export { visitReferences } from "./visitor";
export { traverseAst, hasProperty };

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
  state?: ProgramState,
  barrelList?: string[]
): Promise<ProgramStateNode | null> {
  // get the path to the currently active sdk
  const parser = MonkeyC.parsers.monkeyc;

  const sdk = await getSdkPath();

  const rezDecl = `module Rez { ${[
    "Drawables",
    "Fonts",
    "JsonData",
    "Layouts",
    "Menus",
    "Strings",
  ]
    .map((s) => `  module ${s} {}\n`)
    .join("")}}`;

  const api =
    (await fs.readFile(`${sdk}bin/api.mir`))
      .toString()
      .replace(/\r\n/g, "\n")
      .replace(/^\s*\[.*?\]\s*$/gm, "")
      //.replace(/(COLOR_TRANSPARENT|LAYOUT_[HV]ALIGN_\w+) = (\d+)/gm, "$1 = -$2")
      .replace(/^(\s*type)\s/gm, "$1def ") +
    (barrelList || [])
      .map((name) => `module ${name} { ${rezDecl} }`)
      .concat(rezDecl)
      .join("");

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
      const value = isStateNode(vs) ? vs.node : vs;
      if (
        !value ||
        (value.type !== "EnumStringMember" &&
          (value.type !== "VariableDeclarator" || value.kind != "const"))
      ) {
        throw `Negative constant ${fixup} did not refer to a constant`;
      }
      const init = getLiteralNode(value.init);
      if (!init || init.type !== "Literal") {
        throw `Negative constant ${fixup} was not a Literal`;
      }
      if (typeof init.value !== "number") {
        console.log(`Negative fixup ${fixup} was not a number!`);
      } else if (init.value > 0) {
        init.value = -init.value;
        init.raw = "-" + init.raw;
      } else {
        // console.log(`Negative fixup ${fixup} was already negative!`);
      }
    });
    return result;
  } catch (e) {
    console.error(`${e}`);
    return null;
  }
}

export function isStateNode(node: StateNodeDecl): node is StateNode {
  return hasProperty(node, "node");
}

export function variableDeclarationName(
  node: mctree.TypedIdentifier | mctree.InstanceofIdentifier
) {
  return ("left" in node ? node.left : node).name;
}

type DeclKind = "decls" | "type_decls";

function lookupToStateNodeDecls(results: LookupDefinition[]) {
  return results.reduce<StateNodeDecl[] | null>(
    (result, current) =>
      current.results.length
        ? result
          ? result.concat(current.results)
          : current.results
        : result,
    null
  );
}

function checkOne(
  state: ProgramStateLive,
  ns: StateNode,
  decls: DeclKind,
  node: mctree.Identifier,
  isStatic: boolean
): StateNodeDecl[] | null | false {
  // follow the superchain, looking up node in each class
  const superChain = (cls: ClassStateNode): StateNodeDecl[] | null => {
    if (!cls.superClass || cls.superClass === true) {
      return null;
    }
    return cls.superClass.reduce<StateNodeDecl[] | null>((result, sup) => {
      const sdecls = sup[decls];
      const next = hasProperty(sdecls, node.name)
        ? sdecls[node.name]
        : superChain(sup);
      return next ? (result ? result.concat(next) : next) : result;
    }, null);
  };
  const lookupInContext = (ns: ClassStateNode | ModuleStateNode) => {
    const [, lkup] = lookup(state, decls, node, null, ns.stack);
    return lkup && lookupToStateNodeDecls(lkup);
  };
  // follow the superchain, looking up node in each class's scope
  const superChainScopes = (ns: ClassStateNode): StateNodeDecl[] | null => {
    const result = lookupInContext(ns);
    if (result) return result;
    if (!ns.superClass || ns.superClass === true) {
      return null;
    }
    return ns.superClass.reduce<StateNodeDecl[] | null>((result, sup) => {
      const next = superChainScopes(sup);
      return next ? (result ? result.concat(next) : next) : result;
    }, null);
  };

  const ndecls = ns[decls];
  if (hasProperty(ndecls, node.name)) {
    return ndecls[node.name];
  }
  switch (ns.type) {
    case "ClassDeclaration":
      if (!isStatic) {
        return superChain(ns) || superChainScopes(ns) || false;
      }
    // fall through
    case "ModuleDeclaration":
      return lookupInContext(ns) || false;
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

export function isLookupCandidate(node: mctree.MemberExpression) {
  return node.computed
    ? node.property.type === "UnaryExpression" &&
        node.property.operator === ":" &&
        node.property.argument
    : node.property.type === "Identifier" && node.property;
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
 *  - [string, LookupDefinition[]] - if the lookup succeeds
 *  - [false, false] - if the lookup fails, but its not an error because its not the kind of expression we can lookup
 *  - [null, null] - if the lookup fails unexpectedly.
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
      const property = isLookupCandidate(node);
      if (!property) break;
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
        if (results === false) break;
        if (!results) return [null, null];
        result = results.reduce<LookupDefinition[] | null>(
          (current, lookupDef) => {
            const items = lookupDef.results
              .map((module) => {
                if (!isStateNode(module)) {
                  return null;
                }
                const res = checkOne(state, module, decls, property, false);
                return res ? { parent: module, results: res } : null;
              })
              .filter((r): r is NonNullable<typeof r> => r != null);
            if (!items.length) return current;
            return current ? current.concat(items) : items;
          },
          null
        );
        if (
          !result &&
          results.some((ld) =>
            ld.results.some(
              (sn) =>
                (isStateNode(sn) && sn.fullName?.match(/^\$\.(\w+\.)?Rez\./)) ||
                sn.type === "VariableDeclarator" ||
                sn.type === "Identifier" ||
                sn.type === "BinaryExpression" ||
                (sn.type === "ClassDeclaration" &&
                  property.name === "initialize")
            )
          )
        ) {
          // - The Rez module can contain lots of things from the resource
          //   compiler which we don't track.
          // - Variables, and formal parameters would require type tracking
          //   which we don't yet do
          // - Its ok to call an undeclared initialize method.
          // Report them all as "expected failures".
          return [false, false];
        }
      }
      if (!result) return [null, null];
      return [name || property.name, result];
    }
    case "ThisExpression": {
      for (let i = stack.length; ; ) {
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
    }
    case "Identifier": {
      if (node.name == "$") {
        return [name || node.name, [{ parent: null, results: [stack[0]] }]];
      }
      let inStatic = false;
      let checkedImports = false;
      for (let i = stack.length; i--; ) {
        const si = stack[i];
        switch (si.type) {
          case "ClassDeclaration":
          case "ModuleDeclaration":
          case "Program":
            if (!checkedImports) {
              checkedImports = true;
              const results = findUsingForNode(
                state,
                stack,
                i,
                node,
                decls === "type_decls"
              );
              if (results) {
                return [name || node.name, [{ parent: si, results }]];
              }
            }
            break;
          case "FunctionDeclaration":
            inStatic = si.isStatic === true;
          // fall through
          default:
            if (nonlocal) continue;
            break;
        }

        const results = checkOne(state, si, decls, node, inStatic);
        if (results) {
          return [name || node.name, [{ parent: si, results }]];
        } else if (results === false) {
          break;
        }
      }
      return [null, null];
    }
  }
  return [false, false];
}

export function collectNamespaces(
  ast: mctree.Program,
  stateIn?: ProgramState
): ProgramStateNode {
  const state = (stateIn || {}) as ProgramStateLive;
  if (!state.nextExposed) state.nextExposed = {};
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
        if ((ast.comments[mid].start || 0) < node.start) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      while (
        high < ast.comments.length &&
        (ast.comments[high].end || 0) < node.end
      ) {
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

  state.stackClone = () =>
    state.stack.map((elm) =>
      elm.type === "ModuleDeclaration" || elm.type === "Program"
        ? { ...elm }
        : elm
    );

  state.inType = 0;

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
            case "UnaryExpression":
              if (node.operator === ":" && !state.inType) {
                state.nextExposed[node.argument.name] = true;
              }
              break;
            case "AttributeList":
              return [];
            case "Program":
              if (state.stack.length != 1) {
                throw new Error("Unexpected stack length for Program node");
              }
              state.stack[0].node = node;
              break;
            case "TypeSpecList":
            case "TypeSpecPart":
              state.inType++;
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
            case "CatchClause":
              if (node.param) {
                const [parent] = state.stack.slice(-1);
                if (!parent.decls) parent.decls = {};
                const id =
                  node.param.type === "Identifier"
                    ? node.param
                    : node.param.left;
                state.stack.push({
                  type: "BlockStatement",
                  fullName: undefined,
                  name: undefined,
                  node: node.body,
                  decls: { [id.name]: [id] },
                });
              }
              break;
            case "ForStatement":
              if (node.init && node.init.type === "VariableDeclaration") {
                state.stack.push({
                  type: "BlockStatement",
                  fullName: undefined,
                  name: undefined,
                  node: node,
                });
              }
              break;
            case "BlockStatement": {
              const [parent] = state.stack.slice(-1);
              if (
                parent.node === node ||
                (parent.type != "FunctionDeclaration" &&
                  parent.type != "BlockStatement")
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
                  // Inject the class/module name into itself,
                  // so you can say Graphics.Graphics.Graphics.COLOR_RED
                  elm.decls = { [name]: [elm] };
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
              if (!node.id) {
                state.inType++;
                break;
              }
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
              state.inType++;
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
              if (state.inType !== 1) {
                throw new Error(
                  `Expected inType to be 1 at EnumStringBody. Got ${state.inType}.`
                );
              }
              state.inType--;
              const [parent] = state.stack.slice(-1);
              const values = parent.decls || (parent.decls = {});
              let prev: number | bigint = -1;
              node.members.forEach((m, i) => {
                if (m.type == "Identifier") {
                  if (typeof prev === "bigint") {
                    prev += 1n;
                  } else {
                    prev += 1;
                  }
                  m = node.members[i] = {
                    type: "EnumStringMember",
                    loc: m.loc,
                    start: m.start,
                    end: m.end,
                    id: m,
                    init: {
                      type: "Literal",
                      value: prev,
                      raw:
                        prev.toString() + (typeof prev === "bigint" ? "l" : ""),
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
                  prev = init.value as number | bigint;
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
              case "TypeSpecPart":
              case "TypeSpecList":
              case "TypedefDeclaration":
              case "EnumDeclaration":
                state.inType--;
                break;
              case "EnumStringBody":
                state.inType++;
                break;
            }
            const [parent] = state.stack.slice(-1);
            if (
              parent.node === node ||
              // The pre function might cause node.body to be skipped,
              // so we need to check here, just in case.
              // (this actually happens with prettier-extenison-monkeyc's
              // findItemsByRange)
              (node.type === "CatchClause" && parent.node === node.body)
            ) {
              delete parent.usings;
              delete parent.imports;
              if (node.type != "Program") {
                state.stack.pop();
              }
            }
          }
          if (ret != null) {
            state.removeNodeComments(node, ast);
          }
          return ret;
        } catch (e) {
          handleException(state, node, e);
        }
      }
    );
  state.traverse(ast);
  if (state.inType) {
    throw new Error(`inType was non-zero on exit: ${state.inType}`);
  }
  if (state.stack.length != 1) {
    throw new Error("Invalid AST!");
  }
  if (state.stack[0].type != "Program") {
    throw new Error("Bottom of stack was not a Program!");
  }
  return state.stack[0];
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
  const source = (monkeyCSource || "") + "\n" + serializeMonkeyC(node);
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
        ? `${node.loc.source}:${node.loc.start.line || 0}:${
            node.loc.end.line || 0
          }`
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
  } catch (ex) {
    throw exception;
  }
  throw exception;
}

function findUsing(
  state: ProgramStateLive,
  stack: ProgramStateStack,
  using: ImportUsing
) {
  if (using.module) return using.module;
  let module = stack[0];
  const find = (node: mctree.ScopedName) => {
    let name;
    if (node.type == "Identifier") {
      name = node.name;
    } else {
      find(node.object);
      name = node.property.name;
    }
    if (hasProperty(module.decls, name)) {
      const decls = module.decls[name];
      if (
        decls &&
        decls.length === 1 &&
        decls[0].type === "ModuleDeclaration"
      ) {
        module = decls[0];
        return true;
      }
    }
    return false;
  };
  if (find(using.node.id)) {
    using.module = module as ModuleStateNode;
    return using.module;
  }

  if (state.config?.checkInvalidSymbols !== "OFF") {
    diagnostic(
      state,
      using.node.id.loc,
      `Unable to resolve import of ${formatAst(using.node.id)}`,
      state.config?.checkInvalidSymbols || "WARNING"
    );
  }
  return null;
}

export function findUsingForNode(
  state: ProgramStateLive,
  stack: ProgramStateStack,
  i: number,
  node: mctree.Identifier,
  isType: boolean
) {
  while (i >= 0) {
    const si = stack[i--];
    if (hasProperty(si.usings, node.name)) {
      const using = si.usings[node.name];
      const module = findUsing(state, stack, using);

      return module && [module];
    }
    if (si.imports && isType) {
      for (let j = si.imports.length; j--; ) {
        const using = si.imports[j];
        const module = findUsing(state, stack, using);

        if (module) {
          if (hasProperty(module.type_decls, node.name)) {
            return module.type_decls[node.name];
          }
        }
      }
    }
  }
  return null;
}

const invokeInfo: FunctionInfo | Record<string, never> = {};
const toyboxFnInfo: FunctionInfo | Record<string, never> = {};

export function getApiFunctionInfo(func: FunctionStateNode): FunctionInfo {
  if (
    func.fullName === "$.Toybox.Lang.Method.invoke" ||
    (func.node.params &&
      func.node.params.some(
        (param) =>
          param.type === "BinaryExpression" &&
          param.right.ts.some(
            (tsp) => tsp.type === "TypeSpecPart" && tsp.callspec
          )
      ))
  ) {
    if (!invokeInfo.calledFuncs) {
      invokeInfo.modifiedDecls = new Set();
      invokeInfo.calledFuncs = new Set();
      invokeInfo.callsExposed = true;
    }
    if (func.name === "initialize") {
      const top = func.stack![func.stack!.length - 1];
      if (top.type === "ClassDeclaration") {
        top.hasInvoke = true;
      }
    }
    return invokeInfo as FunctionInfo;
  }
  if (!toyboxFnInfo.calledFuncs) {
    toyboxFnInfo.modifiedDecls = new Set();
    toyboxFnInfo.calledFuncs = new Set();
    toyboxFnInfo.resolvedDecls = new Set();
  }
  return toyboxFnInfo as FunctionInfo;
}

export function markInvokeClassMethod(func: FunctionStateNode) {
  func.info = invokeInfo as FunctionInfo;
}
