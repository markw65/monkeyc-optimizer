export type DiagnosticType = "ERROR" | "WARNING" | "INFO";
export type LookupRules = "COMPILER1" | "COMPILER2" | "DEFAULT";
export type EnforceStatic = "YES" | "NO";
// Configuration options for build
export type BuildConfig = {
  ignore_settings_files?: boolean; // For consistent testing, ignore settings.json files
  workspace?: string; // The project's workspace directory
  jungleFiles?: string; // Semicolon separated list of jungle files
  developerKeyPath?: string; // Path to the developer key file to be used by the garmin tools
  typeCheckLevel?: "Off" | "Default" | "Gradual" | "Informative" | "Strict"; // monkeyC.typeCheckLevel
  optimizationLevel?: "None" | "Basic" | "Fast" | "Slow"; // monkeyC.optimizationLevel
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
  preSkipLiterals?: boolean;
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
  strictTypeCheck?: "On" | "Off" | "Default";
  // post build optimizer
  removeArgc?: boolean;
  postBuildPRE?: boolean;
  allowForbiddenOpts?: boolean;
  runTests?: boolean;
};

interface BuildConfigEntryBase {
  title?: string;
  type: string;
  description?: string;
  taskDescription?: string;
  launchDescription?: string;
  markdownDescription?: string;
  order?: number;
  scope:
    | "application"
    | "machine"
    | "machine-overridable"
    | "window"
    | "resource"
    | "tasks"
    | "launch"
    | "tasks_launch"
    | "language-overridable";
}

interface BuildConfigEntryBoolean extends BuildConfigEntryBase {
  type: "boolean";
  default?: boolean;
}

interface BuildConfigEntryString extends BuildConfigEntryBase {
  type: "string";
  default?: string;
}

interface BuildConfigEntryEnum<V> extends BuildConfigEntryBase {
  type: "string";
  default?: string;
  enum: readonly V[];
  enumDescriptions?: readonly string[];
}

/*
type BuildConfigEntry =
  | BuildConfigEntryBoolean
  | BuildConfigEntryString
  | BuildConfigEntryEnum;
*/
type BuildConfigEntry<V> = boolean extends V
  ? BuildConfigEntryBoolean
  : [V] extends [string]
  ? [string] extends [V]
    ? BuildConfigEntryString
    : BuildConfigEntryEnum<V>
  : never;

type BuildConfigDescription = {
  title: string;
  type: "object";
  properties: {
    [K in keyof BuildConfig]?: BuildConfigEntry<NonNullable<BuildConfig[K]>>;
  };
};

