import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  hasProperty,
  isStateNode,
  traverseAst,
  variableDeclarationName,
} from "./api";
import { pushUnique } from "./util";
import { renameVariable } from "./variable-renamer";

type Expression = mctree.BinaryExpression["left"];

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
  let allSafe = true;
  if (
    !args.every((arg) => {
      switch (arg.type) {
        case "Literal":
          safeArgs.push(true);
          return true;
        case "Identifier":
        case "MemberExpression": {
          const [, results] = state.lookup(arg);
          if (!results || results.length !== 1) {
            safeArgs.push(null);
            return !requireAll;
          }
          const safety = getSafety(results[0]);
          safeArgs.push(safety);
          if (!safety) {
            allSafe = false;
            if (safety === null) {
              return !requireAll;
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
  let callSeen = false;
  let ok = true;
  const params = Object.fromEntries(
    func.node.params.map(
      (param, i) => [variableDeclarationName(param), i] as const
    )
  );
  const getLoc = (node: mctree.Node | mctree.Node[]) =>
    (Array.isArray(node) ? node[0].start : node.start) || 0;
  // look for uses of "unsafe" args that occur after a call.
  // use post to do the checking, because arguments are evaluated
  // prior to the call, so eg "return f(x.y);" is fine, but
  // "return f()+x.y" is not.
  //
  // We also have to use a "pre" to ensure that child nodes are
  // visited in source order (otherwise we could visit x.y before f()
  // in the above example)
  traverseAst(
    func.node.body!,
    (node) => {
      return Object.entries(node)
        .filter(
          (kv): kv is [keyof mctree.NodeAll, mctree.Node | mctree.Node[]] =>
            Array.isArray(kv[1])
              ? kv[1].length !== 0 && hasProperty(kv[1][0], "type")
              : hasProperty(kv[1], "type")
        )
        .sort(([, a], [, b]) => getLoc(a) - getLoc(b))
        .map(([key]) => key);
    },
    (node) => {
      switch (node.type) {
        case "AssignmentExpression":
        case "UpdateExpression": {
          const v = node.type == "UpdateExpression" ? node.argument : node.left;
          if (v.type === "Identifier" && hasProperty(params, v.name)) {
            safeArgs[params[v.name]] = null;
          }
        }
        // fall through
        case "CallExpression":
        case "NewExpression":
          callSeen = true;
          break;
        case "Identifier":
          if (
            callSeen &&
            hasProperty(params, node.name) &&
            !safeArgs[params[node.name]]
          ) {
            safeArgs[params[node.name]] = null;
          }
      }
    }
  );
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

export enum InlineStatus {
  Never,
  AsExpression,
  AsStatement,
}

function inlineRequested(state: ProgramStateAnalysis, func: FunctionStateNode) {
  const excludeAnnotations =
    (func.node.loc?.source &&
      state.fnMap[func.node.loc?.source]?.excludeAnnotations) ||
    {};

  if (
    func.node.attrs &&
    func.node.attrs.attrs &&
    func.node.attrs.attrs.some(
      (attr) =>
        attr.type === "UnaryExpression" &&
        (attr.argument.name === "inline" ||
          (attr.argument.name.startsWith("inline_") &&
            hasProperty(excludeAnnotations, attr.argument.name.substring(7))))
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
        "This function can only be inlined in statement, assignment, or return contexts"
      );
    }
    return context != null;
  }
  return false;
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
  insertedVariableDecls: mctree.VariableDeclaration | boolean,
  params: Record<string, number>
): InlineBodyReturn<T> | null {
  let failed: boolean = false;
  const pre = state.pre!;
  const post = state.post!;
  try {
    state.pre = (node: mctree.Node) => {
      if (failed) return [];
      node.start = call.start;
      node.end = call.end;
      node.loc = call.loc;
      if (node === insertedVariableDecls) return false;
      const result = pre(node, state);
      if (!insertedVariableDecls && node.type === "BlockStatement") {
        const locals = state.localsStack![state.localsStack!.length - 1];
        const { map } = locals;
        if (!map) throw new Error("No local variable map!");
        // We still need to keep track of every local name that was
        // already in use, but we don't want to use any of its renames.
        // We also want to know whether a local is from the function being
        // inlined, or the calling function, so set every element to false.
        Object.keys(map).forEach((key) => (map[key] = false));
        const declarations: mctree.VariableDeclarator[] = func.node.params
          .map((param, i): mctree.VariableDeclarator | null => {
            const paramName = variableDeclarationName(param);
            if (params[paramName] >= 0) return null;
            const name = renameVariable(state, locals, paramName) || paramName;

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
      }
      return result;
    };
    state.post = (node: mctree.Node) => {
      if (failed) return null;
      let replacement = null;
      switch (node.type) {
        case "Identifier": {
          if (state.inType) break;
          if (hasProperty(params, node.name)) {
            const ix = params[node.name];
            if (ix >= 0) {
              replacement = call.arguments[ix];
            }
            break;
          }
          replacement = fixNodeScope(state, node, func.stack!);
          if (!replacement) {
            failed = true;
            inlineDiagnostic(
              state,
              func,
              call,
              `Failed to resolve '${node.name}'`
            );
            return null;
          }
          break;
        }
      }
      return post(replacement || node, state) || replacement;
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
  }
}

export function unused(
  expression: mctree.ExpressionStatement["expression"]
): mctree.ExpressionStatement[];
export function unused(
  expression: mctree.ExpressionStatement["expression"],
  top: true
): mctree.ExpressionStatement[] | null;
export function unused(
  expression: mctree.ExpressionStatement["expression"],
  top?: boolean
): mctree.ExpressionStatement[] | null {
  switch (expression.type) {
    case "Literal":
      return [];
    case "Identifier":
      return [];
    case "BinaryExpression":
      if (expression.operator === "as") {
        return unused(expression.left);
      }
    // fall through
    case "LogicalExpression":
      return unused(expression.left).concat(unused(expression.right));
    case "UnaryExpression":
      return unused(expression.argument);
    case "MemberExpression":
      if (expression.computed) {
        return unused(expression.object).concat(unused(expression.property));
      }
      return unused(expression.object);
    case "ArrayExpression":
      return expression.elements.map((e) => unused(e)).flat(1);
    case "ObjectExpression":
      return expression.properties
        .map((p) => unused(p.key).concat(unused(p.value)))
        .flat(1);
  }
  return top
    ? null
    : [
        {
          type: "ExpressionStatement",
          expression,
          start: expression.start,
          end: expression.end,
          loc: expression.loc,
        },
      ];
}

function diagnostic(
  state: ProgramStateAnalysis,
  loc: mctree.Node["loc"],
  message: string | null
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
    diags[index] = { type: "INFO", loc, message };
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
  | mctree.AssignmentExpression
  | mctree.ExpressionStatement;

function inlineWithArgs(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext
) {
  if (!func.node || !func.node.body) {
    return null;
  }

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
    } else if (context.type === "AssignmentExpression" && retStmtCount !== 1) {
      inlineDiagnostic(
        state,
        func,
        call,
        "Function did not have a return statement"
      );
      return null;
    }
    if (retStmtCount === 1) {
      const last = func.node.body.body.slice(-1)[0];
      if (
        !last ||
        last.type !== "ReturnStatement" ||
        (context.type === "AssignmentExpression" && !last.argument)
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

  const body = JSON.parse(
    JSON.stringify(func.node!.body)
  ) as mctree.BlockStatement;

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

  if (
    !processInlineBody(
      state,
      func,
      call,
      body,
      func.node.params.length ? false : true,
      params
    )
  ) {
    return null;
  }
  diagnostic(state, call.loc, null);
  if (context.type !== "ReturnStatement" && retStmtCount) {
    const last = body.body[body.body.length - 1];
    if (last.type != "ReturnStatement") {
      throw new Error("ReturnStatement got lost!");
    }
    if (context.type === "AssignmentExpression") {
      context.right = last.argument!;
      body.body[body.body.length - 1] = {
        type: "ExpressionStatement",
        expression: context,
      };
    } else if (last.argument) {
      const side_exprs = unused(last.argument);
      body.body.splice(body.body.length - 1, 1, ...side_exprs);
    } else {
      --body.body.length;
    }
  }
  return body;
}

export function inlineFunction(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  context: InlineContext | null
): InlineBody | null {
  if (context) {
    return inlineWithArgs(state, func, call, context);
  }
  const retArg = JSON.parse(
    JSON.stringify(
      (func.node!.body!.body[0] as mctree.ReturnStatement).argument!
    )
  ) as NonNullable<mctree.ReturnStatement["argument"]>;
  const params = Object.fromEntries(
    func.node.params.map(
      (param, i) => [variableDeclarationName(param), i] as const
    )
  );
  return processInlineBody(state, func, call, retArg, true, params);
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
  if (
    current &&
    current.length === original.length &&
    current.every((item, index) => item == original[index])
  ) {
    return lookupNode;
  }
  const node =
    lookupNode.type === "Identifier"
      ? lookupNode
      : (lookupNode.property as mctree.Identifier);

  if (original.length === 1 && original[0].type === "EnumStringMember") {
    return applyTypeIfNeeded(original[0].init);
  }

  const prefixes = original.map((sn) => {
    if (isStateNode(sn) && sn.fullName) {
      return sn.fullName;
    }
    return "";
  });

  if (
    prefixes.length &&
    prefixes[0].startsWith("$.") &&
    prefixes.every((prefix, i) => !i || prefix === prefixes[i - 1])
  ) {
    const prefix = prefixes[0].split(".").slice(0, -1).reverse();
    let found = false;
    return prefix.reduce<mctree.MemberExpression | mctree.Identifier>(
      (current, name) => {
        if (found) return current;
        const [, results] = state.lookup(current);
        if (
          results &&
          results.length === original.length &&
          results.every((result, i) => result === original[i])
        ) {
          found = true;
          return current;
        }
        const object: mctree.Identifier =
          typeof name === "string"
            ? {
                type: "Identifier",
                name,
                start: node.start,
                end: node.end,
                loc: node.loc,
              }
            : name;
        let root = null;
        let property = current;
        while (property.type !== "Identifier") {
          root = property;
          property = property.object as typeof current;
        }
        const mb: mctree.MemberExpression = {
          type: "MemberExpression",
          object,
          property,
          computed: false,
          start: node.start,
          end: node.end,
          loc: node.loc,
        };
        if (root) {
          root.object = mb;
        } else {
          current = mb;
        }
        return current;
      },
      node
    );
  }
  return null;
}
