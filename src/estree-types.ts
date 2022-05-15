// Type definitions for MonkeyC ESTree-like AST specification

// Find the union of all keys across all components of U
type InclusiveUnionKeys<U> = U extends unknown ? keyof U : never;

// Create a type whose keys are InclusiveUnionKeys<U>, and whose
// corresponding types are the union across all components of U[K]
type InclusiveUnion<U> = {
  [K in InclusiveUnionKeys<U>]: U extends any
    ? K extends keyof U
      ? U[K]
      : never
    : never;
};
type SubfieldsOfType<T, U> = {
  [K in keyof T as T[K] extends U ? K : never]: T[K];
};

export type NodeAll = InclusiveUnion<Node>;
export type NodeSubFields = SubfieldsOfType<NodeAll, Node>;
export type NodeSubArrays = SubfieldsOfType<NodeAll, Node[]>;

interface BaseNode {
  // Every leaf interface that extends BaseNode must specify a type property.
  // The type property should be a string literal. For example, Identifier
  // has: `type: "Identifier"`
  type: string;
  loc?: SourceLocation | null | undefined;
  start?: number;
  end?: number;
  range?: [number, number] | undefined;
}

export type Node =
  | Identifier
  | Literal
  | Program
  | SwitchCase
  | CatchClause
  | VariableDeclarator
  | EnumStringBody
  | EnumStringMember
  | Statement
  | Expression
  | Property
  | Identifier
  | Declaration
  | ImportStatement
  | AsTypeSpec
  | TypeSpecList
  | ClassElement
  | ClassBody
  | Comment;

export interface Comment extends BaseNode {
  type: "Line" | "Block";
  value: string;
}

interface SourceLocation {
  source?: string | null | undefined;
  start: Position;
  end: Position;
}

export interface Position {
  /** >= 1 */
  line: number;
  /** >= 0 */
  column: number;
}

export interface Program extends BaseNode {
  type: "Program";
  body: Array<Declaration | ImportStatement>;
  comments?: Array<Comment> | undefined;
}

export interface ModuleDeclaration extends BaseDeclaration {
  type: "ModuleDeclaration";
  body: Array<Declaration | ImportStatement>;
  id: Identifier;
}

interface BaseFunction extends BaseNode {
  params: Array<Identifier>;
  body: BlockStatement;
}

export type Statement =
  | ExpressionStatement
  | BlockStatement
  | ReturnStatement
  | BreakStatement
  | ContinueStatement
  | IfStatement
  | SwitchStatement
  | ThrowStatement
  | TryStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | Declaration;

interface BaseStatement extends BaseNode {}

export interface BlockStatement extends BaseStatement {
  type: "BlockStatement";
  body: Array<Statement>;
  innerComments?: Array<Comment> | undefined;
}

export interface ExpressionStatement extends BaseStatement {
  type: "ExpressionStatement";
  expression: Expression;
}

export interface IfStatement extends BaseStatement {
  type: "IfStatement";
  test: Expression;
  consequent: Statement;
  alternate?: Statement | null | undefined;
}

export interface BreakStatement extends BaseStatement {
  type: "BreakStatement";
}

export interface ContinueStatement extends BaseStatement {
  type: "ContinueStatement";
}

export interface SwitchStatement extends BaseStatement {
  type: "SwitchStatement";
  discriminant: Expression;
  cases: Array<SwitchCase>;
}

export interface ReturnStatement extends BaseStatement {
  type: "ReturnStatement";
  argument?: Expression | null | undefined;
}

export interface ThrowStatement extends BaseStatement {
  type: "ThrowStatement";
  argument: Expression;
}

export interface TryStatement extends BaseStatement {
  type: "TryStatement";
  block: BlockStatement;
  handler?: CatchClause | CatchClauses | null | undefined;
  finalizer?: BlockStatement | null | undefined;
}

