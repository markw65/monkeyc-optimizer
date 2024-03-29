import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { EnumStringMember } from "@markw65/prettier-plugin-monkeyc/build/estree-types";
import { xmlUtil } from "./sdk-util";
import { ExactOrUnion } from "./type-flow/types";

export type DiagnosticType = "ERROR" | "WARNING" | "INFO";
export type LookupRules = "COMPILER1" | "COMPILER2" | "DEFAULT";
export type EnforceStatic = "YES" | "NO";
// Configuration options for build
export type BuildConfig = {
  workspace?: string; // The project's workspace directory
  jungleFiles?: string; // Semicolon separated list of jungle files
  developerKeyPath?: string; // Path to the developer key file to be used by the garmin tools
  typeCheckLevel?: string; // monkeyC.typeCheckLevel
  optimizationLevel?: string; // monkeyC.optimizationLevel
  compilerOptions?: string; // monkeyC.compilerOptions
  compilerWarnings?: boolean; // monkeyC.compilerWarnings
  simulatorBuild?: boolean; // build for the simulator
  releaseBuild?: boolean; // do a release build
  testBuild?: boolean; // do a test build
  products?: string[]; // list of products to build for
  buildDir?: string; // output directory for binaries, default "bin"
  outputPath?: string; // output directory for optimized project, default "bin/optimized"
  program?: string; // name of the built binary
  skipOptimization?: boolean; // Run the build with the specified options on the original project
  checkManifest?: boolean; // Do some basic sanitization on the manifest file, and create a new one for the optimized build if they fail
  device?: string; // The device to build for
  extraExcludes?: string; // Semicolon separated list of exclude annotations to be added/removed from every target
  ignoredExcludeAnnotations?: string; // Semicolon separated list of exclude annotations to ignore when finding optimizer groups
  ignoredAnnotations?: string; // Semicolon separated list of annotations to ignore when finding optimizer groups
  ignoredSourcePaths?: string; // Semicolon separated list of source path regexps
  returnCommand?: boolean; // If true, build_project just returns the command to run the build, rather than building it
  checkBuildPragmas?: boolean; // If true, check any build pragmas in the generated code
  checkInvalidSymbols?: DiagnosticType | "OFF"; // Report missing symbols
  checkCompilerLookupRules?: DiagnosticType | "OFF"; // Report differences in behavior between compiler1 and compiler2
  compilerLookupRules?: LookupRules; // Perform lookups as compiler1 or compiler2
  enforceStatic?: EnforceStatic;
  sizeBasedPRE?: boolean | string;
  prettier?: Record<string, unknown>;
  extensionVersion?: string;
  useLocalOptimizer?: boolean;
  propagateTypes?: boolean;
  trustDeclaredTypes?: boolean;
  minimizeLocals?: boolean;
  minimizeModules?: boolean;
  postBuildOptimizer?: boolean;
  singleUseCopyProp?: boolean;
  iterateOptimizer?: boolean;
  covarianceWarnings?: boolean;
  checkTypes?: DiagnosticType | "OFF"; // how our type checker should report issues
  // post build optimizer
  removeArgc?: boolean;
  postBuildPRE?: boolean;
};
export type StateNodeDecl =
  | StateNode
  /* Enum values */
  | mctree.EnumStringMember
  /* Function parameters */
  | mctree.TypedIdentifier;
export type StateNodeDecls = {
  [key: string]: StateNodeDecl[];
};
export type ImportUsing = {
  node: mctree.Using | mctree.ImportModule;
  module?: ModuleStateNode | null | undefined;
};

export const enum StateNodeAttributes {
  NONE = 0,
  PUBLIC = 1,
  PROTECTED = 2,
  PRIVATE = 4,
  STATIC = 8,
}

