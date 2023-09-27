import {
  LiteralIntegerRe,
  default as MonkeyC,
  mctree,
  serializeMonkeyC,
} from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import * as Prettier from "prettier";
import { getLiteralNode, hasProperty, traverseAst } from "./ast";
import { JungleResourceMap } from "./jungles";
import { analyze } from "./mc-rewrite";
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
  PreDiagnostic,
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
import { TypeMap } from "./type-flow/interp";
import { findObjectDeclsByProperty } from "./type-flow/type-flow-util";
import { getStateNodeDeclsFromType, typeFromLiteral } from "./type-flow/types";
import { log, pushUnique, sameArrays } from "./util";

export { visitReferences, visitorNode } from "./visitor";
export { hasProperty, traverseAst, visit_resources };

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
): Promise<ProgramStateNode> {
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
    .replace(/^(\s*static)?\s*<init>\s*\{\s*\}\s*?\n/gm, "")
    .replace(/^(\s*type)\s/gm, "$1def ");

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
      if (!Array.isArray(decls) || decls.length !== 1 || !decls[0]) {
        throw `Failed to find and fix negative constant ${fixup}`;
      }
      return decls[0];
    }, result);
    const value = isStateNode(vs) ? vs.node : vs;
    if (
      !value ||
      (value.type !== "EnumStringMember" &&
        (value.type !== "VariableDeclarator" || value.kind !== "const"))
    ) {
      throw `Negative constant ${fixup} did not refer to a constant`;
    }
    const init = getLiteralNode(value.init);
    if (!init || init.type !== "Literal") {
      throw `Negative constant ${fixup} was not a Literal`;
    }
    if (typeof init.value !== "number") {
      log(`Negative fixup ${fixup} was not a number!`);
    } else if (init.value > 0) {
      init.value = -init.value;
      init.raw = "-" + init.raw;
    } else {
      // log(`Negative fixup ${fixup} was already negative!`);
    }
  });
  return result;
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
  // follow the super chain, looking up node in each class
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
  // follow the super chain, looking up node in each class's scope
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

function declKey(decl: StateNodeDecl) {
  return isStateNode(decl)
    ? decl.type === "ModuleDeclaration"
      ? decl.fullName
      : decl.node
    : decl;
}

