import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  diagnostic,
  formatAst,
  isLocal,
  isLookupCandidate,
  lookupNext,
} from "../api";
import { isExpression, traverseAst } from "../ast";
import { unhandledType } from "../data-flow";
import {
  ClassStateNode,
  DiagnosticType,
  FunctionStateNode,
  LookupDefinition,
  ProgramStateAnalysis,
  StateNodeAttributes,
} from "../optimizer-types";
import { findObjectDeclsByProperty, resolveDottedMember } from "../type-flow";
import { couldBe } from "./could-be";
import { evaluateBinaryTypes, evaluateLogicalTypes } from "./interp-binary";
import { checkCallArgs, evaluateCall } from "./interp-call";
import { subtypeOf } from "./sub-type";
import {
  cloneType,
  display,
  EnumTagsConst,
  ExactOrUnion,
  getUnionComponent,
  hasNoData,
  hasValue,
  isExact,
  lookupByFullName,
  mustBeFalse,
  mustBeTrue,
  ObjectType,
  typeFromLiteral,
  typeFromSingleTypeSpec,
  typeFromTypespec,
  typeFromTypeStateNode,
  typeFromTypeStateNodes,
  TypeTag,
  ValueTypeTagsConst,
} from "./types";
import { clearValuesUnder, unionInto } from "./union-type";

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

