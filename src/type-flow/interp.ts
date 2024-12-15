import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  diagnostic,
  formatAstLongLines,
  handleImportUsing,
  isLocal,
  isLookupCandidate,
  lookupByFullName,
  lookupNext,
} from "../api";
import { isExpression, traverseAst } from "../ast";
import { RootStateNode } from "../control-flow";
import { unhandledType } from "../data-flow";
import {
  ClassStateNode,
  DiagnosticType,
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNodeAttributes,
} from "../optimizer-types";
import { every, forEach, map } from "../util";
import { ArrayTypeData, restrictArrayData, tupleMap } from "./array-type";
import { couldBe } from "./could-be";
import {
  OpMatch,
  evaluateBinaryTypes,
  evaluateLogicalTypes,
} from "./interp-binary";
import {
  checkCallArgs,
  evaluateCall,
  extraReferenceTypeChecks,
} from "./interp-call";
import { intersection } from "./intersection-type";
import { subtypeOf } from "./sub-type";
import {
  findObjectDeclsByProperty,
  resolveDottedMember,
} from "./type-flow-util";
import {
  EnumTagsConst,
  ExactOrUnion,
  ObjectLikeTagsConst,
  ObjectLiteralType,
  ObjectType,
  TypeTag,
  arrayLiteralKeyFromExpr,
  cloneType,
  display,
  getObjectValue,
  getUnionComponent,
  hasNoData,
  hasValue,
  isExact,
  mustBeFalse,
  mustBeTrue,
  objectLiteralKeyFromExpr,
  objectLiteralKeyFromType,
  reducedType,
  relaxType,
  typeFromEnumValue,
  typeFromLiteral,
  typeFromSingleTypeSpec,
  typeFromTypeStateNode,
  typeFromTypeStateNodes,
  typeFromTypespec,
} from "./types";
import { clearValuesUnder, unionInto } from "./union-type";

export type TypeMap = Map<mctree.Node, ExactOrUnion>;

export const enum DependencyFlags {
  None = 0,
  // We depend on the types of things defined in the other module
  // This could be the return type of a method, or the type of an
  // enum or const.
  Type = 1,
  // We depend on the FunctionInfo of the other module
  Info = 2,
}

export type DependencyMap = Map<RootStateNode, DependencyFlags>;

export type InterpStackElem = {
  value: ExactOrUnion;
  embeddedEffects: boolean;
  node: mctree.Expression | mctree.TypeSpecList | mctree.InstanceOfCase;
};

