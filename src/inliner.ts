import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  hasProperty,
  isLookupCandidate,
  isStateNode,
  sameLookupResult,
  variableDeclarationName,
} from "./api";
import { cloneDeep, traverseAst, withLoc, withLocDeep } from "./ast";
import {
  findCallees,
  findCalleesForNew,
  functionMayModify,
} from "./function-info";
import {
  FunctionStateNode,
  ProgramState,
  ProgramStateAnalysis,
  ProgramStateStack,
  StateNodeAttributes,
  StateNodeDecl,
  VariableStateNode,
} from "./optimizer-types";
import { renameVariable } from "./variable-renamer";

// Note: Keep in sync with replaceInlinedSubExpression below
export function inlinableSubExpression(expr: mctree.Expression) {
  while (true) {
    if (expr.type === "BinaryExpression" || expr.type === "LogicalExpression") {
      expr = expr.left;
    } else if (expr.type === "UnaryExpression") {
      expr = expr.argument;
    } else if (expr.type === "ConditionalExpression") {
      expr = expr.test;
    } else if (expr.type === "MemberExpression") {
      expr = expr.object;
    } else if (expr.type === "CallExpression") {
      return expr;
    } else {
      return null;
    }
  }
}

// Note: Keep in sync with inlinableSubExpression above
function replaceInlinedSubExpression(
  top: mctree.Expression,
  call: mctree.CallExpression,
  repl: mctree.Expression
) {
  if (top === call) return repl;
  let expr = top;
  while (true) {
    if (expr.type === "LogicalExpression" || expr.type === "BinaryExpression") {
      if (expr.left === call) {
        expr.left = repl;
        break;
      }
      expr = expr.left;
    } else if (expr.type === "UnaryExpression") {
      if (expr.argument === call) {
        expr.argument = repl;
        break;
      }
      expr = expr.argument;
    } else if (expr.type === "ConditionalExpression") {
      if (expr.test === call) {
        expr.test = repl;
        break;
      }
      expr = expr.test;
    } else if (expr.type === "MemberExpression") {
      if (expr.object === call) {
        expr.object = repl;
        break;
      }
      expr = expr.object;
    } else {
      throw new Error("Internal error: Didn't find CallExpression");
    }
  }
  return top;
}

