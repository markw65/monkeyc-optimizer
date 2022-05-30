import { mctree } from "@markw65/prettier-plugin-monkeyc";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { formatAst, getApiMapping, hasProperty, isStateNode } from "./api";
import { build_project } from "./build";
import {
  get_jungle,
  JungleQualifier,
  ResolvedBarrel,
  ResolvedJungle,
  Target,
} from "./jungles";
import { launchSimulator, simulateProgram } from "./launch";
import {
  checkManifest,
  manifestDropBarrels,
  manifestProducts,
  writeManifest,
} from "./manifest";
import { analyze, getFileASTs, optimizeMonkeyC } from "./mc-rewrite";
import { appSupport } from "./sdk-util";
import {
  copyRecursiveAsNeeded,
  first_modified,
  globa,
  last_modified,
} from "./util";

export {
  copyRecursiveAsNeeded,
  get_jungle,
  launchSimulator,
  manifestProducts,
  mctree,
  ResolvedJungle,
  simulateProgram,
};

function relative_path_no_dotdot(relative: string) {
  return relative.replace(
    /^(\.\.[\\\/])+/,
    (str) => `__${"dot".repeat(str.length / 3)}__${str.slice(-1)}`
  );
}

async function getVSCodeSettings(
  path: string
): Promise<Record<string, unknown>> {
  try {
    const settings = await fs.readFile(path);
    return JSON.parse(settings.toString());
  } catch (e) {
    return {};
  }
}

export const defaultConfig = {
  outputPath: "bin/optimized",
  workspace: "./",
};

export interface ErrorWithLocation extends Error {
  location?: NonNullable<mctree.Node["loc"]>;
}

export function isErrorWithLocation(e: Error): e is ErrorWithLocation {
  return hasProperty(e, "location");
}

