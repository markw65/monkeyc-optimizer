import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  hasProperty,
  isStateNode,
  traverseAst,
  variableDeclarationName,
} from "./api";

type Expression = mctree.BinaryExpression["left"];

function canInline(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  args: mctree.Node[]
) {
  // determine whether decl might be changed by a function call
  // during the evaluation of FunctionStateNode.
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
          if (!results || results.length !== 1) return false;
          const safety = getSafety(results[0]);
          if (safety === null) return false;
          if (!safety) allSafe = false;
          safeArgs.push(safety);
          return true;
        }
      }
      return false;
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
          callSeen = true;
          break;
        case "Identifier":
          if (
            callSeen &&
            hasProperty(params, node.name) &&
            !safeArgs[params[node.name]]
          ) {
            ok = false;
          }
      }
    }
  );
  return ok;
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

export function shouldInline(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  args: mctree.Node[]
) {
  if (
    !func.node.body ||
    func.node.body.body.length !== 1 ||
    func.node.body.body[0].type !== "ReturnStatement" ||
    !func.node.body.body[0].argument ||
    func.node.params.length !== args.length
  ) {
    return false;
  }

  const autoInline = inliningLooksUseful(
    func.node,
    func.node.body.body[0].argument
  );
  const excludeAnnotations =
    (func.node.loc?.source &&
      state.fnMap[func.node.loc?.source].excludeAnnotations) ||
    {};
  return (
    (autoInline ||
      (func.node.attrs &&
        func.node.attrs.attrs &&
        func.node.attrs.attrs.some(
          (attr) =>
            attr.type === "UnaryExpression" &&
            (attr.argument.name === "inline" ||
              (attr.argument.name.startsWith("inline_") &&
                hasProperty(
                  excludeAnnotations,
                  attr.argument.name.substring(7)
                )))
        ))) &&
    (autoInline === 1 || canInline(state, func, args))
  );
}

export function inlineFunction(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  call: mctree.CallExpression
) {
  const retArg = JSON.parse(
    JSON.stringify(
      (func.node!.body!.body[0] as mctree.ReturnStatement).argument!
    )
  );
  const params = Object.fromEntries(
    func.node.params.map(
      (param, i) => [variableDeclarationName(param), i] as const
    )
  );
  try {
    const result =
      traverseAst(
        retArg,
        (node) => {
          switch (node.type) {
            case "MemberExpression":
              if (!node.computed) {
                return ["object"];
              }
              break;
            case "BinaryExpression":
              if (node.operator === "as") {
                return ["left"];
              }
              break;
            case "UnaryExpression":
              if (node.operator === " as") {
                return [];
              }
          }
          return null;
        },
        (node) => {
          switch (node.type) {
            case "Identifier": {
              if (hasProperty(params, node.name)) {
                return call.arguments[params[node.name]];
              }
              const rep = fixNodeScope(state, node, func.stack!);
              if (!rep) {
                throw new Error(
                  `Inliner: Couldn't fix the scope of '${node.name}`
                );
              }
              return rep;
            }
          }
          return null;
        }
      ) || retArg;
    result.loc = call.loc;
    result.start = call.start;
    result.end = call.end;
    return result;
  } catch (ex) {
    if (ex instanceof Error) {
      if (ex.message.startsWith("Inliner: ")) {
        return null;
      }
    }
    throw ex;
  }
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
