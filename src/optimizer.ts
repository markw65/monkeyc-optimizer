import { mctree } from "@markw65/prettier-plugin-monkeyc";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import * as Prettier from "prettier";
import {
  collectNamespaces,
  formatAst,
  getApiMapping,
  hasProperty,
  isStateNode,
  parseSdkVersion,
} from "./api";
import { build_project } from "./build";
import {
  get_jungle,
  JungleBuildDependencies,
  JungleError,
  JungleQualifier,
  JungleResourceMap,
  ResolvedBarrel,
  ResolvedJungle,
  Target,
} from "./jungles";
import { launchSimulator, simulateProgram } from "./launch";
import {
  checkManifest,
  manifestDropBarrels,
  manifestLanguages,
  manifestProducts,
  writeManifest,
} from "./manifest";
import {
  analyze,
  getFileASTs,
  optimizeMonkeyC,
  reportMissingSymbols,
} from "./mc-rewrite";
import {
  BuildConfig,
  ExcludeAnnotationsMap,
  FilesToOptimizeMap,
  FunctionStateNode,
  ProgramState,
  ProgramStateAnalysis,
  StateNode,
} from "./optimizer-types";
import { appSupport, connectiq, getSdkPath, xmlUtil } from "./sdk-util";
import { buildTypeInfo } from "./type-flow";
import { couldBeWeak } from "./type-flow/could-be";
import { evaluate, InterpState, TypeMap } from "./type-flow/interp";
import { subtypeOf } from "./type-flow/sub-type";
import {
  copyRecursiveAsNeeded,
  first_modified,
  globa,
  last_modified,
} from "./util";
import { runTaskInPool, startPool, stopPool } from "./worker-pool";

declare const MONKEYC_OPTIMIZER_VERSION: string;

export * from "./optimizer-types";
export { display, ExactOrUnion } from "./type-flow/types";
export {
  copyRecursiveAsNeeded,
  get_jungle,
  JungleBuildDependencies,
  JungleError,
  JungleResourceMap,
  launchSimulator,
  manifestProducts,
  mctree,
  ResolvedJungle,
  simulateProgram,
  TypeMap,
};

