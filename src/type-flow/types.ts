import { LiteralIntegerRe, mctree } from "@markw65/prettier-plugin-monkeyc";
import { diagnostic, formatAst, isStateNode } from "../api";
import { getNodeValue, makeScopedName } from "../ast";
import {
  ClassStateNode,
  EnumStateNode,
  FunctionStateNode,
  ModuleStateNode,
  ProgramStateAnalysis,
  ProgramStateStack,
  StateNode,
  StateNodeDecl,
  TypedefStateNode,
} from "../optimizer-types";
import { forEach, map } from "../util";
import { evaluateExpr, roundToFloat } from "./interp";
import { clearValuesUnder, unionInto } from "./union-type";

// prettier-ignore
export const enum TypeTag {
  Never =       0b000000000000000000,
  Null =        0b000000000000000001,
  False =       0b000000000000000010,
  True =        0b000000000000000100,
  Boolean =     0b000000000000000110,
  Number =      0b000000000000001000,
  Long =        0b000000000000010000,
  Float =       0b000000000000100000,
  Double =      0b000000000001000000,
  Decimal =     0b000000000001100000,
  Numeric =     0b000000000001111000,
  Char =        0b000000000010000000,
  String =      0b000000000100000000,
  Array =       0b000000001000000000,
  Dictionary =  0b000000010000000000,
  Module =      0b000000100000000000,
  Function =    0b000001000000000000,
  Class =       0b000010000000000000,
  Object =      0b000100000000000000,
  Enum =        0b001000000000000000,
  Symbol =      0b010000000000000000,
  Typedef =     0b100000000000000000,
  Any =         0b111111111111111111,
}

export function typeTagName(tag: TypeTag) {
  switch (tag) {
    case TypeTag.Never:
      return "Never";
    case TypeTag.Null:
      return "Null";
    case TypeTag.False:
      return "False";
    case TypeTag.True:
      return "True";
    case TypeTag.Boolean:
      return "Boolean";
    case TypeTag.Number:
      return "Number";
    case TypeTag.Long:
      return "Long";
    case TypeTag.Float:
      return "Float";
    case TypeTag.Double:
      return "Double";
    case TypeTag.Decimal:
      return "Decimal";
    case TypeTag.Numeric:
      return "Numeric";
    case TypeTag.Char:
      return "Char";
    case TypeTag.String:
      return "String";
    case TypeTag.Array:
      return "Array";
    case TypeTag.Dictionary:
      return "Dictionary";
    case TypeTag.Module:
      return "Module";
    case TypeTag.Function:
      return "Function";
    case TypeTag.Class:
      return "Class";
    case TypeTag.Object:
      return "Object";
    case TypeTag.Enum:
      return "Enum";
    case TypeTag.Symbol:
      return "Symbol";
    case TypeTag.Typedef:
      return "Typedef";
    case TypeTag.Any:
      return "Any";
  }
  return null;
}

export const LastTypeTag = TypeTag.Typedef;

export const SingleTonTypeTagsConst =
  TypeTag.Null | TypeTag.False | TypeTag.True;
export const UnionDataTypeTagsConst =
  TypeTag.Array |
  TypeTag.Dictionary |
  TypeTag.Module |
  TypeTag.Function |
  TypeTag.Class |
  TypeTag.Object |
  TypeTag.Enum |
  TypeTag.Typedef;
export const ValueTypeTagsConst =
  TypeTag.Number |
  TypeTag.Long |
  TypeTag.Float |
  TypeTag.Double |
  TypeTag.Char |
  TypeTag.String |
  TypeTag.Symbol;

export const ObjectLikeTagsConst =
  TypeTag.Boolean |
  ValueTypeTagsConst |
  TypeTag.Array |
  TypeTag.Dictionary |
  TypeTag.Enum;

export const EnumTagsConst =
  SingleTonTypeTagsConst | (ValueTypeTagsConst & ~TypeTag.Symbol);

type ExactTypeTags =
  | TypeTag.Null
  | TypeTag.False
  | TypeTag.True
  | TypeTag.Number
  | TypeTag.Long
  | TypeTag.Float
  | TypeTag.Double
  | TypeTag.Char
  | TypeTag.String
  | TypeTag.Array
  | TypeTag.Dictionary
  | TypeTag.Module
  | TypeTag.Function
  | TypeTag.Class
  | TypeTag.Object
  | TypeTag.Enum
  | TypeTag.Symbol
  | TypeTag.Typedef;