export const buildConfigDescription: readonly BuildConfigDescription[] = [
  {
    title: "Optimizer",
    type: "object",
    properties: {
      outputPath: {
        type: "string",
        description: "Path to where the optimized project should be generated.",
        default: "bin/optimized",
        scope: "resource",
      },
      extraExcludes: {
        type: "string",
        markdownDescription:
          "[Semicolon separated list of excludeAnnotations to add or remove](https://github.com/markw65/monkeyc-optimizer/wiki/The-extraExcludes-Option)",
        default: "",
        scope: "resource",
      },
      ignoredExcludeAnnotations: {
        type: "string",
        description:
          "Semicolon separated list of excludeAnnotations to ignore, or `*' to ignore all",
        default: "",
        scope: "resource",
      },
      ignoredAnnotations: {
        type: "string",
        description:
          "Semicolon separated list of annotations to ignore, or `*' to ignore all",
        default: "",
        scope: "resource",
      },
      ignoredSourcePaths: {
        type: "string",
        description: "Regex of source paths to ignore.",
        default: "",
        scope: "resource",
      },
      typeCheckLevel: {
        type: "string",
        description:
          "Unless set to 'Default', overrides the corresponding `monkeyC' setting.",
        taskDescription:
          "If present, overrides the corresponding `monkeyC' setting.",
        launchDescription:
          "If present, overrides the corresponding `monkeyC' setting.",
        default: "Off",
        enum: ["Off", "Default", "Gradual", "Informative", "Strict"],
        enumDescriptions: [
          "Disable type checking",
          "Inherit the Garmin Extension's typeCheckLevel",
          "Type match failures are marked as errors, but ambiguity is ignored",
          "Type match failures are marked as errors, and ambiguity is marked as a warning",
          "Type match failures and ambiguity are marked as errors",
        ],
        scope: "resource",
      },
      checkInvalidSymbols: {
        type: "string",
        description:
          "Whether to check for invalid symbols, and how to report them",
        enum: ["OFF", "INFO", "WARNING", "ERROR"],
        enumDescriptions: [
          "Disable checking",
          "Generate INFO level diagnostics",
          "Generate WARNING level diagnostics",
          "Generate ERROR level diagnostics",
        ],
        default: "WARNING",
        scope: "resource",
      },
      checkTypes: {
        type: "string",
        description:
          "Whether to check for type related issues, and how to report them",
        enum: ["OFF", "INFO", "WARNING", "ERROR"],
        enumDescriptions: [
          "Disable checking",
          "Generate INFO level diagnostics",
          "Generate WARNING level diagnostics",
          "Generate ERROR level diagnostics",
        ],
        default: "WARNING",
        scope: "resource",
      },
      strictTypeCheck: {
        type: "string",
        description:
          "Whether to do strict or relaxed type checking - Default deduces it from typeCheckLevel",
        enum: ["On", "Off", "Default"],
        enumDescriptions: [
          "Do Strict type checking",
          "Do Relaxed type checking",
          "Do Strict type checking iff typeCheckLevel is Strict",
        ],
        default: "Default",
        scope: "resource",
      },
      trustDeclaredTypes: {
        order: 100,
        type: "boolean",
        markdownDescription:
          "[Whether to rely on type declarations when optimizing](https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis#trust-declared-types)",
        default: true,
        scope: "resource",
      },
      propagateTypes: {
        order: 110,
        type: "boolean",
        markdownDescription:
          "[Whether to propagate type information, or process it locally](https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis#propagate-types)",
        default: true,
        scope: "resource",
      },
      sizeBasedPRE: {
        order: 111,
        type: "boolean",
        markdownDescription:
          "[Whether to enable the size based partial redundancy pass](https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis#size-based-pre)",
        default: true,
        scope: "resource",
      },
      preSkipLiterals: {
        order: 112,
        type: "boolean",
        markdownDescription:
          "[Whether to skip the size based partial redundancy pass for literal values](https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis#size-based-pre-skip-literals)",
        default: false,
        scope: "resource",
      },
      minimizeLocals: {
        order: 120,
        type: "boolean",
        markdownDescription:
          "[Whether to enable the minimize locals pass](https://github.com/markw65/monkeyc-optimizer/wiki/Local-variable-elimination#minimize-locals)",
        default: true,
        scope: "resource",
      },
      singleUseCopyProp: {
        order: 120,
        type: "boolean",
        markdownDescription:
          "[Whether to enable the single use copy propagation pass](https://github.com/markw65/monkeyc-optimizer/wiki/Local-variable-elimination#single-use-copy-propagation)",
        default: true,
        scope: "resource",
      },
      minimizeModules: {
        order: 120,
        type: "boolean",
        markdownDescription:
          "[Whether to enable the minimize modules pass](https://github.com/markw65/monkeyc-optimizer/wiki/Optimizing-module-imports#minimize-modules)",
        default: true,
        scope: "resource",
      },
      iterateOptimizer: {
        order: 120,
        type: "boolean",
        description:
          "Whether to keep running the optimizer pass until it makes no further changes (may be slow)",
        default: false,
        scope: "resource",
      },
      enforceStatic: {
        type: "string",
        description:
          "Whether to perform lookups in static methods as if they were invoked statically",
        enum: ["NO", "YES"],
        enumDescriptions: [
          "Assume static functions may be invoked non-statically",
          "Assume static functions will always be invoked statically",
        ],
        default: "YES",
        scope: "resource",
      },
      compilerLookupRules: {
        type: "string",
        description:
          "Whether to perform lookups as compiler1, compiler2, or based on the currently selected sdk",
        enum: ["COMPILER1", "COMPILER2", "DEFAULT"],
        enumDescriptions: [
          "Match compiler1's behavior when performing lookups",
          "Match compiler2's behavior when performing lookups",
          "Match the currently selected compiler's behavior",
        ],
        default: "DEFAULT",
        scope: "resource",
      },
      checkCompilerLookupRules: {
        type: "string",
        description:
          "Whether to report differences in your code's behavior between compiler1 and compiler2",
        enum: ["OFF", "INFO", "WARNING", "ERROR"],
        enumDescriptions: [
          "Disable checking",
          "Generate INFO level diagnostics",
          "Generate WARNING level diagnostics",
          "Generate ERROR level diagnostics",
        ],
        default: "WARNING",
        scope: "resource",
      },
      useLocalOptimizer: {
        type: "boolean",
        description:
          "Whether to use a locally installed @markw65/monkeyc-optimizer for builds",
        default: true,
        scope: "resource",
      },
    },
  },
  {
    title: "Post Build Optimizer",
    type: "object",
    properties: {
      postBuildOptimizer: {
        title: "Enable",
        order: 0,
        type: "boolean",
        description: "Whether to enable the post build optimizer",
        default: false,
        scope: "resource",
      },
      removeArgc: {
        order: 1,
        type: "boolean",
        markdownDescription:
          "[Whether to remove argc bytecodes](https://github.com/markw65/monkeyc-optimizer/wiki/Post-Build-Optimizer#remove-argc). Does not apply to exports",
        default: false,
        scope: "resource",
      },
      allowForbiddenOpts: {
        order: 2,
        type: "boolean",
        markdownDescription:
          "[Whether to perform optimizations no longer allowed on the app store](https://github.com/markw65/monkeyc-optimizer/wiki/Post-Build-Optimizer#allow-forbidden-optimizations). Always false for exports",
        default: false,
        scope: "resource",
      },
      postBuildPRE: {
        order: 3,
        type: "boolean",
        markdownDescription:
          "Post Build Size based PRE [similar to the source-to-source pass](https://github.com/markw65/monkeyc-optimizer/wiki/Type-and-Dataflow-analysis#size-based-pre)",
        default: true,
        scope: "resource",
      },
    },
  },
  {
    title: "OnlyTasks",
    type: "object",
    properties: {
      device: {
        type: "string",
        taskDescription:
          "The device to build for. The special value `export' will do an iq build into bin/export, and the value `choose' will let you pick the device from a list",
        launchDescription:
          "Device to run or 'choose' or '${command:GetTargetDevice}' to choose a new device each run.",
        scope: "tasks_launch",
      },
      releaseBuild: {
        type: "boolean",
        taskDescription: "Is this a release build.",
        launchDescription: "Run a release build.",
        scope: "tasks_launch",
      },
      runTests: {
        type: "boolean",
        description: "run test cases.",
        default: false,
        scope: "launch",
      },
      jungleFiles: {
        type: "string",
        description:
          "If present, overrides the corresponding `monkeyC' setting.",
        scope: "tasks_launch",
      },
      developerKeyPath: {
        type: "string",
        description:
          "If present, overrides the corresponding `monkeyC' setting.",
        scope: "tasks_launch",
      },
      optimizationLevel: {
        type: "string",
        description:
          "If present, overrides the corresponding `monkeyC' setting.",
        enum: ["None", "Basic", "Fast", "Slow"],
        enumDescriptions: [
          "No optimization",
          "Basic optimizations for building in debug",
          "Fast optimizations for building in release",
          "Slow optimizations that need more time",
        ],
        scope: "tasks_launch",
      },
      compilerOptions: {
        type: "string",
        description:
          "If present, overrides the corresponding `monkeyC' setting.",
        scope: "tasks_launch",
      },
      compilerWarnings: {
        type: "boolean",
        description:
          "If present, overrides the corresponding `monkeyC' setting.",
        scope: "tasks_launch",
      },
      simulatorBuild: {
        type: "boolean",
        description: "Is this build for the simulator.",
        scope: "tasks",
      },
      testBuild: {
        type: "boolean",
        description: "Is this a test build.",
        scope: "tasks",
      },
    },
  },
] as const;
