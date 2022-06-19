import { mctree } from "@markw65/prettier-plugin-monkeyc";

type SubNodes<T extends mctree.Node> = {
  [K in keyof T as NonNullable<T[K]> extends mctree.Node | mctree.Node[]
    ? K
    : never]: true;
};

type NodeKeys<T extends mctree.Node> = keyof SubNodes<T>;

type MCTreeTypeInfo = {
  [K in mctree.Node["type"]]: Readonly<
    K extends "Line" | "Block" | "MultiLine"
      ? never[]
      : NodeKeys<Extract<mctree.Node, { type: K }>>[]
  >;
};

type TypeInfoFromConst<T> = {
  [K in keyof T]: T[K] extends readonly unknown[]
    ? readonly T[K][number][]
    : never;
};

/*
 * This ensures that mctreeTypeInfo has every key of MCTreeTypeInfo,
 * and that the corresponding arrays contain every element of the
 * corresponding type.
 *
 * ie, any time mctree.Node changes, we'll get errors here if
 * mctreeTypeInfo needs updating.
 *
 */
function _check(x: MCTreeTypeInfo) {
  const y: TypeInfoFromConst<typeof mctreeTypeInfo> = x;
  x = y;
}

const mctreeTypeInfo = {
  ArrayExpression: ["elements"],
  AssignmentExpression: ["left", "right"],
  AttributeList: ["attributes"],
  Attributes: ["elements"],
  BinaryExpression: ["left", "right"],
  Block: [],
  BlockStatement: ["body", "innerComments"],
  BreakStatement: [],
  CallExpression: ["callee", "arguments"],
  CatchClause: ["param", "body"],
  CatchClauses: ["catches"],
  ClassBody: ["body"],
  ClassDeclaration: ["attrs", "id", "superClass", "body"],
  ClassElement: ["item"],
  ConditionalExpression: ["test", "consequent", "alternate"],
  ContinueStatement: [],
  DoWhileStatement: ["body", "test"],
  EnumDeclaration: ["attrs", "id", "body"],
  EnumStringBody: ["members"],
  EnumStringMember: ["id", "init"],
  ExpressionStatement: ["expression"],
  ForStatement: ["init", "test", "body", "update"],
  FunctionDeclaration: ["attrs", "id", "params", "body"],
  Identifier: [],
  IfStatement: ["test", "consequent", "alternate"],
  ImportModule: ["id"],
  InstanceOfCase: ["id"],
  Line: [],
  Literal: [],
  LogicalExpression: ["left", "right"],
  MemberExpression: ["object", "property"],
  MethodDefinition: ["params", "returnType"],
  ModuleDeclaration: ["attrs", "id", "body"],
  MultiLine: [],
  NewExpression: ["callee", "arguments"],
  ObjectExpression: ["properties"],
  ParenthesizedExpression: ["expression"],
  Program: ["body", "comments"],
  Property: ["key", "value"],
  ReturnStatement: ["argument"],
  SequenceExpression: ["expressions"],
  SizedArrayExpression: ["size", "ts"],
  SwitchCase: ["test", "consequent"],
  SwitchStatement: ["discriminant", "cases"],
  ThisExpression: [],
  ThrowStatement: ["argument"],
  TryStatement: ["block", "handler", "finalizer"],
  TypedefDeclaration: ["attrs", "id", "ts"],
  TypeSpecList: ["ts"],
  TypeSpecPart: ["body", "callspec", "generics"],
  UnaryExpression: ["argument"],
  UpdateExpression: ["argument"],
  Using: ["id", "as"],
  VariableDeclaration: ["attrs", "declarations"],
  VariableDeclarator: ["id", "init"],
  WhileStatement: ["test", "body"],
} as const;

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
  if (!mctreeTypeInfo[node.type]) {
    throw new Error("what?");
  }
  for (const key of nodes || mctreeTypeInfo[node.type]) {
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
