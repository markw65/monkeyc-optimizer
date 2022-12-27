import { default as MonkeyC, mctree } from "@markw65/prettier-plugin-monkeyc";
import * as fs from "fs/promises";
import {
  collectNamespaces,
  diagnostic,
  formatAst,
  getApiFunctionInfo,
  getApiMapping,
  hasProperty,
  isLookupCandidate,
  isStateNode,
  markInvokeClassMethod,
  variableDeclarationName,
  visitReferences,
} from "./api";
import {
  cloneDeep,
  getLiteralNode,
  getNodeValue,
  isExpression,
  traverseAst,
  withLoc,
} from "./ast";
import {
  findCallees,
  findCalleesForNew,
  recordCalledFuncs,
  recordModifiedDecls,
  recordModifiedName,
  recordModifiedUnknown,
} from "./function-info";
import {
  inlinableSubExpression,
  InlineContext,
  inlineFunction,
  shouldInline,
  unused,
} from "./inliner";
import { JungleResourceMap } from "./jungles";
import {
  BuildConfig,
  ByNameStateNodeDecls,
  ClassStateNode,
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
} from "./optimizer-types";
import { pragmaChecker } from "./pragma-checker";
import { sizeBasedPRE } from "./pre";
import { xmlUtil } from "./sdk-util";
import { buildTypeInfo } from "./type-flow";
import {
  evaluate,
  evaluateNode,
  InterpState,
  popIstate,
} from "./type-flow/interp";
import { afterEvaluate, beforeEvaluate } from "./type-flow/optimize";
import { cleanupUnusedVars } from "./unused-exprs";
import { pushUnique } from "./util";
import { renameVariable } from "./variable-renamer";

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
  helper(state.stack[0]);
}