export type EnumeratedTypeTags = ExactTypeTags | TypeTag.Never | TypeTag.Any;

export type UnionTypeTags = number;

interface AbstractValue {
  type: UnionTypeTags;
  value?: unknown;
}

export type ExactTypes =
  | NullType
  | FalseType
  | TrueType
  | NumberType
  | LongType
  | FloatType
  | DoubleType
  | CharType
  | StringType
  | ArrayType
  | DictionaryType
  | ModuleType
  | FunctionType
  | ClassType
  | ObjectType
  | EnumType
  | SymbolType
  | TypedefType;

type WithValue<T> = T extends ExactTypes
  ? T extends SingletonType
    ? T
    : T & { value: NonNullable<T["value"]> }
  : never;

export type ExactData<T extends ExactTypeTags> = T extends SingletonType
  ? undefined
  : NonNullable<Extract<ExactTypes, { type: T }>["value"]>;
export type ValueTypes = WithValue<ExactTypes>;
export type ExtendedTypes = ExactTypes | NeverType | AnyType;
export interface NeverType extends AbstractValue {
  type: 0;
  value?: undefined;
}
export interface NullType extends AbstractValue {
  type: TypeTag.Null;
  value?: undefined;
}
export interface FalseType extends AbstractValue {
  type: TypeTag.False;
  value?: undefined;
}
export interface TrueType extends AbstractValue {
  type: TypeTag.True;
  value?: undefined;
}
export interface NumberType extends AbstractValue {
  type: TypeTag.Number;
  value?: number | undefined;
}
export interface LongType extends AbstractValue {
  type: TypeTag.Long;
  value?: bigint | undefined;
}
export interface FloatType extends AbstractValue {
  type: TypeTag.Float;
  value?: number | undefined;
}
export interface DoubleType extends AbstractValue {
  type: TypeTag.Double;
  value?: number | undefined;
}
export interface CharType extends AbstractValue {
  type: TypeTag.Char;
  value?: string | undefined;
}
export interface StringType extends AbstractValue {
  type: TypeTag.String;
  value?: string | undefined;
}
export interface ArrayType extends AbstractValue {
  type: TypeTag.Array;
  value?: ExactOrUnion | undefined;
}
export interface DictionaryType extends AbstractValue {
  type: TypeTag.Dictionary;
  value?: { key: ExactOrUnion; value: ExactOrUnion } | undefined;
}
export interface ModuleType extends AbstractValue {
  type: TypeTag.Module;
  value?: ModuleStateNode | ModuleStateNode[] | undefined;
}
export interface FunctionType extends AbstractValue {
  type: TypeTag.Function;
  value?: FunctionStateNode | FunctionStateNode[] | undefined;
}
export interface ClassType extends AbstractValue {
  type: TypeTag.Class;
  value?: ClassStateNode | ClassStateNode[] | undefined;
}
export interface TypedefType extends AbstractValue {
  type: TypeTag.Typedef;
  value?: TypedefStateNode | TypedefStateNode[] | undefined;
}
export interface ObjectType extends AbstractValue {
  type: TypeTag.Object;
  value?: { klass: ClassType; obj?: Record<string, ExactOrUnion> } | undefined;
}
export interface EnumType extends AbstractValue {
  type: TypeTag.Enum;
  value?:
    | {
        enum: EnumStateNode;
        value?: ExactOrUnion | undefined;
      }
    | {
        enum?: undefined;
        value: ExactOrUnion;
      }
    | undefined;
}
export interface SymbolType extends AbstractValue {
  type: TypeTag.Symbol;
  value?: string | undefined;
}
export interface AnyType extends AbstractValue {
  type: -1;
  value?: undefined;
}

export type SingletonType = NullType | FalseType | TrueType;

