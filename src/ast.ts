import { mctree } from "@markw65/prettier-plugin-monkeyc";

type UnionMemberExtends<T, U> = true extends (T extends U ? true : never)
  ? true
  : unknown;

type SubNodes<T extends mctree.Node> = {
  [K in keyof T as UnionMemberExtends<
    T[K],
    mctree.Node | mctree.Node[]
  > extends true
    ? K extends "enumType"
      ? never
      : K
    : never]: true;
};

type NodeKeys<T extends mctree.Node> = keyof SubNodes<T>;
type Node<K> = K extends "Line" | "Block" | "MultiLine"
  ? mctree.Comment
  : Extract<mctree.Node, { type: K }>;

type NodeExtends<K, T> = UnionMemberExtends<Node<K>, T>;

type MCTreeTypeInfo = {
  [Type in mctree.Node["type"]]: {
    [K in "keys" | "stmt" | "expr" as K extends "stmt"
      ? NodeExtends<Type, mctree.Statement> extends true
        ? K
        : never
      : K extends "expr"
      ? NodeExtends<Type, mctree.Expression> extends true
        ? K
        : never
      : K]: K extends "keys"
      ? Readonly<NodeKeys<Node<Type>>[]>
      : K extends "stmt" | "expr"
      ? true
      : never;
  };
};

type KeysInfoFromConst<T> = T extends { keys: unknown }
  ? T["keys"] extends readonly unknown[]
    ? readonly T["keys"][number][]
    : never
  : never;

type SubInfoFromConst<T> = {
  [K in keyof T]: K extends "keys" ? KeysInfoFromConst<T> : T[K];
};

type TypeInfoFromConst<T> = {
  [K in keyof T]: SubInfoFromConst<T[K]>;
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
  ArrayExpression: { keys: ["elements"], expr: true },
  AssignmentExpression: { keys: ["left", "right"], expr: true },
  AttributeList: { keys: ["attributes"] },
  Attributes: { keys: ["elements"] },
  BinaryExpression: { keys: ["left", "right"], expr: true },
  Block: { keys: [] },
  BlockStatement: { keys: ["body", "innerComments"], stmt: true },
  BreakStatement: { keys: [], stmt: true },
  CallExpression: { keys: ["callee", "arguments"], expr: true },
  CatchClause: { keys: ["param", "body"] },
  CatchClauses: { keys: ["catches"] },
  ClassBody: { keys: ["body"] },
  ClassDeclaration: { keys: ["attrs", "id", "superClass", "body"], stmt: true },
  ClassElement: { keys: ["item"] },
  ConditionalExpression: {
    keys: ["test", "consequent", "alternate"],
    expr: true,
  },
  ContinueStatement: { keys: [], stmt: true },
  DoWhileStatement: { keys: ["body", "test"], stmt: true },
  EnumDeclaration: { keys: ["attrs", "id", "body"], stmt: true },
  EnumStringBody: { keys: ["members"] },
  EnumStringMember: { keys: ["id", "init"] },
  ExpressionStatement: { keys: ["expression"], stmt: true },
  ForStatement: { keys: ["init", "test", "body", "update"], stmt: true },
  FunctionDeclaration: {
    keys: ["attrs", "id", "params", "returnType", "body"],
    stmt: true,
  },
  Identifier: { keys: [], expr: true },
  IfStatement: { keys: ["test", "consequent", "alternate"], stmt: true },
  ImportModule: { keys: ["id"] },
  InstanceOfCase: { keys: ["id"] },
  Line: { keys: [] },
  Literal: { keys: [], expr: true },
  LogicalExpression: { keys: ["left", "right"], expr: true },
  MemberExpression: { keys: ["object", "property"], expr: true },
  MethodDefinition: { keys: ["params", "returnType"] },
  ModuleDeclaration: { keys: ["attrs", "id", "body"], stmt: true },
  MultiLine: { keys: [] },
  NewExpression: { keys: ["callee", "arguments"], expr: true },
  ObjectExpression: { keys: ["properties"], expr: true },
  ParenthesizedExpression: { keys: ["expression"], expr: true },
  Program: { keys: ["body", "comments"] },
  Property: { keys: ["key", "value"] },
  ReturnStatement: { keys: ["argument"], stmt: true },
  SequenceExpression: { keys: ["expressions"], expr: true },
  SizedArrayExpression: { keys: ["size", "ts"], expr: true },
  SwitchCase: { keys: ["test", "consequent"] },
  SwitchStatement: { keys: ["discriminant", "cases"], stmt: true },
  ThisExpression: { keys: [], expr: true },
  ThrowStatement: { keys: ["argument"], stmt: true },
  TryStatement: { keys: ["block", "handler", "finalizer"], stmt: true },
  TypedefDeclaration: { keys: ["attrs", "id", "ts"], stmt: true },
  TypeSpecList: { keys: ["ts"] },
  TypeSpecPart: { keys: ["name", "body", "callspec", "generics"] },
  UnaryExpression: { keys: ["argument"], expr: true },
  UpdateExpression: { keys: ["argument"], expr: true },
  Using: { keys: ["id", "as"] },
  VariableDeclaration: { keys: ["attrs", "declarations"], stmt: true },
  VariableDeclarator: { keys: ["id", "init"] },
  WhileStatement: { keys: ["test", "body"], stmt: true },
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
  for (const key of nodes || mctreeTypeInfo[node.type].keys) {
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

export function isStatement(node: mctree.Node): node is mctree.Statement {
  return hasProperty(mctreeTypeInfo[node.type], "stmt");
}

export function isExpression(node: mctree.Node): node is mctree.Expression {
  return hasProperty(mctreeTypeInfo[node.type], "expr");
}

// We can use hasProperty to remove undefined/null (as a side effect),
// but we shouldn't apply it to things the compiler already knows are
// non null because them the compiler will incorrectly infer never in the
// false case.
export function hasProperty<
  T extends null extends T ? unknown : undefined extends T ? unknown : never
>(obj: T, prop: string): obj is NonNullable<T>;
export function hasProperty<T>(obj: T, prop: string): boolean;
export function hasProperty(obj: unknown, prop: string): boolean {
  return obj ? Object.prototype.hasOwnProperty.call(obj, prop) : false;
}
