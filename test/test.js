import * as path from "path";
import {
  buildOptimizedProject,
  generateOptimizedProject,
} from "../build/optimizer.cjs";
import { globa } from "../build/util.cjs";
import { launchSimulator, simulateProgram } from "../src/launch.js";
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
  let execute = false;
  let testBuild = false;

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
          .then((files) => {
            jungles.push(...files);
          });
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
            re.test(typeof project === "string" ? project : project.root)
          );
        } else {
          remoteProjects = githubProjects;
        }
        break;
      case "execute":
        execute = !value || /^true|1$/i.test(value);
        break;
      case "run-tests":
        testBuild = !value || /^true|1$/i.test(value);
        break;
      default:
        error(`Unknown argument: ${match ? match[0] : value}`);
    }
  }, null);
  if (prev) error(`Missing arg for '${prev}'`);
  if (remoteProjects) {
    promise = promise
      .then(() => fetchGitProjects(remoteProjects))
      .then((j) => {
        jungles.push(...j);
      });
  }
  await promise;
  if (!jungles.length) throw new Error("No inputs!");
  if (testBuild) execute = true;
  if (execute) {
    if (jungleOnly || generateOnly) {
      error(
        `--execute is not compatible with ${
          jungleOnly ? "--jungle-only" : "--generate-only"
        }`
      );
    }
    if (!products) {
      error("--execute requires a product to execute on");
    }
    await launchSimulator();
  }
  if (jungleOnly) {
    products = [];
    generateOnly = true;
  }
  const failures = [];
  await jungles.reduce((promise, jungleFiles) => {
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
      testBuild,
      compilerWarnings,
      typeCheckLevel,
      skipOptimization,
      ...jungleOptions,
      returnCommand: true,
      checkManifest: true,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k]
    );
    return promise
      .then(() =>
        genOnly
          ? generateOptimizedProject(options).then(() => null)
          : buildOptimizedProject(products ? products[0] : null, options).then(
              ({ exe, args, program, product, hasTests }) => {
                args.push(...extraMonkeycArgs);
                console.log(
                  [exe, ...args].map((a) => JSON.stringify(a)).join(" ")
                );
                return spawnByLine(exe, args, console.log, {
                  cwd: workspace,
                }).then(() => ({
                  program,
                  product,
                  hasTests,
                }));
              }
            )
      )
      .then(
        (res) =>
          (testBuild ? res.hasTests : execute) &&
          res &&
          res.program &&
          res.product &&
          (console.log(
            `${testBuild && res.hasTests ? "Running tests" : "Executing"} ${
              res.program
            } on ${res.product}`
          ),
          simulateProgram(
            res.program,
            res.product,
            res.hasTests && testBuild
          ).catch(() => console.error("Simulation failed")))
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
  }, Promise.resolve());
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