export type UnionData = {
  // mask is the set of tags that are actually defined.
  // it should always be a subset of the UnionType's type
  // field.
  mask: TypeTag;
  [TypeTag.Array]?: NonNullable<ArrayType["value"]>;
  [TypeTag.Dictionary]?: NonNullable<DictionaryType["value"]>;
  [TypeTag.Module]?: NonNullable<ModuleType["value"]>;
  [TypeTag.Function]?: NonNullable<FunctionType["value"]>;
  [TypeTag.Class]?: NonNullable<ClassType["value"]>;
  [TypeTag.Object]?: NonNullable<ObjectType["value"]>;
  [TypeTag.Enum]?: NonNullable<EnumType["value"]>;
};
export type UnionDataKey = Exclude<keyof UnionData, "mask">;

export interface UnionType extends AbstractValue {
  value?: UnionData | undefined;
}

export type ExactOrUnion = UnionType | ExactTypes;

export type SingleValue = NonNullable<ValueTypes["value"]>;
type TagValue<TAG> = Extract<ValueTypes, { type: TAG }>["value"];
export type ArrayValueType = TagValue<TypeTag.Array>;
export type DictionaryValueType = TagValue<TypeTag.Dictionary>;
export type ObjectValueType = TagValue<TypeTag.Object>;
export type EnumValueType = TagValue<TypeTag.Enum>;
export type TypedefValueType = TagValue<TypeTag.Typedef>;
export type StateDeclValueType =
  | TagValue<TypeTag.Module>
  | TagValue<TypeTag.Function>
  | TagValue<TypeTag.Class>;

export function isExact(v: AbstractValue): v is ExactTypes {
  // check that there is exactly one bit set
  return v.type !== 0 && !(v.type & (v.type - 1));
}

export function isUnion(v: AbstractValue): v is UnionType {
  return v.type !== 0 && !isExact(v);
}

export function isSingleton(v: AbstractValue): v is SingletonType {
  return isExact(v) && (v.type & SingleTonTypeTagsConst) !== 0;
}

export function hasValue(v: AbstractValue): v is WithValue<ExactTypes> {
  return (
    isExact(v) &&
    ((v.type & SingleTonTypeTagsConst) !== 0 || v.value !== undefined)
  );
}

export function hasNoData(v: AbstractValue, t: TypeTag) {
  if (v.value == null) return true;
  return (
    (hasUnionData(v.type)
      ? (v.value as UnionData).mask & t
      : v.type & t & ~SingleTonTypeTagsConst) == 0
  );
}

export function lookupByFullName(
  state: ProgramStateAnalysis,
  fullName: string
) {
  return fullName.split(".").reduce(
    (results: StateNodeDecl[], part) => {
      return results
        .flatMap((result) =>
          isStateNode(result)
            ? result.decls?.[part] || result.type_decls?.[part]
            : null
        )
        .filter((sn): sn is StateNodeDecl => !!sn);
    },
    [state.stack[0]]
  );
}

function getMethod(state: ProgramStateAnalysis) {
  const results = lookupByFullName(state, "Toybox.Lang.Method");
  if (results.length !== 1) {
    throw new Error("Internal error: Didn't find Toybox.Lang.Method");
  }
  if (results[0].type !== "ClassDeclaration") {
    throw new Error("Internal error: Toybox.Lang.Method was not a Class");
  }
  return results[0];
}

export function cloneType<T extends ExactOrUnion>(t: T): T {
  return { ...t };
}

function resolveEnum(e: EnumStateNode): ExactOrUnion {
  if (e.resolvedType) return e.resolvedType;
  return (e.resolvedType = e.node.body.members.reduce(
    (result, next) => {
      unionInto(
        result,
        next.type === "EnumStringMember" && next.init?.type === "Literal"
          ? typeFromLiteral(next.init)
          : { type: TypeTag.Number }
      );
      return result;
    },
    { type: TypeTag.Never }
  ));
}

