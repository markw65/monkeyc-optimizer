import {
  buildOptimizedProject,
  generateOptimizedProject,
} from "../build/optimizer.cjs";
import * as path from "path";
import { globa } from "../build/util.cjs";
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

  const prev = process.argv.slice(2).reduce((prev, arg) => {
    const match = /^--((?:\w|-)+)(?:=(.*))?$/.exec(arg);
    if (match && prev) {
      error(`Missing arg for '${prev}'`);
    }
    if (prev || match) {
      const key = prev || match[1];
      const value = prev ? arg : match[2];
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
      }
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
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k]
    );
    promise = promise
      .then(() =>
        genOnly
          ? generateOptimizedProject(options)
          : buildOptimizedProject(products ? products[0] : null, options)
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