declare global {
  // Configuration options for build
  type BuildConfig = {
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
    _cache?: {
      barrels?: Record<string, ResolvedJungle>;
      barrelMap?: Record<string, Record<string, ResolvedJungle>>;
    };
  };
  type StateNodeDecl =
    | StateNode
    /* Enum values */
    | mctree.EnumStringMember
    /* Function parameters */
    | mctree.TypedIdentifier
    /* Other declarations */
    | mctree.EnumDeclaration
    | mctree.TypedefDeclaration
    | mctree.VariableDeclarator;
  type StateNodeDecls = {
    [key: string]: StateNodeDecl[];
  };
  interface BaseStateNode {
    type: string;
    node: mctree.Node | null | undefined;
    name: string | null | undefined;
    fullName: string | null | undefined;
    decls?: StateNodeDecls | undefined;
    type_decls?: StateNodeDecls | undefined;
    stack?: ProgramStateStack | undefined;
  }
  interface ProgramStateNode extends BaseStateNode {
    type: "Program";
    node: null | undefined;
    name: "$";
    fullName: "$";
    stack?: undefined;
  }
  interface ModuleStateNode extends BaseStateNode {
    type: "ModuleDeclaration";
    node: mctree.ModuleDeclaration;
    name: string;
    fullName: string;
  }
  interface ClassStateNode extends BaseStateNode {
    type: "ClassDeclaration";
    node: mctree.ClassDeclaration;
    name: string;
    fullName: string;
    superClass?: ClassStateNode[] | true;
  }
  interface FunctionStateNode extends BaseStateNode {
    type: "FunctionDeclaration";
    node: mctree.FunctionDeclaration;
    name: string;
    fullName: string;
    stack?: ProgramStateStack;
    decls?: undefined;
  }
  interface BlockStateNode extends BaseStateNode {
    type: "BlockStatement";
    name: undefined;
    fullName: undefined;
    node: mctree.BlockStatement;
    stack?: undefined;
  }
  type StateNode =
    | ProgramStateNode
    | FunctionStateNode
    | BlockStateNode
    | ClassStateNode
    | ModuleStateNode;
  type ProgramStateStack = StateNode[];
  export type ProgramState = {
    allFunctions?: FunctionStateNode[];
    allClasses?: ClassStateNode[];
    stack?: ProgramStateStack;
    removeNodeComments?: (node: mctree.Node, ast: mctree.Program) => void;
    shouldExclude?: (node: mctree.Node) => boolean;
    pre?: (
      node: mctree.Node,
      state: ProgramStateLive
    ) => null | false | (keyof mctree.NodeAll)[];
    post?: (
      node: mctree.Node,
      state: ProgramStateLive
    ) => null | false | mctree.Node;
    lookup?: (
      node: mctree.Node,
      name?: string | null,
      stack?: ProgramStateStack
    ) => [string, StateNodeDecl[], ProgramStateStack] | [null, null, null];
    lookupValue?: (
      node: mctree.Node,
      name?: string | null,
      stack?: ProgramStateStack
    ) => [string, StateNodeDecl[], ProgramStateStack] | [null, null, null];
    lookupType?: (
      node: mctree.Node,
      name?: string | null,
      stack?: ProgramStateStack
    ) => [string, StateNodeDecl[], ProgramStateStack] | [null, null, null];
    traverse?: (node: mctree.Node) => void | null | false | mctree.Node;
    inType?: boolean;
    exposed?: { [key: string]: true };
    calledFunctions?: { [key: string]: unknown[] };
    localsStack?: {
      node?: mctree.Node;
      map?: { [key: string]: true | string };
      inners?: { [key: string]: true };
    }[];
    index?: { [key: string]: unknown[] };
    constants?: { [key: string]: mctree.Literal };
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
    | "traverse"
    | "index"
    | "constants"
    | "removeNodeComments"
    | "inType"
  >;
  export type ProgramStateAnalysis = Finalized<
    ProgramStateLive,
    "allClasses" | "allFunctions"
  >;
  export type ProgramStateOptimizer = Finalized<
    ProgramStateAnalysis,
    "localsStack" | "exposed" | "calledFunctions"
  >;
  type ExcludeAnnotationsMap = { [key: string]: boolean };
  type FilesToOptimizeMap = {
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
  var lastModifiedSource: number;
}

/**
 * @param {BuildConfig} options
 * @returns {Promise<BuildConfig>}
 */
function getConfig(options: BuildConfig) {
  const config: BuildConfig = { ...defaultConfig, ...(options || {}) };
  return [
    "jungleFiles",
    "developerKeyPath",
    "typeCheckLevel",
    "compilerOptions",
    "compilerWarnings",
    "ignoredExcludeAnnotations",
    "ignoredAnnotations",
    "ignoredSourcePaths",
  ]
    .reduce((promise: Promise<null | Record<string, unknown>>, key) => {
      if (key in config) return promise;
      return promise
        .then(
          (v) =>
            v ||
            getVSCodeSettings(`${appSupport}/Code/User/settings.json`).then(
              (globals) =>
                getVSCodeSettings(
                  `${config.workspace}/.vscode/settings.json`
                ).then((locals) => ({ ...globals, ...locals }))
            )
        )
        .then((settings) => {
          const value =
            settings[`monkeyC.${key}`] || settings[`prettierMonkeyC.${key}`];
          if (value !== undefined) {
            (config as Record<string, unknown>)[key] = value;
          }
          return settings;
        });
    }, Promise.resolve(null))
    .then(() => config);
}

/**
 *
 * @param {string | null} product
 * @param {BuildConfig} options
 * @returns
 */
export async function buildOptimizedProject(
  product: string | null,
  options: BuildConfig
) {
  const config = await getConfig(options);
  if (product) {
    config.products = [product];
  } else {
    delete config.testBuild;
    if (!hasProperty(config, "releaseBuild")) {
      config.releaseBuild = true;
    }
  }
  const { jungleFiles, program, hasTests } = await generateOptimizedProject(
    config
  );
  config.jungleFiles = jungleFiles;
  let bin = config.buildDir || "bin";
  let name = `optimized-${program}.prg`;
  if (product) {
    product = config.products![0];
    if (config.simulatorBuild === false) {
      bin = path.join(bin, product);
    }
  } else {
    bin = path.join(bin, "exported");
    name = `${program}.iq`;
  }
  config.program = path.join(bin, name);
  if (!hasTests) delete config.testBuild;
  return build_project(product, config).then((result) => ({
    hasTests,
    ...result,
  }));
}

/**
 * For each barrel project included in the build, we want to build
 * a local barrel project inside the optimized directory.
 *
 * Note that for each named barrel, each target could include a
 * different barrel, or barrel project. It could even include more
 * than one - but in that case, they should be separate jungle files
 * with the same manifest file.
 *
 * So for each input barrel (resolvedBarrel.jungles are the jungle
 * files corresponding to an input barrel), we create a copy of
 * the barrel with all the sources removed (and pick up the sources
 * from the input barrel)
 *
 * @param {BuildConfig} options
 * @param {Target[]} targets
 */
async function createLocalBarrels(targets: Target[], options: BuildConfig) {
  if (
    targets.every(
      (target) =>
        !target.group?.optimizerConfig.barrelMap ||
        Object.values(target.group.optimizerConfig.barrelMap).every(
          (resolvedBarrel) => !resolvedBarrel.qualifier.resourcePath
        )
    )
  ) {
    // there are no barrels, or every barrel has no resources.
    // we can drop any barrels altogether (we'll need to drop them
    // from the manifest file too).
    return null;
  }
  // where to create the local barrel projects.
  const barrelDir = path.resolve(
    options.workspace!,
    options.outputPath!,
    "opt-barrels"
  );
  return targets.reduce((promise, target) => {
    if (!target.group) return promise;
    const barrelMap = target.group.optimizerConfig.barrelMap;
    if (!barrelMap || target.group.optimizerConfig.optBarrels) {
      return promise;
    }
    const optBarrels: JungleQualifier["optBarrels"] =
      (target.group.optimizerConfig.optBarrels = {});
    return Object.entries(barrelMap).reduce(
      (promise, [barrel, resolvedBarrel]) => {
        const { manifest, jungles } = resolvedBarrel;
        const rawBarrelDir = path.dirname(jungles[0]);
        const rawJungles = jungles.map((jungle) =>
          path.relative(rawBarrelDir, jungle)
        );
        const sha1 = crypto
          .createHash("sha1")
          .update(rawBarrelDir, "binary")
          .digest("base64")
          .replace(/[\/=+]/g, "");
        const optBarrelDir = path.resolve(barrelDir, `${barrel}-${sha1}`);
        if (!hasProperty(optBarrels, barrel)) {
          optBarrels[barrel] = {
            rawBarrelDir,
            manifest,
            jungleFiles: [...rawJungles],
            optBarrelDir,
          };
          return promise.then(() =>
            copyRecursiveAsNeeded(
              rawBarrelDir,
              optBarrelDir,
              (src: string) => !src.endsWith(".mc")
            )
          );
        }
        if (
          optBarrels[barrel].manifest !== manifest ||
          optBarrels[barrel].optBarrelDir !== optBarrelDir ||
          optBarrels[barrel].rawBarrelDir != rawBarrelDir
        ) {
          throw new Error(
            `For device ${
              target.product
            }, barrel ${barrel} was mapped to both ${path.relative(
              optBarrels[barrel].rawBarrelDir,
              optBarrels[barrel].manifest
            )} in ${optBarrels[barrel].rawBarrelDir} and ${path.relative(
              rawBarrelDir,
              manifest
            )} in ${rawBarrelDir}.`
          );
        }
        optBarrels[barrel].jungleFiles.push(...rawJungles);
        return promise;
      },
      promise
    );
  }, Promise.resolve());
}

export async function generateOptimizedProject(options: BuildConfig) {
  const config = await getConfig(options);
  const workspace = config.workspace!;

  const { manifest, targets, xml, jungles } = await get_jungle(
    config.jungleFiles!,
    config
  );
  if (!xml["iq:manifest"]["iq:application"]) {
    const error = new Error(
      xml["iq:manifest"]["iq:barrel"]
        ? "Optimize the project that uses this barrel, not the barrel itself"
        : "Manifest is missing an `iq:application` tag"
    );
    (error as ErrorWithLocation).location = {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 1 },
      source: manifest,
    };
    throw error;
  }
  const dependencyFiles = [manifest, ...jungles];
  await createLocalBarrels(targets, options);

  const buildConfigs: Record<string, JungleQualifier | null> = {};
  const products: Record<string, string[]> = {};
  let pick_one = config.products ? config.products.indexOf("pick-one") : -1;
  if (config.skipOptimization) {
    if (pick_one >= 0) {
      options.products = [...options.products!];
      options.products[pick_one] = targets[0].product;
    }
    return {
      jungleFiles: config.jungleFiles,
      program: path.basename(path.dirname(manifest)),
    };
  }
  let dropBarrels = false;
  const configKey = (p: Target) =>
    p.group!.key + (config.releaseBuild ? "-release" : "-debug");
  targets.forEach((p) => {
    if (!p.group) {
      throw new Error(`Missing group in build target ${p.product}`);
    }
    const key = configKey(p);
    if (!hasProperty(buildConfigs, key)) {
      p.group!.dir = key;
      if (
        p.group!.optimizerConfig.barrelMap &&
        !p.group!.optimizerConfig.optBarrels
      ) {
        dropBarrels = true;
      }
      buildConfigs[key] = null;
    }
    if (
      pick_one >= 0 ||
      !options.products ||
      options.products.includes(p.product) ||
      (p.shape && options.products.includes(p.shape))
    ) {
      if (pick_one >= 0) {
        // don't modify the original array since it may be shared
        // (and *is* shared when we're called from test.js)
        options.products = [...options.products!];
        options.products[pick_one] = p.product;
        pick_one = -1;
      }
      if (!buildConfigs[key]) {
        buildConfigs[key] = p.group.optimizerConfig;
        products[key] = [];
      }
      products[key].push(p.product);
    }
  });

  // console.log(JSON.stringify(targets));

  const jungle_dir = path.resolve(workspace, config.outputPath!);
  await fs.mkdir(jungle_dir, { recursive: true });
  const relative_path = (s: string) => path.relative(jungle_dir, s);
  let relative_manifest = relative_path(manifest);
  const manifestOk =
    (!config.checkManifest ||
      (await checkManifest(
        xml,
        targets.map((t) => t.product)
      ))) &&
    !dropBarrels;
  let hasTests = false;
  const promises = Object.keys(buildConfigs)
    .sort()
    .map((key) => {
      const buildConfig = buildConfigs[key];
      const outputPath = path.join(config.outputPath!, key);

      return buildConfig
        ? generateOneConfig(buildConfig, dependencyFiles, {
            ...config,
            outputPath,
          })
            .catch((e) => {
              if (!e.stack) {
                e = new Error(e.toString());
              }
              e.products = products[key];
              throw e;
            })
            .then((t) => t && (hasTests = true))
        : fs.rm(path.resolve(workspace, outputPath), {
            recursive: true,
            force: true,
          });
    });

  if (!manifestOk) {
    if (dropBarrels) {
      manifestDropBarrels(xml);
    }
    const manifestFile = path.join(jungle_dir, "manifest.xml");
    promises.push(writeManifest(manifestFile, xml));
    relative_manifest = "manifest.xml";
  }

  const parts = [`project.manifest=${relative_manifest}`];
  const process_field = <T extends string>(
    prefix: string,
    base: { [k in T]?: string[] },
    name: T,
    mapper: ((s: string) => string) | null = null
  ) => {
    const obj = base[name];
    if (!obj) return;
    const map_one = (s: string) => (mapper ? mapper(s) : s);
    const map = (s: string | string[]) =>
      Array.isArray(s) ? `[${s.map(map_one).join(";")}]` : map_one(s);
    parts.push(`${prefix}${name} = ${obj.map(map).join(";")}`);
  };
  targets.forEach((target) => {
    if (!buildConfigs[configKey(target)]) return;
    const { product, qualifier, group } = target;
    if (!group) {
      throw new Error(`Missing group in target ${target.product}`);
    }
    const prefix = `${product}.`;
    process_field(prefix, qualifier, "sourcePath", (s) =>
      path
        .join(
          group.dir!,
          "source",
          relative_path_no_dotdot(path.relative(workspace, s))
        )
        .replace(/([\\\/]\*\*)[\\\/]\*/g, "$1")
    );
    if (group.optimizerConfig.optBarrels) {
      parts.push(
        `${prefix}barrelPath = ${Object.values(group.optimizerConfig.optBarrels)
          .map(
            (value) =>
              `[${value.jungleFiles
                .map((j) => relative_path(path.join(value.optBarrelDir, j)))
                .join(";")}]`
          )
          .join(";")}`
      );
    }
    if (group.optimizerConfig.barrelMap) {
      parts.push(
        `${prefix}sourcePath = ${[`$(${prefix}sourcePath)`]
          .concat(
            Object.entries(group.optimizerConfig.barrelMap)
              .map(([barrel, resolvedBarrel]) => {
                const root = path.dirname(resolvedBarrel.jungles[0]);
                return (resolvedBarrel.qualifier.sourcePath || []).map((s) =>
                  path
                    .join(group.dir!, "barrels", barrel, path.relative(root, s))
                    .replace(/([\\\/]\*\*)[\\\/]\*/g, "$1")
                );
              })
              .flat()
              .sort()
              .filter((s, i, arr) => !i || s !== arr[i - 1])
          )
          .join(";")}`
      );
    }
    // annotations were handled via source transformations.
    process_field(prefix, qualifier, "resourcePath", relative_path);
    process_field(prefix, qualifier, "excludeAnnotations");
    const qlang = qualifier.lang;
    if (qlang) {
      Object.keys(qlang).forEach((key) => {
        process_field(`${prefix}lang.`, qlang, key, relative_path);
      });
    }
  });

  const jungleFiles = path.join(
    jungle_dir,
    `${config.releaseBuild ? "release" : "debug"}.jungle`
  );
  promises.push(fs.writeFile(jungleFiles, parts.join("\n")));

  await Promise.all(promises);
  return {
    jungleFiles,
    xml,
    program: path.basename(path.dirname(manifest)),
    hasTests,
  };
}

export type PreAnalysis = {
  fnMap: FilesToOptimizeMap;
  paths: string[];
};

declare type RequiredNonNull<T> = {
  [K1 in keyof T]-?: { [K2 in keyof T[K1]]-?: NonNullable<T[K1][K2]> };
};

export type Analysis = {
  fnMap: RequiredNonNull<FilesToOptimizeMap>;
  paths: string[];
  state: ProgramStateAnalysis;
};

async function fileInfoFromConfig(
  workspace: string,
  output: string,
  buildConfig: JungleQualifier,
  extraExcludes: ExcludeAnnotationsMap
): Promise<PreAnalysis> {
  const paths = (
    await Promise.all(
      buildConfig.sourcePath?.map((pattern) =>
        globa(pattern, { cwd: workspace, mark: true })
      ) || []
    )
  ).flat();

  const files = (
    await Promise.all(
      paths.map((path) =>
        path.endsWith("/")
          ? globa(`${path}**/*.mc`, { cwd: workspace, mark: true })
          : path
      )
    )
  )
    .flat()
    .filter(
      (file) =>
        file.endsWith(".mc") &&
        !path.relative(workspace, file).startsWith("bin") &&
        (!buildConfig.sourceExcludes ||
          !buildConfig.sourceExcludes.includes(file))
    );

  const excludeAnnotations = Object.assign(
    buildConfig.excludeAnnotations
      ? Object.fromEntries(
          buildConfig.excludeAnnotations.map((ex) => [ex, true])
        )
      : {},
    extraExcludes
  );

  return {
    fnMap: Object.fromEntries(
      files.map((file) => [
        file,
        {
          output: path.join(
            output,
            relative_path_no_dotdot(path.relative(workspace, file))
          ),
          excludeAnnotations,
        },
      ])
    ),
    paths: paths.filter((path) => path.endsWith("/")),
  };
}

function excludesFromAnnotations(
  barrel: string,
  annotations: JungleQualifier["annotations"],
  resolvedBarrel: ResolvedBarrel
) {
  const excludes = resolvedBarrel.annotations
    ? Object.fromEntries(resolvedBarrel.annotations.map((a) => [a, true]))
    : {};
  if (annotations && annotations[barrel]) {
    annotations[barrel].forEach((a) => {
      delete excludes[a];
    });
  }
  return excludes;
}

const configOptionsToCheck = [
  "workspace",
  "releaseBuild",
  "testBuild",
  "checkManifest",
  "ignoredExcludeAnnotations",
  "ignoredAnnotations",
  "ignoredSourcePaths",
] as const;

/**
 * @param {BuildConfig} config
 * @param {*} buildConfig
 * @param {string[]} dependencyFiles
 * @returns
 */
async function generateOneConfig(
  buildConfig: JungleQualifier,
  dependencyFiles: string[],
  config: BuildConfig
) {
  const { workspace } = config;
  const output = path.join(workspace!, config.outputPath!);

  const buildModeExcludes = {
    // note: exclude debug in release builds, and release in debug builds
    [config.releaseBuild ? "debug" : "release"]: true,
  };
  if (!config.testBuild) {
    buildModeExcludes.test = true;
  }

  const { fnMap } = await fileInfoFromConfig(
    workspace!,
    path.join(output, "source"),
    buildConfig,
    buildModeExcludes
  );

  if (buildConfig.barrelMap) {
    const barrelFnMaps = await Promise.all(
      Object.entries(buildConfig.barrelMap)
        .map(([barrel, resolvedBarrel]) => {
          dependencyFiles = dependencyFiles.concat(
            resolvedBarrel.jungles,
            resolvedBarrel.manifest
          );
          return fileInfoFromConfig(
            path.dirname(resolvedBarrel.jungles[0]),
            path.join(output, "barrels", barrel),
            resolvedBarrel.qualifier,
            {
              ...buildModeExcludes,
              ...excludesFromAnnotations(
                barrel,
                buildConfig.annotations,
                resolvedBarrel
              ),
            }
          ).then(({ fnMap }) => fnMap);
        })
        .flat()
    );
    barrelFnMaps.forEach((barrelFnMap) => Object.assign(fnMap, barrelFnMap));
  }

  const actualOptimizedFiles = (
    await globa(path.join(output, "**", "*.mc"), { mark: true })
  )
    .filter((file) => !file.endsWith("/"))
    .sort();

  const { hasTests, ...prevOptions } = JSON.parse(
    await fs
      .readFile(path.join(output, "build-info.json"), "utf-8")
      .catch(() => "{}")
  );

  // check that the set of files thats actually there is the same as the
  // set of files we're going to generate (in case eg a jungle file change
  // might have altered it), and that the options we care about haven't
  // changed
  if (
    hasTests != null &&
    configOptionsToCheck.every(
      (option) => prevOptions[option] === config[option]
    ) &&
    actualOptimizedFiles.length == Object.values(fnMap).length &&
    Object.values(fnMap)
      .map((v) => v.output)
      .sort()
      .every((f, i) => f == actualOptimizedFiles[i])
  ) {
    // now if the newest source file is older than
    // the oldest optimized file, we don't need to regenerate
    const source_time = await last_modified(
      Object.keys(fnMap).concat(dependencyFiles)
    );
    const opt_time = await first_modified(
      Object.values(fnMap).map((v) => v.output)
    );
    if (source_time < opt_time && global.lastModifiedSource < opt_time) {
      return hasTests;
    }
  }

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await optimizeMonkeyC(fnMap);
  return Promise.all(
    Object.values(fnMap).map(async (info) => {
      const name = info.output;
      const dir = path.dirname(name);
      await fs.mkdir(dir, { recursive: true });

      const opt_source = formatAst(info.ast!, info.monkeyCSource);
      await fs.writeFile(name, opt_source);
      return info.hasTests;
    })
  ).then((results) => {
    const hasTests = results.some((v) => v);
    return fs
      .writeFile(
        path.join(output, "build-info.json"),
        JSON.stringify({
          hasTests,
          ...Object.fromEntries(
            configOptionsToCheck.map((option) => [option, config[option]])
          ),
        })
      )
      .then(() => hasTests);
  });
}

export async function getProjectAnalysis(
  targets: Target[],
  analysis: PreAnalysis | null,
  options: BuildConfig
): Promise<Analysis | PreAnalysis> {
  const sourcePath = targets
    .map(({ qualifier: { sourcePath } }) => sourcePath)
    .filter((sp): sp is NonNullable<typeof sp> => sp != null)
    .flat()
    .sort()
    .filter((s, i, arr) => !i || s !== arr[i - 1]);

  const { fnMap, paths } = await fileInfoFromConfig(
    options.workspace!,
    options.workspace!,
    { sourcePath },
    {}
  );

  if (analysis) {
    Object.entries(fnMap).forEach(([k, v]) => {
      if (hasProperty(analysis.fnMap, k)) {
        const old = analysis.fnMap[k];
        if (old.monkeyCSource) v.monkeyCSource = old.monkeyCSource;
        if (old.ast) v.ast = old.ast;
      }
    });
  }

  if (!(await getFileASTs(fnMap))) {
    return { fnMap, paths };
  }

  const state = await analyze(fnMap);

  return { fnMap: fnMap as Analysis["fnMap"], paths, state };
}

/**
 *
 * @param {BuildConfig} options
 * @returns
 */
export async function generateApiMirTests(options: BuildConfig) {
  const config = { ...defaultConfig, ...(options || {}) };
  const tests: Array<[string, string]> = [];
  const api = await getApiMapping();
  if (!api) {
    throw new Error("Failed to read api.mir");
  }
  const findConstants = (node: StateNode) => {
    node.decls &&
      Object.entries(node.decls).forEach(([key, decl]) => {
        if (decl.length > 1) throw `Bad decl length:${node.fullName}.${key}`;
        if (decl.length != 1) return;
        const d = decl[0];
        if (
          d.type === "EnumStringMember" ||
          (d.type === "VariableDeclarator" && d.kind === "const")
        ) {
          if (!d.init) {
            throw new Error(`Missing init for ${node.fullName}.${key}`);
          }
          tests.push([`${node.fullName}.${key}`, formatAst(d.init)]);
        } else if (isStateNode(d)) {
          findConstants(d);
        }
      });
  };
  findConstants(api);
  function hasTests(name: string) {
    const names = name.split(".");
    return names
      .map((t, i, arr) => arr.slice(0, i).join(".") + " has :" + t)
      .slice(2)
      .join(" && ");
  }
  const source = [
    "import Toybox.Lang;",
    "import Toybox.Test;",
    "(:test,:typecheck(false))",
    "function apiTest(logger as Logger) as Boolean {",
    ...tests.map(
      (t) =>
        `  if (${hasTests(t[0])}) { if (${t[0]} != ${t[1]}) { logger.debug("${
          t[0]
        }: "+${t[0]}.toString()+" != ${
          t[1]
        }"); } } else { logger.debug("Not tested: ${t[0]}"); }`
    ),
    "  return true;",
    "}",
  ].join("\n");
  const workspace = config.workspace;
  return fs.writeFile(`${workspace}/source/apiTest.mc`, source);
}
