import * as path from "path";
import {
  buildOptimizedProject,
  generateOptimizedProject,
} from "../build/optimizer.cjs";
import { globa } from "../build/util.cjs";
import { spawnByLine } from "../src/util.js";
import { fetchGitProjects, githubProjects } from "./projects.js";

async function test() {
  const jungles = [];
  let products;
  let developerKeyPath;
  let outputPath;
  let releaseBuild;
  let compilerWarnings;
  let typeCheckLevel = "Off";
  let promise = Promise.resolve();
  let remoteProjects;
  let generateOnly;
  let jungleOnly;
  let skipOptimization;
  let extraMonkeycArgs = [];

  const prev = process.argv.slice(2).reduce((key, value) => {
    const match = /^--((?:\w|-)+)(?:=(.*))?$/.exec(value);
    if (!key) {
      if (!match) {
        error(`Expected an argument but got: ${value}`);
      }
      key = match[1];
      value = match[2];
    } else if (match) {
      error(`Missing arg for '${key}'`);
    }
    switch (key) {
      case "output-path":
        if (value == null) return key;
        outputPath = value;
        break;
      case "dev-key":
        if (value == null) return key;
        developerKeyPath = value;
        break;
      case "jungle":
        if (value == null) return key;
        promise = promise
          .then(() => (value.includes(";") ? [value] : globa(value)))
          .then((files) => jungles.push(...files));
        break;
      case "release":
        releaseBuild = !value || /^true|1$/i.test(value);
        break;
      case "warnings":
        compilerWarnings = !value || /^true|1$/i.test(value);
        break;
      case "generate-only":
        generateOnly = !value || /^true|1$/i.test(value);
        break;
      case "jungle-only":
        jungleOnly = !value || /^true|1$/i.test(value);
        break;
      case "typeCheckLevel":
        if (value == null) return key;
        typeCheckLevel = value;
        break;
      case "skipOptimization":
        skipOptimization = !value || /^true|1$/i.test(value);
        break;
      case "ignoreInvalidSymbols":
        if (!value || /^true|1$/i.test(value)) {
          extraMonkeycArgs.push("--Eno-invalid-symbol");
        }
        break;
      case "product":
        if (value == null) return key;
        if (!products) products = [];
        products.push(...value.split(";"));
        break;
      case "github":
        if (value) {
          const re = new RegExp(value, "i");
          remoteProjects = githubProjects.filter((project) =>
            re.test(project.root || project)
          );
        } else {
          remoteProjects = githubProjects;
        }
        break;
      default:
        error(`Unknown argument: ${match ? match[0] : value}`);
    }
  }, null);
  if (prev) error(`Missing arg for '${prev}'`);
  if (remoteProjects) {
    promise = promise
      .then(() => fetchGitProjects(remoteProjects))
      .then((j) => jungles.push(...j));
  }
  await promise;
  if (!jungles.length) throw new Error("No inputs!");
  if (jungleOnly) {
    products = [];
    generateOnly = true;
  }
  const failures = [];
  promise = Promise.resolve();
  jungles.forEach((jungleFiles) => {
    const genOnly = jungleFiles.build === false || generateOnly;
    const jungleOptions = jungleFiles.options || {};
    if (jungleFiles.jungle) {
      jungleFiles = jungleFiles.jungle;
    }
    const workspace = path.dirname(jungleFiles.split(";")[0]);
    const options = {
      jungleFiles,
      workspace,
      developerKeyPath,
      outputPath,
      products,
      releaseBuild,
      compilerWarnings,
      typeCheckLevel,
      skipOptimization,
      returnCommand: true,
      ...jungleOptions,
      checkManifest: true,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k]
    );
    promise = promise
      .then(() =>
        genOnly
          ? generateOptimizedProject(options)
          : buildOptimizedProject(products ? products[0] : null, options).then(
              ({ exe, args }) => {
                args.push(...extraMonkeycArgs);
                console.log(
                  [exe, ...args].map((a) => JSON.stringify(a)).join(" ")
                );
                return spawnByLine(exe, args, console.log, { cwd: workspace });
              }
            )
      )
      .then(() => console.log(`Done: ${jungleFiles}`))
      .catch((e) => {
        const products = e && e.products && e.products.join(",");
        console.error(
          `While building '${jungleFiles}${products ? ` for ${products}` : ""}`
        );
        if (e.name && e.message && e.location) {
          const source = e.location.source
            ? options.workspace
              ? path.relative(options.workspace, e.location.source)
              : e.location.source
            : "<unknown>";
          console.error(
            `ERROR: ${e.name}: ${source}:${e.location.start.line},${e.location.start.column}: ${e.message}`
          );
        } else {
          console.error("Error: ", e);
        }
        failures.push([jungleFiles, e]);
      });
  });
  await promise;
  if (failures.length) {
    throw new Error(
      failures
        .map(([f, e]) => `Failed to build '${f}' with error ${e}`)
        .join("\n\n")
    );
  }
}

test()
  .then(() => console.log("Success"))
  .catch((e) => {
    console.log("Failed: " + e.toString());
  });

function error(message) {
  console.error(message);
  process.exit(1);
}
