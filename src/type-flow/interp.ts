import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { resolveDottedMember } from "../type-flow";
import { diagnostic, formatAst, isLookupCandidate } from "../api";
import { isExpression, traverseAst } from "../ast";
import { unhandledType } from "../data-flow";
import {
  DiagnosticType,
  ClassStateNode,
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNodeAttributes,
} from "../optimizer-types";
import { evaluateBinaryTypes, evaluateLogicalTypes } from "./interp-binary";
import { evaluateCall } from "./interp-call";
import {
  cloneType,
  display,
  EnumTagsConst,
  ExactOrUnion,
  hasNoData,
  hasValue,
  isExact,
  lookupByFullName,
  mustBeFalse,
  mustBeTrue,
  ObjectType,
  SingleTonTypeTagsConst,
  typeFromLiteral,
  typeFromTypespec,
  typeFromTypeStateNode,
  TypeTag,
  ValueTypeTagsConst,
} from "./types";
import { unionInto } from "./union-type";
import { couldBe } from "./could-be";

export type TypeMap = Map<mctree.Node, ExactOrUnion>;

export type InterpStackElem = {
  value: ExactOrUnion;
  embeddedEffects: boolean;
  node: mctree.Expression | mctree.TypeSpecList | mctree.InstanceOfCase;
};

export type InterpState = {
  state: ProgramStateAnalysis;
  stack: InterpStackElem[];
  typeMap?: TypeMap;
  func?: FunctionStateNode;
  pre?: (node: mctree.Node) => mctree.Node | false | null | void;
  post?: (node: mctree.Node) => mctree.Node | false | null | void;
  typeChecker?: (a: ExactOrUnion, b: ExactOrUnion) => boolean;
  checkTypes?: DiagnosticType;
};

export function popIstate(istate: InterpState, node: mctree.Node) {
  const item = istate.stack.pop();
  if (!item) {
    throw new Error("Unbalanced stack!");
  }
  if (item.node !== node) {
    throw new Error("Stack mismatch");
  }
  return item;
}

export function evaluateExpr(
  state: ProgramStateAnalysis,
  expr: mctree.Expression,
  typeMap?: TypeMap
) {
  return evaluate({ state, stack: [], typeMap }, expr);
}

export function evaluate(
  istate: InterpState,
  node: mctree.Expression
): InterpStackElem;
export function evaluate(
  istate: InterpState,
  node: mctree.Node
): InterpStackElem | undefined;
export function evaluate(istate: InterpState, node: mctree.Node) {
  let skipNode: mctree.Expression | null = null;
  const post = (node: mctree.Node) => {
    if (istate.pre && node !== skipNode) {
      const rep = istate.pre(node);
      if (rep) return rep;
    }
    evaluateNode(istate, node);
    if (skipNode === node) {
      skipNode = null;
      return null;
    }
    return istate.post ? istate.post(node) : null;
  };
  const pre = (node: mctree.Node): null | (keyof mctree.NodeAll)[] => {
    switch (node.type) {
      case "MemberExpression":
        if (isLookupCandidate(node)) {
          return ["object"];
        }
        break;
      case "BinaryExpression":
        if (node.operator === "as") {
          return ["left"];
        }
        break;
      case "UnaryExpression":
        if (node.operator === ":") {
          return [];
        }
        break;
      case "AttributeList":
        return [];
      case "AssignmentExpression":
        skipNode = node.left;
        break;
      case "UpdateExpression":
        skipNode = node.argument;
        break;
      case "SizedArrayExpression":
        return ["size"];
      case "VariableDeclarator":
        return ["init"];
      case "CatchClause":
        return ["body"];
    }
    return null;
  };

  traverseAst(node, pre, post);

  const ret = istate.stack.pop();
  if (isExpression(node)) {
    if (!ret || node !== ret.node) {
      throw new Error("evaluate failed to produce a value for an expression");
    }
  }
  return ret;
}

function evaluateUnaryTypes(
  op: mctree.UnaryOperator,
  argument: ExactOrUnion
): ExactOrUnion {
  switch (op) {
    case "+":
      return argument;
    case "-":
      return evaluateBinaryTypes(
        "-",
        { type: TypeTag.Number, value: 0 },
        argument
      );
    case "!":
    case "~":
      if (hasValue(argument)) {
        const left =
          argument.type & TypeTag.Boolean
            ? { type: TypeTag.True }
            : ({ type: TypeTag.Number, value: -1 } as const);
        return evaluateBinaryTypes("^", left, argument);
      }
      return {
        type: argument.type & (TypeTag.Boolean | TypeTag.Number | TypeTag.Long),
      };
  }
  throw new Error(`Unexpected unary operator ${op}`);
}

/*
 * When an enumeration constant, or a constant cast to an
 * enum type is used in an arithmetic context, its converted
 * to its underlying type.
 */
