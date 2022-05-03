import * as fs from "fs/promises";
import path from "path";
import { formatAst, getApiMapping, hasProperty } from "./api.js";
import { build_project } from "./build.js";
import { get_jungle } from "./jungles.js";
import { launchSimulator } from "./launch.js";
import { checkManifest, writeManifest } from "./manifest.js";
import { optimizeMonkeyC } from "./mc-rewrite.js";
import { appSupport } from "./sdk-util.js";
import {
  copyRecursiveAsNeeded,
  first_modified,
  globa,
  last_modified,
} from "./util.js";

export { copyRecursiveAsNeeded, launchSimulator };

function relative_path_no_dotdot(relative) {
  return relative.replace(
    /^(\.\.[\\\/])+/,
    (str) => `__${"dot".repeat(str.length / 3)}__${str.slice(-1)}`
  );
}

async function getVSCodeSettings(path) {
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

async function getConfig(options) {
  const config = { ...defaultConfig, ...(options || {}) };
  let promise;
  [
    "jungleFiles",
    "developerKeyPath",
    "typeCheckLevel",
    "compilerOptions",
    "compilerWarnings",
  ].forEach((key) => {
    if (config[key]) return;
    if (!promise) {
      promise = Promise.resolve()
        .then(() => getVSCodeSettings(`${appSupport}/Code/User/settings.json`))
        .then((globals) =>
          getVSCodeSettings(`${config.workspace}/.vscode/settings.json`).then(
            (locals) => ({ ...globals, ...locals })
          )
        );
    }
    promise.then((settings) => {
      const value = settings[`monkeyC.${key}`];
      if (value) {
        config[key] = value;
      }
    });
  });
  promise && (await promise);
  return config;
}

export async function buildOptimizedProject(product, options) {
  const config = await getConfig(options);
  if (product) {
    config.products = [product];
  } else if (!hasProperty(config, "releaseBuild")) {
    config.releaseBuild = true;
  }
  const { jungleFiles, program } = await generateOptimizedProject(config);
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
  return build_project(product, config);
}

export async function generateOptimizedProject(options) {
  const config = await getConfig(options);
  const workspace = config.workspace;

  const jungleFiles = config.jungleFiles.split(";");
  if (!jungleFiles.includes("barrels.jungle")) {
    const barrels = path.resolve(workspace, "barrels.jungle");
    if (
      await fs
        .stat(barrels)
        .then((s) => s.isFile())
        .catch(() => false)
    ) {
      jungleFiles.push(barrels);
    }
  }
  const { manifest, targets, xml } = await get_jungle(
    jungleFiles.join(";"),
    config
  );
  const buildConfigs = {};
  const products = {};
  let pick_one = config.products ? config.products.indexOf("pick-one") : -1;
  if (config.skipOptimization) {
    if (pick_one >= 0) {
      options.products = [...options.products];
      options.products[pick_one] = targets[0].product;
    }
    return {
      jungleFiles: jungleFiles.join(";"),
      program: path.basename(path.dirname(manifest)),
    };
  }
  const configKey = (p) =>
    p.group.key + (config.releaseBuild ? "-release" : "-debug");
  targets.forEach((p) => {
    const key = configKey(p);
    if (!hasProperty(buildConfigs, key)) {
      p.group.dir = key;
      buildConfigs[key] = null;
      if (p.group.optimizerConfig["excludeAnnotations"] == null) {
        p.group.optimizerConfig["excludeAnnotations"] = [];
      }
      // Note that we exclude (:debug) in release builds, and we
      // exclude (:release) in debug builds. This isn't backwards!
      p.group.optimizerConfig["excludeAnnotations"].push(
        config.releaseBuild ? "debug" : "release"
      );
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
  const relative_path = (s) => path.relative(jungle_dir, s);
  let relative_manifest = relative_path(manifest);
  const manifestOk =
    !config.checkManifest ||
    (await checkManifest(
      xml,
      targets.map((t) => t.product)
    ));
  const promises = Object.keys(buildConfigs)
    .sort()
    .map((key) => {
      const buildConfig = buildConfigs[key];
      const outputPath = path.join(config.outputPath, key);

      return buildConfig
        ? generateOneConfig({
            ...config,
            buildConfig,
            outputPath,
          }).catch((e) => {
            if (!e.stack) {
              e = new Error(e.toString());
            }
            e.products = products[key];
            throw e;
          })
        : fs.rm(path.resolve(workspace, outputPath), {
            recursive: true,
            force: true,
          });
    });

  if (!manifestOk) {
    const manifestFile = path.join(jungle_dir, "manifest.xml");
    promises.push(writeManifest(manifestFile, xml));
    relative_manifest = "manifest.xml";
  }

  const parts = [`project.manifest=${relative_manifest}`];
  const process_field = (prefix, base, name, mapper) => {
    if (!base[name]) return;
    const map_one = (s) => (mapper ? mapper(s) : s);
    const map = (s) =>
      Array.isArray(s) ? `[${s.map(map_one).join(";")}]` : map_one(s);
    parts.push(`${prefix}${name} = ${base[name].map(map).join(";")}`);
  };
  targets.forEach((jungle) => {
    if (!buildConfigs[configKey(jungle)]) return;
    const { product, qualifier, group } = jungle;
    const prefix = `${product}.`;
    process_field(prefix, qualifier, "sourcePath", (s) =>
      path
        .join(group.dir, relative_path_no_dotdot(path.relative(workspace, s)))
        .replace(/([\\\/]\*\*)[\\\/]\*/g, "$1")
    );
    process_field(prefix, qualifier, "resourcePath", relative_path);
    process_field(prefix, qualifier, "barrelPath", relative_path);
    process_field(prefix, qualifier, "annotations");
    process_field(prefix, qualifier, "excludeAnnotations");
    if (qualifier.lang) {
      Object.keys(qualifier.lang).forEach((key) => {
        process_field(`${prefix}lang.`, qualifier.lang, key, relative_path);
      });
    }
  });

  const outputJungle = path.join(
    jungle_dir,
    `${config.releaseBuild ? "release" : "debug"}.jungle`
  );
  promises.push(fs.writeFile(outputJungle, parts.join("\n")));

  await Promise.all(promises);
  return {
    jungleFiles: outputJungle,
    program: path.basename(path.dirname(manifest)),
  };
}

async function generateOneConfig(config) {
  const { workspace, buildConfig } = config;
  const output = path.join(workspace, config.outputPath);

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
        !file.endsWith("/") &&
        (!buildConfig.sourceExcludes ||
          !buildConfig.sourceExcludes.includes(file))
    )
    .map((file) => path.relative(workspace, file))
    .filter((file) => !file.startsWith("bin"));

  const fnMap = Object.fromEntries(
    files
      .filter((src) => /\.mc$/.test(src))
      .map((file) => [
        path.join(workspace, file),
        path.join(output, relative_path_no_dotdot(file)),
      ])
  );

  const actualOptimizedFiles = (
    await globa(path.join(output, "**", "*.mc"), { mark: true })
  )
    .filter((file) => !file.endsWith("/"))
    .sort();

  // check that the set of files thats actually there is the same as the
  // set of files we're going to generate (in case eg a jungle file change
  // might have altered it)
  if (
    actualOptimizedFiles.length == files.length &&
    Object.values(fnMap)
      .sort()
      .every((f, i) => f == actualOptimizedFiles[i])
  ) {
    // now if the newest source file is older than
    // the oldest optimized file, we don't need to regenerate
    const source_time = await last_modified(Object.keys(fnMap));
    const opt_time = await first_modified(Object.values(fnMap));
    if (source_time < opt_time && global.lastModifiedSource < opt_time) return;
  }

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const optFiles = await optimizeMonkeyC(Object.keys(fnMap), buildConfig);
  return await Promise.all(
    optFiles.map(async (file) => {
      const name = fnMap[file.name];
      const dir = path.dirname(name);
      await fs.mkdir(dir, { recursive: true });

      const opt_source = formatAst(file.ast);
      await fs.writeFile(name, opt_source);
      return name;
    })
  );
}

export async function generateApiMirTests(options) {
  const config = { ...defaultConfig, ...(options || {}) };
  const tests = [];
  const api = await getApiMapping();
  const findConstants = (node) => {
    Object.entries(node.decls).forEach(([key, decl]) => {
      if (decl.length > 1) throw `Bad decl length:${node.fullName}.${key}`;
      if (decl.length != 1) return;
      if (decl[0].type == "Literal") {
        tests.push([`${node.fullName}.${key}`, formatAst(decl[0])]);
      } else if (decl[0].decls) {
        findConstants(decl[0]);
      }
    });
  };
  findConstants(api);
  function hasTests(name) {
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