function getArgSafety(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  args: mctree.Node[],
  requireAll: boolean
) {
  // determine whether decl might be changed by a function call
  // or assignment during the evaluation of FunctionStateNode.
  const getSafety = (decl: StateNodeDecl) => {
    switch (decl.type) {
      // enums are constant, they cant change
      case "EnumStringMember":
        return true;
      case "VariableDeclarator": {
        // constants also can't change
        if (decl.node.kind === "const") return true;
        // if decl is a local, it also can't be changed
        // by a call to another function.
        for (let i = 0; ; i++) {
          if (!state.stack[i] || decl.stack[i] !== state.stack[i]) return false;
          if (state.stack[i].type === "FunctionDeclaration") return true;
        }
      }
      case "Identifier":
      case "BinaryExpression":
        // This is a parameter of the calling function.
        // It also can't be changed during the execution
        // of the inlined function
        return true;
      default:
        return null;
    }
  };

  const safeArgs: (boolean | null)[] = [];
  const argDecls: VariableStateNode[] = [];
  let allSafe = true;
  if (
    !args.every((arg, i) => {
      switch (arg.type) {
        case "UnaryExpression":
          if (arg.operator === ":") {
            safeArgs.push(true);
            return true;
          }
          break;
        case "Literal":
          safeArgs.push(true);
          return true;
        case "Identifier":
        case "MemberExpression": {
          const [, results] = state.lookup(arg);
          if (
            !results ||
            results.length !== 1 ||
            results[0].results.length !== 1
          ) {
            safeArgs.push(null);
            return !requireAll;
          }
          const decl = results[0].results[0];
          const safety = getSafety(decl);
          safeArgs.push(safety);
          if (!safety) {
            allSafe = false;
            if (safety === null) {
              return !requireAll;
            } else if (decl.type === "VariableDeclarator") {
              argDecls[i] = decl;
            }
          }
          return true;
        }
      }
      allSafe = false;
      safeArgs.push(null);
      return !requireAll;
    })
  ) {
    return false;
  }
  if (allSafe && requireAll) return true;
  const callsSeen = new Set<FunctionStateNode>();
  const modifiedDecls = new Set<VariableStateNode>();
  let modifiedUnknown = false;
  const params = Object.fromEntries(
    func.node.params.map(
      (param, i) => [variableDeclarationName(param), i] as const
    )
  );
  // look for uses of "unsafe" args that occur after a call.
  // use post to do the checking, because arguments are evaluated
  // prior to the call, so eg "return f(x.y);" is fine, but
  // "return f()+x.y" is not.
  const { pre, post, stack } = state;
  try {
    delete state.pre;
    state.post = (node) => {
      switch (node.type) {
        case "AssignmentExpression":
        case "UpdateExpression": {
          const v = node.type == "UpdateExpression" ? node.argument : node.left;
          if (v.type === "Identifier" && hasProperty(params, v.name)) {
            // If a parameter is modified, we can't just substitute the
            // argument wherever the parameter is used.
            safeArgs[params[v.name]] = null;
            break;
          }
          if (modifiedUnknown) break;
          const [, results] = state.lookup(v);
          if (results) {
            results.forEach((r) =>
              r.results.forEach(
                (decl) =>
                  decl.type === "VariableDeclarator" && modifiedDecls.add(decl)
              )
            );
          } else {
            modifiedUnknown = true;
          }
          break;
        }
        case "CallExpression":
        case "NewExpression":
          if (!modifiedUnknown) {
            const [, results] = state.lookup(
              node.callee,
              null,
              // calls are looked up as non-locals, but new is not
              node.type === "CallExpression" ? func.stack : state.stack
            );
            if (!results) {
              const callee_name =
                node.callee.type === "Identifier"
                  ? node.callee
                  : node.callee.type === "MemberExpression"
                  ? isLookupCandidate(node.callee)
                  : null;
              if (callee_name) {
                const callees = state.allFunctions[callee_name.name];
                if (callees) {
                  callees.forEach((callee) => callsSeen.add(callee));
                }
              } else {
                modifiedUnknown = true;
              }
            } else {
              const callees =
                node.type === "CallExpression"
                  ? findCallees(results)
                  : findCalleesForNew(results);
              if (callees) {
                callees.forEach((callee) => callsSeen.add(callee));
              }
            }
          }
          break;

        case "Identifier":
          if (
            hasProperty(params, node.name) &&
            !safeArgs[params[node.name]] &&
            (modifiedUnknown ||
              !argDecls[params[node.name]] ||
              modifiedDecls.has(argDecls[params[node.name]]) ||
              Array.from(callsSeen).some((callee) =>
                functionMayModify(state, callee, argDecls[params[node.name]])
              ))
          ) {
            safeArgs[params[node.name]] = null;
          }
      }
      return null;
    };
    state.stack = func.stack!;
    state.traverse(func.node.body!);
  } finally {
    state.pre = pre;
    state.post = post;
    state.stack = stack;
  }
  return safeArgs;
}

function canInline(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  args: mctree.Node[]
) {
  const safeArgs = getArgSafety(state, func, args, true);
  if (safeArgs === true || safeArgs === false) {
    return safeArgs;
  }
  return safeArgs.every((arg) => arg !== null);
}

function inliningLooksUseful(
  func: mctree.FunctionDeclaration,
  node: mctree.Node
) {
  while (true) {
    if (node.type === "BinaryExpression" && node.operator === "as") {
      node = node.left;
    } else if (node.type === "UnaryExpression" && node.operator === " as") {
      node = node.argument;
    } else {
      break;
    }
  }
  if (node.type === "Literal") return true;
  if (node.type === "Identifier") {
    if (
      func.params.length === 1 &&
      variableDeclarationName(func.params[0]) === node.name
    ) {
      return 1;
    }
    return true;
  }
  return false;
}