export function typeFromTypeStateNode(
  state: ProgramStateAnalysis,
  sn: StateNodeDecl,
  classVsObj?: boolean
): ExactOrUnion {
  switch (sn.type) {
    case "ClassDeclaration": {
      switch (sn.fullName) {
        case "$.Toybox.Lang.Boolean":
          return { type: TypeTag.Boolean };
        case "$.Toybox.Lang.Number":
          return { type: TypeTag.Number };
        case "$.Toybox.Lang.Long":
          return { type: TypeTag.Long };
        case "$.Toybox.Lang.Float":
          return { type: TypeTag.Float };
        case "$.Toybox.Lang.Double":
          return { type: TypeTag.Double };
        case "$.Toybox.Lang.Char":
          return { type: TypeTag.Char };
        case "$.Toybox.Lang.String":
          return { type: TypeTag.String };
        case "$.Toybox.Lang.Array":
          return { type: TypeTag.Array };
        case "$.Toybox.Lang.Dictionary":
          return { type: TypeTag.Dictionary };
        case "$.Toybox.Lang.Symbol":
          return { type: TypeTag.Symbol };
        case "$.Toybox.Lang.Object":
          return { type: TypeTag.Object };
      }
      const cls = { type: TypeTag.Class, value: sn } as const;
      if (classVsObj) return cls;
      return { type: TypeTag.Object, value: { klass: cls } };
    }
    case "FunctionDeclaration":
      return { type: TypeTag.Function, value: sn };
    case "ModuleDeclaration":
      return { type: TypeTag.Module, value: sn };
    case "Program":
      return { type: TypeTag.Module };
    case "EnumDeclaration":
      return {
        type: TypeTag.Enum,
        value: { enum: sn, value: resolveEnum(sn) },
      };
    case "EnumStringMember": {
      const e = state.enumMap?.get(sn);
      const value =
        sn.init?.type === "Literal"
          ? typeFromLiteral(sn.init)
          : e
          ? resolveEnum(e)
          : { type: TypeTag.Number | TypeTag.Long };
      return { type: TypeTag.Enum, value: { enum: e, value } };
    }

    case "TypedefDeclaration": {
      if (sn.resolvedType) {
        return sn.resolvedType;
      }
      if (sn.isExpanding) {
        sn.isRecursive = true;
        return { type: TypeTag.Typedef, value: sn };
      }
      sn.isExpanding = true;
      const result = typeFromTypespec(state, sn.node.ts.argument, sn.stack);
      delete sn.isExpanding;
      if (sn.isRecursive) {
        // Something like
        //   typedef Foo as Number or String or Foo;
        // is pointless. Its just the same as
        //   typedef Foo as Number or String;
        // Recursive typedefs are only useful when the
        // recursion happens under a generic.
        // So check for that, and remove it.
        if (result.type & TypeTag.Typedef) {
          const value = getUnionComponent(result, TypeTag.Typedef);
          if (value) {
            const a = [] as TypedefStateNode[];
            forEach(value, (v) => {
              if (v !== sn) a.push(v);
            });
            clearValuesUnder(result, TypeTag.Typedef, true);
            if (a.length) {
              unionInto(result, {
                type: TypeTag.Typedef,
                value: a.length > 1 ? a : a[0],
              });
            }
          }
        }
      }
      sn.resolvedType = result;
      return result;
    }

    case "VariableDeclarator":
      if (sn.node.kind === "const" && sn.node.init) {
        let node = sn.node.init;
        if (node.type === "Literal") {
          return typeFromLiteral(node);
        }
        while (node.type === "BinaryExpression" && node.operator === "as") {
          node = node.left;
        }
        if (
          node.type === "Literal" ||
          (node.type === "UnaryExpression" && node.operator === ":")
        ) {
          return evaluateExpr(state, sn.node.init).value;
        }
      }
      if (sn.node.id.type === "BinaryExpression") {
        return typeFromTypespec(state, sn.node.id.right, sn.stack);
      }
      return { type: TypeTag.Any };
  }
  throw new Error(`Internal error: Unexpected StateNodeDecl.type: ${sn.type}`);
}

export function typeFromTypeStateNodes(
  state: ProgramStateAnalysis,
  sns: StateNodeDecl[],
  classVsObj?: boolean
) {
  return sns.reduce<ExactOrUnion>(
    (cur, sn) => {
      unionInto(cur, typeFromTypeStateNode(state, sn, classVsObj));
      return cur;
    },
    { type: TypeTag.Never }
  );
}

