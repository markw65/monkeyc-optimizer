import { LiteralIntegerRe, mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  diagnostic,
  formatAstLongLines,
  isStateNode,
  lookupByFullName,
} from "../api";
import { getNodeValue, hasProperty, makeScopedName } from "../ast";
import { unhandledType } from "../data-flow";
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
import { deEnumerate, evaluateExpr, roundToFloat } from "./interp";
import { intersection } from "./intersection-type";
import { clearValuesUnder, unionInto } from "./union-type";

// prettier-ignore
export const enum TypeTag {
  Never =       0b0000000000000000000,
  Null =        0b0000000000000000001,
  False =       0b0000000000000000010,
  True =        0b0000000000000000100,
  Boolean =     0b0000000000000000110,
  Number =      0b0000000000000001000,
  Long =        0b0000000000000010000,
  Float =       0b0000000000000100000,
  Double =      0b0000000000001000000,
  Decimal =     0b0000000000001100000,
  Numeric =     0b0000000000001111000,
  Char =        0b0000000000010000000,
  String =      0b0000000000100000000,
  Array =       0b0000000001000000000,
  Dictionary =  0b0000000010000000000,
  Method     =  0b0000000100000000000,
  Module =      0b0000001000000000000,
  Function =    0b0000010000000000000,
  Class =       0b0000100000000000000,
  Object =      0b0001000000000000000,
  Enum =        0b0010000000000000000,
  Symbol =      0b0100000000000000000,
  Typedef =     0b1000000000000000000,
  Any =         0b1111111111111111111,
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
    case TypeTag.Method:
      return "Method";
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
    default:
      unhandledType(tag);
  }
}

export const LastTypeTag = TypeTag.Typedef;

export const SingletonTypeTagsConst =
  TypeTag.Null | TypeTag.False | TypeTag.True;
export const UnionDataTypeTagsConst =
  TypeTag.Array |
  TypeTag.Dictionary |
  TypeTag.Method |
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
  TypeTag.Method |
  TypeTag.Enum;

export const EnumTagsConst =
  SingletonTypeTagsConst | (ValueTypeTagsConst & ~TypeTag.Symbol);

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
  | TypeTag.Method
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
  | MethodType
  | ModuleType
  | FunctionType
  | ClassType
  | ObjectType
  | EnumType
  | SymbolType
  | TypedefType;

export type ObjectLiteralType = Map<string, ExactOrUnion> & {
  value?: undefined;
};

type ExactPairHelper<T> = T extends ExactTypes
  ? { type: T["type"]; avalue: T["value"]; bvalue: T["value"] }
  : never;

export type ExactPairs = ExactPairHelper<ExactTypes>;
export type ValuePairs = ExactPairHelper<ValueTypes>;