function deEnumerate(t: ExactOrUnion) {
  if (hasValue(t) && t.type === TypeTag.Enum && t.value.value) {
    return t.value.value;
  }
  if (t.type & TypeTag.Enum) {
    return {
      type: (t.type & ~TypeTag.Enum) | EnumTagsConst,
    };
  }
  return t;
}

function pushScopedNameType(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier,
  object?: InterpStackElem
) {
  let embeddedEffects = object ? object.embeddedEffects : false;

  let result;
  if (istate.typeMap) {
    result = istate.typeMap?.get(node);
    if (
      !result &&
      object &&
      node.type === "MemberExpression" &&
      !node.computed
    ) {
      const resolved = resolveDottedMember(istate, object.value, node);
      if (resolved) {
        result = resolved.property;
        if (resolved.mayThrow) {
          embeddedEffects = true;
        }
      }
    }
  } else {
    const [, results] = istate.state.lookup(node);
    result =
      (results &&
        results.reduce<ExactOrUnion | null>(
          (cur, lookupDefn) =>
            lookupDefn.results.reduce<ExactOrUnion | null>((cur, result) => {
              if (
                result.type !== "BinaryExpression" &&
                result.type !== "Identifier"
              ) {
                const type = typeFromTypeStateNode(istate.state, result, true);
                if (!cur) {
                  cur = cloneType(type);
                } else {
                  unionInto(cur, type);
                }
              }
              return cur;
            }, cur),
          null
        )) ||
      undefined;
  }
  istate.stack.push({
    value: result || { type: TypeTag.Any },
    embeddedEffects,
    node,
  });
}

