import * as path from "path";
import {
  buildOptimizedProject,
  generateOptimizedProject,
  launchSimulator,
  simulateProgram,
} from "../build/optimizer.cjs";
import { getSdkPath } from "../build/sdk-util.cjs";
import { globa, spawnByLine } from "../build/util.cjs";
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
  let checkInvalidSymbols = "ERROR";

  const sdk = await getSdkPath();
  const isBeta = sdk.match(/Compiler2Beta/);

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
      case "garminOptLevel":
        if (!isBeta) {
          error("garminOptLevel requires the Compiler2Beta sdk");
        }
        if (value == null) return key;
        extraMonkeycArgs.push(`-O${value}`);
        break;
      case "checkInvalidSymbols":
        if (value == null) return key;
        checkInvalidSymbols = value;
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
  if (testBuild) {
    execute = true;
  } else if (products) {
    products.splice(1);
  }
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
  const runOne = (promise, products, jungleFiles) => {
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
      checkInvalidSymbols,
      ...jungleOptions,
      returnCommand: true,
      checkManifest: true,
      checkBuildPragmas: testBuild == true,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k]
    );
    return promise
      .then(() =>
        genOnly
          ? generateOptimizedProject(options).then(() => null)
          : buildOptimizedProject(products ? products[0] : null, options).then(
              ({ exe, args, program, product, hasTests, diagnostics }) => {
                let hasErrors = false;
                diagnostics &&
                  Object.keys(diagnostics)
                    .sort()
                    .forEach((file) => {
                      const diags = diagnostics[file];
                      diags.forEach((diag) => {
                        if (diag.type === "ERROR") {
                          hasErrors = true;
                        }
                        console.log(
                          `${diag.type}: ${diag.message} at ${file}:${diag.loc.start.line}`
                        );
                      });
                    });
                if (
                  hasErrors &&
                  !extraMonkeycArgs.includes("--Eno-invalid-symbol")
                ) {
                  throw new Error("'ERROR' level diagnostics were reported");
                }
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
      .then((res) => {
        if (
          res &&
          (testBuild ? res.hasTests : execute) &&
          res.program &&
          res.product
        ) {
          console.log(
            `${testBuild && res.hasTests ? "Running tests" : "Executing"} ${
              res.program
            } on ${res.product}`
          );
          let pass = res.hasTests && testBuild ? undefined : true;
          let resultsSeen = false;
          let expectedErrors = 0;
          let expectedFailures = 0;
          const handler = (line) => {
            if (resultsSeen) {
              const match = line.match(/^((\w|\.)+)\s+(PASS|FAIL|ERROR)\s*$/);
              if (match) {
                if (match[1].match(/crash/i)) {
                  if (match[3] === "ERROR") {
                    line = line.replace(/ERROR\s*$/, "EXPECTED ERROR");
                    expectedErrors++;
                  } else if (match[3] === "PASS") {
                    pass = false;
                  }
                } else if (isBeta && match[1].match(/FailsBeta/i)) {
                  if (match[3] === "FAIL") {
                    line = line.replace(/FAIL\s*$/, "EXPECTED FAIL");
                    expectedFailures++;
                  } else if (match[3] === "PASS" && skipOptimization) {
                    // some tests that would fail on Beta are fixed by
                    // our optimizer, so only mark them as failures if
                    // they pass without our optimizer
                    line = line.replace(/ERROR\s*$/, "UNEXPECTED PASS");
                    pass = false;
                  }
                }
              }
            } else if (line.match(/^RESULTS\s*$/)) {
              resultsSeen = true;
            }
            const match = line.match(
              /^(PASSED|FAILED)\s*\(passed=(\d+),\s+failed=(\d+),\s+errors=(\d+)\)/
            );
            if (match && pass !== false) {
              if (match[1] === "PASSED") {
                pass = true;
              } else if (
                parseInt(match[3], 10) === expectedFailures &&
                parseInt(match[4], 10) === expectedErrors
              ) {
                pass = true;
                line = `PASSED (passed=${match[2]}, expected failed=${expectedFailures}, expected errors=${expectedErrors})`;
              } else {
                pass = false;
              }
            }
            console.log(line);
          };
          return simulateProgram(res.program, res.product, pass === undefined, [
            handler,
            handler,
          ]).then(() => {
            if (!pass) {
              const e = new Error(
                pass === false
                  ? "Tests failed!"
                  : "Tests didn't report their status!"
              );
              e.products = [res.product];
              throw e;
            }
          });
        }
      })
      .then(() =>
        console.log(`Done: ${new Date().toLocaleString()} - ${jungleFiles}`)
      )
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
  };
  await jungles.reduce(
    (promise, jungleFiles) => {
      if (testBuild) {
        return products.reduce(
          (promise, product) => runOne(promise, [product], jungleFiles),
          promise
        );
      }
      return runOne(promise, products, jungleFiles);
    },

    Promise.resolve()
  );
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
    error("Failed: " + e.toString());
  });

function error(message) {
  console.error(message);
  process.exit(1);
}