type WithValue<T> = T extends ExactTypes
  ? T extends SingletonType
    ? T
    : { type: T["type"]; value: NonNullable<T["value"]> }
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
  value?: ExactOrUnion | ExactOrUnion[] | undefined;
}
export interface DictionaryType extends AbstractValue {
  type: TypeTag.Dictionary;
  value?:
    | { key: ExactOrUnion; value: ExactOrUnion }
    | ObjectLiteralType
    | undefined;
}
export interface MethodType extends AbstractValue {
  type: TypeTag.Method;
  value?: { args: ExactOrUnion[]; result: ExactOrUnion } | undefined;
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
  type: TypeTag.Any;
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
  [TypeTag.Method]?: NonNullable<MethodType["value"]>;
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
export type EnumValueType = TagValue<TypeTag.Enum>;

export function isExact(v: AbstractValue): v is ExactTypes {
  // check that there is exactly one bit set
  return v.type !== 0 && !(v.type & (v.type - 1));
}

export function isUnion(v: AbstractValue): v is UnionType {
  return v.type !== 0 && !isExact(v);
}

export function isSingleton(v: AbstractValue): v is SingletonType {
  return isExact(v) && (v.type & SingletonTypeTagsConst) !== 0;
}

export function hasValue(v: AbstractValue): v is WithValue<ExactTypes> {
  return (
    isExact(v) &&
    ((v.type & SingletonTypeTagsConst) !== 0 || v.value !== undefined)
  );
}

export function hasNoData(v: AbstractValue, t: TypeTag) {
  if (v.value == null) return true;
  return (
    (hasUnionData(v.type)
      ? (v.value as UnionData).mask & t
      : v.type & t & ~SingletonTypeTagsConst) === 0
  );
}

export function cloneType<T extends ExactOrUnion>(t: T): T {
  return { ...t };
}

/*
 * Drop literal types, so that Number<42> becomes Number, false becomes Boolean,
 * etc.
 */
export function relaxType(type: ExactOrUnion) {
  if (type.type === TypeTag.Null) {
    return { type: TypeTag.Null | TypeTag.Object };
  }
  const valTypes = type.type & ValueTypeTagsConst;
  if (
    (!valTypes || hasNoData(type, valTypes)) &&
    (!(type.type & TypeTag.Boolean) ||
      (type.type & TypeTag.Boolean) === TypeTag.Boolean)
  ) {
    return type;
  }
  // drop any literals from the type
  const relaxed = {
    type: valTypes | (type.type & TypeTag.Boolean ? TypeTag.Boolean : 0),
  };
  unionInto(relaxed, type);
  return relaxed;
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
        case "$.Toybox.Lang.Method":
          return { type: TypeTag.Method };
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
    case "EnumDeclaration": {
      if (sn.resolvedType) return sn.resolvedType;
      if (hasProperty(sn, "resolvedType")) {
        return {
          type: TypeTag.Enum,
          value: { enum: sn, value: { type: EnumTagsConst } },
        };
      }
      sn.resolvedType = undefined;
      const value = sn.node.body.members.reduce(
        (type, member) => {
          unionInto(type, deEnumerate(typeFromTypeStateNode(state, member)));
          return type;
        },
        {
          type: TypeTag.Never,
        }
      );
      return (sn.resolvedType = {
        type: TypeTag.Enum,
        value: { enum: sn, value },
      });
    }
    case "EnumStringMember": {
      const n = sn as mctree.EnumStringMember & { resolvedType?: ExactOrUnion };
      if (!n.resolvedType) {
        if (hasProperty(n, "resolvedType")) {
          return { type: EnumTagsConst };
        }
        n.resolvedType = undefined;
        const value =
          n.init?.type === "Literal"
            ? typeFromLiteral(n.init)
            : n.init
            ? deEnumerate(evaluateExpr(state, n.init).value)
            : { type: TypeTag.Number };

        n.resolvedType = value;
      }
      const e = state.enumMap?.get(n);
      return e
        ? { type: TypeTag.Enum, value: { enum: e, value: n.resolvedType } }
        : n.resolvedType;
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

    case "VariableDeclarator": {
      if (sn.resolvedType) return sn.resolvedType;
      let declared: ExactOrUnion | null = null;
      if (sn.node.id.type === "BinaryExpression") {
        declared = typeFromTypespec(state, sn.node.id.right, sn.stack);
      }
      if (sn.node.kind === "const" && sn.node.init) {
        if (hasProperty(sn, "resolvedType")) {
          // The constant is defined recursively
          return declared ?? { type: TypeTag.Any };
        }
        // set the marker in case the constant appears in its
        // own initializer.
        sn.resolvedType = undefined;
        const stack = state.stack;
        let resolved;
        try {
          state.stack = sn.stack;
          resolved = evaluateExpr(state, sn.node.init).value;
        } finally {
          state.stack = stack;
        }
        if (resolved.type === TypeTag.Never) {
          resolved = declared ?? { type: TypeTag.Any };
        } else if (declared) {
          resolved = intersection(resolved, declared);
          if (resolved.type === TypeTag.Never) {
            resolved = declared;
          }
        }

        sn.resolvedType = resolved;
        return resolved;
      }
      if (sn.node.id.type === "BinaryExpression") {
        return typeFromTypespec(state, sn.node.id.right, sn.stack);
      }
      return { type: TypeTag.Any };
    }
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

export function arrayLiteralKeyFromType(k: ExactOrUnion | null | undefined) {
  if (k && k.value != null) {
    if (k.type === TypeTag.Number || k.type === TypeTag.Long) {
      return Number(k.value);
    }
  }
  return null;
}

export function arrayLiteralKeyFromExpr(key: mctree.Expression) {
  if (key.type === "Literal") {
    return arrayLiteralKeyFromType(typeFromLiteral(key));
  }
  return null;
}

export function objectLiteralKeyFromExpr(
  key: mctree.Expression
): string | null {
  switch (key.type) {
    case "Literal": {
      const t = typeFromLiteral(key);
      if (t.value == null) return t.type.toString();
      return `${t.type}:${t.value}`;
    }
    case "UnaryExpression":
      if (key.operator === ":") {
        return `${TypeTag.Symbol}:${key.argument.name}`;
      }
      break;
  }
  return null;
}

function objectLiteralKeyFromKeyExpr(key: mctree.Expression): string {
  const str = objectLiteralKeyFromExpr(key);
  if (str) {
    return str;
  }
  throw new Error(`Unexpected object expression key: ${key.type}`);
}

export function objectLiteralKeyFromType(key: ExactOrUnion): string | null {
  switch (key.type) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
      return `${key.type}`;
    case TypeTag.Number:
    case TypeTag.Float:
    case TypeTag.Double:
    case TypeTag.Long:
    case TypeTag.Char:
    case TypeTag.String:
    case TypeTag.Symbol:
      if (key.value != null) {
        return `${key.type}:${key.value}`;
      }
      break;
  }
  return null;
}

export function typeFromObjectLiteralKey(key: string): ValueTypes {
  const match = key.match(/^(\d+)(:(.*))?$/);
  if (!match) {
    throw new Error(`Not an object literal key: '${key}'`);
  }
  const type = Number(match[1]);
  switch (type) {
    case TypeTag.Null:
    case TypeTag.False:
    case TypeTag.True:
      return { type };
    case TypeTag.Number:
    case TypeTag.Float:
    case TypeTag.Double:
      return { type, value: Number(match[3]) };
    case TypeTag.Long:
      return { type, value: BigInt(match[3]) };
    case TypeTag.Char:
    case TypeTag.String:
    case TypeTag.Symbol:
      return { type, value: match[3] };
  }
  throw new Error(`Unexpected object literal key: ${type}`);
}

export function typeFromSingleTypeSpec(
  state: ProgramStateAnalysis,
  type: mctree.SingleTypeSpec,
  stack?: ProgramStateStack | undefined
): ExactOrUnion {
  if (typeof type === "string") {
    type = { type: "TypeSpecPart", name: type };
  }
  switch (type.type) {
    case "ArrayExpression": {
      return {
        type: TypeTag.Array,
        value: type.elements.map((cur) =>
          typeFromTypespec(state, cur as unknown as mctree.TypeSpecList, stack)
        ),
      };
    }
    case "ObjectExpression": {
      const fields: ObjectLiteralType = new Map();
      type.properties.forEach((property) => {
        const prop = property as unknown as mctree.AsExpression;
        fields.set(
          objectLiteralKeyFromKeyExpr(prop.left),
          typeFromTypespec(state, prop.right, stack)
        );
      });
      return { type: TypeTag.Dictionary, value: fields };
    }
    case "TypeSpecPart": {
      if (type.body) {
        // this is an interface declaration.
        // For now, make it an instance of an unknown class.
        return { type: TypeTag.Object };
      }
      if (type.callspec) {
        // only legal thing here is Method(<args>) as <result>
        // For now, make it an instance of an unknown class.
        const result = typeFromTypespec(
          state,
          type.callspec.returnType.argument,
          stack
        );
        const args = type.callspec.params.map((param) =>
          param.type === "BinaryExpression"
            ? typeFromTypespec(state, param.right, stack)
            : { type: TypeTag.Any }
        );
        return {
          type: TypeTag.Method,
          value: { result, args },
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
            formatAstLongLines(id).then(
              (idStr) => `Unable to resolve type ${idStr}`
            ),
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
        // try to prettify the resulting number.
        // "raw" typically has way more digits than it needs,
        // so try to find a shorter representation of the same
        // Float.
        const match = raw.match(/^(-)?(\d*)\.(\d+)(e[-+]?\d+)?/i);
        if (match) {
          const lastSig = 9 + (match[2] + match[3]).search(/[^0]|$/);
          if (match[2].length + match[3].length > lastSig) {
            for (let l = lastSig - match[2].length; l > 0; l--) {
              const fraction = match[3].substring(0, l);
              // try truncating to l places after the decimal
              const s1 = `${match[1] || ""}${match[2]}.${fraction}${
                match[4] || ""
              }`;
              if (type.value === roundToFloat(parseFloat(s1))) {
                raw = s1;
                continue;
              }
              // try truncating to l places after the decimal,
              // but round up. Note that there's an odd edge case
              // here. 0.9999999999 won't get rounded to 1.0
              // because we don't carry across the decimal point.
              // That's ok; the result is still correct, it just
              // looks uglier.
              const s2 = `${match[1] || ""}${match[2]}.${(
                "0000000000" +
                (+fraction + 1)
              ).slice(-l)}${match[4] || ""}`;
              if (type.value !== roundToFloat(parseFloat(s2))) break;
              raw = s2;
            }
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
          if (!type.value.enum) {
            return left;
          }
          const enumStr = type.value.enum.fullName.slice(2);
          if (
            enumStr === "Toybox.Graphics.ColorValue" &&
            left.type === "Literal" &&
            typeof left.value === "number" &&
            left.value >= 0 &&
            left.value <= 0xffffff &&
            /^\d+$/.test(left.raw)
          ) {
            left.raw = "0x" + `00000${left.value.toString(16)}`.slice(-6);
          }
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
              // Don't try to implement these, due to inconsistencies and bugs
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
        result.type = Number(type.value) === 0 ? TypeTag.False : TypeTag.True;
        return result;
      }
    }
  }
  return result;
}

export function reducedType(
  elems: ExactOrUnion[] | ExactOrUnion
): ExactOrUnion {
  if (!Array.isArray(elems)) {
    return elems;
  }
  return elems.reduce(
    (p, t) => {
      unionInto(p, t);
      return p;
    },
    { type: TypeTag.Never }
  );
}

/*
 * Anything consisting of solely these types is definitely true
 */
export const TruthyTypes =
  TypeTag.True |
  // TypeTag.Object | // omit because of missing null on various Toybox types
  TypeTag.Module |
  TypeTag.Class |
  TypeTag.Function;

export function mustBeTrue(arg: ExactOrUnion) {
  return (
    ((arg.type === TypeTag.Number || arg.type === TypeTag.Long) &&
      arg.value != null &&
      Number(arg.value) !== 0) ||
    ((arg.type & TruthyTypes) !== 0 && (arg.type & ~TruthyTypes) === 0)
  );
}

export function mustBeFalse(arg: ExactOrUnion) {
  return (
    arg.type === TypeTag.Null ||
    arg.type === TypeTag.False ||
    ((arg.type === TypeTag.Number || arg.type === TypeTag.Long) &&
      arg.value != null &&
      Number(arg.value) === 0)
  );
}

export function display(type: ExactOrUnion): string {
  const names = <T>(v: T | T[] | null, fn: (v: T) => string) =>
    map(v, fn)
      .sort()
      .filter((s, i, arr) => !i || s !== arr[i - 1])
      .join(" or ");

  const parts: string[] = [];

  const displayOne = (tv: ValueTypes): string | undefined => {
    switch (tv.type) {
      case TypeTag.Null:
      case TypeTag.False:
      case TypeTag.True:
        throw new Error("Unexpected value for SingletonTypeTag");
      case TypeTag.Number:
      case TypeTag.Long:
      case TypeTag.Float:
      case TypeTag.Double:
        return tv.value.toString();
      case TypeTag.Char:
        return `'${JSON.stringify(tv.value).slice(1, -1)}'`;
      case TypeTag.String:
        return JSON.stringify(tv.value);
      case TypeTag.Array:
        return Array.isArray(tv.value)
          ? `[${tv.value.map((t) => display(t)).join(", ")}]`
          : `Array<${display(tv.value)}>`;
      case TypeTag.Dictionary:
        return tv.value.value
          ? `Dictionary<${display(tv.value.key)}, ${display(tv.value.value)}>`
          : `{ ${Array.from(tv.value)
              .map(
                ([key, value]) =>
                  `${display(typeFromObjectLiteralKey(key))} as ${display(
                    value
                  )}`
              )
              .join(", ")} }`;
      case TypeTag.Method:
        return `Method(${tv.value.args
          .map((arg, i) => `a${i + 1} as ${display(arg)}`)
          .join(", ")}) as ${display(tv.value.result)}`;
      case TypeTag.Module:
      case TypeTag.Function:
      case TypeTag.Class:
      case TypeTag.Typedef:
        return names(tv.value, (v) => v.fullName.slice(2));
      case TypeTag.Object: {
        const klass = tv.value.klass;
        if (!klass.value) return undefined;
        const obj = tv.value.obj;
        const ret = displayOne({ type: TypeTag.Class, value: klass.value });
        return obj
          ? `${ret}<{${Object.entries(obj)
              .map(([key, value]) => `${key}: ${display(value)}`)
              .join(", ")}}>`
          : ret;
      }
      case TypeTag.Enum: {
        const v = tv.value;
        return v.enum != null
          ? v.value != null
            ? `${display(v.value)} as ${v.enum.fullName.slice(2)}`
            : v.enum.fullName.slice(2)
          : v.value != null
          ? `enum<${display(v.value)}>`
          : `enum`;
      }
      case TypeTag.Symbol:
        return `:${tv.value}`;
      default:
        unhandledType(tv);
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
    const valueStr =
      value != null && displayOne({ type: bit, value } as ValueTypes);
    if (!valueStr) {
      parts.push(name);
    } else if (
      bit &
      (TypeTag.Object |
        TypeTag.Enum |
        TypeTag.Typedef |
        TypeTag.Symbol |
        TypeTag.Method |
        TypeTag.String |
        TypeTag.Array |
        TypeTag.Dictionary)
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
  return (tag & (tag - 1)) !== 0;
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
  fn: (type: ExactTypes) => boolean | void
) {
  // never iterate the singleton bits, because they don't have data
  bits &= ~SingletonTypeTagsConst;
  if (!bits) return;
  if ((v.type | bits) & UnionDataTypeTagsConst) {
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

    if (fn({ type: bit, value: data } as ExactTypes) === false) break;
    bits = next;
  } while (bits);
}

export function getUnionComponent<T extends ExactTypeTags>(
  v: ExactOrUnion,
  tag: T
): ExactData<T> | null {
  if (v.value == null) return null;
  let bits = v.type & ~SingletonTypeTagsConst;
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
      (type: ExactTypes) => {
        if (type.value == null) return;
        switch (type.type) {
          case TypeTag.Object:
            if (
              type.value.klass.type === TypeTag.Class &&
              type.value.klass.value
            ) {
              if (Array.isArray(type.value.klass.value)) {
                decls.push(...type.value.klass.value);
              } else {
                decls.push(type.value.klass.value);
              }
            }
            break;
          case TypeTag.Module:
          case TypeTag.Class:
            if (Array.isArray(type.value)) {
              decls.push(...type.value);
            } else {
              decls.push(type.value);
            }
            break;
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