export function typeFromSingleTypeSpec(
  state: ProgramStateAnalysis,
  type: mctree.TypeSpecPart | mctree.ObjectExpression,
  stack?: ProgramStateStack | undefined
): ExactOrUnion {
  if (typeof type === "string") {
    type = { type: "TypeSpecPart", name: type };
  }
  switch (type.type) {
    case "ObjectExpression":
      return { type: TypeTag.Dictionary };
    case "TypeSpecPart": {
      if (type.body) {
        // this is an interface declaration.
        // For now, make it an instance of an unknown class.
        return { type: TypeTag.Object };
      }
      if (type.callspec) {
        // only legal thing here is Method(<args>) as <result>
        // For now, make it an instance of an unknown class.
        return {
          type: TypeTag.Object,
          value: { klass: { type: TypeTag.Class, value: getMethod(state) } },
        };
      }
      const id: mctree.ScopedName =
        typeof type.name === "string" ? makeScopedName(type.name) : type.name;
      const [, results] = state.lookupType(id, null, stack);
      if (!results) {
        if (id.type === "Identifier") {
          switch (id.name) {
            case "Void":
            case "Null":
              return { type: TypeTag.Null };
          }
        }
        const level = state.config?.checkInvalidSymbols;
        if (level !== "OFF") {
          diagnostic(
            state,
            id,
            `Unable to resolve type ${formatAst(id)}`,
            level || "WARNING"
          );
        }
        return { type: TypeTag.Any };
      }
      const resultType = results.reduce<ExactOrUnion>(
        (cur, lookupDefn) => {
          unionInto(cur, typeFromTypeStateNodes(state, lookupDefn.results));
          return cur;
        },
        { type: TypeTag.Never }
      );
      if (type.generics) {
        if (resultType.type === TypeTag.Array && type.generics.length === 1) {
          resultType.value = typeFromTypespec(state, type.generics[0], stack);
        } else if (
          resultType.type === TypeTag.Dictionary &&
          type.generics.length === 2
        ) {
          resultType.value = {
            key: typeFromTypespec(state, type.generics[0], stack),
            value: typeFromTypespec(state, type.generics[1], stack),
          };
        }
      }

      return resultType;
    }
  }
}

export function typeFromTypespec(
  state: ProgramStateAnalysis,
  ts: mctree.TypeSpecList,
  stack?: ProgramStateStack | undefined
): ExactOrUnion {
  if (!state.config?.trustDeclaredTypes) {
    if (ts.ts.length === 1 && typeof ts.ts[0] === "string") {
      const e = lookupByFullName(state, ts.ts[0]);
      if (e && e.length === 1 && e[0].type === "EnumDeclaration") {
        return {
          type: TypeTag.Enum,
          value: { enum: e[0] },
        };
      }
    }
    return { type: TypeTag.Any };
  }
  return ts.ts.reduce<ExactOrUnion>(
    (cur, type) => {
      unionInto(cur, typeFromSingleTypeSpec(state, type, stack));
      return cur;
    },
    { type: TypeTag.Never }
  );
}

export function typeFromLiteral(literal: mctree.Literal): ExactTypes {
  const [value, type] = getNodeValue(literal);
  switch (type) {
    case "Null":
      return { type: TypeTag.Null };
    case "Boolean":
      return literal.value ? { type: TypeTag.True } : { type: TypeTag.False };
    case "Number":
      return { type: TypeTag.Number, value: value.value };
    case "Long":
      return { type: TypeTag.Long, value: BigInt(value.value) };
    case "Float":
      return { type: TypeTag.Float, value: value.value };
    case "Double":
      return { type: TypeTag.Double, value: value.value };
    case "Char":
      return { type: TypeTag.Char, value: value.value };
    case "String":
      return { type: TypeTag.String, value: value.value };
    default:
      throw new Error(`Unexpected literal type: ${type}:${literal.value}`);
  }
}