function inlineRequested(state: ProgramStateAnalysis, func: FunctionStateNode) {
  const excludeAnnotations =
    (func.node.loc?.source &&
      state.fnMap[func.node.loc?.source]?.excludeAnnotations) ||
    {};

  if (
    func.node.attrs &&
    func.node.attrs.attributes &&
    func.node.attrs.attributes.elements.some(
      (attr) =>
        attr.type === "UnaryExpression" &&
        (attr.argument.name === "inline" ||
          (attr.argument.name.startsWith("inline_") &&
            !hasProperty(excludeAnnotations, attr.argument.name.substring(7))))
    )
  ) {
    return true;
  }
  return false;
}

export function shouldInline(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext | null
): boolean {
  if (state.inlining) return false;
  let autoInline: number | boolean = false;
  let inlineAsExpression = false;
  const args = call.arguments;
  if (
    func.node.body &&
    func.node.body.body.length === 1 &&
    func.node.body.body[0].type === "ReturnStatement" &&
    func.node.body.body[0].argument &&
    func.node.params.length === args.length
  ) {
    inlineAsExpression = true;
    autoInline = inliningLooksUseful(
      func.node,
      func.node.body.body[0].argument
    );
  }

  if (autoInline === 1) {
    return true;
  }

  const requested = inlineRequested(state, func);
  if (autoInline || requested) {
    if (inlineAsExpression) {
      if (canInline(state, func, args)) {
        return true;
      }
    }
    if (!context && requested) {
      inlineDiagnostic(
        state,
        func,
        call,
        "This function can only be inlined in statement, assignment, if or return contexts"
      );
    }
    return context != null;
  }
  return false;
}

// We still need to keep track of every local name that was
// already in use before we started inlining, but we don't want to
// use any of its renames. We also want to know whether a local is
// from the function being inlined, or the calling function, so
// set every element to false.
function fixupLocalsMap(state: ProgramStateAnalysis) {
  if (!state.localsStack) throw new Error("No local variable map!");
  const locals = state.localsStack[state.localsStack!.length - 1];
  const { map } = locals;
  if (!map) throw new Error("No local variable map!");
  const original = { ...map };
  Object.keys(map).forEach((key) => (map[key] = false));
  return original;
}

type InlineBody =
  | mctree.BlockStatement
  | mctree.ExpressionStatement["expression"];
type InlineBodyReturn<T extends InlineBody> =
  | T
  | (T extends mctree.BlockStatement
      ? mctree.BlockStatement
      : mctree.ExpressionStatement["expression"]);