export interface WhileStatement extends BaseStatement {
  type: "WhileStatement";
  test: Expression;
  body: Statement;
}

export interface DoWhileStatement extends BaseStatement {
  type: "DoWhileStatement";
  body: Statement;
  test: Expression;
}

export interface ForStatement extends BaseStatement {
  type: "ForStatement";
  init?: VariableDeclaration | Expression | null | undefined;
  test?: Expression | null | undefined;
  update?: Expression | null | undefined;
  body: Statement;
}

export type Declaration =
  | ClassDeclaration
  | EnumDeclaration
  | FunctionDeclaration
  | ModuleDeclaration
  | TypedefDeclaration
  | VariableDeclaration;

interface BaseDeclaration extends BaseStatement {
  attrs?: AttributeList;
}

export interface FunctionDeclaration extends BaseFunction, BaseDeclaration {
  type: "FunctionDeclaration";
  id: Identifier;
  body: BlockStatement;
  optimizable?: boolean;
  hasOverride?: boolean;
}

export interface VariableDeclaration extends BaseDeclaration {
  type: "VariableDeclaration";
  declarations: Array<VariableDeclarator>;
  kind: "var" | "const";
}

export interface VariableDeclarator extends BaseNode {
  type: "VariableDeclarator";
  id: Identifier;
  init?: Expression | null | undefined;
}

type Expression =
  | ThisExpression
  | ArrayExpression
  | ObjectExpression
  | Literal
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | AsExpression
  | AssignmentExpression
  | LogicalExpression
  | MemberExpression
  | ConditionalExpression
  | CallExpression
  | NewExpression
  | SequenceExpression
  | Identifier;

export interface BaseExpression extends BaseNode {
  // Added by optimizer
  enumType?: string | Node;
}

type ChainElement = SimpleCallExpression | MemberExpression;

export interface ThisExpression extends BaseExpression {
  type: "ThisExpression";
  text: string;
}

export interface ArrayExpression extends BaseExpression {
  type: "ArrayExpression";
  elements: Array<Expression>;
}

export interface ObjectExpression extends BaseExpression {
  type: "ObjectExpression";
  properties: Array<Property>;
}

export interface Property extends BaseNode {
  type: "Property";
  key: Expression;
  value: Expression;
  kind: "init";
}

export interface SequenceExpression extends BaseExpression {
  type: "SequenceExpression";
  expressions: Array<Expression>;
}

interface BaseUnaryExpression extends BaseExpression {
  type: "UnaryExpression";
  prefix: true;
}

interface TrueUnaryExpression extends BaseUnaryExpression {
  operator: UnaryOperator;
  argument: Expression;
}

interface SymbolExpression extends BaseUnaryExpression {
  operator: ":";
  argument: Identifier;
}

export type UnaryExpression = TrueUnaryExpression | SymbolExpression;