export function mcExprFromType(type: ValueTypes): mctree.Expression | null {
  switch (type.type) {
    case TypeTag.Null:
      return { type: "Literal", value: null, raw: "null" };
    case TypeTag.False:
      return { type: "Literal", value: false, raw: "false" };
    case TypeTag.True:
      return { type: "Literal", value: true, raw: "true" };
    case TypeTag.Number:
      return { type: "Literal", value: type.value, raw: `${type.value}` };
    case TypeTag.Long:
      return { type: "Literal", value: type.value, raw: `${type.value}l` };
    case TypeTag.Float: {
      let raw = type.value.toString();
      if (LiteralIntegerRe.test(raw)) {
        raw += "f";
      } else {
        const match = raw.match(/^(-)?(\d*)\.(\d+)(e\d+)?/);
        if (match && match[2].length + match[3].length > 9) {
          for (let l = 9 - match[2].length; l > 0; l--) {
            const s = `${match[1] || ""}${match[2]}.${match[3].substring(
              0,
              l
            )}${match[4] || ""}`;
            if (type.value !== roundToFloat(parseFloat(s))) break;
            raw = s;
          }
        }
      }
      return { type: "Literal", value: type.value, raw };
    }
    case TypeTag.Double:
      return { type: "Literal", value: type.value, raw: `${type.value}d` };
    case TypeTag.Char:
      return {
        type: "Literal",
        value: type.value,
        raw: `'${JSON.stringify(type.value).slice(1, -1)}'`,
      };
    case TypeTag.String:
      return {
        type: "Literal",
        value: type.value,
        raw: JSON.stringify(type.value),
      };
    case TypeTag.Enum:
      if (type.value.value && hasValue(type.value.value)) {
        const left = mcExprFromType(type.value.value);
        if (left) {
          return type.value.enum
            ? ({
                type: "BinaryExpression",
                operator: "as",
                left,
                right: {
                  type: "TypeSpecList",
                  ts: [type.value.enum.fullName.slice(2)],
                },
              } as unknown as mctree.AsExpression)
            : left;
        }
      }
  }
  return null;
}

/*
 * Cast one type to another, as might happen during
 * operator coercion. If the source type has a value,
 * try to preserve it.
 * eg in 1.0 + 2, the 2 will be converted to 2.0 before adding.
 * Note that many possible conversions simply can't happen.
 * eg Number can be converted to Long, Float or Double, but
 * Long, Float and Double never get converted to Number.
 */
export function castType(type: ExactOrUnion, target: UnionTypeTags) {
  if (type.type === target) return cloneType(type);
  const result: ExactOrUnion = { type: target };
  if (hasValue(type)) {
    if (isExact(result)) {
      switch (result.type) {
        case TypeTag.Null:
        case TypeTag.False:
        case TypeTag.True:
        case TypeTag.Number:
          break;
        case TypeTag.Long:
          if (type.type === TypeTag.Number) {
            result.value = BigInt(type.value);
            return result;
          }
          break;
        case TypeTag.Float:
          if (type.type === TypeTag.Number) {
            result.value = type.value;
            return result;
          }
          break;
        case TypeTag.Double:
          switch (type.type) {
            case TypeTag.Number:
            case TypeTag.Long:
            case TypeTag.Float:
              result.value = Number(type.value);
              return result;
          }
          break;
        case TypeTag.Char:
          switch (type.type) {
            case TypeTag.Number:
            case TypeTag.Long:
              result.value = String.fromCharCode(Number(type.value));
              return result;
          }
          break;
        case TypeTag.String:
          switch (type.type) {
            case TypeTag.Null:
              result.value = "null";
              return result;
            case TypeTag.False:
              result.value = "false";
              return result;
            case TypeTag.True:
              result.value = "true";
              return result;
            case TypeTag.Number:
            case TypeTag.Long:
              result.value = type.value.toString();
              return result;
            case TypeTag.Float:
            case TypeTag.Double:
              // Dont try to implement these, due to inconsistencies and bugs
              return result;
            case TypeTag.Char:
              result.value = type.value;
              return result;
            default:
              return result;
          }
          break;
      }
      throw new Error(`Trying to cast ${display(type)} to ${display(result)}`);
    } else if (result.type === TypeTag.Boolean) {
      // Number or Long operands to '&', '|', and '^' are coerced
      // to boolean if the other argument is boolean.
      if (type.type & (TypeTag.Number | TypeTag.Long)) {
        result.type = type.value == 0 ? TypeTag.False : TypeTag.True;
        return result;
      }
    }
  }
  return result;
}

/*
 * Anything consisting of solely these types is definitely true
 */
