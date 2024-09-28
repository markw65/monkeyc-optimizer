import { default as MonkeyC, mctree } from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  diagnostic,
  formatAstLongLines,
  getApiFunctionInfo,
  getApiMapping,
  hasProperty,
  isLookupCandidate,
  isStateNode,
  markInvokeClassMethod,
  resolveDiagnosticsMap,
  variableDeclarationName,
  visitReferences,
} from "./api";
import {
  cloneDeep,
  getLiteralNode,
  getNodeValue,
  isExpression,
  makeScopedName,
  traverseAst,
  withLoc,
  withLocDeep,
} from "./ast";
import { unhandledType } from "./data-flow";
import {
  findCallees,
  findCalleesForNew,
  recordCalledFuncs,
  recordModifiedDecls,
  recordModifiedName,
  recordModifiedUnknown,
} from "./function-info";
import {
  InlineContext,
  inlinableSubExpression,
  inlineDiagnostic,
  inlineFunction,
  reportFailedInlining,
  shouldInline,
  unused,
} from "./inliner";
import { JungleResourceMap } from "./jungles";
import {
  BuildConfig,
  ByNameStateNodeDecls,
  ClassStateNode,
  Diagnostic,
  EnumStateNode,
  FilesToOptimizeMap,
  FunctionStateNode,
  LookupDefinition,
  ModuleStateNode,
  ProgramState,
  ProgramStateAnalysis,
  ProgramStateLive,
  ProgramStateOptimizer,
  StateNode,
  StateNodeAttributes,
  TypedefStateNode,
} from "./optimizer-types";
import { pragmaChecker } from "./pragma-checker";
import { sizeBasedPRE } from "./pre";
import { xmlUtil } from "./sdk-util";
import { buildTypeInfo } from "./type-flow";
import { couldBeWeak } from "./type-flow/could-be";
import {
  InterpState,
  evaluate,
  evaluateNode,
  preEvaluate,
} from "./type-flow/interp";
import { minimizeModules } from "./type-flow/minimize-modules";
import { afterEvaluate, beforeEvaluate } from "./type-flow/optimize";
import { subtypeOf } from "./type-flow/sub-type";
import { TypeTag, mcExprFromType, typeFromLiteral } from "./type-flow/types";
import { cleanupUnusedVars } from "./unused-exprs";
import { AwaitedError, pushUnique } from "./util";
import { renameIdentifier, renameVariable } from "./variable-renamer";

/*
 * Map each name to the list of StateNodes that declare that
 * name (excluding Functions, which are already in allFunctions)
 */
function collectDeclarationsByName(state: ProgramStateLive) {
  state.allDeclarations = {};
  const allDecls = state.allDeclarations;
  const helper = (sn: StateNode) => {
    if (
      sn.type === "ClassDeclaration" ||
      sn.type === "Program" ||
      sn.type === "ModuleDeclaration"
    ) {
      if (sn.decls) {
        Object.entries(sn.decls).forEach(([key, decls]) => {
          const keyed: ByNameStateNodeDecls[] = [];
          decls.forEach((decl) => {
            switch (decl.type) {
              case "ClassDeclaration":
              case "ModuleDeclaration":
                helper(decl);
              // fall through;
              case "VariableDeclarator":
              case "EnumStringMember":
              case "FunctionDeclaration":
                keyed.push(sn);
            }
          });
          if (keyed.length) {
            if (!hasProperty(allDecls, key)) {
              allDecls[key] = keyed;
            } else {
              allDecls[key].push(...keyed);
            }
          }
        });
      }
    }
  };
  helper(state.stack[0].sn);
}