interface BaseStateNode {
  type: string;
  node: mctree.Node | null | undefined;
  name: string | null | undefined;
  fullName: string | null | undefined;
  decls?: StateNodeDecls | undefined;
  type_decls?: StateNodeDecls | undefined;
  stack?: ProgramStateStack | undefined;
  attributes: StateNodeAttributes;
}
export interface ProgramStateNode extends BaseStateNode {
  type: "Program";
  node: mctree.Program | undefined;
  name: "$";
  fullName: "$";
  stack?: undefined;
}
export interface ModuleStateNode extends BaseStateNode {
  type: "ModuleDeclaration";
  node: mctree.ModuleDeclaration;
  name: string;
  fullName: string;
}
export interface ClassStateNode extends BaseStateNode {
  type: "ClassDeclaration";
  node: mctree.ClassDeclaration;
  name: string;
  fullName: string;
  superClass?: ClassStateNode[] | true;
  hasInvoke?: boolean;
  // every element of superClasses is a class,
  // but by declaring it as Set<StateNode> we can
  // check any StateNode without having to check if
  // its a class.
  superClasses?: Set<StateNode>;
}

export type FunctionInfo = {
  modifiedDecls: Set<VariableStateNode>;
  calledFuncs: Set<FunctionStateNode>;
  resolvedDecls?: Set<VariableStateNode>;
  callsExposed?: boolean;
  modifiedUnknown?: boolean;
  modifiedNames?: Set<string>;
};

export interface FunctionStateNode extends BaseStateNode {
  type: "FunctionDeclaration";
  node: mctree.FunctionDeclaration;
  name: string;
  fullName: string;
  stack?: ProgramStateStack;
  decls?: undefined;
  info?: FunctionInfo | false;
  next_info?: FunctionInfo;
}
export interface BlockStateNode extends BaseStateNode {
  type: "BlockStatement";
  name: undefined;
  fullName: string;
  node: mctree.BlockStatement | mctree.ForStatement;
  stack?: undefined;
}
export interface TypedefStateNode extends BaseStateNode {
  type: "TypedefDeclaration";
  node: mctree.TypedefDeclaration;
  name: string;
  fullName: string;
  isExpanding?: true;
  isRecursive?: true;
  resolvedType?: ExactOrUnion;
}
export interface VariableStateNode extends BaseStateNode {
  type: "VariableDeclarator";
  node: mctree.VariableDeclarator;
  name: string;
  fullName: string;
  stack: ProgramStateStack;
  used?: true;
  resolvedType?: ExactOrUnion | undefined;
}
export interface EnumStateNode extends BaseStateNode {
  type: "EnumDeclaration";
  node: mctree.EnumDeclaration;
  name: string;
  fullName: string;
  stack: ProgramStateStack;
  resolvedType?: ExactOrUnion;
}

interface DiagnosticBase {
  loc: mctree.SourceLocation;
  message: string;
}

export interface DiagnosticInfo extends DiagnosticBase {
  loc: Finalized<mctree.SourceLocation, "source">;
}
export interface Diagnostic extends DiagnosticBase {
  type: DiagnosticType;
  related?: DiagnosticInfo[];
  extra?: { uri: string; message: string };
}

export type PreDiagnostic = Omit<Diagnostic, "message"> & {
  message: string | Promise<string> | null;
};

type ProgramStateStackElem = {
  sn: StateNode;
  usings?: Record<string, ImportUsing>;
  imports?: ImportUsing[];
};
export type StateNode =
  | ProgramStateNode
  | FunctionStateNode
  | BlockStateNode
  | ClassStateNode
  | ModuleStateNode
  | TypedefStateNode
  | VariableStateNode
  | EnumStateNode;
export type ProgramStateStack = ProgramStateStackElem[];
export type LookupDefinition = {
  parent: StateNode | null;
  results: StateNodeDecl[];
};
export type LookupResult =
  | [string, LookupDefinition[]]
  | [null, null]
  | [false, false];
export type ByNameStateNodeDecls =
  | ModuleStateNode
  | ClassStateNode
  | FunctionStateNode
  | ProgramStateNode;