export interface BinaryExpression extends BaseExpression {
  type: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface AsExpression extends BaseExpression {
  type: "BinaryExpression";
  operator: "as";
  left: Expression;
  right: TypeSpecList;
}

export interface AssignmentExpression extends BaseExpression {
  type: "AssignmentExpression";
  operator: AssignmentOperator;
  left: Identifier | MemberExpression;
  right: Expression;
}

export interface UpdateExpression extends BaseExpression {
  type: "UpdateExpression";
  operator: UpdateOperator;
  argument: Expression;
  prefix: boolean;
}

export interface LogicalExpression extends BaseExpression {
  type: "LogicalExpression";
  operator: LogicalOperator;
  left: Expression;
  right: Expression;
}

export interface ConditionalExpression extends BaseExpression {
  type: "ConditionalExpression";
  test: Expression;
  alternate: Expression;
  consequent: Expression;
}

interface BaseCallExpression extends BaseExpression {
  callee: Expression;
  arguments: Array<Expression>;
}
export type CallExpression = SimpleCallExpression | NewExpression;

export interface SimpleCallExpression extends BaseCallExpression {
  type: "CallExpression";
}

export interface NewExpression extends BaseCallExpression {
  type: "NewExpression";
}

export interface MemberExpression extends BaseExpression {
  type: "MemberExpression";
  object: Expression;
  property: Expression;
  computed: boolean;
}

export interface SwitchCase extends BaseNode {
  type: "SwitchCase";
  test?: Expression | null | undefined;
  consequent: Array<Statement>;
}

export interface CatchClause extends BaseNode {
  type: "CatchClause";
  param: Identifier | null;
  body: BlockStatement;
}

export interface CatchClauses extends BaseNode {
  type: "CatchClauses";
  catches: CatchClause[];
}

export interface Identifier extends BaseNode, BaseExpression {
  type: "Identifier";
  name: string;
  ts?: AsTypeSpec;
}

export interface Literal extends BaseNode, BaseExpression {
  type: "Literal";
  value: string | boolean | number | null;
  raw?: string | undefined;
}

export type UnaryOperator = "-" | "+" | "!" | "~" | " as";

export type BinaryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "<<"
  | ">>"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "|"
  | "^"
  | "&"
  | "has"
  | "instanceof";

export type LogicalOperator = "||" | "&&";

export type AssignmentOperator =
  | "="
  | "+="
  | "-="
  | "*="
  | "/="
  | "%="
  | "<<="
  | ">>="
  | "|="
  | "^="
  | "&=";

export type UpdateOperator = "++" | "--";

export interface ClassDeclaration extends BaseDeclaration {
  type: "ClassDeclaration";
  id: Identifier;
  superClass?: Expression | null | undefined;
  body: ClassBody;
}

export interface ClassBody extends BaseStatement {
  type: "ClassBody";
  body: Array<ClassElement>;
}

export interface ClassElement extends BaseStatement {
  type: "ClassElement";
  item: Omit<Declaration, "ModuleDeclaration">;
}

export interface EnumDeclaration extends BaseDeclaration {
  type: "EnumDeclaration";
  id?: Identifier | null;
  body: EnumStringBody;
}

export interface EnumStringBody extends BaseNode {
  type: "EnumStringBody";
  members: Array<EnumStringMember | Identifier>;
  // Added by optimizer
  enumType?: string | Node;
}

export interface EnumStringMember extends BaseNode {
  type: "EnumStringMember";
  id: Identifier;
  init: Expression;
  // Added by optimizer
  enumType?: string | Node;
}

export interface TypedefDeclaration extends BaseDeclaration {
  type: "TypedefDeclaration";
  id: Identifier;
  ts: AsTypeSpec;
}

export interface AsTypeSpec
  extends Omit<UnaryExpression, "operator" | "argument"> {
  operator: " as";
  argument: TypeSpecList;
}

export interface TypeSpecList extends BaseNode {
  type: "TypeSpecList";
  ts: Array<TypeSpecPart>;
}

export interface TypeSpecPart extends BaseNode {
  type: "TypeSpecPart";
  name: Identifier | MemberExpression;
  body?: BlockStatement;
  callspec?: MethodDefinition;
  generics?: Array<TypeSpecList>;
}

export interface MethodDefinition extends BaseNode {
  type: "MethodDefinition";
  kind: "method";
  key: "";
  params: Array<Identifier>;
  returnType: AsTypeSpec;
}

export type AccessSpecifier =
  | "static"
  | "private"
  | "protected"
  | "hidden"
  | "public";

export interface AttributeList extends BaseNode {
  type: "AttributeList";
  attrs?: Attribute[];
  access?: AccessSpecifier[];
}

type Attribute = SymbolExpression | CallExpression;

export type ImportStatement = ImportModule | Using;

export interface ImportModule extends BaseNode {
  type: "ImportModule";
  id: MemberExpression;
}

export interface Using extends BaseNode {
  type: "Using";
  id: MemberExpression;
  as: Identifier;
}