function collectClassInfo(state: ProgramStateAnalysis) {
  const toybox = state.stack[0].sn.decls!["Toybox"][0] as ModuleStateNode;
  const lang = toybox.decls!["Lang"][0] as ModuleStateNode;
  const object = lang.decls!["Object"] as ClassStateNode[];
  const invalidSymbols = state.config?.checkInvalidSymbols ?? "WARNING";
  state.allClasses.forEach((elm) => {
    if (elm.stack![elm.stack!.length - 1].sn.type === "ClassDeclaration") {
      // nested classes don't get access to their contained
      // context. Put them in the global scope instead.
      elm.stack = elm.stack!.slice(0, 1);
      if (!hasProperty(state.nestedClasses, elm.name)) {
        state.nestedClasses[elm.name] = [];
      }
      state.nestedClasses[elm.name].push(elm);
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
      if (elm.superClass === true) {
        if (invalidSymbols !== "OFF") {
          diagnostic(
            state,
            elm.node,
            formatAstLongLines(elm.node.superClass).then(
              (superClass) =>
                `Unable to find super class ${superClass} for ${elm.fullName}`
            ),
            invalidSymbols
          );
        }
      } else if (name) {
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
    scls: ClassStateNode[] | true,
    seen: Set<ClassStateNode>
  ) => {
    if (scls === true) return;
    for (let i = scls.length; i--; ) {
      const c = scls[i];
      if (!c.decls) continue;
      if (seen.has(c)) {
        if (invalidSymbols !== "OFF") {
          diagnostic(
            state,
            cls.node,
            `Class ${cls.fullName}'s inheritance graph contains a cycle including ${c.fullName}`,
            invalidSymbols
          );
        }
        scls.splice(i, 1);
        continue;
      }
      Object.values(c.decls).forEach((funcs) => {
        funcs.forEach((f) => {
          if (
            f.type === "FunctionDeclaration" &&
            hasProperty(cls.decls, f.name)
          ) {
            f.node.hasOverride = true;
          }
        });
      });
      if (c.superClass) {
        seen.add(c);
        markOverrides(cls, c.superClass, seen);
        seen.delete(c);
      }
    }
  };

  state.allClasses.forEach((elm) => {
    if (elm.superClass) {
      const seen = new Set<ClassStateNode>();
      markOverrides(elm, elm.superClass, seen);
    }
    if (elm.hasInvoke && elm.decls) {
      Object.values(elm.decls).forEach((funcs) => {
        funcs.forEach((f) => {
          if (
            f.type === "FunctionDeclaration" &&
            !(f.attributes & StateNodeAttributes.STATIC)
          ) {
            markInvokeClassMethod(state, f);
          }
        });
      });
    }
  });
  state.allClasses.forEach((elm) => {
    if (
      elm.superClass &&
      elm.superClass !== true &&
      elm.superClass.length === 0
    ) {
      elm.superClass = true;
    }
  });
}

export function getFileSources(fnMap: FilesToOptimizeMap) {
  return Promise.all(
    Object.values(fnMap).map((value) => {
      if (value.monkeyCSource) return value.monkeyCSource;
      return fs
        .readFile(value.name)
        .then(
          (data) =>
            (value.monkeyCSource = data.toString().replace(/\r\n/g, "\n"))
        );
    })
  ).then(() => {
    return;
  });
}

export function getFileASTs(fnMap: FilesToOptimizeMap) {
  return getFileSources(fnMap).then(() =>
    Object.values(fnMap).reduce((ok, value) => {
      if (!value.ast && !value.parserError) {
        const options: Record<string, unknown> = {
          filepath: value.name,
        };
        if (/\.mss$/i.test(value.name)) {
          options.mss = value.barrel;
        }
        try {
          value.ast = MonkeyC.parsers.monkeyc.parse(
            value.monkeyCSource!,
            null,
            options
          ) as mctree.Program;
        } catch (e) {
          if (e instanceof Error) {
            value.parserError = e;
          } else {
            value.parserError = new Error("An unknown parser error occurred");
          }
        }
      }
      return value.parserError ? false : ok;
    }, true)
  );
}

export async function analyze(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document | undefined,
  config: BuildConfig,
  allowParseErrors?: boolean
) {
  let hasTests = false;
  let markApi = true;
  const preState: ProgramState = {
    fnMap,
    config,
    allFunctions: {},
    allClasses: [],
    nestedClasses: {},
    allModules: new Set(),
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
              if (attr.type !== "UnaryExpression") return drop;
              if (attr.argument.type !== "Identifier") return drop;
              if (hasProperty(excludeAnnotations, attr.argument.name)) {
                return true;
              }
              if (attr.argument.name === "test") {
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
    pre(node) {
      switch (node.type) {
        case "FunctionDeclaration":
        case "ModuleDeclaration":
        case "ClassDeclaration": {
          const scope = (this as ProgramStateAnalysis).top().sn;
          scope.stack = (this as ProgramStateAnalysis)
            .stackClone()
            .slice(0, -1);
          if (scope.type === "FunctionDeclaration") {
            if (markApi && node.loc?.source === "api.mir") {
              node.body = null;
              scope.info = getApiFunctionInfo(this, scope);
            }
            const allFuncs = this.allFunctions!;
            if (!hasProperty(allFuncs, scope.name)) {
              allFuncs[scope.name] = [scope];
            } else {
              allFuncs[scope.name].push(scope);
            }
          } else if (scope.type === "ClassDeclaration") {
            this.allClasses!.push(scope);
          } else if (scope.type === "ModuleDeclaration") {
            this.allModules!.add(scope);
          }
          break;
        }
      }
      return null;
    },
  };

  await getApiMapping(preState, resourcesMap, manifestXML);
  markApi = false;

  const state = preState as ProgramStateAnalysis;

  await getFileASTs(fnMap);
  Object.values(fnMap).forEach((value) => {
    const { ast, parserError } = value;
    if (!ast) {
      if (allowParseErrors) return;
      throw parserError || new Error(`Failed to parse ${value.name}`);
    }
    hasTests = false;
    collectNamespaces(ast, state);
    value.hasTests = hasTests;
  });

  delete state.shouldExclude;
  delete state.pre;

  collectDeclarationsByName(state);
  collectClassInfo(state);

  state.exposed = state.nextExposed;
  state.nextExposed = {};
  return state;
}

export function reportMissingSymbols(
  state: ProgramStateAnalysis,
  config?: BuildConfig
) {
  const diagnosticType =
    config?.checkInvalidSymbols !== "OFF"
      ? config?.checkInvalidSymbols || "WARNING"
      : null;
  const compiler2DiagnosticType =
    config?.checkCompilerLookupRules !== "OFF"
      ? config?.checkCompilerLookupRules || "WARNING"
      : null;
  if (
    diagnosticType &&
    !config?.compilerOptions?.includes("--Eno-invalid-symbol")
  ) {
    const checkTypes = config?.checkTypes?.toLowerCase() !== "off";
    const report = (ast: mctree.Program) => {
      visitReferences(state, ast, null, false, (node, results, error) => {
        if (node.type === "BinaryExpression" && node.operator === "has") {
          // Its not an error to check whether a property exists...
          return undefined;
        }
        if (!error) {
          if (
            state.sdkVersion === 4001006 &&
            compiler2DiagnosticType &&
            node.type === "MemberExpression" &&
            (node.object.type === "Identifier" ||
              node.object.type === "MemberExpression") &&
            results.some((result) => {
              const parent = result.parent;
              if (!parent || parent.type !== "ClassDeclaration") {
                return false;
              }
              return result.results.some((sn) => {
                switch (sn.type) {
                  case "VariableDeclarator":
                  case "FunctionDeclaration":
                    return (
                      sn.attributes &
                      (StateNodeAttributes.PRIVATE |
                        StateNodeAttributes.PROTECTED)
                    );
                }
                return false;
              });
            })
          ) {
            diagnostic(
              state,
              node,
              formatAstLongLines(node).then(
                (nodeStr) =>
                  `The expression ${nodeStr} will fail at runtime using sdk-4.1.6`
              ),
              compiler2DiagnosticType
            );
          }
          return undefined;
        }
        if (state.inType) {
          if (
            !checkTypes ||
            (node.type === "Identifier" && node.name.match(/^Void|Null$/))
          ) {
            return undefined;
          }
        }
        diagnostic(
          state,
          node,
          formatAstLongLines(node).then(
            (nodeStr) => `Undefined symbol ${nodeStr}`
          ),
          diagnosticType
        );
        return false;
      });
    };
    Object.values(state.fnMap).forEach((v) => v.ast && report(v.ast));
    state.rezAst && report(state.rezAst);
  }
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

function optimizeNode(istate: InterpState, node: mctree.Node) {
  if (istate.state.inlining) return null;
  if (istate.state.inType) {
    return null;
  }
  switch (node.type) {
    case "UpdateExpression":
      // we only evaluated any sub-expressions of the argument.
      evaluateNode(istate, node.argument);
      break;
    case "AssignmentExpression": {
      // we only evaluated any sub-expressions of the lhs.
      const right = istate.stack.pop()!;
      evaluateNode(istate, node.left);
      istate.stack.push(right);
      break;
    }
    case "BinaryExpression":
      if (
        node.operator === "has" &&
        node.right.type === "UnaryExpression" &&
        node.right.operator === ":"
      ) {
        // we skipped this node, so evaluate it now...
        istate.stack.push(evaluate(istate, node.right));
      }
      break;
  }
  const before = beforeEvaluate(istate, node);
  if (before != null) {
    if (!before) return false;
    const ret = afterEvaluate(istate, before);
    return ret ?? before;
  }

  evaluateNode(istate, node);

  return afterEvaluate(istate, node);
}

function evaluateFunction(
  istate: InterpState,
  func: mctree.FunctionDeclaration,
  args: mctree.Node[] | null
): mctree.Literal | null | false {
  if (
    !func.body ||
    istate.state.inlining ||
    (args && args.length !== func.params.length)
  ) {
    return false;
  }
  const paramValues =
    args &&
    Object.fromEntries(
      func.params.map((p, i) => [
        variableDeclarationName(p),
        args[i] as mctree.Expression,
      ])
    );
  let ret: mctree.Node | null = null;
  const body = args ? cloneDeep(func.body) : func.body;
  const depth = istate.stack.length;
  try {
    traverseAst(
      body,
      (node) => {
        switch (node.type) {
          case "BlockStatement":
          case "ReturnStatement":
          case "UnaryExpression":
          case "BinaryExpression":
          case "ConditionalExpression":
          case "LogicalExpression":
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
                return null;
              case "Identifier":
                if (hasProperty(paramValues, node.name)) {
                  istate.stack.push(
                    evaluate(istate, (node = paramValues[node.name]))
                  );
                  return node;
                }
              // fall through;
              default: {
                const repl = optimizeNode(istate, node) || node;
                if (repl.type === "Literal") return repl;
                throw new Error("Didn't optimize");
              }
            }
          }
    );
    delete istate.state.inlining;
    istate.stack.length = depth;
    return ret;
  } catch (e) {
    delete istate.state.inlining;
    istate.stack.length = depth;
    return false;
  }
}

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

export function optimizeMonkeyC(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document,
  config: BuildConfig
) {
  return optimizeMonkeyCHelper(fnMap, resourcesMap, manifestXML, config).catch(
    (ex: unknown) =>
      Promise.reject(ex instanceof AwaitedError ? ex.resolve() : ex)
  );
}

async function optimizeMonkeyCHelper(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document,
  config: BuildConfig
) {
  const state = (await analyze(
    fnMap,
    resourcesMap,
    manifestXML,
    config
  )) as ProgramStateOptimizer;
  state.localsStack = [{}];
  state.calledFunctions = {};
  state.usedByName = {};

  const checkLookupRules = config.checkCompilerLookupRules;
  config.checkCompilerLookupRules = "OFF";

  let again = false;
  const optimizeCallHelper = (
    istate: InterpState,
    call: mctree.CallExpression,
    node: InlineContext | null
  ) => {
    const result = optimizeCall(istate, call, node);
    if (result) {
      if (isExpression(result)) {
        const elem = istate.stack[istate.stack.length - 1];
        elem.node = result;
        if (result.type === "Literal") {
          elem.value = typeFromLiteral(result);
          elem.embeddedEffects = false;
        }
      }
      again = true;
    }
    return result;
  };

  const topLocals = (state: ProgramStateOptimizer) =>
    state.localsStack[state.localsStack.length - 1];
  /*
   * Does elm (a class) have a maybeCalled function called name,
   * anywhere in its superClass chain.
   */
  const checkInherited = (
    state: ProgramStateOptimizer,
    elm: ClassStateNode,
    name: string
  ): boolean =>
    elm.superClass === true ||
    (elm.superClass != null &&
      elm.superClass.some(
        (sc) =>
          (hasProperty(sc.decls, name) &&
            sc.decls[name].some(
              (f) =>
                isStateNode(f) &&
                f.type === "FunctionDeclaration" &&
                maybeCalled(state, f.node)
            )) ||
          (sc.superClass && checkInherited(state, sc, name))
      ));

  const renamer = (
    state: ProgramStateOptimizer,
    idNode: mctree.TypedIdentifier | mctree.InstanceofIdentifier
  ) => {
    const ident = idNode.type === "Identifier" ? idNode : idNode.left;
    const locals = topLocals(state);
    const { map } = locals;
    if (map) {
      const declName = ident.name;
      const name = renameVariable(state, locals, declName);
      if (name) {
        const [, results] = state.lookupValue(ident);
        if (!results) {
          throw new Error(
            `Didn't find local ${declName} which needed renaming`
          );
        }
        if (results.length !== 1) {
          throw new Error(
            `Lookup of local ${declName} found more than one result`
          );
        }
        const parent = results[0].parent;
        if (!parent) {
          throw new Error(`No parent in lookup of local ${declName}`);
        }
        const decls = parent.decls;
        if (!decls || !hasProperty(decls, declName)) {
          throw new Error(`Missing decls in lookup of local ${declName}`);
        }
        if (hasProperty(decls, name)) {
          throw new Error(
            `While renaming ${declName} to ${name}, there was already a variable ${name}`
          );
        }
        if (decls[declName].length === 1) {
          decls[name] = decls[declName];
          delete decls[declName];
        } else {
          let i = decls[declName].length;
          while (i--) {
            const decl = decls[declName][i];
            if (
              decl === idNode ||
              (decl.type === "VariableDeclarator" && decl.node.id === idNode)
            ) {
              decls[declName].splice(i, 1);
              decls[name] = [decl];
              break;
            }
          }
          if (i < 0) {
            throw new Error(
              `While renaming ${declName} to ${name}: Didn't find original declaration`
            );
          }
        }
        renameIdentifier(ident, name);
      } else {
        map[declName] = true;
      }
    }
  };

  // use this when optimizing initializer expressions,
  // outside of any function.
  const gistate: InterpState = { state, stack: [] };
  if (
    state.config?.checkTypes !== "OFF" &&
    state.config?.trustDeclaredTypes &&
    state.config.propagateTypes
  ) {
    gistate.typeChecker =
      state.config.strictTypeCheck?.toLowerCase() === "on"
        ? subtypeOf
        : couldBeWeak;
    gistate.checkTypes = state.config?.checkTypes || "WARNING";
  }

  // use this when type inference is enabled, and we're
  // inside a function.
  let istate: InterpState = gistate;

  state.pre = function (node) {
    const ret = preEvaluate(istate, node);
    switch (node.type) {
      case "EnumDeclaration":
        return ["body"];
      case "EnumStringBody":
        return ["members"];
      case "EnumStringMember":
        return ["init"];
      case "ForStatement": {
        const map = topLocals(this).map;
        if (map) {
          this.localsStack.push({ node, map: { ...map } });
        }
        break;
      }
      case "VariableDeclarator": {
        renamer(this, node.id);
        break;
      }
      case "CatchClause":
        if (node.param) {
          this.localsStack.push({
            node,
            map: { ...(topLocals(this).map || {}) },
          });
          renamer(this, node.param);
        }
        break;
      case "BinaryExpression":
        if (
          node.operator === "has" &&
          node.right.type === "UnaryExpression" &&
          node.right.operator === ":"
        ) {
          // Using `expr has :symbol` doesn't "expose"
          // symbol, and the rhs of an "as" isn't an
          // expression. In both cases, skip the rhs
          return ["left"];
        }
        break;
      case "Identifier": {
        const map = topLocals(this).map;
        if (hasProperty(map, node.name)) {
          const name = map[node.name];
          if (typeof name === "string") {
            renameIdentifier(node, name);
          }
          const [, results] = this.lookupValue(node);
          if (results) {
            if (results.length !== 1 || results[0].results.length !== 1) {
              throw new Error(`Local ${node.name} had multiple lookup results`);
            }
            const parent = results[0].parent;
            if (!parent) {
              throw new Error(`Local ${node.name} had no parent`);
            }
            const decl = results[0].results[0];
            if (
              parent.type === "FunctionDeclaration" ||
              decl.type !== "VariableDeclarator"
            ) {
              // we can't optimize away function or catch parameters
              return [];
            }
            if (parent.type !== "BlockStatement") {
              throw new Error(
                `Local ${node.name} was not declared at block scope(??)`
              );
            }
            decl.used = true;
          }
        }
        return [];
      }
      case "AssignmentExpression":
      case "UpdateExpression": {
        const lhs =
          node.type === "AssignmentExpression" ? node.left : node.argument;
        if (lhs.type === "Identifier") {
          const map = topLocals(this).map;
          if (map) {
            if (hasProperty(map, lhs.name)) {
              const name = map[lhs.name];
              if (typeof name === "string") {
                renameIdentifier(lhs, name);
              }
            }
          }
        } else if (lhs.type === "MemberExpression") {
          const object = this.traverse(lhs.object);
          if (object) {
            lhs.object = object as mctree.Expression;
          }
          if (!isLookupCandidate(lhs)) {
            const property = this.traverse(lhs.property);
            if (property) {
              lhs.property = property as mctree.Expression;
            }
          }
        }
        return node.type === "AssignmentExpression" ? ["right"] : [];
      }
      case "BlockStatement": {
        const map = topLocals(this).map;
        if (map) {
          this.localsStack.push({
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
        this.localsStack.push({ node, map });
        const [{ sn: parent }, { sn: self }] = this.stack.slice(-2);
        if (this.currentFunction) {
          throw new Error(
            `Nested functions: ${self.fullName} was activated during processing of ${this.currentFunction.fullName}`
          );
        }
        this.currentFunction = self as FunctionStateNode;
        const is =
          !this.config?.propagateTypes ||
          node.attrs?.attributes?.elements.find(
            (attr) =>
              attr.type === "UnaryExpression" &&
              attr.argument.name === "noConstProp"
          )
            ? null
            : buildTypeInfo(this, this.currentFunction, true);
        if (is) {
          /*
           * istate contains a copy of state, but we need the real
           * thing, because "state" is captured here.
           *
           * A better solution will be to separate out a
           * "lookup context", which will be a stack, plus a couple
           * of fields from state, and then pass that around.
           */
          is.state = this;
          if (
            this.config?.checkTypes !== "OFF" &&
            this.config?.trustDeclaredTypes
          ) {
            is.typeChecker = gistate.typeChecker;
            is.checkTypes = this.config?.checkTypes || "WARNING";
          }
          istate = is;
        }
        if (parent.type === "ClassDeclaration" && !maybeCalled(this, node)) {
          let used = false;
          if (node.id.name === "initialize") {
            used = true;
          } else if (parent.superClass) {
            used = checkInherited(this, parent, node.id.name);
          }
          if (used) {
            markFunctionCalled(this, node);
          }
        }
        // We don't want to call evaluateNode on
        // id, args or returnType
        return ["body"];
      }
      case "ClassDeclaration":
      case "ModuleDeclaration":
        // We don't want to call evaluateNode on
        // id, or superClass
        return ["body"];
    }
    return ret;
  };
  state.post = function (node) {
    const locals = topLocals(this);
    if (locals.node === node) {
      this.localsStack.pop();
    }
    const opt = optimizeNode(istate, node);
    if (opt != null) {
      return opt;
    }
    switch (node.type) {
      case "FunctionDeclaration":
        if (node.body && evaluateFunction(istate, node, null) !== false) {
          node.optimizable = true;
        }
        if (!this.currentFunction) {
          throw new Error(
            `Finished function ${
              this.top().sn.fullName
            }, but it was not marked current`
          );
        }
        this.currentFunction.info = this.currentFunction.next_info || false;
        delete this.currentFunction.next_info;
        delete this.currentFunction;
        if (istate.stack.length) {
          throw new Error("Stack was not empty");
        }
        istate = gistate;
        if (again) {
          again = false;
          const top = this.stack.pop();
          this.traverse(node);
          this.stack.push(top!);
        }
        break;
      case "BlockStatement":
      case "ForStatement":
        if (locals.map && cleanupUnusedVars(this, node) && !this.inlining) {
          again = true;
        }
        break;

      case "IfStatement": {
        const call = inlinableSubExpression(node.test);
        if (call) {
          return optimizeCallHelper(istate, call, node);
        }
        break;
      }

      case "ReturnStatement":
        if (node.argument && node.argument.type === "CallExpression") {
          return optimizeCallHelper(istate, node.argument, node);
        }
        break;

      case "Identifier":
        if (hasProperty(this.index, node.name)) {
          this.usedByName[node.name] = true;
        }
        break;
      case "MemberExpression": {
        const property = isLookupCandidate(node);
        if (property) {
          if (hasProperty(this.index, property.name)) {
            this.usedByName[property.name] = true;
          }
        }
        break;
      }
      case "NewExpression":
        if (this.currentFunction) {
          const [, results] = this.lookup(node.callee);
          if (results) {
            recordCalledFuncs(this.currentFunction, findCalleesForNew(results));
          } else {
            recordModifiedUnknown(this.currentFunction);
          }
        }
        break;

      case "CallExpression": {
        return optimizeCallHelper(istate, node, null);
      }

      case "VariableDeclaration": {
        const locals = topLocals(this);
        if (!locals.map) {
          if (again) {
            again = false;
            this.traverse(node);
          }
          break;
        }
        if (locals.node && locals.node.type === "BlockStatement") {
          let results: mctree.Statement[] | undefined;
          const declarations = node.declarations;
          let i = 0;
          let j = 0;
          while (i < node.declarations.length) {
            const decl = declarations[i++];
            if (!decl.init) continue;
            const call = inlinableSubExpression(decl.init);
            if (call) {
              const inlined = optimizeCallHelper(istate, call, decl);
              if (!inlined) continue;
              if (Array.isArray(inlined) || inlined.type !== "BlockStatement") {
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
          return optimizeCallHelper(istate, node.expression, node);
        } else if (node.expression.type === "AssignmentExpression") {
          const call = inlinableSubExpression(node.expression.right);
          if (call) {
            let ok = false;
            if (node.expression.left.type === "Identifier") {
              if (hasProperty(topLocals(this).map, node.expression.left.type)) {
                ok = true;
              }
            }
            if (!ok && node.expression.operator === "=") {
              const [, result] = this.lookup(node.expression.left);
              ok = !!result;
            }
            if (ok) {
              return optimizeCallHelper(istate, call, node.expression);
            }
          }
        } else {
          return unused(this, node.expression, true);
        }
        break;
      case "UpdateExpression": {
        // convert ++/-- to +=1/-=1, so that pre can "see" the 1
        const n = node as unknown as mctree.AssignmentExpression & {
          prefix?: boolean;
        };
        n.type = "AssignmentExpression";
        n.left = node.argument;
        n.right = withLoc(
          mcExprFromType({ type: TypeTag.Number, value: 1 })!,
          n.left
        );
        n.operator = node.operator === "++" ? "+=" : "-=";
        delete n.prefix;
        // fall through
      }
      case "AssignmentExpression":
        if (this.currentFunction) {
          const lhs =
            node.type === "AssignmentExpression" ? node.left : node.argument;
          const [, results] = this.lookup(lhs);
          if (results) {
            recordModifiedDecls(this.currentFunction, results);
          } else {
            const id = lhs.type === "Identifier" ? lhs : isLookupCandidate(lhs);
            if (id) {
              recordModifiedName(this.currentFunction, id.name);
            } else {
              recordModifiedUnknown(this.currentFunction);
            }
          }
        }
        break;
    }
    return null;
  };
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });

  enum Changes {
    None = 0,
    Some = 1,
    Force = 2,
  }
  const cleanupAll = (state: ProgramStateOptimizer) => {
    const usedDecls = findRezRefs(state);
    const pre = state.pre;
    const post = state.post;
    try {
      delete state.pre;
      return Object.values(fnMap).reduce((changes, f) => {
        state.post = function (node) {
          if (usedDecls.has(node)) {
            return null;
          }
          const ret = cleanup(this, node, f.ast!, usedDecls);
          if (ret === false) {
            changes |= Changes.Some;
            this.removeNodeComments(node, f.ast!);
          } else if (ret) {
            // If we replaced an enum with a union typedef, we should
            // reprocess everything to cleanup things like `42 as EnumType`
            // since there are places that Garmin's compiler will accept 42
            // but not accept `42 as EnumType`.
            if (
              node.type === "EnumDeclaration" &&
              ret.type === "TypedefDeclaration" &&
              ret.ts.argument.ts.length > 1
            ) {
              changes |= Changes.Force;
            } else {
              changes |= Changes.Some;
            }
          }
          return ret;
        };
        collectNamespaces(f.ast!, state);
        return changes;
      }, Changes.None);
    } finally {
      state.pre = pre;
      state.post = post;
    }
  };

  while (true) {
    state.usedByName = {};
    state.calledFunctions = {};
    state.exposed = state.nextExposed;
    state.nextExposed = {};
    Object.values(fnMap).forEach((f) => {
      collectNamespaces(f.ast!, state);
    });
    state.exposed = state.nextExposed;
    state.nextExposed = {};
    const changes = cleanupAll(state);
    if (
      changes & Changes.Force ||
      (changes & Changes.Some && state.config?.iterateOptimizer)
    ) {
      continue;
    }
    break;
  }

  delete state.pre;
  delete state.post;

  if (state.config?.minimizeModules ?? true) {
    Object.values(fnMap).forEach((f) => {
      minimizeModules(f.ast!, state);
    });
  }

  await Object.values(state.allFunctions).reduce(
    (promise, fns) =>
      fns.reduce(
        (promise, fn) => promise.then(() => sizeBasedPRE(state, fn)),
        promise
      ),
    Promise.resolve()
  );

  cleanupAll(state);
  config.checkCompilerLookupRules = checkLookupRules;
  reportMissingSymbols(state, config);
  Object.values(fnMap).forEach(
    ({ ast }) => ast && reportFailedInlining(state, ast)
  );

  if (state.inlineDiagnostics) {
    if (!state.diagnostics) {
      state.diagnostics = state.inlineDiagnostics;
    } else {
      Object.entries(state.inlineDiagnostics).forEach(([key, diags]) => {
        if (!hasProperty(state.diagnostics, key)) {
          state.diagnostics![key] = diags;
        } else {
          state.diagnostics[key].push(...diags);
        }
      });
    }
    delete state.inlineDiagnostics;
  }

  const diagnostics: Record<string, Diagnostic[]> | undefined =
    state.diagnostics && (await resolveDiagnosticsMap(state.diagnostics));

  if (state.config?.checkBuildPragmas) {
    Object.values(fnMap).forEach((f) => {
      pragmaChecker(state, f.ast!, diagnostics?.[f.name]);
    });
  }

  return {
    diagnostics,
    sdkVersion: state.sdkVersion,
  };
}

function findRezRefs(state: ProgramStateAnalysis) {
  const usedDecls = new Set<mctree.Node>();
  state.rezAst &&
    visitReferences(
      state,
      state.rezAst,
      null,
      false,
      (node, results, error) => {
        if (error) return;
        results.forEach((result) =>
          result.results.forEach((sn) => {
            switch (sn.type) {
              case "ModuleDeclaration":
              case "Program":
              case "BlockStatement":
                return;
              case "Identifier":
              case "BinaryExpression":
                // function params
                return;
              case "EnumStringMember":
                if (sn.system) return;
                usedDecls.add(sn);
                break;
              case "ClassDeclaration":
              case "FunctionDeclaration":
              case "EnumDeclaration":
              case "TypedefDeclaration":
                if (sn.node.attrs?.system) return;
              // fallthrough
              case "VariableDeclarator":
                if (
                  sn.fullName.startsWith("$.Toybox") ||
                  sn.fullName.startsWith("$.Rez")
                ) {
                  return;
                }
                usedDecls.add(sn.node);
                break;
              default:
                unhandledType(sn);
            }
          })
        );
        return undefined;
      }
    );
  return usedDecls;
}
/*
 * Might this function be called from somewhere, including
 * callbacks from the api (eg getSettingsView, etc).
 */
function maybeCalled(
  state: ProgramStateAnalysis,
  func: mctree.FunctionDeclaration
) {
  if (!func.body) {
    // this is an api.mir function. It can be called
    return true;
  }
  if (hasProperty(state.exposed, func.id.name)) return true;
  if (
    func.attrs &&
    func.attrs.attributes &&
    func.attrs.attributes.elements.some((attr) => {
      if (attr.type !== "UnaryExpression") return false;
      if (attr.argument.type !== "Identifier") return false;
      return attr.argument.name === "test";
    })
  ) {
    return true;
  }

  if (hasProperty(state.calledFunctions, func.id.name)) {
    return state.calledFunctions[func.id.name].find((f) => f === func) !== null;
  }

  return false;
}

function cleanup(
  state: ProgramStateAnalysis,
  node: mctree.Node,
  ast: mctree.Program,
  usedNodes: Set<mctree.Node>
) {
  switch (node.type) {
    case "ThisExpression":
      node.text = "self";
      break;
    case "EnumDeclaration": {
      if (
        !node.body.members.every((m) => {
          if (usedNodes.has(m)) return false;
          const name = "name" in m ? m.name : m.id.name;
          return (
            hasProperty(state.index, name) &&
            !hasProperty(state.exposed, name) &&
            !hasProperty(state.usedByName, name)
          );
        })
      ) {
        break;
      }
      const enumType = new Set(
        node.body.members.map((m) => {
          if (!("init" in m)) return "Number";
          const [node, type] = getNodeValue(m.init);
          return node ? type : null;
        })
      );
      if (enumType.has(null)) break;

      if (!node.id) return false;
      state.removeNodeComments(node, ast);
      const typedefDecl = withLocDeep(
        {
          type: "TypedefDeclaration",
          id: node.id,
          ts: {
            type: "UnaryExpression",
            argument: {
              type: "TypeSpecList",
              ts: Array.from(enumType).map((t) => ({
                type: "TypeSpecPart",
                name: t === "Null" ? t : makeScopedName(`Toybox.Lang.${t}`),
              })),
            },
            prefix: true,
            operator: " as",
          },
        } as const,
        node,
        node
      );
      const decls =
        state.stack[state.stack.length - 1].sn?.type_decls?.[node.id.name];
      if (decls) {
        const i = decls.findIndex(
          (d) => d.type === "EnumDeclaration" && d.node === node
        );
        if (i >= 0) {
          const old = decls[i] as EnumStateNode;
          const rep = {
            ...old,
            type: "TypedefDeclaration",
            node: typedefDecl,
          } satisfies TypedefStateNode;
          delete rep.resolvedType;
          decls.splice(i, 1, rep);
        }
      }
      return typedefDecl;
    }
    case "VariableDeclarator": {
      const name = variableDeclarationName(node.id);
      return !hasProperty(state.index, name) ||
        hasProperty(state.exposed, name) ||
        hasProperty(state.usedByName, name)
        ? null
        : false;
    }
    case "VariableDeclaration": {
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
      if (!maybeCalled(state, node)) {
        if (
          node.attrs &&
          node.attrs.attributes &&
          node.attrs.attributes.elements.some(
            (attr) =>
              attr.type === "UnaryExpression" && attr.argument.name === "keep"
          )
        ) {
          break;
        }

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
}

function optimizeCall(
  istate: InterpState,
  node: mctree.CallExpression,
  context: InlineContext | null
) {
  const state = istate.state as ProgramStateOptimizer;
  const [name, results] = state.lookupNonlocal(node.callee);
  const callees = results ? findCallees(results) : null;
  if (!callees || !callees.length) {
    const n =
      name ||
      ("name" in node.callee && node.callee.name) ||
      ("property" in node.callee &&
        node.callee.property &&
        "name" in node.callee.property &&
        node.callee.property.name);
    if (n) {
      if (hasProperty(state.allFunctions, n)) {
        if (state.currentFunction) {
          recordCalledFuncs(state.currentFunction!, state.allFunctions[n]);
        }
        state.allFunctions[n].forEach((fn) =>
          markFunctionCalled(state, fn.node)
        );
      }
    } else if (state.currentFunction) {
      // I don't think this can happen: foo[x](args)
      // doesn't parse, so you can't even do things like
      // $.Toybox.Lang[:format]("fmt", [])
      recordModifiedUnknown(state.currentFunction);
    }
    return null;
  }
  if (state.currentFunction) {
    recordCalledFuncs(state.currentFunction, callees);
  }
  if (callees.length === 1) {
    const callee = callees[0].node;
    if (callees[0].type === "FunctionDeclaration" && !callee.hasOverride) {
      if (
        !context &&
        callee.optimizable &&
        node.arguments.every((n) => getNodeValue(n)[0] !== null)
      ) {
        const ret = evaluateFunction(istate, callee, node.arguments);
        if (ret) {
          inlineDiagnostic(state, callees[0], node, null);
          return withLoc(ret, node, node);
        }
      }
      if (shouldInline(state, callees[0], node, context)) {
        const ret = inlineFunction(state, callees[0], node, context);
        if (ret) {
          return ret;
        }
      }
    }
  }
  callees.forEach((c) => markFunctionCalled(state, c.node));
  return null;
}