function processInlineBody<T extends InlineBody>(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  root: T,
  params: Record<string, number>
): InlineBodyReturn<T> | null {
  let failed = false;
  const pre = state.pre!;
  const post = state.post!;
  state.inlining = true;
  let insertedVariableDecls: mctree.VariableDeclaration | null = null;
  const replacements = new Set<mctree.Node>();
  // lookup determines static-ness of the lookup context based on seeing
  // a static FunctionDeclaration, but the FunctionDeclaration's stack
  // doesn't include the FunctionDeclaration itself.
  const stack =
    func.attributes & StateNodeAttributes.STATIC
      ? func.stack!.concat(func)
      : func.stack!;
  try {
    state.pre = (node: mctree.Node) => {
      if (failed) return [];
      if (replacements.has(node)) return false;
      const result = pre(node, state);
      if (!insertedVariableDecls && node.type === "BlockStatement") {
        // the block just created a new locals map, so we don't
        // need to restore it at the end.
        fixupLocalsMap(state);
        const locals = state.localsStack![state.localsStack!.length - 1];
        const declarations: mctree.VariableDeclarator[] = func.node.params
          .map((param, i): mctree.VariableDeclarator | null => {
            const paramName = variableDeclarationName(param);
            if (params[paramName] >= 0) return null;
            const name = renameVariable(state, locals, paramName) || paramName;
            locals.map![name] = true;
            return {
              type: "VariableDeclarator",
              id: { type: "Identifier", name },
              kind: "var",
              init: call.arguments[i],
            };
          })
          .filter((n): n is mctree.VariableDeclarator => n != null);
        insertedVariableDecls = {
          type: "VariableDeclaration",
          declarations,
          kind: "var",
        };
        node.body.unshift(insertedVariableDecls);
        replacements.add(insertedVariableDecls);
      }
      return result;
    };
    const fixId = (node: mctree.Identifier) => {
      if (state.inType) return null;
      if (hasProperty(params, node.name)) {
        const ix = params[node.name];
        if (ix >= 0) {
          const replacement = { ...call.arguments[ix] };
          replacements.add(replacement);
          return replacement;
        }
        return null;
      }
      const replacement = fixNodeScope(state, node, stack);
      if (!replacement) {
        failed = true;
        inlineDiagnostic(state, func, call, `Failed to resolve '${node.name}'`);
      }
      return replacement;
    };
    state.post = (node: mctree.Node) => {
      if (failed) return post(node, state);
      let replacement = null;
      switch (node.type) {
        case "AssignmentExpression":
          if (node.left.type === "Identifier") {
            const rep = fixId(node.left);
            if (rep) {
              node.left = rep as mctree.Identifier | mctree.MemberExpression;
            }
          }
          break;
        case "UpdateExpression":
          if (node.argument.type === "Identifier") {
            const rep = fixId(node.argument);
            if (rep) {
              node.argument = rep as
                | mctree.Identifier
                | mctree.MemberExpression;
            }
          }
          break;
        case "Identifier":
          replacement = fixId(node);
          break;
      }
      const ret = post(replacement || node, state);
      return ret === false || ret ? ret : replacement;
    };
    let ret = state.traverse(root) as InlineBodyReturn<T>;
    if (failed) {
      return null;
    }
    if (ret === null) {
      ret = root;
    }
    if (!ret) {
      inlineDiagnostic(state, func, call, `Internal error`);
      return null;
    }
    inlineDiagnostic(state, func, call, null);
    return ret;
  } finally {
    state.pre = pre;
    state.post = post;
    delete state.inlining;
  }
}

export function unused(
  state: ProgramStateAnalysis,
  expression: mctree.ExpressionStatement["expression"]
): mctree.Statement[];
export function unused(
  state: ProgramStateAnalysis,
  expression: mctree.ExpressionStatement["expression"],
  top: true
): mctree.Statement[] | null;
export function unused(
  state: ProgramStateAnalysis,
  expression: mctree.ExpressionStatement["expression"],
  top?: boolean
): mctree.Statement[] | null {
  const estmt = (expression: mctree.Expression) =>
    withLoc(
      {
        type: "ExpressionStatement",
        expression,
      },
      expression
    );
  switch (expression.type) {
    case "Literal":
      return [];
    case "Identifier":
      return [];
    case "ThisExpression":
      return [];
    case "BinaryExpression":
      if (expression.operator === "as") {
        return unused(state, expression.left);
      }
      return unused(state, expression.left).concat(
        unused(state, expression.right)
      );
    case "LogicalExpression": {
      const right = unused(state, expression.right);
      if (!right.length) return unused(state, expression.left);
      const consequent = withLoc(
        {
          type: "BlockStatement",
          body: [estmt(expression.right)],
        },
        expression.right
      );
      let alternate;
      if (expression.operator == "||" || expression.operator == "or") {
        alternate = { ...consequent };
        consequent.body = [];
      }
      return [
        withLoc(
          {
            type: "IfStatement",
            test: expression.left,
            consequent,
            alternate,
          },
          expression
        ),
      ];
    }
    case "ConditionalExpression": {
      const consequentExprs = unused(state, expression.consequent);
      const alternateExprs = unused(state, expression.alternate);
      if (!consequentExprs.length && !alternateExprs.length) {
        return unused(state, expression.test);
      }
      return [
        withLoc(
          {
            type: "IfStatement",
            test: expression.test,
            consequent: withLoc(
              {
                type: "BlockStatement",
                body: consequentExprs,
              },
              expression.consequent
            ),
            alternate: withLoc(
              {
                type: "BlockStatement",
                body: alternateExprs,
              },
              expression.alternate
            ),
          },
          expression
        ),
      ];
    }
    case "UnaryExpression":
      return unused(state, expression.argument);
    case "MemberExpression":
      if (expression.computed) {
        return unused(state, expression.object).concat(
          unused(state, expression.property)
        );
      }
      if (
        (state.sdkVersion || 0) < 4001007 &&
        expression.object.type === "NewExpression"
      ) {
        // prior to 4.1.7 top level new expressions were discarded,
        // but (new X()).a was not. After 4.1.7, top level new is
        // executed, but top level (new X()).a is an error.
        break;
      }
      return unused(state, expression.object);
    case "ArrayExpression":
      return expression.elements.map((e) => unused(state, e)).flat(1);
    case "ObjectExpression":
      return expression.properties
        .map((p) => unused(state, p.key).concat(unused(state, p.value)))
        .flat(1);
  }
  return top ? null : [estmt(expression)];
}