export const TruthyTypes =
  TypeTag.True |
  TypeTag.Object |
  TypeTag.Module |
  TypeTag.Class |
  TypeTag.Function;

export function mustBeTrue(arg: ExactOrUnion) {
  return (
    ((arg.type === TypeTag.Number || arg.type === TypeTag.Long) &&
      arg.value != null &&
      arg.value != 0) ||
    ((arg.type & TruthyTypes) != 0 && (arg.type & ~TruthyTypes) == 0)
  );
}

export function mustBeFalse(arg: ExactOrUnion) {
  return (
    arg.type === TypeTag.Null ||
    arg.type === TypeTag.False ||
    ((arg.type === TypeTag.Number || arg.type === TypeTag.Long) &&
      arg.value != null &&
      arg.value == 0)
  );
}

export function display(type: ExactOrUnion): string {
  const names = <T>(v: T | T[] | null, fn: (v: T) => string) =>
    map(v, fn)
      .sort()
      .filter((s, i, arr) => !i || s !== arr[i - 1])
      .join(" or ");

  const parts: string[] = [];

  const displayOne = (bit: number, value: SingleValue): string | undefined => {
    switch (bit) {
      case TypeTag.Null:
      case TypeTag.False:
      case TypeTag.True:
        throw new Error("Unexpected value for SingletonTypeTag");
      case TypeTag.Number:
      case TypeTag.Long:
      case TypeTag.Float:
      case TypeTag.Double:
        return value.toString();
      case TypeTag.Char:
        return `'${JSON.stringify(value).slice(1, -1)}'`;
      case TypeTag.String:
        return JSON.stringify(type.value);
      case TypeTag.Array:
        return display(value as ExactOrUnion);
      case TypeTag.Dictionary:
        return `${display((value as DictionaryValueType).key)}, ${display(
          (value as DictionaryValueType).value
        )}`;
      case TypeTag.Module:
      case TypeTag.Function:
      case TypeTag.Class:
      case TypeTag.Typedef:
        return names(
          value as FunctionStateNode | FunctionStateNode[] | null,
          (v) => v.fullName.slice(2)
        );
      case TypeTag.Object: {
        const klass = (value as ObjectValueType).klass;
        if (!klass.value) return undefined;
        const obj = (value as ObjectValueType).obj;
        const ret = displayOne(TypeTag.Class, klass.value);
        return obj
          ? `${ret}<{${Object.entries(obj)
              .map(([key, value]) => `${key}: ${display(value)}`)
              .join(", ")}}>`
          : ret;
      }
      case TypeTag.Enum: {
        const v = value as EnumValueType;

        return v.enum != null
          ? v.value != null
            ? `${display(v.value)} as ${v.enum.fullName.slice(2)}`
            : v.enum.fullName.slice(2)
          : v.value != null
          ? `enum<${display(v.value)}>`
          : `enum`;
      }
      case TypeTag.Symbol:
        return `:${value}`;
      default:
        throw new Error(`Unexpected type tag '${bit}'`);
    }
  };
  let bits = type.type;
  if (!bits) return "Never";
  if (bits === TypeTag.Any && type.value == null) {
    return "Any";
  }
  while (bits) {
    const next = bits & (bits - 1);
    const bit = bits - next;
    if (bit === TypeTag.False && next & TypeTag.True) {
      parts.push("Boolean");
      bits = next - TypeTag.True;
      continue;
    }
    const name = typeTagName(bit)!;
    const value = getUnionComponent(type, bit);
    const valueStr = value != null && displayOne(bit, value);
    if (!valueStr) {
      parts.push(name);
    } else if (
      bit &
      (TypeTag.Object |
        TypeTag.Enum |
        TypeTag.Typedef |
        TypeTag.Symbol |
        TypeTag.String)
    ) {
      parts.push(valueStr);
    } else {
      parts.push(`${name}<${valueStr}${valueStr.endsWith(">") ? " " : ""}>`);
    }
    bits = next;
  }

  return parts.join(" or ");
}

export function hasUnionData(tag: TypeTag) {
  tag &= UnionDataTypeTagsConst;
  return (tag & (tag - 1)) != 0;
}

