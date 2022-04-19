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
              re.test(project)
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
  const failures = [];
  promise = Promise.resolve();
  jungles.forEach((jungleFiles) => {
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
        generateOnly
          ? generateOptimizedProject(options)
          : buildOptimizedProject(products ? products[0] : null, options)
      )
      .then(() => console.log(`Done: ${jungleFiles}`))
      .catch((e) => {
        console.error("Error: ", e, jungleFiles);
        if (e.stack) console.error(e.stack);
        failures.push([jungleFiles, e]);
      });
  });
  await promise;
}

test()
  .then(() => console.log("Success"))
  .catch((e) => {
    console.log("Failed: " + e.toString());
    if (e.stack) console.log(e.stack);
  });

function error(message) {
  console.error(message);
  process.exit(1);
}