export function diagnostic(
  state: ProgramState,
  loc: mctree.Node["loc"],
  message: string | null,
  type: NonNullable<
    ProgramStateAnalysis["diagnostics"]
  >[string][number]["type"] = "INFO"
) {
  if (!loc || !loc.source) return;
  const source = loc.source;
  if (!state.diagnostics) state.diagnostics = {};
  if (!hasProperty(state.diagnostics, source)) {
    if (!message) return;
    state.diagnostics[source] = [];
  }
  const diags = state.diagnostics[source];
  let index = diags.findIndex((item) => item.loc === loc);
  if (message) {
    if (index < 0) index = diags.length;
    diags[index] = { type, loc, message };
  } else if (index >= 0) {
    diags.splice(index, 1);
  }
}

function inlineDiagnostic(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  message: string | null
) {
  if (inlineRequested(state, func)) {
    diagnostic(
      state,
      call.loc,
      message && `While inlining ${func.node.id.name}: ${message}`
    );
  }
}

export type InlineContext =
  | mctree.ReturnStatement
  | mctree.IfStatement
  | mctree.AssignmentExpression
  | mctree.ExpressionStatement
  | mctree.VariableDeclarator;

function inlineWithArgs(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext
) {
  if (!func.node || !func.node.body) {
    return null;
  }

  const lastStmt = (
    block: mctree.BlockStatement
  ): [mctree.Statement, mctree.BlockStatement] => {
    const last = block.body.slice(-1)[0];
    return last.type === "BlockStatement" ? lastStmt(last) : [last, block];
  };
  let retStmtCount = 0;
  if (context.type === "ReturnStatement") {
    const last = func.node.body.body.slice(-1)[0];
    if (!last || last.type !== "ReturnStatement") {
      inlineDiagnostic(
        state,
        func,
        call,
        "Function didn't end with a return statement"
      );
      return null;
    }
  } else {
    traverseAst(func.node.body, (node) => {
      node.type === "ReturnStatement" && retStmtCount++;
    });
    if (retStmtCount > 1) {
      inlineDiagnostic(
        state,
        func,
        call,
        "Function had more than one return statement"
      );
    } else if (
      (context.type === "AssignmentExpression" ||
        context.type === "VariableDeclarator" ||
        context.type === "IfStatement") &&
      retStmtCount !== 1
    ) {
      inlineDiagnostic(
        state,
        func,
        call,
        "Function did not have a return statement"
      );
      return null;
    }
    if (retStmtCount === 1) {
      const [last] = lastStmt(func.node.body);
      if (
        !last ||
        last.type !== "ReturnStatement" ||
        ((context.type === "AssignmentExpression" ||
          context.type === "VariableDeclarator" ||
          context.type === "IfStatement") &&
          !last.argument)
      ) {
        inlineDiagnostic(
          state,
          func,
          call,
          "There was a return statement, but not at the end of the function"
        );
        return null;
      }
    }
  }

  const body = cloneDeep(func.node!.body);

  const safeArgs = getArgSafety(state, func, call.arguments, false);
  const params = Object.fromEntries(
    func.node.params.map((param, i) => {
      const argnum =
        safeArgs === true || (safeArgs !== false && safeArgs[i] !== null)
          ? i
          : -1;
      const name = variableDeclarationName(param);
      return [name, argnum];
    })
  );

  if (!processInlineBody(state, func, call, body, params)) {
    return null;
  }
  diagnostic(state, call.loc, null);
  if (context.type !== "ReturnStatement" && retStmtCount) {
    const [last, block] = lastStmt(body);
    if (last.type != "ReturnStatement") {
      throw new Error("ReturnStatement got lost!");
    }
    if (last.argument) {
      if (context.type === "AssignmentExpression") {
        context.right = replaceInlinedSubExpression(
          context.right,
          call,
          last.argument
        );

        block.body[block.body.length - 1] = {
          type: "ExpressionStatement",
          expression: context,
        };
      } else if (context.type === "VariableDeclarator") {
        const { id, init, kind: _kind, ...rest } = context;
        const right = replaceInlinedSubExpression(init!, call, last.argument);
        block.body[block.body.length - 1] = {
          ...rest,
          type: "ExpressionStatement",
          expression: {
            ...rest,
            type: "AssignmentExpression",
            operator: "=",
            left: id.type === "Identifier" ? id : id.left,
            right,
          },
        };
      } else if (context.type === "IfStatement") {
        // Generate a pmcr_tmp name that doesn't conflict with anything
        const locals = state.localsStack![state.localsStack!.length - 1];
        const name = renameVariable(state, locals, null)!;
        locals.map![name] = true;

        // Replace the inlined function's return statement
        // with an assignment to pmcr_tmp
        block.body[block.body.length - 1] = {
          type: "ExpressionStatement",
          expression: {
            type: "AssignmentExpression",
            operator: "=",
            left: { type: "Identifier", name },
            right: last.argument,
          },
        };
        // The IfStatement either has the call as its test, or as
        // the leftmost argument to a series of Binary/Logical expressions
        // Either way, replace the call with pmcr_tmp
        const repl = { type: "Identifier", name } as const;
        context.test = replaceInlinedSubExpression(context.test, call, repl);

        // Wrap the inlined body so it looks like
        // {
        //   var pmcr_tmp;
        //   { /* inlined body, with assignment to pmcr_tmp */ }
        //   if (context) {} // original if statement
        // }
        body.body = [
          {
            type: "VariableDeclaration",
            kind: "var",
            declarations: [
              {
                type: "VariableDeclarator",
                kind: "var",
                id: { type: "Identifier", name },
              },
            ],
          },
          { type: "BlockStatement", body: body.body },
          context,
        ];
      } else {
        const side_exprs = unused(state, last.argument);
        block.body.splice(block.body.length - 1, 1, ...side_exprs);
      }
    } else {
      --block.body.length;
    }
  }
  withLocDeep(body, context, context, true);
  return body;
}