function relative_path_no_dotdot(relative: string) {
  return relative.replace(
    /^(\.\.[\\/])+/,
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
  // eslint-disable-next-line no-var
  var lastModifiedSource: number;
}

/**
 * @param {BuildConfig} options
 * @returns {Promise<BuildConfig>}
 */
export function getConfig(options: BuildConfig) {
  const config: BuildConfig = { ...defaultConfig, ...(options || {}) };
  return [
    "jungleFiles",
    "developerKeyPath",
    "typeCheckLevel",
    "optimizationLevel",
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
 * WARNING WARNING WARNING WARNING WARNING WARNING
 *
 * prettier-extension-monkeyc can dynamically import this
 * function from a local copy of @markw65/monkeyc-optimizer,
 * rather than using the version that ships with the
 * extension.
 *
 * For this to work, buildOptimizedProject's signature cannot
 * change (or at least, can only change in a backward compatible
 * way).
 *
 * DON'T CHANGE THIS FUNCTION's SIGNATURE
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
  const { jungleFiles, program, hasTests, diagnostics } =
    await generateOptimizedProject(config);
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
    diagnostics,
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
          .replace(/[/=+]/g, "");
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
          optBarrels[barrel].rawBarrelDir !== rawBarrelDir
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

  const {
    manifest,
    typeCheckLevel,
    optimizationLevel,
    targets,
    xml,
    devices,
    resources,
    buildDependencies,
  } = await get_jungle(config.jungleFiles!, config);
  if (xml.body instanceof Error) {
    throw xml.body;
  }
  if (!xml.body.children("iq:application").length()) {
    const error = new Error(
      xml.body.children("iq:barrel").length()
        ? "Optimize the project that uses this barrel, not the barrel itself"
        : "Manifest is missing an `iq:application` tag"
    );
    (error as ErrorWithLocation).location =
      xml.body.elements[0].loc || undefined;
    throw error;
  }
  const dependencyFiles = Object.keys(resources).concat(
    Object.keys(buildDependencies)
  );
  await createLocalBarrels(targets, config);

  const buildConfigs: Record<string, JungleQualifier | null> = {};
  let pick_one = config.products ? config.products.indexOf("pick-one") : -1;
  if (config.skipOptimization) {
    if (pick_one >= 0) {
      options.products = [...options.products!];
      options.products[pick_one] = targets[0].product;
    }
    return {
      jungleFiles: config.jungleFiles,
      xml,
      program: path.basename(path.dirname(manifest)),
      hasTests: !!config.testBuild,
    };
  }
  let dropBarrels = false;
  let configsToBuild = 0;
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
        configsToBuild++;
      }
    }
  });

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
  let diagnostics: NonNullable<ProgramState["diagnostics"]> = {};
  const jungleFiles = path.join(
    jungle_dir,
    `${config.releaseBuild ? "release" : "debug"}.jungle`
  );
  let poolStarted;
  try {
    if (configsToBuild > 1) {
      poolStarted = startPool();
    }
    let hasPersonality = false;
    const promises = Object.keys(buildConfigs)
      .sort()
      .map((key) => {
        const buildConfig = buildConfigs[key];
        const outputPath = path.join(config.outputPath!, key);

        return buildConfig
          ? runTaskInPool({
              type: "generateOneConfig",
              data: {
                buildConfig,
                manifestXML: xml,
                dependencyFiles,
                config: {
                  ...config,
                  outputPath,
                },
              },
            })
              .catch((e) => {
                if (!e.stack) {
                  e = new Error(e.toString());
                }
                if (buildConfig.products) {
                  e.products = buildConfig.products;
                }
                throw e;
              })
              .then((t) => {
                if (t.hasTests) hasTests = true;
                if (t.diagnostics) {
                  diagnostics = { ...diagnostics, ...t.diagnostics };
                }
                if (t.sdkVersion != null && t.sdkVersion >= 4002001) {
                  hasPersonality = true;
                }
              })
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
    if (typeCheckLevel != null) {
      parts.push(`project.typecheck = ${typeCheckLevel}`);
    }
    if (optimizationLevel != null) {
      parts.push(`project.optimization = ${optimizationLevel}`);
    }
    const map_field = <T extends string>(
      base: { [k in T]?: string[] },
      name: T,
      mapper: ((s: string) => string) | null = null
    ) => {
      const obj = base[name];
      if (!obj) return null;
      const map_one = (s: string) => (mapper ? mapper(s) : s);
      const map = (s: string | string[]) =>
        Array.isArray(s) ? `[${s.map(map_one).join(";")}]` : map_one(s);
      return `${obj.map(map).join(";")}`;
    };
    const process_field = <T extends string>(
      prefix: string,
      base: { [k in T]?: string[] },
      name: T,
      mapper: ((s: string) => string) | null = null
    ) => {
      const mapped = map_field(base, name, mapper);
      if (!mapped) return;
      parts.push(`${prefix}${name} = ${mapped}`);
    };
    const languagesToInclude = Object.fromEntries(
      (manifestLanguages(xml) || []).map((lang) => [lang, true] as const)
    );
    const unsupportedLangsCache: Record<string, string> = {};
    let availableDefaults: string[] | null = null;
    const nextAvailableDefault = () => {
      if (!availableDefaults) {
        availableDefaults = Object.keys(
          Object.values(devices).reduce((m, d) => {
            m[d.deviceFamily] = true;
            const match = d.deviceFamily.match(/^(\w+)-\d+x\d+/);
            if (match) m[match[1]] = true;
            return m;
          }, {} as Record<string, true>)
        ).sort();
        availableDefaults.unshift("base");
      }
      return availableDefaults.shift();
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
          .replace(/([\\/]\*\*)[\\/]\*/g, "$1")
      );
      if (group.optimizerConfig.optBarrels) {
        parts.push(
          `${prefix}barrelPath = ${Object.values(
            group.optimizerConfig.optBarrels
          )
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
                      .join(
                        group.dir!,
                        "barrels",
                        barrel,
                        path.relative(root, s)
                      )
                      .replace(/([\\/]\*\*)[\\/]\*/g, "$1")
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
      process_field(prefix, qualifier, "personality", relative_path);
      process_field(prefix, qualifier, "excludeAnnotations");
      const qLang = qualifier.lang;
      if (qLang) {
        const devLang = devices[product].languages;
        const unsupportedLangs = Object.keys(qLang)
          .sort()
          .map((key) => {
            if (
              hasProperty(devLang, key) ||
              !hasProperty(languagesToInclude, key)
            ) {
              return null;
            }
            const mapped = map_field(qLang, key, relative_path);
            if (!mapped) return null;
            return [key, mapped] as const;
          })
          .filter((a): a is NonNullable<typeof a> => a != null);
        let keysToSkip: Record<string, string> | null = null;
        if (unsupportedLangs.length) {
          const key = JSON.stringify(unsupportedLangs);
          if (!hasProperty(unsupportedLangsCache, key)) {
            const base = nextAvailableDefault();
            if (base) {
              unsupportedLangs.forEach(([key, value]) =>
                parts.push(`${base}.lang.${key} = ${value}`)
              );
              unsupportedLangsCache[key] = `${base}.lang`;
            }
          }
          if (hasProperty(unsupportedLangsCache, key)) {
            keysToSkip = Object.fromEntries(unsupportedLangs);
            parts.push(`${prefix}lang = $(${unsupportedLangsCache[key]})`);
          }
        }
        Object.keys(qLang).forEach((key) => {
          hasProperty(keysToSkip, key) ||
            !hasProperty(languagesToInclude, key) ||
            process_field(`${prefix}lang.`, qLang, key, relative_path);
        });
      }
    });

    await Promise.all(promises);
    await fs.writeFile(
      jungleFiles,
      (hasPersonality
        ? parts
        : parts.filter((part) => !/\.personality = /.test(part))
      ).join("\n")
    );
  } finally {
    if (poolStarted) {
      stopPool();
    }
  }
  return {
    jungleFiles,
    xml,
    program: path.basename(path.dirname(manifest)),
    hasTests,
    diagnostics,
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
  typeMap?: TypeMap | null | undefined;
};

async function filesFromPaths(
  workspace: string,
  paths: string[] | null | undefined,
  extension: string
) {
  paths = (
    await Promise.all(
      paths?.map((pattern) => globa(pattern, { cwd: workspace, mark: true })) ||
        []
    )
  ).flat();

  const files = await Promise.all(
    paths.map((path) =>
      path.endsWith("/")
        ? globa(`${path}**/*${extension}`, { cwd: workspace, mark: true })
        : path
    )
  );
  return {
    files: files
      .flat()
      .filter(
        (file) =>
          file.endsWith(extension) &&
          !path.relative(workspace, file).startsWith("bin")
      ),
    paths,
  };
}

async function fileInfoFromConfig(
  workspace: string,
  output: string,
  buildConfig: JungleQualifier,
  extraExcludes: ExcludeAnnotationsMap,
  barrel: string
): Promise<PreAnalysis> {
  const { files, paths } = await filesFromPaths(
    workspace,
    buildConfig.sourcePath,
    ".mc"
  );

  let personality = buildConfig.personality;
  if (buildConfig.products) {
    personality = (personality ?? []).concat(
      buildConfig.products.map(
        (product) => `${connectiq}/Devices/${product}/personality.mss`
      )
    );
  }
  const { files: personalityFiles } = await filesFromPaths(
    workspace,
    personality,
    ".mss"
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
      files
        .filter(
          (file) =>
            !buildConfig.sourceExcludes ||
            !buildConfig.sourceExcludes.includes(file)
        )
        .concat(personalityFiles)
        .map((file) => [
          file,
          {
            output: path.join(
              output,
              relative_path_no_dotdot(path.relative(workspace, file))
            ),
            barrel,
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

const configOptionsToCheck: Array<keyof BuildConfig> = [
  "workspace",
  "releaseBuild",
  "testBuild",
  "checkManifest",
  "ignoredExcludeAnnotations",
  "ignoredAnnotations",
  "ignoredSourcePaths",
  "checkInvalidSymbols",
  "checkCompilerLookupRules",
  "checkTypes",
  "sizeBasedPRE",
  "trustDeclaredTypes",
  "propagateTypes",
  "singleUseCopyProp",
  "minimizeLocals",
  "minimizeModules",
  "extensionVersion",
  "typeCheckLevel",
  "covarianceWarnings",
  "iterateOptimizer",
];

/**
 * @param {BuildConfig} config
 * @param {*} buildConfig
 * @param {string[]} dependencyFiles
 * @returns
 */
export async function generateOneConfig(
  buildConfig: JungleQualifier,
  manifestXML: xmlUtil.Document,
  dependencyFiles: string[],
  config: BuildConfig
): Promise<{
  hasTests: boolean;
  diagnostics: ProgramState["diagnostics"];
  sdkVersion: number | undefined;
}> {
  const { workspace } = config;
  const output = path.join(workspace!, config.outputPath!);

  const buildModeExcludes = {
    // note: exclude debug in release builds, and release in debug builds
    [config.releaseBuild ? "debug" : "release"]: true,
  };
  if (!config.testBuild) {
    buildModeExcludes.test = true;
  }

  const resourcesMap: Record<string, JungleResourceMap> = {};
  if (buildConfig.resourceMap) {
    resourcesMap[""] = buildConfig.resourceMap;
  }
  const { fnMap } = await fileInfoFromConfig(
    workspace!,
    path.join(output, "source"),
    buildConfig,
    buildModeExcludes,
    ""
  );

  if (buildConfig.barrelMap) {
    const barrelFnMaps = await Promise.all(
      Object.entries(buildConfig.barrelMap)
        .map(([barrel, resolvedBarrel]) => {
          if (resolvedBarrel.resources) {
            resourcesMap[barrel] = resolvedBarrel.resources;
          }
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
            },
            barrel
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

  const {
    hasTests,
    diagnostics: prevDiagnostics,
    sdkVersion: prevSdkVersion,
    ...prevOptions
  } = JSON.parse(
    await fs
      .readFile(path.join(output, "build-info.json"), "utf-8")
      .catch(() => "{}")
  ) as {
    hasTests: boolean;
    diagnostics: NonNullable<ProgramState["diagnostics"]>;
    sdkVersion: number | undefined;
  } & BuildConfig;

  // check that the set of files thats actually there is the same as the
  // set of files we're going to generate (in case eg a jungle file change
  // might have altered it), and that the options we care about haven't
  // changed
  const mcFiles = Object.values(fnMap).filter((f) => /\.mc/i.test(f.output));
  if (
    hasTests != null &&
    !config.checkBuildPragmas &&
    configOptionsToCheck.every(
      (option) => prevOptions[option] === config[option]
    ) &&
    actualOptimizedFiles.length === mcFiles.length &&
    mcFiles
      .map((v) => v.output)
      .sort()
      .every((f, i) => f === actualOptimizedFiles[i])
  ) {
    const sdk = await getSdkPath();
    const match = sdk.match(/-(\d+\.\d+\.\d+)/);
    if ((match && parseSdkVersion(match[1])) === prevSdkVersion) {
      // now if the newest source file is older than
      // the oldest optimized file, we don't need to regenerate
      const source_time = await last_modified(
        Object.keys(fnMap).concat(dependencyFiles)
      );
      const opt_time = await first_modified(
        Object.values(fnMap).map((v) => v.output)
      );
      if (source_time < opt_time && lastModifiedSource < opt_time) {
        return {
          hasTests,
          diagnostics: prevDiagnostics,
          sdkVersion: prevSdkVersion,
        };
      }
    }
  }

  const [, , prettierConfig] = await Promise.all([
    fs.rm(output, { recursive: true, force: true }),
    fs.mkdir(output, { recursive: true }),
    Prettier.resolveConfig(config.workspace!, {
      useCache: false,
      editorconfig: true,
    }),
  ]);
  return optimizeMonkeyC(fnMap, resourcesMap, manifestXML, config).then(
    ({ diagnostics, sdkVersion }) => {
      const options = { ...prettierConfig, ...(config.prettier || {}) };
      return Promise.all(
        mcFiles.map(async (info) => {
          const name = info.output;
          const dir = path.dirname(name);
          await fs.mkdir(dir, { recursive: true });

          options.filepath = name;
          const opt_source = formatAst(info.ast!, info.monkeyCSource, options);
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
              diagnostics,
              sdkVersion,
              optimizerVersion: MONKEYC_OPTIMIZER_VERSION,
              ...Object.fromEntries(
                configOptionsToCheck.map((option) => [option, config[option]])
              ),
            })
          )
          .then(() => ({ hasTests, diagnostics, sdkVersion }));
      });
    }
  );
}

export async function getProjectAnalysis(
  targets: Target[],
  analysis: PreAnalysis | null,
  manifestXML: xmlUtil.Document,
  options: BuildConfig
): Promise<Analysis | PreAnalysis> {
  const qualifiers: Map<
    string,
    { sourcePath: Set<string>; personality: Set<string> }
  > = new Map();

  const addQualifier = (name: string, qualifier: JungleQualifier) => {
    const sp = qualifier.sourcePath;
    const pp = qualifier.personality;
    if (sp || pp) {
      let q = qualifiers.get(name);
      if (!q) {
        q = { sourcePath: new Set(), personality: new Set() };
        qualifiers.set(name, q);
      }
      sp?.forEach((s) => q!.sourcePath!.add(s));
      pp?.forEach((p) => q!.personality!.add(p));
    }
  };

  const products = targets.map(({ qualifier, product }) => {
    addQualifier("", qualifier);
    if (qualifier.barrelMap) {
      Object.entries(qualifier.barrelMap).forEach(([name, bm]) => {
        addQualifier(name, bm.qualifier);
      });
    }
    return product;
  });

  const { fnMap, paths } = await Promise.all(
    Array.from(qualifiers).map(([name, qualifier]) =>
      fileInfoFromConfig(
        options.workspace!,
        options.workspace!,
        {
          sourcePath: Array.from(qualifier.sourcePath),
          personality: Array.from(qualifier.personality),
          products: name === "" ? products : undefined,
        },
        {},
        name
      )
    )
  ).then(
    (results) =>
      results.reduce((cur, result) => {
        if (!cur) return result;
        Object.entries(result.fnMap).forEach(
          ([key, value]) => (cur.fnMap[key] = value)
        );
        cur.paths.push(...result.paths);
        return cur;
      }, null as PreAnalysis | null)!
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

  const resourcesMap: Record<string, JungleResourceMap> = {};
  const addResources = (
    name: string,
    resources: JungleResourceMap | null | undefined
  ) => {
    if (!resources) return;
    if (!hasProperty(resourcesMap, name)) {
      resourcesMap[name] = { ...resources };
    } else {
      Object.assign(resourcesMap[name], resources);
    }
  };
  targets.forEach((target) => {
    addResources("", target.qualifier.resourceMap);
    if (target.qualifier.barrelMap) {
      Object.entries(target.qualifier.barrelMap).forEach(([key, value]) =>
        addResources(key, value.resources)
      );
    }
  });
  const state = await analyze(fnMap, resourcesMap, manifestXML, options);
  reportMissingSymbols(state, options);
  let typeMap: TypeMap | null = null;
  if (
    state.config?.propagateTypes &&
    state.config.trustDeclaredTypes &&
    state.config.checkTypes !== "OFF" &&
    Object.values(state.fnMap).every((ast) => ast != null)
  ) {
    const gistate: InterpState = {
      state,
      stack: [],
      typeChecker:
        state.config.typeCheckLevel?.toLowerCase() === "strict"
          ? subtypeOf
          : couldBeWeak,
      checkTypes: state.config?.checkTypes || "WARNING",
    };

    state.pre = (node) => {
      switch (node.type) {
        case "FunctionDeclaration": {
          const self = state.top().sn as FunctionStateNode;
          const istate = buildTypeInfo(state, self, false);
          if (istate) {
            istate.state = state;
            istate.typeChecker = gistate.typeChecker;
            istate.checkTypes = gistate.checkTypes;
            evaluate(istate, node.body!);
            if (istate.typeMap) {
              if (typeMap == null) {
                typeMap = istate.typeMap;
              } else {
                istate.typeMap.forEach((value, key) =>
                  typeMap!.set(key, value)
                );
              }
            }
          }
          return [];
        }
      }
      return null;
    };
    Object.values(state.fnMap).forEach((f) => {
      collectNamespaces(f.ast!, state);
    });
    delete state.pre;
  }

  return { fnMap: fnMap as Analysis["fnMap"], paths, state, typeMap };
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
        if (decl.length !== 1) return;
        const d = decl[0];
        if (
          d.type === "EnumStringMember" ||
          (d.type === "VariableDeclarator" && d.node.kind === "const")
        ) {
          const init = isStateNode(d) ? d.node.init : d.init;
          if (!init) {
            throw new Error(`Missing init for ${node.fullName}.${key}`);
          }
          tests.push([`${node.fullName}.${key}`, formatAst(init)]);
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