export function evaluateNode(istate: InterpState, node: mctree.Node) {
  const { state, stack } = istate;

  const push = (item: InterpStackElem | null | false | undefined) => {
    if (!item) {
      throw new Error("Pushing null");
    }
    istate.stack.push(item);
  };
  switch (node.type) {
    case "BinaryExpression": {
      if (node.operator === "as") {
        push({
          value: typeFromTypespec(istate.state, node.right),
          embeddedEffects: false,
          node: node.right,
        });
      }
      const right = popIstate(istate, node.right);
      const left = popIstate(istate, node.left);
      if (node.operator === "as") {
        if (
          (left.value.type & (ValueTypeTagsConst | SingleTonTypeTagsConst)) ==
            left.value.type &&
          (right.value.type & left.value.type) === left.value.type &&
          hasNoData(right.value, left.value.type)
        ) {
          push({
            value: left.value,
            embeddedEffects: left.embeddedEffects,
            node,
          });
          return;
        }
        if (istate.checkTypes && !couldBe(left.value, right.value)) {
          diagnostic(
            istate.state,
            node,
            `The type ${display(left.value)} cannot be converted to ${display(
              right.value
            )} because they have nothing in common`,
            istate.checkTypes
          );
        }
        if (hasValue(right.value) && right.value.type === TypeTag.Enum) {
          if (
            (left.value.type & (TypeTag.Numeric | TypeTag.String)) ==
            left.value.type
          ) {
            right.value.value.value = left.value;
            stack.push({
              value: right.value,
              embeddedEffects: left.embeddedEffects,
              node,
            });
            return;
          }
        }
        push({
          value: right.value,
          embeddedEffects: left.embeddedEffects,
          node,
        });
      } else {
        if (
          istate.checkTypes &&
          (node.operator === "==" || node.operator == "!=") &&
          ((left.value.type === TypeTag.Null &&
            !(right.value.type & TypeTag.Null)) ||
            (right.value.type === TypeTag.Null &&
              !(left.value.type & TypeTag.Null))) &&
          (left.value.type | right.value.type) &
            (TypeTag.Object |
              TypeTag.Array |
              TypeTag.Dictionary |
              TypeTag.String)
        ) {
          diagnostic(
            istate.state,
            node,
            `This comparison seems redundant because ${formatAst(
              left.value.type === TypeTag.Null ? node.right : node.left
            )} should never be null`,
            istate.checkTypes
          );
        }
        push({
          value: evaluateBinaryTypes(
            node.operator,
            deEnumerate(left.value),
            deEnumerate(right.value)
          ),
          embeddedEffects: left.embeddedEffects || right.embeddedEffects,
          node,
        });
      }
      break;
    }
    case "UnaryExpression":
      if (node.operator === ":") {
        push({
          value: { type: TypeTag.Symbol, value: node.argument.name },
          embeddedEffects: false,
          node,
        });
      } else if (node.operator !== " as") {
        const arg = popIstate(istate, node.argument);
        push({
          value: evaluateUnaryTypes(node.operator, deEnumerate(arg.value)),
          embeddedEffects: arg.embeddedEffects,
          node,
        });
      }
      break;
    case "SizedArrayExpression": {
      const arg = popIstate(istate, node.size);
      push({
        value: { type: TypeTag.Array },
        embeddedEffects: arg.embeddedEffects,
        node,
      });
      break;
    }
    case "ArrayExpression": {
      const args = node.elements.length
        ? stack.splice(-node.elements.length)
        : [];
      const embeddedEffects = args.some((arg) => arg.embeddedEffects);
      if (node.byte) {
        push({
          value: {
            type: TypeTag.Object,
            value: {
              klass: {
                type: TypeTag.Class,
                value: lookupByFullName(
                  state,
                  "Toybox.Lang.ByteArray"
                ) as ClassStateNode[],
              },
            },
          },
          embeddedEffects,
          node,
        });
      } else {
        const value = args.reduce(
          (cur, next) => {
            unionInto(cur, next.value);
            return cur;
          },
          { type: TypeTag.Never }
        );
        const valTypes = value.type & ValueTypeTagsConst;
        if (valTypes && !hasNoData(value, valTypes)) {
          // drop any literals from the type
          unionInto(value, { type: valTypes });
        }
        push({
          value:
            value.type === TypeTag.Never
              ? {
                  type: TypeTag.Array,
                }
              : { type: TypeTag.Array, value },
          embeddedEffects,
          node,
        });
      }
      break;
    }
    case "ObjectExpression": {
      const args = node.properties.length
        ? stack.splice(-node.properties.length * 2)
        : [];
      const value = args.reduce(
        (cur, next, i) => {
          unionInto(i & 1 ? cur.value : cur.key, next.value);
          return cur;
        },
        { key: { type: TypeTag.Never }, value: { type: TypeTag.Never } }
      );
      push({
        value:
          value.key.type === TypeTag.Never && value.value.type === TypeTag.Never
            ? {
                type: TypeTag.Dictionary,
              }
            : {
                type: TypeTag.Dictionary,
                value,
              },
        embeddedEffects: args.some((arg) => arg.embeddedEffects),
        node,
      });
      break;
    }
    case "ThisExpression": {
      const self = (() => {
        for (let i = state.stack.length; i--; ) {
          const si = state.stack[i];
          if (si.type === "ClassDeclaration") {
            const klass = { type: TypeTag.Class, value: si } as const;
            if ((istate.func?.attributes || 0) & StateNodeAttributes.STATIC) {
              return klass;
            } else {
              return { type: TypeTag.Object, value: { klass } } as const;
            }
          }
          if (si.type === "ModuleDeclaration") {
            return { type: TypeTag.Module, value: si } as const;
          }
        }
        return { type: TypeTag.Module } as const;
      })();
      push({ value: self, embeddedEffects: false, node });
      break;
    }

    case "LogicalExpression": {
      const right = popIstate(istate, node.right);
      const left = popIstate(istate, node.left);
      push({
        value: evaluateLogicalTypes(
          node.operator,
          deEnumerate(left.value),
          deEnumerate(right.value)
        ),
        embeddedEffects: left.embeddedEffects || right.embeddedEffects,
        node,
      });
      break;
    }
    case "ConditionalExpression": {
      const alternate = popIstate(istate, node.alternate);
      const consequent = popIstate(istate, node.consequent);
      const test = popIstate(istate, node.test);
      const testType = deEnumerate(test.value);
      if (mustBeTrue(testType)) {
        push({
          value: consequent.value,
          embeddedEffects: test.embeddedEffects || consequent.embeddedEffects,
          node,
        });
      } else if (mustBeFalse(testType)) {
        push({
          value: alternate.value,
          embeddedEffects: test.embeddedEffects || alternate.embeddedEffects,
          node,
        });
      } else {
        const value = cloneType(consequent.value);
        unionInto(value, alternate.value);
        push({
          value,
          embeddedEffects:
            test.embeddedEffects ||
            alternate.embeddedEffects ||
            consequent.embeddedEffects,
          node,
        });
      }
      break;
    }
    case "ParenthesizedExpression": {
      const { value, embeddedEffects } = popIstate(istate, node.expression);
      push({ value, embeddedEffects, node });
      break;
    }
    case "Literal":
      push({
        value: typeFromLiteral(node),
        embeddedEffects: false,
        node,
      });
      break;
    case "Identifier":
      pushScopedNameType(istate, node);
      break;

    case "MemberExpression":
      if (!isLookupCandidate(node)) {
        const property = popIstate(istate, node.property);
        const object = popIstate(istate, node.object);
        if (
          hasValue(object.value) &&
          object.value.type === TypeTag.Array &&
          property.value.type & (TypeTag.Number | TypeTag.Long)
        ) {
          push({
            value: object.value.value,
            embeddedEffects: object.embeddedEffects || property.embeddedEffects,
            node,
          });
          break;
        }
        if (
          hasValue(object.value) &&
          object.value.type === TypeTag.Dictionary &&
          property.value.type & object.value.value.key.type
        ) {
          const value = { type: TypeTag.Null };
          unionInto(value, object.value.value.value);
          push({
            value,
            embeddedEffects: object.embeddedEffects || property.embeddedEffects,
            node,
          });
          break;
        }
        push({
          value: { type: TypeTag.Any },
          embeddedEffects: object.embeddedEffects || property.embeddedEffects,
          node,
        });
      } else {
        const object = popIstate(istate, node.object);
        pushScopedNameType(istate, node, object);
      }
      break;
    case "SequenceExpression": {
      if (stack.length < node.expressions.length) {
        throw new Error("Unbalanced stack");
      }
      if (node.expressions.length) {
        const right = popIstate(
          istate,
          node.expressions[node.expressions.length - 1]
        );
        if (node.expressions.length > 1) {
          right.embeddedEffects =
            stack
              .splice(1 - node.expressions.length)
              .some(({ embeddedEffects }) => embeddedEffects) ||
            right.embeddedEffects;
        }
        push({
          value: right.value,
          embeddedEffects: right.embeddedEffects,
          node,
        });
      }
      break;
    }
    case "AssignmentExpression": {
      const right = popIstate(istate, node.right);
      const left = popIstate(istate, node.left);
      if (node.operator === "=") {
        push({
          value: right.value,
          embeddedEffects: true,
          node,
        });
      } else {
        push({
          value: evaluateBinaryTypes(
            node.operator.slice(0, -1) as mctree.BinaryOperator,
            left.value,
            right.value
          ),
          embeddedEffects: true,
          node,
        });
      }
      break;
    }
    case "UpdateExpression": {
      const right = { type: TypeTag.Number, value: 1 } as const;
      const left = popIstate(istate, node.argument);
      push({
        value: evaluateBinaryTypes(
          node.operator.slice(1) as mctree.BinaryOperator,
          left.value,
          right
        ),
        embeddedEffects: true,
        node,
      });
      break;
    }
    case "NewExpression": {
      const [klass, ..._args] = stack.splice(-1 - node.arguments.length);
      // we should check the arguments at some point...
      const obj: ObjectType = { type: TypeTag.Object };
      if (isExact(klass.value) && klass.value.type === TypeTag.Class) {
        obj.value = { klass: klass.value };
      }
      push({ value: obj, embeddedEffects: true, node });
      break;
    }
    case "CallExpression": {
      const [callee, ...args] = stack.splice(-1 - node.arguments.length);
      push(
        evaluateCall(
          istate,
          node,
          callee.value,
          args.map(({ value }) => value)
        )
      );
      break;
    }
    // Statements, and other
    case "VariableDeclarator":
    case "EnumStringMember":
      if (node.init) popIstate(istate, node.init);
      break;
    case "ExpressionStatement":
      popIstate(istate, node.expression);
      break;
    case "ReturnStatement":
      if (node.argument) {
        popIstate(istate, node.argument);
      }
      break;
    case "IfStatement":
    case "WhileStatement":
    case "DoWhileStatement":
      popIstate(istate, node.test);
      break;
    case "SwitchStatement":
      popIstate(istate, node.discriminant);
      break;
    case "SwitchCase":
      if (node.test) popIstate(istate, node.test);
      break;
    case "InstanceOfCase": {
      const klass = popIstate(istate, node.id);
      push({
        value: { type: TypeTag.Boolean },
        embeddedEffects: klass.embeddedEffects,
        node,
      });
      break;
    }
    case "BlockStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "TryStatement":
      break;
    case "ThrowStatement":
      popIstate(istate, node.argument);
      break;
    case "ForStatement":
      if (node.update) popIstate(istate, node.update);
      if (node.test) popIstate(istate, node.test);
      if (node.init && node.init.type !== "VariableDeclaration") {
        popIstate(istate, node.init);
      }
      break;
    case "ImportModule":
      popIstate(istate, node.id);
      break;
    case "Using":
      if (node.as) popIstate(istate, node.as);
      popIstate(istate, node.id);
      break;
    case "ClassDeclaration":
    case "EnumDeclaration":
    case "FunctionDeclaration":
    case "ModuleDeclaration":
    case "TypedefDeclaration":
    case "VariableDeclaration":
    case "Program":
    case "TypeSpecList":
    case "CatchClause":
    case "CatchClauses":
    case "EnumStringBody":
    case "Property":
    case "AttributeList":
    case "Attributes":
    case "TypeSpecPart":
    case "ClassElement":
    case "ClassBody":
    case "MethodDefinition":
    case "Block":
    case "Line":
    case "MultiLine":
      break;
    default:
      unhandledType(node);
  }
}

export function roundToFloat(value: number) {
  return new Float32Array([value as number])[0];
}