function isTypecheckArg(
  node: mctree.Attributes["elements"][number],
  arg: boolean | null
) {
  return (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === ":typecheck" &&
    (arg === null ||
      (node.arguments.length === 1 &&
        node.arguments[0].type === "Literal" &&
        node.arguments[0].value === arg))
  );
}

function inlineFunctionHelper(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext | null
): InlineBody | null {
  if (context) {
    return inlineWithArgs(state, func, call, context);
  }
  const retArg = cloneDeep(
    (func.node!.body!.body[0] as mctree.ReturnStatement).argument!
  );
  const params = Object.fromEntries(
    func.node.params.map(
      (param, i) => [variableDeclarationName(param), i] as const
    )
  );
  const map = fixupLocalsMap(state);
  const ret = processInlineBody(state, func, call, retArg, params);
  state.localsStack![state.localsStack!.length - 1].map = map;
  return ret && withLocDeep(ret, call, call, true);
}

export function inlineFunction(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext | null
): InlineBody | null {
  const ret = inlineFunctionHelper(state, func, call, context);
  if (!ret) return ret;
  const typecheckFalse = func.node.attrs?.attributes?.elements.find((attr) =>
    isTypecheckArg(attr, false)
  );
  if (!typecheckFalse) {
    return ret;
  }
  const callerSn = state.stack.find(
    (sn) => sn.type === "FunctionDeclaration"
  ) as FunctionStateNode;
  if (!callerSn) {
    return ret;
  }
  const caller = callerSn.node;
  if (!caller.attrs) {
    caller.attrs = withLoc(
      {
        type: "AttributeList",
      },
      caller,
      false
    );
  }
  if (!caller.attrs.attributes) {
    caller.attrs.attributes = withLoc(
      { type: "Attributes", elements: [] },
      caller.attrs,
      false
    );
  }
  if (
    caller.attrs.attributes.elements.find((attr) => isTypecheckArg(attr, null))
  ) {
    return ret;
  }
  caller.attrs.attributes.elements.unshift(
    withLocDeep({ ...typecheckFalse }, caller.attrs, false)
  );
  return ret;
}

