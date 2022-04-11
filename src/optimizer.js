import * as fs from "fs/promises";
import path from "path";
import { formatAst, getApiMapping } from "./api.js";
import { get_jungle } from "./jungles.js";
import { optimizeMonkeyC } from "./mc-rewrite.js";
import {
  appSupport,
  copyRecursiveAsNeeded,
  first_modified,
  globa,
  last_modified,
} from "./util.js";

export { copyRecursiveAsNeeded };

async function getVSCodeSettings(path) {
  try {
    const settings = await fs.readFile(path);
    return JSON.parse(settings.toString());
  } catch (e) {
    return {};
  }
}

export const defaultConfig = {
  outputPath: "optimized",
  workspace: "./",
};

export async function buildOptimizedProject(options) {
  const config = { ...defaultConfig, ...(options || {}) };
  const workspace = config.workspace;

  // const sdk = await getSdkPath();
  const global_settings = await getVSCodeSettings(
    `${appSupport}/Code/User/settings.json`
  );
  const settings = {
    ...global_settings,
    ...(await getVSCodeSettings(`${workspace}/.vscode/settings.json`)),
  };
  //  const developer_key = config.developerKeyPath || settings["monkeyC.developerKeyPath"];
  const jungle_path = config.jungleFiles || settings["monkeyC.jungleFiles"];

  const { manifest, targets } = await get_jungle(jungle_path, config);
  const buildConfigs = {};
  targets.forEach((p) => (buildConfigs[p.group.key] = p.group.optimizerConfig));

  console.log(JSON.stringify(targets));

  await Promise.all(
    Object.keys(buildConfigs)
      .sort()
      .map((key) => {
        const buildConfig = buildConfigs[key];
        return buildOneConfig({
          ...config,
          buildConfig,
          outputPath: config.outputPath + "/" + key,
        });
      })
  );

  const parts = [`project.manifest=${manifest}`];
  const process_field = (prefix, base, name, map) =>
    base[name] &&
    parts.push(
      `${prefix}${name} = ${base[name]
        .map((s) => (map ? map(s) : s))
        .join(";")}`
    );

  targets.forEach((jungle) => {
    const { product, qualifier } = jungle;
    process_field(`${product}.`, qualifier, "sourcePath", (s) =>
      path.resolve(
        workspace,
        config.outputPath,
        jungle.group.key.toString(),
        path.relative(workspace, s)
      )
    );
    process_field(`${product}.`, qualifier, "resourcePath");
    process_field(`${product}.`, qualifier, "barrelPath");
    process_field(`${product}.`, qualifier, "annotations");
    process_field(`${product}.`, qualifier, "excludeAnnotations");
    if (qualifier.lang) {
      Object.entries(qualifier.lang).forEach(([key, value]) => {
        process_field(`${product}.lang.`, value, key);
      });
    }
  });

  await fs.writeFile(
    path.resolve(workspace, config.outputPath, "monkey.jungle"),
    parts.join("\n")
  );
}

async function buildOneConfig(config) {
  const { workspace, buildConfig } = config;
  const output = `${workspace}/${config.outputPath}`;

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
    .filter((file) => !file.endsWith("/"))
    .map((file) => path.relative(workspace, file));

  const source_time = await last_modified(
    files.map((file) => `${workspace}/${file}`)
  );
  const opt_time = await first_modified(
    files.map((file) => `${output}/${file}`)
  );
  if (source_time < opt_time) return;

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  const baseFileNames = files.filter((src) => /\.mc$/.test(src));
  const fnMap = Object.fromEntries(
    baseFileNames.map((file) => [`${workspace}/${file}`, `${output}/${file}`])
  );
  const optFiles = await optimizeMonkeyC(Object.keys(fnMap));
  return await Promise.all(
    optFiles.map(async (file) => {
      const name = fnMap[file.name];
      const match = /^(.*)\//.exec(name);
      await fs.mkdir(match[1], { recursive: true });

      // Prettier inserts comments by using the source location to
      // find the original comment, rather than using the contents
      // of the comment as reported by the comment nodes themselves.
      // Since we're passing in the ast, rather than the actual
      // source code, this goes horribly wrong. The easiest fix is
      // to just drop all the comments.
      delete file.ast.comments;
      const opt_source = formatAst(file.ast);
      await fs.writeFile(name, opt_source);
      return name;
    })
  );
}

export async function generateApiMirTests(options) {
  const config = { ...defaultConfig, ...(options || {}) };
  const tests = [];
  const state = {
    post(node) {
      if (node.type == "EnumDeclaration") {
        const [parent] = state.stack.slice(-1);
        node.body.members.forEach((e) => {
          const name = e.name || e.id.name;
          const values = parent.decls[name];
          if (values == null || values.length != 1) {
            throw "Can't find value for enum";
          }
          const value = values[0];
          tests.push([`${parent.fullName}.${name}`, formatAst(value)]);
        });
      } else if (node.type == "VariableDeclaration" && node.kind == "const") {
        const [parent] = state.stack.slice(-1);
        node.declarations.forEach((decl) =>
          tests.push([
            `${parent.fullName}.${decl.id.name}`,
            formatAst(decl.init),
          ])
        );
      }
    },
  };
  await getApiMapping(state);

  function hasTests(name) {
    const names = name.split(".");
    return names
      .map((t, i, arr) => arr.slice(0, i).join(".") + " has :" + t)
      .slice(2)
      .join(" && ");
  }
  const source = [
    "import Toybox.Test;",
    "(:test)",
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
