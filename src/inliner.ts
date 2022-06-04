import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  hasProperty,
  isStateNode,
  traverseAst,
  variableDeclarationName,
} from "./api";
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
    // enums are constant, they cant change
    if (decl.type === "EnumStringMember") return true;
    if (decl.type === "VariableDeclarator") {
      // constants also can't change
      if (decl.node.kind === "const") return true;
      // if decl is a local, it also can't be changed
      // by a call to another function.
      for (let i = 0; ; i++) {
        if (!state.stack[i] || decl.stack[i] !== state.stack[i]) return false;
        if (state.stack[i].type === "FunctionDeclaration") return true;
      }
    }
    return null;
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
  if (allSafe) return true;
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
        case "CallExpression":
        case "NewExpression":
        case "AssignmentExpression":
        case "UpdateExpression":
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

export function shouldInline(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  args: mctree.Node[]
): InlineStatus {
  let autoInline: number | boolean = false;
  let inlineAsExpression = false;
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
    return InlineStatus.AsExpression;
  }

  const excludeAnnotations =
    (func.node.loc?.source &&
      state.fnMap[func.node.loc?.source]?.excludeAnnotations) ||
    {};

  const inlineRequested =
    func.node.attrs &&
    func.node.attrs.attrs &&
    func.node.attrs.attrs.some(
      (attr) =>
        attr.type === "UnaryExpression" &&
        (attr.argument.name === "inline" ||
          (attr.argument.name.startsWith("inline_") &&
            hasProperty(excludeAnnotations, attr.argument.name.substring(7))))
    );
  if (autoInline || inlineRequested) {
    return inlineAsExpression && canInline(state, func, args)
      ? InlineStatus.AsExpression
      : InlineStatus.AsStatement;
  }
  return InlineStatus.Never;
}

type InlineBody =
  | mctree.BlockStatement
  | mctree.ExpressionStatement["expression"];
type InlineBodyReturn<T extends InlineBody> = T extends mctree.BlockStatement
  ? mctree.BlockStatement
  : mctree.ExpressionStatement["expression"];

function processInlineBody<T extends InlineBody>(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression,
  root: T,
  insertedVariableDecls: mctree.VariableDeclaration | boolean,
  params?: Record<string, number>
): InlineBodyReturn<T> | null {
  if (!params) {
    const safeArgs = getArgSafety(state, func, call.arguments, false);
    params = Object.fromEntries(
      func.node.params.map((param, i) => {
        const argnum =
          safeArgs === true || (safeArgs !== false && safeArgs[i] !== null)
            ? i
            : -1;
        const name = variableDeclarationName(param);
        return [name, argnum];
      })
    );
  }

  const pre = state.pre!;
  const post = state.post!;
  try {
    state.pre = (node: mctree.Node) => {
      node.start = call.start;
      node.end = call.end;
      node.loc = call.loc;
      if (node === insertedVariableDecls) return false;
      const result = pre(node, state);
      if (!insertedVariableDecls && node.type === "BlockStatement") {
        const locals = state.localsStack![state.localsStack!.length - 1];
        const { map } = locals;
        if (!map) throw new Error("No local variable map!");
        const declarations: mctree.VariableDeclarator[] = func.node.params
          .map((param, i): mctree.VariableDeclarator | null => {
            const paramName = variableDeclarationName(param);
            if (params![paramName] >= 0) return null;
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
            throw new Error(`Inliner: Couldn't fix the scope of '${node.name}`);
          }
          break;
        }
      }
      return post(replacement || node, state) || replacement;
    };
    return (state.traverse(root) as InlineBodyReturn<T>) || null;
  } catch (ex) {
    if (ex instanceof Error) {
      if (ex.message.startsWith("Inliner: ")) {
        return null;
      }
    }
    throw ex;
  } finally {
    state.pre = pre;
    state.post = post;
  }
}

export function unused(
  expression: mctree.ExpressionStatement["expression"]
): mctree.ExpressionStatement[] {
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
      return unused(expression.object).concat(unused(expression.property));
  }
  return [
    {
      type: "ExpressionStatement",
      expression,
    },
  ];
}

function inlineWithArgs(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression
) {
  if (!func.node || !func.node.body) {
    return null;
  }

  let retStmtCount = 0;
  traverseAst(func.node.body, (node) => {
    node.type === "ReturnStatement" && retStmtCount++;
  });
  if (
    retStmtCount > 1 ||
    (retStmtCount === 1 &&
      func.node.body.body.slice(-1)[0].type !== "ReturnStatement")
  ) {
    return null;
  }

  const body = JSON.parse(
    JSON.stringify(func.node!.body)
  ) as mctree.BlockStatement;

  processInlineBody(
    state,
    func,
    call,
    body,
    func.node.params.length ? false : true
  );
  if (retStmtCount) {
    const last = body.body[body.body.length - 1];
    if (last.type != "ReturnStatement") {
      throw new Error("ReturnStatement got lost!");
    }
    if (last.argument) {
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
  inlineStatus: InlineStatus
): InlineBody | null {
  if (inlineStatus == InlineStatus.AsStatement) {
    return inlineWithArgs(state, func, call);
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
  return processInlineBody(state, func, call, retArg, true, params) || retArg;
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
    for (let i = state.stack.length; --i > nodeStack.length; ) {
      const si = state.stack[i];
      if (hasProperty(si.decls, lookupNode.name)) {
        // its a local from the inlined function.
        // Nothing to do.
        return lookupNode;
      }
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
