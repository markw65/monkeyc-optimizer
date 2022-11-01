import * as path from "path";
import {
  buildOptimizedProject,
  generateOptimizedProject,
  launchSimulator,
  mctree,
  simulateProgram,
} from "./optimizer";
import { getSdkPath, readPrg, SectionKinds } from "./sdk-util";
import { globa, spawnByLine } from "./util";
import { BuildConfig, DiagnosticType } from "./optimizer-types";
import { fetchGitProjects, githubProjects, RemoteProject } from "./projects";

type JungleInfo = {
  jungle: string;
  build: boolean | null;
  options: BuildConfig | null;
};

function cleanPath(workspace: string | null | undefined, file: string) {
  if (!workspace) return file;
  const rel = path.relative(workspace, file);
  if (rel.startsWith("..")) return file;
  return rel;
}

export async function driver() {
  const jungles: (string | JungleInfo)[] = [];
  let products: string[] | undefined;
  let developerKeyPath: string | undefined;
  let outputPath: string | undefined;
  let releaseBuild: boolean | undefined;
  let compilerWarnings: boolean | undefined;
  let typeCheckLevel = "Off";
  let promise = Promise.resolve();
  let remoteProjects: RemoteProject[] | undefined;
  let generateOnly: boolean | undefined;
  let jungleOnly;
  let skipOptimization: boolean | undefined;
  const extraMonkeycArgs: string[] = [];
  let execute = false;
  let testBuild = false;
  let checkInvalidSymbols: DiagnosticType | "OFF" = "ERROR";
  let sizeBasedPRE: string | boolean = true;
  let checkBuildPragmas: boolean | undefined;
  let showInfo = false;

  const sdk = await getSdkPath();
  const supportsCompiler2 =
    /* sdk 5 or later, or */
    sdk.match(/-(\d\d+|[5-9])\.\d+\.\d+/) ||
    /* sdk 4.2.x or later, or */
    sdk.match(/-4\.([2-9]|\d\d+)\.\d+/) ||
    /* one of the 4.1.x compiler2-beta releases */
    sdk.match(/Compiler2Beta/i);

  const prev = process.argv.slice(2).reduce<string | null>((key, value) => {
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
        if (!supportsCompiler2) {
          error("garminOptLevel requires a more recent sdk");
        }
        if (value == null) return key;
        extraMonkeycArgs.push(`-O${value}`);
        break;
      case "checkInvalidSymbols":
        if (value == null) return key.toUpperCase();
        switch (value) {
          case "ERROR":
          case "WARNING":
          case "INFO":
          case "OFF":
            checkInvalidSymbols = value;
            break;
          default:
            error(`Invalid option for checkInvalidSymbols: ${value}`);
        }
        break;
      case "sizeBasedPRE":
        if (value == null) return key;
        sizeBasedPRE = /^true|1$/i.test(value)
          ? true
          : /^false|0$/i.test(value)
          ? false
          : value;
        break;
      case "ignoreInvalidSymbols":
        if (!value || /^true|1$/i.test(value)) {
          extraMonkeycArgs.push("--Eno-invalid-symbol");
        }
        break;
      case "checkBuildPragmas":
        checkBuildPragmas = !value || /^true|1$/i.test(value);
        break;
      case "product":
        if (value == null) return key;
        if (!products) products = [];
        products.push(...value.split(";"));
        break;
      case "github":
        if (value) {
          const re = new RegExp(value.replace(/-/g, "."), "i");
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
      case "showInfo":
        showInfo = !value || /^true|1$/i.test(value);
        break;

      default:
        error(`Unknown argument: ${match ? match[0] : value}`);
    }
    return null;
  }, null);
  if (prev) error(`Missing arg for '${prev}'`);
  if (remoteProjects) {
    const rp = remoteProjects;
    promise = promise
      .then(() => fetchGitProjects(rp))
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
  }
  if (checkBuildPragmas === undefined && testBuild !== false) {
    checkBuildPragmas = true;
  }
  if (jungleOnly) {
    products = [];
    generateOnly = true;
  }
  const usesCompiler2 = (() => {
    if (!supportsCompiler2) return false;
    const opt = extraMonkeycArgs.reverse().find((arg) => arg.startsWith("-O"));
    return !opt || opt != "-O0";
  })();
  const failures: [string, unknown][] = [];
  const runOne = (
    promise: Promise<unknown>,
    products: string[],
    jungleInfo: JungleInfo
  ) => {
    const genOnly = jungleInfo.build === false || generateOnly;
    const jungleOptions = jungleInfo.options || {};
    const jungleFiles = jungleInfo.jungle;
    const workspace = path.dirname(jungleFiles.split(";")[0]);
    const options: BuildConfig = {
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
      sizeBasedPRE,
      ...jungleOptions,
      returnCommand: true,
      checkManifest: true,
      checkBuildPragmas,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k as keyof typeof options]
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
        if (showInfo && res && res.program) {
          return readPrg(res.program).then((info) => {
            console.log(
              `${path.basename(res.program)} sizes: text: ${
                info[SectionKinds.TEXT]
              } data: ${info[SectionKinds.DATA]}`
            );
            return res;
          });
        }
        return res;
      })
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
          const handler = (line: string) => {
            if (resultsSeen) {
              const match = line.match(/^((\w|\.)+)\s+(PASS|FAIL|ERROR)\s*$/);
              if (match) {
                if (match[1].match(/crash/i)) {
                  if (match[3] === "ERROR") {
                    line = line.replace(/ERROR\s*$/, "EXPECTED ERROR");
                    expectedErrors++;
                  }
                } else if (usesCompiler2 && match[1].match(/FailsBeta/i)) {
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
          return launchSimulator(pass !== undefined).then(() =>
            simulateProgram(res.program, res.product!, pass === undefined, [
              handler,
              handler,
            ])
              .catch(() => null)
              .then(() => {
                if (!pass) {
                  const e: Error & { products?: string[] } = new Error(
                    pass === false
                      ? "Tests failed!"
                      : "Tests didn't report their status!"
                  );
                  if (res.product) {
                    e.products = [res.product];
                  }
                  throw e;
                }
              })
          );
        }
        return null;
      })
      .then(() =>
        console.log(`Done: ${new Date().toLocaleString()} - ${jungleFiles}`)
      )
      .catch((ex: unknown) => {
        if (ex instanceof Error) {
          const e = ex as Error & {
            products?: string[];
            location?: NonNullable<mctree.Node["loc"]>;
          };
          const products =
            "products" in e && e.products && e.products.join(",");
          console.error(
            `While building '${jungleFiles}${
              products ? ` for ${products}` : ""
            }`
          );
          if (e.name && e.message && e.location) {
            const source = e.location.source
              ? cleanPath(options.workspace, e.location.source)
              : "<unknown>";
            ex = `${e.name}: ${source}:${e.location.start.line},${e.location.start.column}: ${e.message}`;
            console.error(`ERROR: ${ex}`);
          } else {
            ex = e.toString();
            console.error(e);
          }
        }
        failures.push([jungleFiles, ex]);
      });
  };
  await jungles.reduce(
    (promise, jungleFiles) => {
      const jf =
        typeof jungleFiles === "string"
          ? { jungle: jungleFiles, build: null, options: null }
          : jungleFiles;

      if (testBuild) {
        return products!.reduce(
          (promise, product) => runOne(promise, [product], jf),
          promise
        );
      }
      return runOne(promise, products!, jf);
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

export function error(message: string): never {
  console.error(message);
  process.exit(1);
}