function collectClassInfo(state: ProgramStateAnalysis) {
  const toybox = state.stack[0].decls!["Toybox"][0] as ModuleStateNode;
  const lang = toybox.decls!["Lang"][0] as ModuleStateNode;
  const object = lang.decls!["Object"] as ClassStateNode[];
  state.allClasses.forEach((elm) => {
    if (elm.stack![elm.stack!.length - 1].type === "ClassDeclaration") {
      // nested classes don't get access to their contained
      // context. Put them in the global scope instead.
      elm.stack = elm.stack!.slice(0, 1);
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
    } else if (elm !== object[0]) {
      elm.superClass = object;
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
  ).then(() => {
    return;
  });
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

export async function analyze(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document | undefined,
  config: BuildConfig
) {
  let hasTests = false;
  let markApi = true;
  const preState: ProgramState = {
    fnMap,
    config,
    allFunctions: {},
    allClasses: [],
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
              if (attr.type != "UnaryExpression") return drop;
              if (attr.argument.type != "Identifier") return drop;
              if (hasProperty(excludeAnnotations, attr.argument.name)) {
                return true;
              }
              if (attr.argument.name == "test") {
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
    pre(node, state) {
      switch (node.type) {
        case "FunctionDeclaration":
        case "ModuleDeclaration":
        case "ClassDeclaration": {
          const [scope] = state.stack.slice(-1);
          scope.stack = state.stackClone().slice(0, -1);
          if (scope.type == "FunctionDeclaration") {
            if (markApi) {
              node.body = null;
              scope.info = getApiFunctionInfo(state, scope);
              delete scope.stack;
            }
            const allFuncs = state.allFunctions!;
            if (!hasProperty(allFuncs, scope.name)) {
              allFuncs[scope.name] = [scope];
            } else {
              allFuncs[scope.name].push(scope);
            }
          } else if (scope.type === "ClassDeclaration") {
            state.allClasses!.push(scope as ClassStateNode);
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
    const checkTypes =
      config?.typeCheckLevel && config.typeCheckLevel !== "Off";
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
              `The expression ${formatAst(
                node
              )} will fail at runtime using sdk-4.1.6`,
              compiler2DiagnosticType
            );
          }
          return undefined;
        }
        let nodeStr;
        if (state.inType) {
          if (!checkTypes || (nodeStr = formatAst(node)).match(/^Void|Null$/)) {
            return undefined;
          }
        }
        diagnostic(
          state,
          node,
          `Undefined symbol ${nodeStr || formatAst(node)}`,
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
      // we only evaluated any subexpressions of the argument.
      evaluateNode(istate, node.argument);
      break;
    case "AssignmentExpression": {
      // we only evaluated any subexpressions of the lhs.
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
  if (before != null) return before;

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
    (args && args.length != func.params.length)
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

export async function optimizeMonkeyC(
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

  const replace = (
    node: mctree.Node | false | null,
    old: mctree.Node
  ): mctree.Node | mctree.Node[] | false | null => {
    if (node === false || node === null) return node;
    if (isExpression(node)) {
      popIstate(istate, old);
    }
    const rep = state.traverse(node);
    if (rep === false || Array.isArray(rep)) return rep;
    const result = {
      ...(rep || node),
      loc: old.loc,
      start: old.start,
      end: old.end,
    };
    if (isExpression(result)) {
      istate.stack[istate.stack.length - 1].node = result;
    }
    return result;
  };

  let again = false;
  const optimizeCallHelper = (
    istate: InterpState,
    call: mctree.CallExpression,
    node: InlineContext | null
  ) => {
    const result = optimizeCall(istate, call, node);
    if (result) {
      if (isExpression(result)) {
        istate.stack[istate.stack.length - 1].node = result;
      }
      again = true;
    }
    return result;
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
      func.attrs.attributes &&
      func.attrs.attributes.elements.some((attr) => {
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

  const renamer = (
    idnode: mctree.TypedIdentifier | mctree.InstanceofIdentifier
  ) => {
    const ident = idnode.type === "Identifier" ? idnode : idnode.left;
    const locals = topLocals();
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
              decl === idnode ||
              (decl.type === "VariableDeclarator" && decl.node.id === idnode)
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
        ident.name = name;
      } else {
        map[declName] = true;
      }
    }
  };

  // use this when optimizing initializer expressions,
  // outside of any function.
  const gistate: InterpState = { state, stack: [] };
  // use this when type inference is enabled, and we're
  // inside a function.
  let istate: InterpState = gistate;

  state.pre = (node) => {
    switch (node.type) {
      case "EnumDeclaration":
        return [];
      case "ForStatement": {
        const map = topLocals().map;
        if (map) {
          state.localsStack.push({ node, map: { ...map } });
        }
        break;
      }
      case "VariableDeclarator": {
        renamer(node.id);
        return ["init"];
      }
      case "CatchClause":
        if (node.param) {
          state.localsStack.push({ node, map: { ...(topLocals().map || {}) } });
          renamer(node.param);
          return ["body"];
        }
        break;
      case "BinaryExpression":
        if (
          node.operator === "has"
            ? node.right.type === "UnaryExpression" &&
              node.right.operator === ":"
            : node.operator === "as"
        ) {
          // Using `expr has :symbol` doesn't "expose"
          // symbol, and the rhs of an "as" isn't an
          // expression. In both cases, skip the rhs
          return ["left"];
        }

        break;
      case "UnaryExpression":
        if (node.operator == ":") {
          // node.argument is not a normal identifier.
          // don't visit it.
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
            const [, results] = state.lookupValue(node);
            if (results) {
              if (results.length !== 1 || results[0].results.length !== 1) {
                throw new Error(
                  `Local ${node.name} had multiple lookup results`
                );
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
        }
        return [];
      }
      case "AssignmentExpression":
      case "UpdateExpression": {
        const lhs =
          node.type === "AssignmentExpression" ? node.left : node.argument;
        if (lhs.type === "Identifier") {
          const map = topLocals().map;
          if (map) {
            if (hasProperty(map, lhs.name)) {
              const name = map[lhs.name];
              if (typeof name === "string") {
                lhs.name = name;
              }
            }
          }
        } else if (lhs.type === "MemberExpression") {
          const object = state.traverse(lhs.object);
          if (object) {
            lhs.object = object as mctree.Expression;
          }
          if (!isLookupCandidate(lhs)) {
            const property = state.traverse(lhs.property);
            if (property) {
              lhs.property = property as mctree.Expression;
            }
          }
        }
        return node.type === "AssignmentExpression" ? ["right"] : [];
      }
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
        const [parent, self] = state.stack.slice(-2);
        if (state.currentFunction) {
          throw new Error(
            `Nested functions: ${self.fullName} was activated during processing of ${state.currentFunction.fullName}`
          );
        }
        state.currentFunction = self as FunctionStateNode;
        const is =
          !state.config?.propagateTypes ||
          node.attrs?.attributes?.elements.find(
            (attr) =>
              attr.type == "UnaryExpression" &&
              attr.argument.name === "noConstProp"
          )
            ? null
            : buildTypeInfo(state, state.currentFunction);
        if (is) {
          /*
           * istate contains a copy of state, but we need the real
           * thing, because "state" is captured here.
           *
           * A better solution will be to separate out a
           * "lookup context", which will be a stack, plus a couple
           * of fields from state, and then pass that around.
           */
          is.state = state;
          istate = is;
        }
        if (parent.type == "ClassDeclaration" && !maybeCalled(node)) {
          let used = false;
          if (node.id.name == "initialize") {
            used = true;
          } else if (parent.superClass) {
            used = checkInherited(parent, node.id.name);
          }
          if (used) {
            markFunctionCalled(state, node);
          }
        }
        // We dont want to call evaluateNode on
        // id, args or returnType
        return ["body"];
      }
      case "ClassDeclaration":
      case "ModuleDeclaration":
        // We dont want to call evaluateNode on
        // id, or superClass
        return ["body"];
    }
    return null;
  };
  state.post = (node) => {
    const locals = topLocals();
    if (locals.node === node) {
      state.localsStack.pop();
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
        if (!state.currentFunction) {
          throw new Error(
            `Finished function ${
              state.stack.slice(-1)[0].fullName
            }, but it was not marked current`
          );
        }
        state.currentFunction.info = state.currentFunction.next_info || false;
        delete state.currentFunction.next_info;
        delete state.currentFunction;
        if (istate.stack.length) {
          throw new Error("Stack was not empty");
        }
        istate = gistate;
        if (again) {
          again = false;
          const top = state.stack.pop();
          state.traverse(node);
          state.stack.push(top!);
        }
        break;
      case "BlockStatement":
        if (node.body.length === 1 && node.body[0].type === "BlockStatement") {
          node.body.splice(0, 1, ...node.body[0].body);
        }
      // fall through
      case "ForStatement":
        if (locals.map) {
          cleanupUnusedVars(state, node);
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
        if (hasProperty(state.index, node.name)) {
          state.usedByName[node.name] = true;
        }
        break;
      case "MemberExpression": {
        const property = isLookupCandidate(node);
        if (property) {
          if (hasProperty(state.index, property.name)) {
            state.usedByName[property.name] = true;
          }
        }
        break;
      }
      case "NewExpression":
        if (state.currentFunction) {
          const [, results] = state.lookup(node.callee);
          if (results) {
            recordCalledFuncs(
              state.currentFunction,
              findCalleesForNew(results)
            );
          } else {
            recordModifiedUnknown(state.currentFunction);
          }
        }
        break;

      case "CallExpression": {
        return optimizeCallHelper(istate, node, null);
      }

      case "VariableDeclaration": {
        const locals = topLocals();
        if (
          locals.map &&
          locals.node &&
          locals.node.type === "BlockStatement"
        ) {
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
              if (Array.isArray(inlined) || inlined.type != "BlockStatement") {
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
              if (hasProperty(topLocals().map, node.expression.left.type)) {
                ok = true;
              }
            }
            if (!ok && node.expression.operator == "=") {
              const [, result] = state.lookup(node.expression.left);
              ok = !!result;
            }
            if (ok) {
              return optimizeCallHelper(istate, call, node.expression);
            }
          }
        } else {
          const ret = unused(state, node.expression, true);
          if (ret) {
            return ret
              .map((r) => replace(r, r))
              .flat(1)
              .filter((s): s is Exclude<typeof s, false | null> => !!s);
          }
        }
        break;
      case "AssignmentExpression":
        if (
          node.operator === "=" &&
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          node.left.name === node.right.name
        ) {
          return replace({ type: "Literal", value: null, raw: "null" }, node);
        }
      // fall through;
      case "UpdateExpression":
        if (state.currentFunction) {
          const lhs =
            node.type === "AssignmentExpression" ? node.left : node.argument;
          const [, results] = state.lookup(lhs);
          if (results) {
            recordModifiedDecls(state.currentFunction, results);
          } else {
            const id = lhs.type === "Identifier" ? lhs : isLookupCandidate(lhs);
            if (id) {
              recordModifiedName(state.currentFunction, id.name);
            } else {
              recordModifiedUnknown(state.currentFunction);
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
  state.usedByName = {};
  state.calledFunctions = {};
  state.exposed = state.nextExposed;
  state.nextExposed = {};
  Object.values(fnMap).forEach((f) => {
    collectNamespaces(f.ast!, state);
  });
  state.exposed = state.nextExposed;
  state.nextExposed = {};
  delete state.pre;
  delete state.post;
  Object.values(state.allFunctions).forEach((fns) =>
    fns.forEach((fn) => sizeBasedPRE(state, fn))
  );

  const cleanup = (node: mctree.Node) => {
    switch (node.type) {
      case "ThisExpression":
        node.text = "self";
        break;
      case "EnumStringBody":
        if (
          node.members.every((m) => {
            const name = "name" in m ? m.name : m.id.name;
            return (
              hasProperty(state.index, name) &&
              !hasProperty(state.exposed, name) &&
              !hasProperty(state.usedByName, name)
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
          if (!node.body.enumType) {
            throw new Error("Missing enumType on optimized enum");
          }
          return {
            type: "TypedefDeclaration",
            id: node.id,
            ts: {
              type: "UnaryExpression",
              argument: {
                type: "TypeSpecList",
                ts: [
                  node.body.enumType,
                ] as unknown as mctree.TypeSpecList["ts"],
              },
              prefix: true,
              operator: " as",
            },
          } as const;
        }
        break;
      case "VariableDeclaration": {
        node.declarations = node.declarations.filter((d) => {
          const name = variableDeclarationName(d.id);
          return (
            !hasProperty(state.index, name) ||
            hasProperty(state.exposed, name) ||
            hasProperty(state.usedByName, name)
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
  };
  Object.entries(fnMap).forEach(([, f]) => {
    traverseAst(f.ast!, undefined, (node) => {
      const ret = cleanup(node);
      if (ret === false) {
        state.removeNodeComments(node, f.ast!);
      }
      return ret;
    });
  });

  reportMissingSymbols(state, config);

  Object.entries(fnMap).forEach(([name, f]) => {
    if (state.config && state.config.checkBuildPragmas) {
      pragmaChecker(state, f.ast!, state.diagnostics?.[name]);
    }
  });

  return state.diagnostics;
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
  if (callees.length == 1 && callees[0].type === "FunctionDeclaration") {
    const callee = callees[0].node;
    if (
      !context &&
      callee.optimizable &&
      !callee.hasOverride &&
      node.arguments.every((n) => getNodeValue(n)[0] !== null)
    ) {
      const ret = evaluateFunction(istate, callee, node.arguments);
      if (ret) {
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
  callees.forEach((c) => markFunctionCalled(state, c.node));
  return null;
}