export function applyTypeIfNeeded(node: mctree.Node) {
  if ("enumType" in node && node.enumType) {
    node = {
      type: "BinaryExpression",
      operator: "as",
      left: node,
      right: { type: "TypeSpecList", ts: [node.enumType] },
    } as mctree.AsExpression;
  }
  return node;
}

type ScopedEntity =
  | mctree.Identifier
  | mctree.MemberExpression
  | mctree.ThisExpression;

function fixNodeScope(
  state: ProgramStateAnalysis,
  lookupNode: mctree.Identifier | mctree.MemberExpression,
  nodeStack: ProgramStateStack
) {
  if (lookupNode.type === "Identifier") {
    const locals = state.localsStack![state.localsStack!.length - 1];
    const { map } = locals;
    if (!map) throw new Error("No local variable map!");
    if (hasProperty(map, lookupNode.name) && map[lookupNode.name] !== false) {
      // map[name] !== false means its an entry that was created during inlining
      // so its definitely one of our locals.
      return lookupNode;
    }
  }
  const [, original] = state.lookup(lookupNode, null, nodeStack);
  if (!original) {
    return null;
  }
  const [, current] = state.lookup(lookupNode);
  // For now, leave it alone if it already maps to the same thing.
  // With a bit more work, we could find the guaranteed shortest
  // reference, and then use this to optimize *all* symbols, not
  // just fix inlined ones.
  if (current && sameLookupResult(original, current)) {
    return lookupNode;
  }
  const node =
    lookupNode.type === "Identifier"
      ? lookupNode
      : (lookupNode.property as mctree.Identifier);

  if (
    original.length === 1 &&
    original[0].results.length === 1 &&
    original[0].results[0].type === "EnumStringMember"
  ) {
    return applyTypeIfNeeded(original[0].results[0].init);
  }

  const prefixes = original
    .map((lookupDef) =>
      lookupDef.results.map((sn) => {
        if (isStateNode(sn) && sn.fullName) {
          return sn.fullName;
        }
        return "";
      })
    )
    .flat();

  const member = (
    object: ScopedEntity,
    property: mctree.Identifier
  ): mctree.MemberExpression => ({
    type: "MemberExpression",
    object,
    property,
    computed: false,
    start: node.start,
    end: node.end,
    loc: node.loc,
  });
  if (
    prefixes.length &&
    prefixes[0].startsWith("$.") &&
    prefixes.every((prefix, i) => !i || prefix === prefixes[i - 1])
  ) {
    const prefix = prefixes[0].split(".").slice(0, -1).reverse();
    let found = false;
    return prefix.reduce<mctree.MemberExpression>(
      (current, name) => {
        if (found) return current;
        const [, results] = state.lookup(current);
        if (results && sameLookupResult(original, results)) {
          found = true;
          return current;
        }
        const object: mctree.Identifier = {
          type: "Identifier",
          name,
          start: node.start,
          end: node.end,
          loc: node.loc,
        };
        let root = null;
        let property: ScopedEntity = current;
        do {
          root = property;
          property = property.object as ScopedEntity;
        } while (property.type === "MemberExpression");

        if (property.type === "ThisExpression") {
          root.object = object;
          return root;
        }
        root.object = member(object, property);
        return current;
      },
      member(
        {
          type: "ThisExpression",
          text: "self",
          start: node.start,
          end: node.end,
          loc: node.loc,
        },
        node
      )
    );
  }
  return null;
}