export type InterpState = {
  state: ProgramStateAnalysis;
  stack: InterpStackElem[];
  typeMap?: TypeMap;
  localLvals?: Set<mctree.Node>;
  root?: RootStateNode;
  pre?: (node: mctree.Node) => mctree.Node | false | null | void;
  post?: (node: mctree.Node) => mctree.Node | false | null | void;
  typeChecker?: (a: ExactOrUnion, b: ExactOrUnion) => boolean;
  checkTypes?: DiagnosticType;
  dependencies?: DependencyMap;
  frpushType?: ExactOrUnion;
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

function diagnoseBinaryOrLogical(
  istate: InterpState,
  node: mctree.Expression & { operator: string },
  result: { type: ExactOrUnion } & OpMatch
) {
  const { type, mismatch } = result;
  if (type.type && !mismatch) return type;
  if (!istate.typeChecker) return type;
  if (istate.typeChecker === subtypeOf) {
    if (!mismatch) return type;
    diagnostic(
      istate.state,
      node,
      `Unexpected types for operator '${node.operator}': ${Array.from(mismatch)
        .map(
          ([rhs, lhs]) =>
            `[${display({
              type: lhs,
            })} vs ${display({ type: rhs })}]`
        )
        .join(", ")}`,
      istate.checkTypes
    );
  }
  return type;
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
    case "TypedefDeclaration":
      //console.log(`preEvaluate: ${node.id.name}`);
      return [];
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
export function evaluate(istate: InterpState, root: mctree.Node) {
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
  const pre = (node: mctree.Node): null | false | (keyof mctree.NodeAll)[] => {
    const ret = preEvaluate(istate, node);
    if (ret) return ret;
    switch (node.type) {
      case "ImportModule":
      case "Using":
        handleImportUsing(istate.state, node);
        return false;
      case "FunctionDeclaration":
      case "ModuleDeclaration":
      case "ClassDeclaration":
        if (node !== root) return false;
        return ["body"];
      case "AssignmentExpression":
        skipNode = node.left;
        break;
      case "UpdateExpression":
        skipNode = node.argument;
        break;
    }
    return null;
  };

  traverseAst(root, pre, post);

  const ret = istate.stack.pop();
  if (isExpression(root)) {
    if (!ret || root !== ret.node) {
      throw new Error("evaluate failed to produce a value for an expression");
    }
  }
  return ret;
}

export function evaluateUnaryTypes(
  op: mctree.UnaryOperator,
  argument: ExactOrUnion
): { type: ExactOrUnion } & OpMatch {
  argument = deEnumerate(argument);
  if (argument.type & TypeTag.Object && hasNoData(argument, TypeTag.Object)) {
    argument.type |= ObjectLikeTagsConst;
  }
  switch (op) {
    case "+":
      // `+ x` ignores the type of x, and returns x
      return { type: argument };
    case "-":
      return evaluateBinaryTypes(
        "-",
        { type: TypeTag.Number, value: 0 },
        argument
      );
    case "!":
    case "~": {
      if (hasValue(argument)) {
        const left =
          argument.type & TypeTag.Boolean
            ? { type: TypeTag.True }
            : ({ type: TypeTag.Number, value: -1 } as const);
        return evaluateBinaryTypes("^", left, argument);
      }
      const ret = {
        type: {
          type:
            (argument.type & TypeTag.True && TypeTag.False) |
            (argument.type & TypeTag.False && TypeTag.True) |
            (argument.type & (TypeTag.Number | TypeTag.Long)),
        },
      } as { type: ExactOrUnion } & OpMatch;
      const t =
        argument.type & ~(TypeTag.Boolean | TypeTag.Number | TypeTag.Long);
      if (t) {
        ret.mismatch = new Map([[t, t]]);
      }
      return ret;
    }
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
    unionInto(t, typeFromEnumValue(data));
  }
  return t;
}

function arrayTypeAtIndex(
  arr: ArrayTypeData,
  elemType: ExactOrUnion | null | undefined,
  forStrictAssign: boolean,
  enforceTuples: boolean
) {
  if (elemType) {
    elemType = deEnumerate(elemType);
  }
  const reduce = (v: ExactOrUnion[]) =>
    forStrictAssign
      ? v.reduce(
          (t, c) => (t ? intersection(t, c) : c),
          null as ExactOrUnion | null
        ) ?? { type: TypeTag.Never }
      : reducedType(v);
  const key =
    elemType && isExact(elemType) && elemType.type === TypeTag.Number
      ? elemType.value
      : null;
  return tupleMap(
    arr,
    (v) => (key != null ? v[key] ?? null : reduce(v)),
    (v) => v,
    (v) =>
      v.length
        ? reduce(v)
        : enforceTuples
        ? { type: TypeTag.Never }
        : { type: TypeTag.Any }
  );
}

function getLhsConstraintHelper(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier
): [ExactOrUnion | undefined | null, boolean] {
  if (istate.localLvals?.has(node)) {
    return [istate.typeMap?.get(node), false];
  }
  let lookupDefs = istate.state.lookupNonlocal(node)[1];
  if (!lookupDefs) {
    if (node.type === "MemberExpression") {
      if (!istate.typeMap) {
        throw new Error("Checking types without a typeMap");
      }
      const trackedObject = istate.typeMap?.get(node.object);
      const object =
        ((node.object.type === "Identifier" ||
          node.object.type === "MemberExpression") &&
          getLhsConstraintHelper(istate, node.object)[0]) ||
        trackedObject;

      if (object) {
        const tracked = trackedObject ?? object;
        const objType = object.type & tracked.type;
        if (node.computed) {
          const strict = istate.typeChecker === subtypeOf;
          if (
            strict &&
            objType &
              ~(
                TypeTag.Array |
                TypeTag.Dictionary |
                TypeTag.Object |
                TypeTag.Typedef
              )
          ) {
            return [{ type: TypeTag.Never }, true];
          }
          if (object.value) {
            let result: ExactOrUnion | null = null;
            if (objType & TypeTag.Array) {
              let arr = getUnionComponent(object, TypeTag.Array);
              if (arr) {
                if (trackedObject) {
                  const current = getUnionComponent(
                    trackedObject,
                    TypeTag.Array
                  );
                  if (current) {
                    arr = restrictArrayData(arr, current);
                  }
                }
                result = arrayTypeAtIndex(
                  arr,
                  istate.typeMap.get(node.property) ?? {
                    type: TypeTag.Number,
                    value: arrayLiteralKeyFromExpr(node.property) ?? undefined,
                  },
                  strict,
                  istate.state.config?.extraReferenceTypeChecks !== false
                );
              }
            }
            const updateResult = (value: ExactOrUnion) => {
              if (result) {
                if (strict) {
                  result = intersection(result, value);
                } else {
                  result = cloneType(result);
                  unionInto(result, value);
                }
              } else {
                result = value;
              }
            };
            if (object.type & TypeTag.Dictionary) {
              const dict = getUnionComponent(object, TypeTag.Dictionary);
              if (dict) {
                if (dict.value) {
                  updateResult(dict.value);
                } else {
                  const keyType = istate.typeMap.get(node.property);
                  const keyStr = keyType
                    ? objectLiteralKeyFromType(keyType)
                    : objectLiteralKeyFromExpr(node.property);
                  if (keyStr) {
                    const value = dict.get(keyStr);
                    if (value != null) {
                      updateResult(value);
                    }
                  }
                }
              }
            }
            if (object.type & TypeTag.Object) {
              const obj = getUnionComponent(object, TypeTag.Object);
              if (obj && isByteArrayData(obj)) {
                updateResult({ type: TypeTag.Number | TypeTag.Char });
              }
            }
            if (result) {
              return [result, true];
            }
          }
        } else {
          const [, trueDecls] = findObjectDeclsByProperty(
            istate.state,
            object,
            node.property
          );
          if (trueDecls) {
            lookupDefs = lookupNext(
              istate.state,
              [{ parent: null, results: trueDecls }],
              "decls",
              node.property
            );
          }
        }
      }
    }
  }
  if (!lookupDefs) {
    return [null, false];
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
    ? [null, false]
    : [typeFromTypeStateNodes(istate.state, trueDecls), true];
}

export function getLhsConstraint(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier
) {
  const [constraintType, constrained] = getLhsConstraintHelper(istate, node);
  return constrained ? constraintType : null;
}

function pushScopedNameType(
  istate: InterpState,
  node: mctree.MemberExpression | mctree.Identifier,
  object?: InterpStackElem
) {
  let embeddedEffects = object ? object.embeddedEffects : false;

  istate.frpushType = object?.value;
  let result;
  if (istate.typeMap) {
    result = istate.typeMap.get(node);
    if (
      !result &&
      object &&
      node.type === "MemberExpression" &&
      !node.computed
    ) {
      const objectType = deEnumerate(object.value);
      istate.typeMap.set(node.object, objectType);
      const resolved = resolveDottedMember(istate, objectType, node);
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
  const argType = (arg: InterpStackElem, i: number) => {
    const n = node as {
      originalTypes?: Array<mctree.TypeSpecList | null>;
    };
    const t =
      n.originalTypes?.[i] ||
      (arg.node.type === "BinaryExpression" &&
        arg.node.operator === "as" &&
        arg.node.right);
    return t ? typeFromTypespec(istate.state, t) : arg.value;
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
        if (
          istate.checkTypes &&
          !couldBe(left.value, right.value) &&
          !subtypeOf({ type: TypeTag.Null | TypeTag.Object }, right.value)
        ) {
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
            formatAstLongLines(
              left.value.type === TypeTag.Null ? node.right : node.left
            ).then(
              (nodeStr) =>
                `This comparison seems redundant because ${nodeStr} should never be null`
            ),
            istate.checkTypes
          );
        }
        push({
          value: diagnoseBinaryOrLogical(
            istate,
            node,
            evaluateBinaryTypes(node.operator, left.value, right.value)
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
        const { type, mismatch } = evaluateUnaryTypes(
          node.operator,
          deEnumerate(arg.value)
        );
        if (istate.typeChecker) {
          if (istate.typeChecker === subtypeOf) {
            if (mismatch) {
              diagnostic(
                istate.state,
                node,
                `Unexpected types for operator: ${display({
                  type: Array.from(mismatch.keys()).reduce(
                    (prev, type) => prev | type,
                    TypeTag.Never
                  ),
                })}`,
                istate.checkTypes
              );
            }
          } else if (type.type === TypeTag.Never) {
            diagnostic(
              istate.state,
              node,
              `Unexpected types for operator: ${display(arg.value)}`,
              istate.checkTypes
            );
          }
        }
        push({
          value: type,
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
        const value = args.map((arg, i) => relaxType(argType(arg, i)));
        push({
          value: { type: TypeTag.Array, value },
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
      const fields: ObjectLiteralType = new Map();
      for (let i = 0; i < args.length; i += 2) {
        const key = argType(args[i], i);
        const value = argType(args[i + 1], i + 1);
        const keyStr = objectLiteralKeyFromType(key);
        if (!keyStr) {
          const value = args.reduce(
            (cur, next, i) => {
              unionInto(i & 1 ? cur.value : cur.key, next.value);
              return cur;
            },
            { key: { type: TypeTag.Never }, value: { type: TypeTag.Never } }
          );
          value.key = relaxType(value.key);
          value.value = relaxType(value.value);
          push({
            value:
              value.key.type === TypeTag.Never &&
              value.value.type === TypeTag.Never
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
          return;
        }
        fields.set(keyStr, relaxType(value));
      }
      push({
        value: {
          type: TypeTag.Dictionary,
          value: fields,
        },
        embeddedEffects: args.some((arg) => arg.embeddedEffects),
        node,
      });
      break;
    }
    case "ThisExpression": {
      const self = (() => {
        for (let i = state.stack.length; i--; ) {
          const si = state.stack[i].sn;
          if (si.type === "ClassDeclaration") {
            const klass = { type: TypeTag.Class, value: si } as const;
            if ((istate.root?.attributes || 0) & StateNodeAttributes.STATIC) {
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
        ).type,
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
        const objectType = deEnumerate(object.value);
        let byteArray = false;
        if (objectType.type & TypeTag.Object && objectType.value) {
          const odata = getObjectValue(objectType);
          if (odata && isByteArrayData(odata)) {
            byteArray = true;
          }
        }
        if (
          objectType.value &&
          !(
            objectType.type &
            (TypeTag.Class | (byteArray ? 0 : TypeTag.Object))
          )
        ) {
          let result: ExactOrUnion | null = null;
          if (objectType.type & TypeTag.Array) {
            const avalue = getUnionComponent(objectType, TypeTag.Array) || {
              type: TypeTag.Any,
            };
            const atype = arrayTypeAtIndex(avalue, property.value, false, true);
            if (result) {
              unionInto((result = cloneType(result)), atype);
            } else {
              result = atype;
            }
          }
          if (objectType.type & TypeTag.Dictionary) {
            // Dictionary TODO: Try to use the property
            const dvalue = getUnionComponent(objectType, TypeTag.Dictionary)
              ?.value || {
              type: TypeTag.Any,
            };
            if (result) {
              unionInto((result = cloneType(result)), dvalue);
            } else {
              result = dvalue;
            }
            if (!(result.type & TypeTag.Null)) {
              result = cloneType(result);
              result.type |= TypeTag.Null;
            }
          }
          if (
            objectType.type & TypeTag.Module &&
            couldBe(property.value, { type: TypeTag.Symbol })
          ) {
            const mvalue = getUnionComponent(objectType, TypeTag.Module);
            if (!mvalue) {
              result = { type: TypeTag.Any };
              push({
                value: result,
                embeddedEffects:
                  object.embeddedEffects || property.embeddedEffects,
                node,
              });
              break;
            }
            if (result) result = cloneType(result);
            forEach(mvalue, (m) => {
              if (m.decls) {
                Object.values(m.decls).forEach((sn) => {
                  const t = typeFromTypeStateNodes(istate.state, sn, true);
                  if (result) {
                    unionInto(result, t);
                  } else {
                    result = cloneType(t);
                  }
                });
              }
            });
          }
          if (byteArray) {
            const t = { type: TypeTag.Number };
            if (result) {
              unionInto(t, result);
            }
            result = t;
          }
          if (result) {
            push({
              value: result,
              embeddedEffects:
                object.embeddedEffects || property.embeddedEffects,
              node,
            });
            break;
          }
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
          value: diagnoseBinaryOrLogical(
            istate,
            node,
            evaluateBinaryTypes(
              node.operator.slice(0, -1) as mctree.BinaryOperator,
              left.value,
              right.value
            )
          ),
          embeddedEffects: true,
          node,
        });
      }
      if (istate.typeChecker) {
        const constraint = getLhsConstraint(istate, node.left);
        const actual = istate.stack[istate.stack.length - 1].value;
        if (constraint) {
          if (istate.typeChecker(actual, constraint)) {
            if (istate.state.config?.extraReferenceTypeChecks !== false) {
              extraReferenceTypeChecks(
                istate,
                (sourceType, targetType) =>
                  diagnostic(
                    istate.state,
                    node,
                    formatAstLongLines(node.left).then(
                      (nodeStr) =>
                        `Unsafe assignment to ${nodeStr}: assigning ${sourceType} to ${targetType} is not type safe`
                    ),
                    istate.checkTypes,
                    {
                      uri: "https://github.com/markw65/monkeyc-optimizer/wiki/Extra-Reference-Type-Checks-(prettierMonkeyC.extraReferenceTypeChecks)",
                      message: "more info",
                    }
                  ),
                constraint,
                actual,
                node.right
              );
            }
          } else {
            diagnostic(
              istate.state,
              node,
              formatAstLongLines(node.left).then(
                (nodeStr) =>
                  `Invalid assignment to ${nodeStr}. Expected ${display(
                    constraint
                  )} but got ${display(actual)}`
              ),
              istate.checkTypes
            );
          }
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
        ).type,
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
          const callees = map(
            klass.value.value,
            (klass) => klass.decls?.initialize
          )
            .flat()
            .filter(
              (result): result is FunctionStateNode =>
                result?.type === "FunctionDeclaration"
            );
          if (callees.length) {
            checkCallArgs(
              istate,
              node,
              callees,
              args.map(({ value }) => value)
            );
          } else if (args.length) {
            diagnostic(
              istate.state,
              node,
              `initialize method expected no args, but got ${args.length}`,
              istate.checkTypes
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
          const top = istate.state.top().sn;
          if (top.type !== "BlockStatement") {
            const declType = typeFromTypespec(istate.state, node.id.right);
            if (!istate.typeChecker(init.value, declType)) {
              diagnostic(
                istate.state,
                node,
                Promise.all([
                  formatAstLongLines(node.id.left),
                  formatAstLongLines(node.id.right),
                ]).then(
                  ([leftStr, rightStr]) =>
                    `Invalid initializer for ${leftStr}. Expected ${rightStr} but got ${display(
                      init.value
                    )}`
                ),
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
        const root = istate.root;
        if (root?.type !== "FunctionDeclaration") {
          throw new Error("ReturnStatement found outside of function");
        }
        if (root.node.returnType) {
          const returnType = typeFromTypespec(
            istate.state,
            root.node.returnType.argument,
            root.stack
          );
          if (value) {
            if (istate.typeChecker(value.value, returnType)) {
              if (istate.state.config?.extraReferenceTypeChecks !== false) {
                extraReferenceTypeChecks(
                  istate,
                  (sourceType, targetType) =>
                    diagnostic(
                      istate.state,
                      node,
                      `Unsafe return from ${root.fullName}: converting ${sourceType} to ${targetType} is not type safe`,
                      istate.checkTypes,
                      {
                        uri: "https://github.com/markw65/monkeyc-optimizer/wiki/Extra-Reference-Type-Checks-(prettierMonkeyC.extraReferenceTypeChecks)",
                        message: "more info",
                      }
                    ),
                  returnType,
                  value.value,
                  node.argument!
                );
              }
            } else {
              diagnostic(
                istate.state,
                node,
                `Expected ${root.fullName} to return ${display(
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

export function isByteArray(object: ExactOrUnion) {
  return (
    hasValue(object) &&
    object.type === TypeTag.Object &&
    isByteArrayData(object.value)
  );
}

export function isByteArrayData(objectData: NonNullable<ObjectType["value"]>) {
  return (
    objectData.klass.value &&
    every(
      objectData.klass.value,
      (klass) => klass.fullName === "$.Toybox.Lang.ByteArray"
    )
  );
}