export function lookupResultContains(
  a: LookupDefinition[],
  b: LookupDefinition[]
) {
  if (!b.length) return false;
  const bs = new Set(b.flatMap((bdef) => bdef.results.map(declKey)));
  return a.some((adef) => adef.results.some((adecl) => bs.has(declKey(adecl))));
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
  maybeStack?: ProgramStateStack | null,
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
        const si = stack[--i].sn;
        if (
          si.type === "ModuleDeclaration" ||
          si.type === "ClassDeclaration" ||
          !i
        ) {
          return [
            name || (si.name as string),
            [{ parent: i ? stack[i - 1].sn : null, results: [si] }],
          ];
        }
      }
    }
    case "Identifier": {
      if (node.name === "$") {
        return [name || node.name, [{ parent: null, results: [stack[0].sn] }]];
      }
      let inStatic = false;
      let checkedImports = ignoreImports;
      let imports = null;
      for (let i = stack.length; i--; ) {
        const si = stack[i].sn;
        switch (si.type) {
          case "ClassDeclaration":
            if (inStatic && state.config?.enforceStatic !== "NO") {
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
          const imp = imports;
          if (state.config?.checkInvalidSymbols !== "OFF") {
            diagnostic(
              state,
              node,
              formatAst(node).then(
                (nodeStr) =>
                  `${nodeStr} is ambiguous and exists in multiple imported modules [${imp
                    .map(({ name }) => name)
                    .join(", ")}]`
              ),
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
        if (imports.length === 1) {
          if (decls !== "type_decls") {
            if (state.config?.checkCompilerLookupRules !== "OFF") {
              diagnostic(
                state,
                node,
                formatAst(node).then(
                  (nodeStr) =>
                    `${nodeStr} will only be found when compiled with compiler2 at -O1 or above`
                ),
                state.config?.checkCompilerLookupRules || "WARNING",
                {
                  uri: "https://github.com/markw65/monkeyc-optimizer/wiki/Compiler1-vs-Compiler2-lookup-rules",
                  message: "more info",
                }
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

export function lookupWithType(
  state: ProgramStateAnalysis,
  node: mctree.Node,
  typeMap: TypeMap | undefined | null,
  nonLocal = false,
  stack: ProgramStateStack | null = null
): LookupResult {
  const results = nonLocal
    ? state.lookupNonlocal(node, null, stack)
    : state.lookup(node, null, stack);
  if (results[1] || !typeMap) return results;
  if (node.type === "MemberExpression" && !node.computed) {
    const objectType = typeMap.get(node.object);
    if (!objectType) return results;
    const [, decls] = findObjectDeclsByProperty(state, objectType, node);
    if (decls) {
      const next = lookupNext(
        state,
        [{ parent: null, results: decls }],
        "decls",
        node.property
      );
      if (next) {
        return [node.property.name, next];
      }
    }
  } else if (node.type === "Literal") {
    const type = typeFromLiteral(node);
    const results = getStateNodeDeclsFromType(state, type);
    return [node.raw, [{ parent: null, results }]];
  } else if (node.type === "UnaryExpression" && node.operator === ":") {
    return [
      node.argument.name,
      [
        {
          parent: null,
          results: lookupByFullName(state, "Toybox.Lang.Symbol") as StateNode[],
        },
      ],
    ];
  }
  return results;
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
      return this.stack.slice();
    },

    top() {
      return this.stack[this.stack.length - 1];
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
                  return (this.pre && this.pre(node, this)) ?? ["object"];
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
                if (this.stack.length !== 1) {
                  throw new Error("Unexpected stack length for Program node");
                }
                this.stack[0].sn.node = node;
                break;
              case "TypeSpecList":
              case "TypeSpecPart":
                this.inType++;
                break;
              case "ImportModule":
              case "Using": {
                const parent = { ...this.stack.pop()! };
                this.stack.push(parent);
                parent.usings = parent.usings ? { ...parent.usings } : {};
                const name =
                  (node.type === "Using" && node.as && node.as.name) ||
                  (node.id.type === "Identifier"
                    ? node.id.name
                    : node.id.property.name);
                const using = { node };
                parent.usings[name] = using;
                if (node.type === "ImportModule") {
                  if (!parent.imports) {
                    parent.imports = [using];
                  } else {
                    parent.imports = parent.imports.slice();
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
                  const parent = this.top().sn;
                  if (!parent.decls) parent.decls = {};
                  const id =
                    node.param.type === "Identifier"
                      ? node.param
                      : node.param.left;
                  this.stack.push({
                    sn: {
                      type: "BlockStatement",
                      fullName: parent.fullName,
                      name: undefined,
                      node: node.body,
                      decls: { [id.name]: [id] },
                      attributes: StateNodeAttributes.NONE,
                    },
                  });
                }
                break;
              case "ForStatement":
                if (node.init && node.init.type === "VariableDeclaration") {
                  this.stack.push({
                    sn: {
                      type: "BlockStatement",
                      fullName: this.top().sn.fullName,
                      name: undefined,
                      node: node,
                      attributes: StateNodeAttributes.NONE,
                    },
                  });
                }
                break;
              case "BlockStatement": {
                const parent = this.top().sn;
                if (
                  parent.node === node ||
                  (parent.type !== "FunctionDeclaration" &&
                    parent.type !== "BlockStatement")
                ) {
                  break;
                }
                // fall through
              }
              case "ClassDeclaration":
              case "FunctionDeclaration":
              case "ModuleDeclaration": {
                const parent = this.top().sn;
                const name = "id" in node ? node.id && node.id.name : undefined;
                const fullName = this.stack
                  .map((e) => e.sn.name)
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
                this.stack.push({ sn: elm });
                if (name) {
                  if (!parent.decls) parent.decls = {};
                  if (hasProperty(parent.decls, name)) {
                    const what =
                      node.type === "ModuleDeclaration" ? "type" : "node";
                    const e = parent.decls[name].find(
                      (d): d is StateNode =>
                        isStateNode(d) && d[what] === elm[what]
                    );
                    if (e != null) {
                      e.node = node;
                      this.top().sn = e;
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
                    node.type === "ModuleDeclaration" ||
                    node.type === "ClassDeclaration"
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
                const parent = this.top().sn;
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
                const parent = this.top().sn;
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
                const parent = this.top().sn;
                if (!parent.decls) parent.decls = {};
                const decls = parent.decls;
                const stack = this.stackClone();
                node.declarations.forEach((decl) => {
                  const name = variableDeclarationName(decl.id);
                  if (!hasProperty(decls, name)) {
                    decls[name] = [];
                  } else if (
                    decls[name].find(
                      (n) => (isStateNode(n) ? n.node : n) === decl
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
                  if (node.kind === "const") {
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
                const parent = this.top().sn;
                const values = parent.decls || (parent.decls = {});
                let prev: number | bigint = -1;
                node.members.forEach((m, i) => {
                  if (m.type === "Identifier") {
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
                  if (init !== m.init) {
                    if (m.init.enumType) {
                      init.enumType = m.init.enumType;
                    }
                    m.init = init;
                  }
                  if (
                    init.type === "Literal" &&
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
              const parent = this.top();
              if (
                parent.sn.node === node ||
                // The pre function might cause node.body to be skipped,
                // so we need to check here, just in case.
                // (this actually happens with prettier-extension-monkeyc's
                // findItemsByRange)
                (node.type === "CatchClause" && parent.sn.node === node.body)
              ) {
                let top = this.stack.pop()!;
                if (node.type === "Program") {
                  top = { ...top };
                  delete top.usings;
                  delete top.imports;
                  this.stack.push(top);
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
        sn: {
          type: "Program",
          name: "$",
          fullName: "$",
          node: undefined,
          attributes: StateNodeAttributes.NONE,
        },
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
  if (state.stack.length !== 1) {
    throw new Error("Invalid AST!");
  }
  if (state.stack[0].sn.type !== "Program") {
    throw new Error("Bottom of stack was not a Program!");
  }
  return state.stack[0].sn;
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
      return Promise.resolve("{}");
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
  return Promise.resolve(
    Prettier.format(source, {
      ...(options || {}),
      parser: "monkeyc-json",
      plugins: [MonkeyC],
      endOfLine: "lf",
    })
  );
}

function findNamesInExactScope(decl: StateNode, regexp: RegExp) {
  if (!decl.decls) return [];
  return Object.entries(decl.decls).flatMap(([name, decls]) =>
    regexp.test(name) ? { name, decls } : []
  );
}

export function findNamesInScope(
  declStack: StateNode[][],
  pattern: string | RegExp
) {
  const regex =
    typeof pattern === "string"
      ? new RegExp(pattern.replace(/\W/g, "").split("").join(".*"), "i")
      : pattern;
  const results = new Map<
    string,
    Map<number, Array<{ decl: StateNodeDecl; parent: StateNode }>>
  >();
  const helper = (decls: StateNode[], depth: number) => {
    decls.forEach((parent) => {
      if (parent.type === "ClassDeclaration") {
        if (parent.superClass && parent.superClass !== true) {
          helper(parent.superClass, depth);
        }
      }
      findNamesInExactScope(parent, regex).forEach(({ name, decls }) => {
        let names = results.get(name);
        if (!names) {
          results.set(name, (names = new Map()));
        }
        names.set(
          depth,
          decls.map((decl) => ({ decl, parent }))
        );
      });
    });
  };
  let depth = 0;
  while (depth < declStack.length) {
    helper(declStack[declStack.length - 1 - depth], depth);
    depth++;
  }
  return Array.from(results.values())
    .map((m) =>
      Array.from(m).map(([depth, entries]) =>
        entries.map(({ decl, parent }) => [decl, { parent, depth }] as const)
      )
    )
    .flat(2);
}

export function mapVarDeclsByType(
  state: ProgramStateAnalysis,
  decls: StateNodeDecl[],
  node: mctree.Node,
  typeMap: TypeMap | null | undefined
) {
  return decls.flatMap((decl): StateNodeDecl | StateNodeDecl[] => {
    if (
      decl.type === "VariableDeclarator" ||
      decl.type === "Identifier" ||
      decl.type === "BinaryExpression"
    ) {
      const type = typeMap?.get(node);
      return type ? getStateNodeDeclsFromType(state, type) : [];
    }
    return decl;
  });
}

export function formatScopedName(
  node: mctree.ScopedName | mctree.ThisExpression
): string {
  if (node.type === "ThisExpression") return node.text;
  if (node.type === "Identifier") return node.name;
  return `${formatScopedName(node.object)}.${node.property.name}`;
}

export function formatAstLongLines(node: mctree.Node) {
  return formatAst(node, null, { printWidth: 10000 });
}

export async function createDocumentationMap(
  functionDocumentation: { name: string; parent: string; doc: string }[]
) {
  const docMap = new Map<string, string>();
  const state = await analyze({}, {}, undefined, {});
  functionDocumentation.forEach((info) => {
    state.allFunctions[info.name]?.forEach(
      (decl) =>
        decl.node?.loc?.source === "api.mir" &&
        decl.fullName.endsWith(`.${info.parent}.${info.name}`) &&
        docMap.set(
          decl.fullName,
          info.doc
            .replace(
              /@example\s*(.*?)<br\/>(.*?)(@|<div class|$)/g,
              (match, title, m1, m2) =>
                `\n#### Example: ${title}\n\`\`\`${m1.replace(
                  /<br\/>/g,
                  "\n"
                )}\`\`\`${m2}`
            )
            .replace(/(\*.*?)\s*<br\/>\s*(?!\s*\*)/g, "$1\n\n")
            .replace(/@note/g, "\n#### Note\n")
            .replace(/@see/, "\n#### See Also:\n$&")
            .replace(/@see\s+(.*?)(?=<br\/>)/g, "\n  * {$1}")
            .replace(/@throws/, "\n#### Throws:\n$&")
            .replace(/@throws\s+(.*?)(?=<br\/>)/g, "\n  * $1")
            .replace(/@option\s+\w+\s+(.*?)(?=<br\/>)/g, "\n  - $1")
            .replace(
              /@since\s+(.*?)(?=<br\/>)/,
              "\n#### Since:\nAPI Level $1\n"
            )
            .replace(/<div class="description">/, "### Description\n")
            .replace(/<div class="param">/, "\n#### Parameters\n$&")
            .replace(/<div class="param">/g, "  \n*")
            .replace(/\s*<div[^>]*>/g, "  \n\n")
            .replace(/\s*<br\/>\s*([@*])/g, "\n$1")
            //.replace(/\s\s\s(\s)*(?!\/\/)/g, "  \n")
            .replace(/<[^>]*>/g, "")
            .replace(/@/g, "  \n\n@")
            //.replace(/\s\*/g, "  \n*")
            .replace(/\+(\w+)\+/g, "`$1`")
            .trim()
            .replace(
              /\[((\s*(\w+::)+\w+\s*,)*(\s*(\w+::)+\w+\s*))\]/g,
              (arg, a1: string) => {
                return a1
                  .split(",")
                  .map((s) => {
                    const name = s.trim().replace(/::/g, ".");
                    const decl = lookupByFullName(state, name);
                    if (decl && decl.length === 1) {
                      const sn: StateNodeDecl & { name?: string } = decl[0];
                      const link = makeToyboxLink(sn);
                      return `[${sn.name || name}](${link})`;
                    }
                    return s;
                  })
                  .join(" or ");
              }
            )
            .replace(
              /\{(\s*(?:\w+::)+\w+(?:#\w+)?|https:\/\/\S+)\s*(\S.*?)?\s*\}/g,
              (arg, a1: string, a2: string) => {
                if (a1.startsWith("https://")) {
                  return `[${a2 || a1}](${a1})`;
                }
                let name = a1.trim().replace(/::|#/g, ".");
                if (!name.startsWith("Toybox")) {
                  name = `Toybox.${name}`;
                }
                const decl = lookupByFullName(state, name);
                if (decl && decl.length === 1) {
                  const link = makeToyboxLink(decl[0]);
                  return `[${a2 || a1}](${link})`;
                }
                return arg;
              }
            )
        )
    );
  });
  return docMap;
}

export function makeToyboxLink(result: StateNodeDecl) {
  const make_link = (fullName: string, fragment?: string) => {
    const path = fullName.split(".");
    return (
      `https://developer.garmin.com/connect-iq/api-docs/${path
        .slice(1, fragment ? -1 : undefined)
        .join("/")}.html` +
      (fragment ? `#${path.slice(-1)[0]}-${fragment}` : "")
    );
  };
  switch (result.type) {
    case "ClassDeclaration":
    case "ModuleDeclaration":
      if (result.fullName.startsWith("$.Toybox")) {
        return make_link(result.fullName);
      }
      break;

    case "FunctionDeclaration":
      return make_link(result.fullName, "instance_function");

    case "EnumStringMember":
      if (result.init.enumType && typeof result.init.enumType === "string") {
        return make_link("$." + result.init.enumType, "module");
      }
      break;

    case "EnumDeclaration":
      return make_link(result.fullName, "module");

    case "TypedefDeclaration":
      return make_link(result.fullName, "named_type");

    case "VariableDeclarator":
      return make_link(result.fullName, "var");
  }
  return null;
}

export function lookupByFullName(
  state: ProgramStateAnalysis,
  fullName: string
) {
  return fullName.split(".").reduce(
    (results: StateNodeDecl[], part) => {
      return results
        .flatMap((result) =>
          isStateNode(result)
            ? result.decls?.[part] || result.type_decls?.[part]
            : null
        )
        .filter((sn): sn is StateNodeDecl => !!sn);
    },
    [state.stack[0].sn]
  );
}

function handleException(
  state: ProgramStateLive,
  node: mctree.Node,
  exception: unknown
): never {
  try {
    const fullName = state.stack
      .map((e) => e.sn.name)
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
  let module = stack[0].sn;
  const find = (node: mctree.ScopedName) => {
    let name;
    if (node.type === "Identifier") {
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
      formatAst(using.node.id).then(
        (nodeStr) => `Unable to resolve import of ${nodeStr}`
      ),
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
              decls: { parent: si.sn, results: module.type_decls[node.name] },
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
      const top = func.stack![func.stack!.length - 1].sn;
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
  return v.stack[v.stack.length - 1]?.sn.type === "BlockStatement";
}

export function isClassVariable(v: VariableStateNode) {
  return v.stack[v.stack.length - 1]?.sn.type === "ClassDeclaration";
}

export function resolveDiagnostics(diagnostics?: PreDiagnostic[]) {
  return diagnostics
    ? Promise.all(
        diagnostics
          ?.filter((diagnostic) => typeof diagnostic.message !== "string")
          .map((diagnostic) => diagnostic.message)
      ).then(() => {
        const groups: Map<string, Diagnostic[]> = new Map();
        diagnostics.forEach((d) => {
          let key = `${d.loc.start.offset}:${d.loc.end.offset}`;
          if (d.related) {
            key +=
              ":" +
              d.related
                .map((r) => `${r.loc.start.offset}:${r.loc.end.offset}`)
                .join(":");
          }
          if (!d.message) {
            groups.delete(key);
          } else {
            const group = groups.get(key);
            if (!group) {
              groups.set(key, [d as Diagnostic]);
            } else {
              const index = group.findIndex((g) => g.message === d.message);
              if (index < 0) {
                group.push(d as Diagnostic);
              } else {
                group[index] = d as Diagnostic;
              }
            }
          }
        });
        diagnostics.splice(0);
        diagnostics.push(...Array.from(groups.values()).flat());
        return diagnostics as Diagnostic[];
      })
    : diagnostics;
}

export function resolveDiagnosticsMap(
  diagnosticsMap: Record<string, PreDiagnostic[]>
) {
  return Promise.all(
    Object.values(diagnosticsMap).map((diagnostics) =>
      resolveDiagnostics(diagnostics)
    )
  ).then(() => diagnosticsMap as Record<string, Diagnostic[]>);
}

export function diagnostic(
  state: ProgramState,
  node: mctree.Node,
  message: string | Promise<string> | null,
  type: DiagnosticType = "INFO",
  extra?: Diagnostic["extra"]
) {
  if (!state.diagnostics) state.diagnostics = {};
  diagnosticHelper(state.diagnostics, node, message, type, extra);
}

export function diagnosticHelper(
  diagnostics: Record<string, PreDiagnostic[]>,
  node: mctree.Node,
  message: string | Promise<string> | null,
  type: DiagnosticType = "INFO",
  extra: Diagnostic["extra"] | undefined
) {
  const loc = node.loc;
  if (!loc || !loc.source) return;
  const source = loc.source;
  if (!hasProperty(diagnostics, source)) {
    if (!message) return;
    diagnostics[source] = [];
  }
  const diags = diagnostics[source];
  const diag: PreDiagnostic = {
    type,
    loc,
    message:
      message == null
        ? null
        : typeof message === "string"
        ? message
        : message.then((m) => (diag.message = m)),
  };
  if (extra) {
    diag.extra = extra;
  }
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
  diags.push(diag);
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