export type ProgramState = {
  allFunctions?: Record<string, FunctionStateNode[]>;
  allClasses?: ClassStateNode[];
  invokeInfo?: FunctionInfo;
  allDeclarations?: Record<string, ByNameStateNodeDecls[]>;
  fnMap?: FilesToOptimizeMap;
  rezAst?: mctree.Program;
  manifestXML?: xmlUtil.Document;
  stack?: ProgramStateStack;
  top?: () => ProgramStateStackElem;
  currentFunction?: FunctionStateNode;
  removeNodeComments?: (node: mctree.Node, ast: mctree.Program) => void;
  shouldExclude?: (node: mctree.Node) => boolean;
  pre?: (
    node: mctree.Node,
    state: ProgramStateLive
  ) => null | false | (keyof mctree.NodeAll)[];
  post?: (
    node: mctree.Node,
    state: ProgramStateLive
  ) => null | false | mctree.Node | mctree.Node[];
  lookup?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack | null
  ) => LookupResult;
  lookupValue?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack | null
  ) => LookupResult;
  lookupType?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack | null
  ) => LookupResult;
  lookupNonlocal?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack | null
  ) => LookupResult;
  stackClone?: () => ProgramStateStack;
  traverse?: (
    node: mctree.Node
  ) => void | null | false | mctree.Node | mctree.Node[];
  inType?: number;
  inlining?: true;
  config?: BuildConfig;
  sdk?: string;
  sdkVersion?: number;
  lookupRules?: LookupRules;
  nextExposed?: Record<string, true>;
  exposed?: Record<string, true>;
  usedByName?: Record<string, true>;
  calledFunctions?: { [key: string]: mctree.FunctionDeclaration[] };
  localsStack?: {
    node?: mctree.Node;
    map?: { [key: string]: boolean | string };
    inners?: { [key: string]: true };
  }[];
  index?: { [key: string]: unknown[] };
  constants?: { [key: string]: mctree.Literal };
  diagnostics?: Record<string, PreDiagnostic[]>;
  inlineDiagnostics?: Record<string, Diagnostic[]>;
  enumMap?: Map<EnumStringMember, EnumStateNode>;
};
export type Finalized<T, Keys extends keyof T> = T & {
  [key in Keys]-?: NonNullable<T[key]>;
};
export type ProgramStateLive = Finalized<
  ProgramState,
  | "stack"
  | "top"
  | "lookup"
  | "lookupValue"
  | "lookupType"
  | "lookupNonlocal"
  | "stackClone"
  | "traverse"
  | "index"
  | "constants"
  | "removeNodeComments"
  | "inType"
  | "nextExposed"
  | "lookupRules"
>;
export type ProgramStateAnalysis = Finalized<
  ProgramStateLive,
  "allClasses" | "allFunctions" | "fnMap" | "allDeclarations" | "invokeInfo"
>;
export type ProgramStateOptimizer = Finalized<
  ProgramStateAnalysis,
  "localsStack" | "exposed" | "calledFunctions" | "usedByName"
>;
export type ExcludeAnnotationsMap = { [key: string]: boolean };
export type FilesToOptimizeMap = {
  [key: string]: {
    // Name of the optimized file
    output: string;
    // The name of the barrel this file belongs to, or ""
    barrel: string;
    // ExcludeAnnotations to apply to this file
    excludeAnnotations: ExcludeAnnotationsMap;
    // - On input to analyze, if provided, use this, rather than reading `key`
    //   from disk.
    // - After analyze, the source for `key`.
    monkeyCSource?: string;
    // - On input to analyze, if provided, use this, rather than parsing
    //   monkeyCSource.
    // - After analyze, the ast.
    ast?: mctree.Program;
    // If parsing failed, we have this instead of an ast.
    parserError?: Error;
    // After analyze, whether this file provides tests.
    hasTests?: boolean;
  };
};
