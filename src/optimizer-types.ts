import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { ResolvedJungle } from "./jungles";

type DiagnosticType = "ERROR" | "WARNING" | "INFO";
// Configuration options for build
export type BuildConfig = {
  workspace?: string; // The project's workspace directory
  jungleFiles?: string; // Semicolon separated list of jungle files
  developerKeyPath?: string; // Path to the developer key file to be used by the garmin tools
  typeCheckLevel?: string; // monkeyC.typeCheckLevel
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
  ignoredExcludeAnnotations?: string; // Semicolon separated list of exclude annoations to ignore when finding optimizer groups
  ignoredAnnotations?: string; // Semicolon separated list of annoations to ignore when finding optimizer groups
  ignoredSourcePaths?: string; // Semicolon separated list of source path regexes
  returnCommand?: boolean; // If true, build_project just returns the command to run the build, rather than building it
  checkBuildPragmas?: boolean; // If true, check any build pragmas in the generated code
  checkInvalidSymbols?: DiagnosticType | "OFF";
  sizeBasedPRE?: boolean | string;
  _cache?: {
    barrels?: Record<string, ResolvedJungle>;
    barrelMap?: Record<string, Record<string, ResolvedJungle>>;
  };
};
export type StateNodeDecl =
  | StateNode
  /* Enum values */
  | mctree.EnumStringMember
  /* Function parameters */
  | mctree.TypedIdentifier
  /* Other declarations */
  | mctree.EnumDeclaration;
export type StateNodeDecls = {
  [key: string]: StateNodeDecl[];
};
export type ImportUsing = {
  node: mctree.Using | mctree.ImportModule;
  module?: ModuleStateNode | null | undefined;
};
interface BaseStateNode {
  type: string;
  node: mctree.Node | null | undefined;
  name: string | null | undefined;
  fullName: string | null | undefined;
  decls?: StateNodeDecls | undefined;
  type_decls?: StateNodeDecls | undefined;
  stack?: ProgramStateStack | undefined;
  usings?: Record<string, ImportUsing>;
  imports?: ImportUsing[];
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
  isStatic?: boolean;
  info?: FunctionInfo;
  next_info?: FunctionInfo;
}
export interface BlockStateNode extends BaseStateNode {
  type: "BlockStatement";
  name: undefined;
  fullName: undefined;
  node: mctree.BlockStatement;
  stack?: undefined;
}
export interface TypedefStateNode extends BaseStateNode {
  type: "TypedefDeclaration";
  node: mctree.TypedefDeclaration;
  name: string;
  fullName: string;
}
export interface VariableStateNode extends BaseStateNode {
  type: "VariableDeclarator";
  node: mctree.VariableDeclarator;
  name: string;
  fullName: string;
  stack: ProgramStateStack;
}
export type StateNode =
  | ProgramStateNode
  | FunctionStateNode
  | BlockStateNode
  | ClassStateNode
  | ModuleStateNode
  | TypedefStateNode
  | VariableStateNode;
export type ProgramStateStack = StateNode[];
export type LookupDefinition = {
  parent: StateNodeDecl | null;
  results: StateNodeDecl[];
};
export type LookupResult =
  | [string, LookupDefinition[]]
  | [null, null]
  | [false, false];
export type ProgramState = {
  allFunctions?: Record<string, FunctionStateNode[]>;
  allClasses?: ClassStateNode[];
  fnMap?: FilesToOptimizeMap;
  stack?: ProgramStateStack;
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
    stack?: ProgramStateStack
  ) => LookupResult;
  lookupValue?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack
  ) => LookupResult;
  lookupType?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack
  ) => LookupResult;
  lookupNonlocal?: (
    node: mctree.Node,
    name?: string | null,
    stack?: ProgramStateStack
  ) => LookupResult;
  stackClone?: () => ProgramStateStack;
  traverse?: (
    node: mctree.Node
  ) => void | null | false | mctree.Node | mctree.Node[];
  inType?: number;
  inlining?: true;
  config?: BuildConfig;
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
  diagnostics?: Record<
    string,
    {
      type: DiagnosticType;
      loc: {
        start: mctree.Position;
        end: mctree.Position;
      };
      message: string;
    }[]
  >;
};
type Finalized<T, Keys extends keyof T> = T & {
  [key in Keys]-?: NonNullable<T[key]>;
};
export type ProgramStateLive = Finalized<
  ProgramState,
  | "stack"
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
>;
export type ProgramStateAnalysis = Finalized<
  ProgramStateLive,
  "allClasses" | "allFunctions" | "fnMap"
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
