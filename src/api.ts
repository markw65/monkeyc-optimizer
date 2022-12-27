import {
  default as MonkeyC,
  LiteralIntegerRe,
  mctree,
  serializeMonkeyC,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import * as Prettier from "prettier";
import { getLiteralNode, hasProperty, traverseAst } from "./ast";
import { JungleResourceMap } from "./jungles";
import { negativeFixups } from "./negative-fixups";
import {
  ClassStateNode,
  Diagnostic,
  DiagnosticInfo,
  DiagnosticType,
  EnumStateNode,
  FunctionInfo,
  FunctionStateNode,
  ImportUsing,
  LookupDefinition,
  LookupResult,
  ModuleStateNode,
  ProgramState,
  ProgramStateAnalysis,
  ProgramStateLive,
  ProgramStateNode,
  ProgramStateStack,
  StateNode,
  StateNodeAttributes,
  StateNodeDecl,
  StateNodeDecls,
  TypedefStateNode,
  VariableStateNode,
} from "./optimizer-types";
import { add_resources_to_ast, visit_resources } from "./resources";
import { getSdkPath, xmlUtil } from "./sdk-util";
import { pushUnique, sameArrays } from "./util";

export { visitorNode, visitReferences } from "./visitor";
export { traverseAst, hasProperty, visit_resources };

/*
 * This is an unfortunate hack. I want to be able to extract things
 * like the types of all of a Class's variables (in particular the type
 * of each member of Activity.Info), and also map things like enum names
 * to their values (eg to take font names, and color names to their values).
 * The only place I can find this information is in api.mir, which is totally
 * undocumented. The same could be said of compiler.json and simulator.json,
 * but those are at least in a standard format.
 */

export function parseSdkVersion(version: string | undefined): number {
  if (!version) return 0;
  const match = version.match(/^(\d+)[._](\d+)[._](\d+)$/);
  if (!match) return 0;

  return (
    parseInt(match[1], 10) * 1000000 +
    parseInt(match[2], 10) * 1000 +
    parseInt(match[3], 10)
  );
}

export function checkCompilerVersion(version: string, sdkVer: number) {
  const match = version.match(
    /^(\d+[._]\d+[._]\d+)?([-_])?(\d+[._]\d+[._]\d+)?$/
  );
  if (
    !match ||
    (match[1] && match[3] && !match[2]) ||
    (!match[1] && !match[3])
  ) {
    return undefined;
  }
  const v1 = parseSdkVersion(match[1]);
  const v2 = parseSdkVersion(match[3]);
  if (v1) {
    if (v2) {
      return v1 <= sdkVer && sdkVer <= v2;
    }
    if (match[2]) {
      return v1 <= sdkVer;
    }
    return v1 === sdkVer;
  }
  return sdkVer <= v2;
}

// Extract all enum values from api.mir
export async function getApiMapping(
  state?: ProgramState,
  resourcesMap?: Record<string, JungleResourceMap>,
  manifestXML?: xmlUtil.Document
): Promise<ProgramStateNode | null> {
  // get the path to the currently active sdk
  const parser = MonkeyC.parsers.monkeyc;

  const sdk = await getSdkPath();
  if (state) {
    state.sdk = sdk;
    const match = state.sdk?.match(/-(\d+\.\d+\.\d+)/);
    if (match) {
      state.sdkVersion = parseSdkVersion(match[1]);
    }
  }

  const api = (await fs.readFile(`${sdk}bin/api.mir`))
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/^(\s*type)\s/gm, "$1def ");

  try {
    const ast = parser.parse(api, null, {
      filepath: "api.mir",
    }) as mctree.Program;
    if (resourcesMap) {
      const rezAst: mctree.Program = state
        ? state.rezAst || { type: "Program", body: [] }
        : ast;
      add_resources_to_ast(state, rezAst, resourcesMap, manifestXML);
      if (state) {
        state.rezAst = rezAst;
        state.manifestXML = manifestXML;
      }
    }
    const result = collectNamespaces(ast, state);
    if (state && state.rezAst) {
      collectNamespaces(state.rezAst, state);
    }
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

export function isStateNode(node: { type: string }): node is StateNode {
  return hasProperty(node, "node");
}

export function variableDeclarationName(
  node: mctree.TypedIdentifier | mctree.InstanceofIdentifier
) {
  return ("left" in node ? node.left : node).name;
}

type DeclKind = "decls" | "type_decls";

function stateNodeAttrs(attrs: mctree.FunctionDeclaration["attrs"]) {
  return attrs && attrs.access
    ? attrs.access.reduce((cur, attr) => {
        switch (attr) {
          case "static":
            return cur | StateNodeAttributes.STATIC;
          case "public":
            return cur | StateNodeAttributes.PUBLIC;
          case "protected":
            return cur | StateNodeAttributes.PROTECTED;
          case "hidden":
            return cur | StateNodeAttributes.PROTECTED;
          case "private":
            return cur | StateNodeAttributes.PRIVATE;
          default:
            return cur;
        }
      }, 0)
    : 0;
}

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
  node: mctree.Identifier
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
    const [, lkup] = lookup(state, decls, node, null, ns.stack, false, true);
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
      return superChain(ns) || superChainScopes(ns) || false;

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

export function lookupNext(
  state: ProgramStateLive,
  results: LookupDefinition[],
  decls: DeclKind,
  property: mctree.Identifier
) {
  return results.reduce<LookupDefinition[] | null>((current, lookupDef) => {
    const items = lookupDef.results
      .map((module) => {
        if (!isStateNode(module)) {
          return null;
        }
        const res = checkOne(state, module, decls, property);
        return res ? { parent: module, results: res } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r != null);
    if (!items.length) return current;
    return current ? current.concat(items) : items;
  }, null);
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
  nonlocal?: boolean,
  ignoreImports?: boolean
): LookupResult {
  const stack = maybeStack || state.stack;
  switch (node.type) {
    case "MemberExpression": {
      const property = isLookupCandidate(node);
      if (!property) break;
      let result;
      if (node.object.type === "ThisExpression") {
        [, result] = lookup(
          state,
          decls,
          node.property,
          name,
          stack,
          true,
          true
        );
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
        result = lookupNext(state, results, decls, property);
        if (
          !result &&
          results.some((ld) =>
            ld.results.some(
              (sn) =>
                sn.type === "VariableDeclarator" ||
                sn.type === "Identifier" ||
                sn.type === "BinaryExpression" ||
                (sn.type === "ClassDeclaration" &&
                  property.name === "initialize")
            )
          )
        ) {
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
        const si = stack[--i];
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
      let checkedImports = ignoreImports;
      let imports = null;
      for (let i = stack.length; i--; ) {
        const si = stack[i];
        switch (si.type) {
          case "ClassDeclaration":
            if (inStatic && state.config?.enforceStatic != "NO") {
              inStatic = false;
              if (hasProperty(si.decls, node.name)) {
                const r = si.decls[node.name].filter((s) => {
                  switch (s.type) {
                    case "FunctionDeclaration":
                    case "VariableDeclarator":
                    case "ClassDeclaration":
                      // In theory we should include EnumStringMember here too, but
                      // without adding an attributes field to EnumStringMember,
                      // or turning it into a StateNodeDecl, we don't know whether
                      // its static or not. But thats ok, because the optimizer
                      // will replace its use with its value, so the optimized
                      // code *will* work anyway.
                      return s.attributes & StateNodeAttributes.STATIC;
                    default:
                      return true;
                  }
                });
                if (r.length) {
                  return [name || node.name, [{ parent: si, results: r }]];
                }
              }
              continue;
            }
          // fall through
          case "ModuleDeclaration":
          case "Program":
            if (!checkedImports) {
              checkedImports = true;
              const results = findUsingForNode(state, stack, i, node);
              if (results) {
                if (Array.isArray(results)) {
                  if (!imports) imports = results;
                } else {
                  return [
                    name || node.name,
                    [{ parent: si, results: [results] }],
                  ];
                }
              }
            }
            break;
          case "FunctionDeclaration":
            inStatic = !!(si.attributes & StateNodeAttributes.STATIC);
          // fall through
          default:
            if (nonlocal) continue;
            break;
        }

        const results = checkOne(state, si, decls, node);
        if (results) {
          return [name || node.name, [{ parent: si, results }]];
        } else if (results === false) {
          break;
        }
      }
      if (imports) {
        if (imports.length > 1) {
          if (state.config?.checkInvalidSymbols !== "OFF") {
            diagnostic(
              state,
              node,
              `${formatAst(
                node
              )} is ambiguous and exists in multiple imported modules [${imports
                .map(({ name }) => name)
                .join(", ")}]`,
              state.config?.checkInvalidSymbols || "WARNING"
            );
          } else if (
            decls !== "type_decls" &&
            state.lookupRules === "COMPILER1"
          ) {
            return [null, null];
          }
          return [name || node.name, imports.map((d) => d.decls)];
        }
        if (imports.length == 1) {
          if (decls !== "type_decls") {
            if (state.config?.checkCompilerLookupRules !== "OFF") {
              diagnostic(
                state,
                node,
                `${formatAst(
                  node
                )} will only be found when compiled with compiler2 at -O1 or above`,
                state.config?.checkCompilerLookupRules || "WARNING"
              );
            } else if (state.lookupRules === "COMPILER1") {
              return [null, null];
            }
          }
          return [name || node.name, [imports[0].decls]];
        }
      }
      return [null, null];
    }
  }
  return [false, false];
}

function stateFuncs() {
  let currentEnum: EnumStateNode | null = null;

  return {
    removeNodeComments(node: mctree.Node, ast: mctree.Program) {
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
    },

    lookup(node, name, stack) {
      return lookup(
        this,
        this.inType ? "type_decls" : "decls",
        node,
        name,
        stack
      );
    },

    lookupNonlocal(node, name, stack) {
      return lookup(this, "decls", node, name, stack, true);
    },

    lookupValue(node, name, stack) {
      return lookup(this, "decls", node, name, stack);
    },

    lookupType(node, name, stack) {
      return lookup(this, "type_decls", node, name, stack);
    },

    stackClone() {
      return this.stack.map((elm) =>
        elm.type === "ModuleDeclaration" || elm.type === "Program"
          ? { ...elm }
          : elm
      );
    },

    traverse(root) {
      return traverseAst(
        root,
        (node) => {
          try {
            if (this.shouldExclude && this.shouldExclude(node)) {
              // don't visit any children, but do call post
              return [];
            }
            switch (node.type) {
              case "MemberExpression": {
                if (isLookupCandidate(node)) {
                  return (this.pre && this.pre(node, this)) || ["object"];
                }
                break;
              }
              case "UnaryExpression":
                if (node.operator === ":" && !this.inType) {
                  this.nextExposed[node.argument.name] = true;
                }
                break;
              case "AttributeList":
                return [];
              case "Program":
                if (this.stack.length != 1) {
                  throw new Error("Unexpected stack length for Program node");
                }
                this.stack[0].node = node;
                break;
              case "TypeSpecList":
              case "TypeSpecPart":
                this.inType++;
                break;
              case "ImportModule":
              case "Using": {
                const [parent] = this.stack.slice(-1);
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
                  const [parent] = this.stack.slice(-1);
                  if (!parent.decls) parent.decls = {};
                  const id =
                    node.param.type === "Identifier"
                      ? node.param
                      : node.param.left;
                  this.stack.push({
                    type: "BlockStatement",
                    fullName: undefined,
                    name: undefined,
                    node: node.body,
                    decls: { [id.name]: [id] },
                    attributes: 0,
                  });
                }
                break;
              case "ForStatement":
                if (node.init && node.init.type === "VariableDeclaration") {
                  this.stack.push({
                    type: "BlockStatement",
                    fullName: undefined,
                    name: undefined,
                    node: node,
                    attributes: 0,
                  });
                }
                break;
              case "BlockStatement": {
                const [parent] = this.stack.slice(-1);
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
                const [parent] = this.stack.slice(-1);
                const name = "id" in node ? node.id && node.id.name : undefined;
                const fullName = this.stack
                  .map((e) => e.name)
                  .concat(name)
                  .filter((e) => e != null)
                  .join(".");
                const elm = {
                  type: node.type,
                  name,
                  fullName,
                  node,
                  attributes:
                    node.type === "BlockStatement"
                      ? 0
                      : stateNodeAttrs(node.attrs),
                } as StateNode;
                this.stack.push(elm);
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
                      this.stack.splice(-1, 1, e);
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
                  break;
                }
                break;
              }
              // an EnumDeclaration doesn't create a scope, but
              // it does create a type (if it has a name)
              case "EnumDeclaration": {
                if (!node.id) {
                  this.inType++;
                  break;
                }
                const [parent] = this.stack.slice(-1);
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
                this.inType++;
                const name = node.id!.name;
                const [parent] = this.stack.slice(-1);
                if (!parent.type_decls) parent.type_decls = {};
                if (!hasProperty(parent.type_decls, name)) {
                  parent.type_decls[name] = [];
                } else if (
                  parent.type_decls[name].find(
                    (n) => (isStateNode(n) ? n.node : n) === node
                  )
                ) {
                  break;
                }
                const decl = {
                  type: node.type,
                  node,
                  name,
                  fullName: parent.fullName + "." + name,
                  attributes: stateNodeAttrs(node.attrs),
                  stack: this.stackClone(),
                } as TypedefStateNode | EnumStateNode;
                parent.type_decls[name].push(decl);
                if (decl.type === "EnumDeclaration") {
                  currentEnum = decl;
                }
                break;
              }
              case "VariableDeclaration": {
                const [parent] = this.stack.slice(-1);
                if (!parent.decls) parent.decls = {};
                const decls = parent.decls;
                const stack = this.stackClone();
                node.declarations.forEach((decl) => {
                  const name = variableDeclarationName(decl.id);
                  if (!hasProperty(decls, name)) {
                    decls[name] = [];
                  } else if (
                    decls[name].find(
                      (n) => (isStateNode(n) ? n.node : n) == decl
                    )
                  ) {
                    return;
                  }
                  decl.kind = node.kind;
                  decls[name].push({
                    type: "VariableDeclarator",
                    node: decl,
                    name,
                    fullName: parent.fullName + "." + name,
                    stack,
                    attributes: stateNodeAttrs(node.attrs),
                  });
                  if (node.kind == "const") {
                    if (!hasProperty(this.index, name)) {
                      this.index[name] = [];
                    }
                    pushUnique(this.index[name], parent);
                  }
                });
                break;
              }
              case "EnumStringBody": {
                if (this.inType !== 1) {
                  throw new Error(
                    `Expected inType to be 1 at EnumStringBody. Got ${this.inType}.`
                  );
                }
                this.inType--;
                const [parent] = this.stack.slice(-1);
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
                          prev.toString() +
                          (typeof prev === "bigint" ? "l" : ""),
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
                    if (m.init.enumType) {
                      init.enumType = m.init.enumType;
                    }
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
                  if (pushUnique(values[name], m) && currentEnum) {
                    if (!this.enumMap) this.enumMap = new Map();
                    this.enumMap.set(m, currentEnum);
                  }
                  if (!hasProperty(this.index, name)) {
                    this.index[name] = [];
                  }
                  pushUnique(this.index[name], parent);
                });
                break;
              }
            }
            if (this.pre) return this.pre(node, this);
          } catch (e) {
            handleException(this, node, e);
          }
          return null;
        },
        (node) => {
          try {
            let ret;
            if (this.shouldExclude && this.shouldExclude(node)) {
              // delete the node.
              ret = false as const;
            } else {
              const type = node.type;
              if (this.post) ret = this.post(node, this);
              switch (type) {
                case "EnumDeclaration":
                  currentEnum = null;
                // fall through
                case "TypeSpecPart":
                case "TypeSpecList":
                case "TypedefDeclaration":
                  this.inType--;
                  break;
                case "EnumStringBody":
                  this.inType++;
                  break;
              }
              const [parent] = this.stack.slice(-1);
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
                  this.stack.pop();
                }
              }
            }
            if (ret != null && node.loc && node.loc.source && this.fnMap) {
              const fnInfo = this.fnMap[node.loc.source];
              fnInfo && fnInfo.ast && this.removeNodeComments(node, fnInfo.ast);
            }
            return ret;
          } catch (e) {
            handleException(this, node, e);
          }
        }
      );
    },
  } as ProgramStateLive;
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
      {
        type: "Program",
        name: "$",
        fullName: "$",
        node: undefined,
        attributes: 0,
      },
    ];
  }
  if (!state.lookupRules) {
    const rules = state?.config?.compilerLookupRules || "DEFAULT";
    if (rules !== "COMPILER1" && rules !== "COMPILER2") {
      const match = state.sdk?.match(/-(\d+\.\d+\.\d+).(compiler2beta)?/i);
      if (match && (match[2] || parseSdkVersion(match[1]) >= 4001006)) {
        state.lookupRules = "COMPILER2";
      } else {
        state.lookupRules = "COMPILER1";
      }
    }
  }

  Object.assign(state, stateFuncs());

  state.inType = 0;

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
  monkeyCSource: string | null = null,
  options: Record<string, unknown> | null = null
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
    case "BlockStatement":
      if (node.body.length) break;
      return "{}";
    case "Program":
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
    ...(options || {}),
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
      using.node.id,
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
  node: mctree.Identifier
) {
  let imports = null;
  while (i >= 0) {
    const si = stack[i--];
    if (hasProperty(si.usings, node.name)) {
      const using = si.usings[node.name];
      return findUsing(state, stack, using);
    }
    if (si.imports) {
      for (let j = si.imports.length; j--; ) {
        const using = si.imports[j];
        const module = findUsing(state, stack, using);

        if (module) {
          if (hasProperty(module.type_decls, node.name)) {
            if (!imports) imports = [];
            imports.push({
              name: `${module.fullName}.${node.name}`,
              decls: { parent: si, results: module.type_decls[node.name] },
            });
          }
        }
      }
    }
  }
  return imports;
}