export function getObjectValue(t: ExactOrUnion): ObjectType["value"] | null {
  if (!(t.type & TypeTag.Object) || t.value == null) return null;
  if (hasUnionData(t.type)) {
    return (t.value as UnionData)[TypeTag.Object];
  }
  return t.value as ObjectType["value"];
}

export function forEachUnionComponent(
  v: ExactOrUnion,
  bits: TypeTag,
  fn: (
    tag: ExactTypeTags,
    value: SingleValue | null | undefined
  ) => boolean | void
) {
  // never iterate the singleton bits, because they don't have data
  bits &= ~SingleTonTypeTagsConst;
  if (!bits) return;
  if (v.type & UnionDataTypeTagsConst) {
    // Don't iterate the value type bits if any union bit is set
    bits &= ~ValueTypeTagsConst;
  } else if (bits & (bits - 1)) {
    // More than one ValueTypeTagsConst bit set, so there's
    // no data.
    return;
  }
  const hasUnion = hasUnionData(v.type);

  const unionData = v.value as UnionData;
  do {
    const next = bits & (bits - 1);
    const bit = bits - next;
    const data = hasUnion
      ? unionData[bit as UnionDataKey]
      : bit & v.type
      ? v.value
      : null;

    if (fn(bit, data as SingleValue | null | undefined) === false) break;
    bits = next;
  } while (bits);
}

export function getUnionComponent<T extends ExactTypeTags>(
  v: ExactOrUnion,
  tag: T
): ExactData<T> | null {
  if (v.value == null) return null;
  let bits = v.type & ~SingleTonTypeTagsConst;
  if (!bits) return null;
  if (bits & (bits - 1)) {
    bits &= UnionDataTypeTagsConst;
    if (!bits) {
      throw new Error(`Non-exact type had no union bits set`);
    }
  }
  if (bits === tag) {
    return v.value as ExactData<T> | null;
  } else if (bits & tag) {
    const unionData = v.value as UnionData;
    return (unionData[tag as Exclude<keyof UnionData, "mask">] ||
      null) as ExactData<T> | null;
  }
  return null;
}

export function setUnionComponent<T extends ExactTypeTags>(
  v: ExactOrUnion,
  tag: T,
  c: ExactData<T>
) {
  if (hasUnionData(v.type)) {
    const value = (
      v.value ? { ...(v.value as UnionData) } : { mask: 0 }
    ) as UnionData;
    (value as unknown as Record<number, typeof c>)[tag] = c;
    value.mask |= tag;
    v.value = value;
  } else {
    v.value = c;
  }
}

export function getStateNodeDeclsFromType(
  state: ProgramStateAnalysis,
  object: ExactOrUnion
) {
  const decls: StateNode[] = [];
  if (
    object.value != null &&
    object.type & (TypeTag.Module | TypeTag.Class | TypeTag.Object)
  ) {
    forEachUnionComponent(
      object,
      object.type & (TypeTag.Module | TypeTag.Class | TypeTag.Object),
      (tag, value) => {
        if (!value) return;
        if (tag === TypeTag.Object) {
          const ovalue = value as ObjectValueType;
          if (ovalue.klass.type === TypeTag.Class && ovalue.klass.value) {
            if (Array.isArray(ovalue.klass.value)) {
              decls.push(...(ovalue.klass.value as StateNode[]));
            } else {
              decls.push(ovalue.klass.value as StateNode);
            }
          }
        } else {
          if (Array.isArray(value)) {
            decls.push(...(value as StateNode[]));
          } else {
            decls.push(value as StateNode);
          }
        }
      }
    );
  }
  let bits = object.type & (ObjectLikeTagsConst | TypeTag.Object);
  if (bits & TypeTag.Object && getObjectValue(object)) {
    bits -= TypeTag.Object;
  }
  if (bits) {
    do {
      let next = bits & (bits - 1);
      let bit = bits - next;
      if (bit & TypeTag.Boolean) {
        bit = TypeTag.Boolean;
        next &= ~TypeTag.Boolean;
      }
      const name = `Toybox.Lang.${typeTagName(bit)}`;
      const sns = lookupByFullName(state, name);
      sns.forEach((sn) => isStateNode(sn) && decls.push(sn));
      bits = next;
    } while (bits);
  }
  return decls;
}