export function tryPop(
  istate: InterpState,
  node: InterpStackElem["node"]
): InterpStackElem {
  const item = istate.stack.pop();
  if (!item) {
    throw new Error("Unbalanced stack!");
  }
  if (item.node !== node) {
    istate.stack.push(item);
    return {
      value: { type: TypeTag.False },
      embeddedEffects: false,
      node,
    };
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

function checkKnownDirection(
  typeMap: TypeMap,
  node: mctree.Expression
): boolean | null {
  const type = typeMap.get(node);
  if (type) {
    if (mustBeFalse(type)) {
      return false;
    }
    if (mustBeTrue(type)) {
      return true;
    }
  }
  switch (node.type) {
    case "LogicalExpression": {
      const leftKnown = checkKnownDirection(typeMap, node.left);
      if (leftKnown !== null) {
        if (node.operator === "&&" || node.operator === "and") {
          if (leftKnown === false) return false;
        } else {
          if (leftKnown === true) return true;
        }
        return checkKnownDirection(typeMap, node.right);
      }
      const rightKnown = checkKnownDirection(typeMap, node.right);
      if (rightKnown !== null) {
        if (node.operator === "&&" || node.operator === "and") {
          if (rightKnown === false) return false;
        } else {
          if (rightKnown === true) return true;
        }
      }
      return null;
    }
    case "ConditionalExpression": {
      const testKnown = checkKnownDirection(typeMap, node.test);
      if (testKnown !== null) {
        return checkKnownDirection(
          typeMap,
          testKnown ? node.consequent : node.alternate
        );
      }
      const trueKnown = checkKnownDirection(typeMap, node.consequent);
      if (
        trueKnown !== null &&
        trueKnown === checkKnownDirection(typeMap, node.alternate)
      ) {
        return trueKnown;
      }
      return null;
    }
  }
  return null;
}

export function preEvaluate(
  istate: InterpState,
  node: mctree.Node
): null | (keyof mctree.NodeAll)[] {
  switch (node.type) {
    case "IfStatement":
    case "ConditionalExpression":
      if (istate.typeMap) {
        const known = checkKnownDirection(istate.typeMap, node.test);
        if (known === null) break;
        return ["test", known ? "consequent" : "alternate"];
      }
      break;
    case "LogicalExpression":
      if (istate.typeMap) {
        const known = checkKnownDirection(istate.typeMap, node.left);
        if (known === null) break;
        if (
          node.operator === "&&" || node.operator === "and"
            ? known === false
            : known === true
        ) {
          return ["left"];
        }
      }
      break;

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
    case "SizedArrayExpression":
      return ["size"];
    case "VariableDeclarator":
      return ["init"];
    case "CatchClause":
      return ["body"];
  }
  return null;
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
    const ret = preEvaluate(istate, node);
    if (ret) return ret;
    switch (node.type) {
      case "AssignmentExpression":
        skipNode = node.left;
        break;
      case "UpdateExpression":
        skipNode = node.argument;
        break;
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
export function deEnumerate(t: ExactOrUnion) {
  if (t.type & TypeTag.Enum) {
    const data = getUnionComponent(t, TypeTag.Enum);
    t = cloneType(t);
    clearValuesUnder(t, TypeTag.Enum, true);
    unionInto(
      t,
      (data && (data.value || data.enum?.resolvedType)) || {
        type: EnumTagsConst,
      }
    );
  }
  return t;
}

function getLhsConstraint(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier
) {
  let lookupDefs: LookupDefinition[] | null | false = null;
  if (node.type === "MemberExpression") {
    if (!istate.typeMap) {
      throw new Error("Checking types without a typeMap");
    }
    const object = istate.typeMap.get(node.object);
    if (object && !node.computed) {
      const objDecls = findObjectDeclsByProperty(istate.state, object, node);
      if (objDecls) {
        lookupDefs = lookupNext(
          istate.state,
          [{ parent: null, results: objDecls }],
          "decls",
          node.property
        );
      }
    }
  }
  if (!lookupDefs) {
    [, lookupDefs] = istate.state.lookup(node);
  }
  if (!lookupDefs) {
    return null;
  }
  const trueDecls = lookupDefs.flatMap((lookupDef) =>
    lookupDef.results.filter(
      (decl) =>
        decl.type === "VariableDeclarator" &&
        decl.node.kind === "var" &&
        !isLocal(decl)
    )
  );
  return trueDecls.length === 0
    ? null
    : typeFromTypeStateNodes(istate.state, trueDecls);
}

function pushScopedNameType(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier,
  object?: InterpStackElem
) {
  let embeddedEffects = object ? object.embeddedEffects : false;

  let result;
  if (istate.typeMap) {
    result = istate.typeMap.get(node);
    if (
      !result &&
      object &&
      node.type === "MemberExpression" &&
      !node.computed
    ) {
      istate.typeMap.set(node.object, object.value);
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

function byteArrayType(state: ProgramStateAnalysis): ObjectType {
  return {
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
  };
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
        // Drop widening casts, but keep "Object?" as a special case
        // so we can do (x as Object?) as Whatever without a warning.
        // Also keep enum -> non-enum casts, because of issues with
        // garmin's type checker.
        if (
          subtypeOf(left.value, right.value) &&
          !subtypeOf({ type: TypeTag.Null | TypeTag.Object }, right.value) &&
          (!(left.value.type & TypeTag.Enum) ||
            right.value.type & TypeTag.Enum) &&
          !couldBe({ type: TypeTag.Array | TypeTag.Dictionary }, left.value)
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
          if ((left.value.type & EnumTagsConst) === left.value.type) {
            const result = cloneType(right.value);
            result.value = { ...result.value, value: left.value };
            stack.push({
              value: result,
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
          (node.operator === "==" || node.operator === "!=") &&
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
      let type: ExactOrUnion = { type: TypeTag.Array };
      if (node.byte) {
        type = byteArrayType(state);
      } else if (node.ts) {
        type = typeFromSingleTypeSpec(istate.state, node.ts);
        if (type.type !== TypeTag.Array) {
          type = { type: TypeTag.Array, value: type };
        }
      }
      push({
        value: type,
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
          value: byteArrayType(state),
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
      const right = tryPop(istate, node.right);
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
      const alternate = tryPop(istate, node.alternate);
      const consequent = tryPop(istate, node.consequent);
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
      } else {
        push({
          value: { type: TypeTag.Null },
          embeddedEffects: false,
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
      if (istate.typeChecker) {
        const constraint = getLhsConstraint(istate, node.left);
        const actual = istate.stack[istate.stack.length - 1].value;
        if (constraint && !istate.typeChecker(actual, constraint)) {
          diagnostic(
            istate.state,
            node,
            `Invalid assignment to ${formatAst(node.left)}. Expected ${display(
              constraint
            )} but got ${display(actual)}`,
            istate.checkTypes
          );
        }
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
      const [klass, ...args] = stack.splice(-1 - node.arguments.length);
      const obj: ObjectType = { type: TypeTag.Object };
      if (isExact(klass.value) && klass.value.type === TypeTag.Class) {
        obj.value = { klass: klass.value };
        if (istate.checkTypes && klass.value.value) {
          const results = lookupNext(
            istate.state,
            [
              {
                parent: null,
                results: Array.isArray(klass.value.value)
                  ? klass.value.value
                  : [klass.value.value],
              },
            ],
            "decls",
            { type: "Identifier", name: "initialize" }
          );
          if (results) {
            const callees = results.flatMap((lookupDef) =>
              lookupDef.results.filter(
                (result): result is FunctionStateNode =>
                  result.type === "FunctionDeclaration"
              )
            );
            checkCallArgs(
              istate,
              node,
              callees,
              args.map(({ value }) => value)
            );
          }
        }
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
      if (node.init) {
        const init = popIstate(istate, node.init);
        if (node.id.type === "BinaryExpression" && istate.typeChecker) {
          const top = istate.state.stack[istate.state.stack.length - 1];
          if (top.type !== "BlockStatement") {
            const declType = typeFromTypespec(istate.state, node.id.right);
            if (!istate.typeChecker(init.value, declType)) {
              diagnostic(
                istate.state,
                node,
                `Invalid initializer for ${formatAst(
                  node.id.left
                )}. Expected ${formatAst(node.id.right)} but got ${display(
                  init.value
                )}`,
                istate.checkTypes
              );
            }
          }
        }
      }
      break;
    case "EnumStringMember":
      if (node.init) popIstate(istate, node.init);
      break;
    case "ExpressionStatement":
      popIstate(istate, node.expression);
      break;
    case "ReturnStatement": {
      const value = node.argument && popIstate(istate, node.argument);
      if (istate.typeChecker) {
        if (!istate.func) {
          throw new Error("ReturnStatement found outside of function");
        }
        if (istate.func.node.returnType) {
          const returnType = typeFromTypespec(
            istate.state,
            istate.func.node.returnType.argument,
            istate.func.stack
          );
          if (value) {
            if (!istate.typeChecker(value.value, returnType)) {
              diagnostic(
                istate.state,
                node,
                `Expected ${istate.func.fullName} to return ${display(
                  returnType
                )} but got ${display(value.value)}`,
                istate.checkTypes
              );
            }
          }
        }
      }
      break;
    }
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

export function mustBeIdentical(a: ExactOrUnion, b: ExactOrUnion) {
  if (a.type & TypeTag.Enum) a = deEnumerate(a);
  if (b.type & TypeTag.Enum) b = deEnumerate(b);
  if (a.type === b.type && hasValue(a) && hasValue(b)) {
    switch (a.type) {
      case TypeTag.Null:
      case TypeTag.False:
      case TypeTag.True:
        return true;
      case TypeTag.Number:
      case TypeTag.Float:
      case TypeTag.Long:
      case TypeTag.Double:
      case TypeTag.Char:
      case TypeTag.Symbol:
        return a.value === b.value;
      case TypeTag.String:
        // maybe cheating?
        return a.value === b.value;
    }
  }
  return false;
}