export function getApiFunctionInfo(
  state: ProgramState,
  func: FunctionStateNode
): FunctionInfo | false {
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
    if (!state.invokeInfo) {
      state.invokeInfo = {
        modifiedDecls: new Set(),
        calledFuncs: new Set(),
        callsExposed: true,
      };
    }
    if (func.name === "initialize") {
      const top = func.stack![func.stack!.length - 1];
      if (top.type === "ClassDeclaration") {
        top.hasInvoke = true;
      }
    }
    return state.invokeInfo;
  }
  return false;
}

export function markInvokeClassMethod(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  func.info = state.invokeInfo;
}

export function isLocal(v: VariableStateNode) {
  return v.stack[v.stack.length - 1]?.type === "BlockStatement";
}

export function diagnostic(
  state: ProgramState,
  node: mctree.Node,
  message: string | null,
  type: DiagnosticType = "INFO"
) {
  const loc = node.loc;
  if (!loc || !loc.source) return;
  const source = loc.source;
  if (!state.diagnostics) state.diagnostics = {};
  if (!hasProperty(state.diagnostics, source)) {
    if (!message) return;
    state.diagnostics[source] = [];
  }
  const diags = state.diagnostics[source];
  let index = diags.findIndex(
    (item) =>
      item.loc.start.offset === loc.start.offset &&
      item.loc.end.offset === loc.end.offset &&
      (!item.related
        ? !node.origins
        : item.related.length === node.origins?.length &&
          item.related.every(
            (r, i) =>
              r.loc.start.offset === node.origins![i].loc.start.offset &&
              r.loc.end.offset === node.origins![i].loc.end.offset &&
              r.loc.source === node.origins![i].loc.source
          ))
  );
  if (message) {
    if (index < 0) index = diags.length;
    const diag: Diagnostic = {
      type,
      loc,
      message,
    };
    if (node.origins) {
      diag.related = [];
      const related = diag.related;
      node.origins.forEach((origin) => {
        if (origin.loc.source) {
          related.push({
            loc: origin.loc as DiagnosticInfo["loc"],
            message: `inlined from ${origin.func}`,
          });
        }
      });
    }
    diags[index] = diag;
  } else if (index >= 0) {
    diags.splice(index, 1);
  }
}

export function getSuperClasses(klass: ClassStateNode) {
  if (klass.superClasses) return klass.superClasses;
  if (!klass.superClass || klass.superClass === true) return null;
  const superClasses = (klass.superClasses = new Set());
  klass.superClass.forEach((s) => {
    superClasses.add(s);
    const rest = getSuperClasses(s);
    if (rest) {
      rest.forEach((r) => superClasses.add(r));
    }
  });
  return superClasses;
}
