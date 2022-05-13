import * as crypto from "crypto";
import * as fs from "fs/promises";
import path from "path";
import { formatAst, getApiMapping, hasProperty } from "src/api";
import { build_project } from "src/build";
import {
  get_jungle,
  JungleQualifier,
  Target,
  ResolvedBarrel,
  ResolvedJungle,
} from "src/jungles";
import { launchSimulator, simulateProgram } from "src/launch";
import {
  checkManifest,
  writeManifest,
  manifestDropBarrels,
} from "src/manifest";
import { optimizeMonkeyC } from "src/mc-rewrite";
import { appSupport } from "src/sdk-util";
import {
  copyRecursiveAsNeeded,
  first_modified,
  globa,
  last_modified,
} from "src/util";
import { Node as ESTreeNode } from "src/estree-types";

export { copyRecursiveAsNeeded, launchSimulator, simulateProgram };

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

  type ExcludeAnnotationsMap = { [key: string]: boolean };
  type FilesToOptimizeMap = {
    [key: string]: {
      output: string;
      excludeAnnotations: ExcludeAnnotationsMap;
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
  product: string,
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
    product = config.products[0];
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
        !target.group.optimizerConfig.barrelMap ||
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
    options.workspace,
    options.outputPath,
    "opt-barrels"
  );
  return targets.reduce((promise, target) => {
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

/**
 *
 * @param {BuildConfig} options
 * @returns
 */
export async function generateOptimizedProject(options: BuildConfig) {
  const config = await getConfig(options);
  const workspace = config.workspace;

  const { manifest, targets, xml, jungles } = await get_jungle(
    config.jungleFiles,
    config
  );

  const dependencyFiles = [manifest, ...jungles];
  await createLocalBarrels(targets, options);

  const buildConfigs: Record<string, JungleQualifier | null> = {};
  const products: Record<string, string[]> = {};
  let pick_one = config.products ? config.products.indexOf("pick-one") : -1;
  if (config.skipOptimization) {
    if (pick_one >= 0) {
      options.products = [...options.products];
      options.products[pick_one] = targets[0].product;
    }
    return {
      jungleFiles: config.jungleFiles,
      program: path.basename(path.dirname(manifest)),
    };
  }
  let dropBarrels = false;
  const configKey = (p: Target) =>
    p.group.key + (config.releaseBuild ? "-release" : "-debug");
  targets.forEach((p) => {
    const key = configKey(p);
    if (!hasProperty(buildConfigs, key)) {
      p.group.dir = key;
      if (
        p.group.optimizerConfig.barrelMap &&
        !p.group.optimizerConfig.optBarrels
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
        options.products = [...options.products];
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

  const jungle_dir = path.resolve(workspace, config.outputPath);
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
      const outputPath = path.join(config.outputPath, key);

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
    mapper: (s: string) => string = null
  ) => {
    if (!base[name]) return;
    const map_one = (s: string) => (mapper ? mapper(s) : s);
    const map = (s: string | string[]) =>
      Array.isArray(s) ? `[${s.map(map_one).join(";")}]` : map_one(s);
    parts.push(`${prefix}${name} = ${base[name].map(map).join(";")}`);
  };
  targets.forEach((jungle) => {
    if (!buildConfigs[configKey(jungle)]) return;
    const { product, qualifier, group } = jungle;
    const prefix = `${product}.`;
    process_field(prefix, qualifier, "sourcePath", (s) =>
      path
        .join(
          group.dir,
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
                    .join(group.dir, "barrels", barrel, path.relative(root, s))
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
    if (qualifier.lang) {
      Object.keys(qualifier.lang).forEach((key) => {
        process_field(`${prefix}lang.`, qualifier.lang, key, relative_path);
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
    program: path.basename(path.dirname(manifest)),
    hasTests,
  };
}

async function fileInfoFromConfig(
  workspace: string,
  output: string,
  buildConfig: JungleQualifier,
  extraExcludes: ExcludeAnnotationsMap
): Promise<FilesToOptimizeMap> {
  const paths = (
    await Promise.all(
      buildConfig.sourcePath.map((pattern) =>
        globa(pattern, { cwd: workspace, mark: true })
      )
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

  return Object.fromEntries(
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
  );
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
];

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
  const output = path.join(workspace, config.outputPath);

  const buildModeExcludes = {
    // note: exclude debug in release builds, and release in debug builds
    [config.releaseBuild ? "debug" : "release"]: true,
  };
  if (!config.testBuild) {
    buildModeExcludes.test = true;
  }

  const fnMap = await fileInfoFromConfig(
    workspace,
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
          );
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
  const optFiles = await optimizeMonkeyC(fnMap);
  return Promise.all(
    optFiles.map(async (file) => {
      const name = fnMap[file.name].output;
      const dir = path.dirname(name);
      await fs.mkdir(dir, { recursive: true });

      const opt_source = formatAst(file.ast);
      await fs.writeFile(name, opt_source);
      return file.hasTests;
    })
  ).then((results) => {
    const hasTests = results.some((v) => v);
    fs.writeFile(
      path.join(output, "build-info.json"),
      JSON.stringify({
        hasTests,
        ...Object.fromEntries(
          configOptionsToCheck.map((option) => [option, config[option]])
        ),
      })
    );
    return hasTests;
  });
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
  const findConstants = (node: StateNode) => {
    Object.entries(node.decls).forEach(([key, decl]) => {
      if (decl.length > 1) throw `Bad decl length:${node.fullName}.${key}`;
      if (decl.length != 1) return;
      const d = decl[0];
      if (typeof d === "string") return;
      if (d.type == "Literal") {
        tests.push([`${node.fullName}.${key}`, formatAst(d)]);
      } else if (d.decls) {
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