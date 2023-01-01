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
  StateNodeDecl,
  TypedefStateNode,
} from "../optimizer-types";
import { forEach, map } from "../util";
import { evaluateExpr, roundToFloat } from "./interp";
import { clearValuesUnder, unionInto } from "./union-type";

/**
 * TypeBit gives the position of the 1 bit in TypeTag
 */
export enum TypeBit {
  Null,
  False,
  True,
  Number,
  Long,
  Float,
  Double,
  Char,
  String,
  Array,
  Dictionary,
  Module,
  Function,
  Class,
  Object,
  Enum,
  Symbol,
  Typedef,
}

export enum TypeTag {
  Never = 0,
  Null = 0b00000000000000001,
  False = 0b00000000000000010,
  True = 0b00000000000000100,
  Boolean = 0b00000000000000110,
  Number = 0b00000000000001000,
  Long = 0b00000000000010000,
  Float = 0b00000000000100000,
  Double = 0b00000000001000000,
  Numeric = 0b00000000001111000,
  Char = 0b00000000010000000,
  String = 0b00000000100000000,
  Array = 0b00000001000000000,
  Dictionary = 0b00000010000000000,
  Module = 0b00000100000000000,
  Function = 0b00001000000000000,
  Class = 0b00010000000000000,
  Object = 0b00100000000000000,
  Enum = 0b01000000000000000,
  Symbol = 0b10000000000000000,
  Typedef = 0b100000000000000000,
  Any = 0b111111111111111111,
}

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

function lookupByFullName(state: ProgramStateAnalysis, fullName: string) {
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
      return { type: TypeTag.Enum, value: { enum: sn } };
    case "EnumStringMember": {
      const e = state.enumMap?.get(sn);
      const value =
        sn.init?.type === "Literal"
          ? typeFromLiteral(sn.init)
          : { type: TypeTag.Numeric | TypeTag.String };
      if (e) {
        return { type: TypeTag.Enum, value: { enum: e, value } };
      }
      return value;
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
            forEach(value as TypedefValueType, (v) => {
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
        if (sn.node.init.type === "Literal") {
          return typeFromLiteral(sn.node.init);
        }
        const [value] = getNodeValue(sn.node.init);
        if (value) {
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

function typeFromSingleTypeSpec(
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
            id.loc,
            `Unable to resolve type ${formatAst(id)}`,
            level || "WARNING"
          );
        }
        return { type: TypeTag.Any };
      }
      const resultType = results.reduce<ExactOrUnion>(
        (cur, lookupDefn) =>
          lookupDefn.results.reduce<ExactOrUnion>((cur, result) => {
            unionInto(cur, typeFromTypeStateNode(state, result));
            return cur;
          }, cur),
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
          return {
            type: "BinaryExpression",
            operator: "as",
            left,
            right: {
              type: "TypeSpecList",
              ts: [type.value.enum.fullName.slice(2)],
            },
          } as unknown as mctree.AsExpression;
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

        return v.value
          ? `${display(v.value)} as ${v.enum.fullName.slice(2)}`
          : v.enum.fullName.slice(2);
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
    const name = TypeTag[bit];
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
    tag: UnionDataKey,
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

export function getUnionComponent(
  v: ExactOrUnion,
  tag: TypeTag
): SingleValue | null {
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
    return v.value as Exclude<typeof v.value, UnionData>;
  } else if (bits & tag) {
    const unionData = v.value as UnionData;
    return unionData[tag as keyof UnionData] || null;
  }
  return null;
}
