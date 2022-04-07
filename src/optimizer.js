import * as fs from "fs/promises";
import * as glob from "glob";
import { formatAst, getApiMapping } from "./api.js";
import { optimizeMonkeyC } from "./mc-rewrite.js";
import {
  copyRecursiveAsNeeded,
  first_modified,
  last_modified,
} from "./util.js";

function globa(pattern, options) {
  return new Promise((resolve, reject) => {
    glob.glob(pattern, options, (er, files) => {
      if (er) {
        reject(files);
      } else {
        resolve(files);
      }
    });
  });
}

export { copyRecursiveAsNeeded };

export const defaultConfig = {
  pathsToClone:
    "source;source-*;resources;resources-*;monkey.jungle;manifest.xml",
  outputPath: "optimized",
  workspace: "./",
};

export async function buildOptimizedProject(options) {
  const config = { ...defaultConfig, ...(options || {}) };
  const pathPatterns = config.pathsToClone.split(";");
  const workspace = config.workspace;
  const output = `${workspace}/${config.outputPath}`;

  const paths = (
    await Promise.all(
      pathPatterns.map((pattern) =>
        globa(pattern, { cwd: workspace, mark: true })
      )
    )
  ).flat();

  const files = (
    await Promise.all(
      paths.map((path) =>
        path.endsWith("/")
          ? globa(`${path}**/*`, { cwd: workspace, mark: true })
          : path
      )
    )
  )
    .flat()
    .filter((file) => !file.endsWith("/"));

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
  const [optFiles] = await Promise.all([
    optimizeMonkeyC(Object.keys(fnMap)),
    Promise.all(
      paths.map((path) => {
        copyRecursiveAsNeeded(
          `${workspace}/${path}`,
          `${output}/${path}`,
          (src) => !/\.mc$/.test(src)
        );
      })
    ),
  ]);

  return await Promise.all(
    optFiles.map(async (file) => {
      const name = fnMap[file.name];
      // const match = /^(.*)\//.exec(name);
      // await fs.mkdir(match[1], { recursive: true });

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
