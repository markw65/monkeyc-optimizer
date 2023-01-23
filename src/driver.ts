import * as os from "node:os";
import * as path from "path";
import { checkCompilerVersion, parseSdkVersion } from "./api";
import {
  defaultConfig,
  getProjectAnalysis,
  get_jungle,
  launchSimulator,
  mctree,
  simulateProgram,
} from "./optimizer";
import { BuildConfig, DiagnosticType, ProgramState } from "./optimizer-types";
import { fetchGitProjects, githubProjects, RemoteProject } from "./projects";
import { getSdkPath, readPrg, SectionKinds } from "./sdk-util";
import { forEach, globa, promiseAll, spawnByLine } from "./util";
import { runTaskInPool, startPool, stopPool } from "./worker-pool";

type JungleInfo = {
  jungle: string;
  build: boolean | null;
  options: BuildConfig | null;
  garminOptLevel: number | null;
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
  let jungleOnly: boolean | undefined;
  let analyzeOnly: boolean | undefined;
  let skipOptimization: boolean | undefined;
  const extraMonkeycArgs: string[] = [];
  let execute = false;
  let testBuild: string | boolean = false;
  let checkInvalidSymbols: DiagnosticType | "OFF" = "ERROR";
  let checkCompilerLookupRules: DiagnosticType | "OFF" = "ERROR";
  let sizeBasedPRE: string | boolean = true;
  let checkBuildPragmas: boolean | undefined;
  let showInfo = false;
  let parallelism: number | undefined = undefined;
  let propagateTypes = true;
  let trustDeclaredTypes = true;
  let checkTypes: DiagnosticType | "OFF" = "WARNING";
  let skipRemote = false;
  let covarianceWarnings: boolean | undefined;

  const sdk = await getSdkPath();
  const sdkVersion = (() => {
    const match = sdk.match(/-(\d+\.\d+\.\d+)/);
    return match ? parseSdkVersion(match[1]) : 0;
  })();
  const supportsCompiler2 =
    sdkVersion >= 4001006 || sdk.match(/compiler2beta/i);

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
      case "parallelism":
        if (value == null) return key;
        parallelism = parseInt(value, 10);
        break;
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
      case "analyze-only":
        analyzeOnly = !value || /^true|1$/i.test(value);
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
      case "compilerOptions":
        if (value == null) return key;
        extraMonkeycArgs.push(...value.split(/\s+/));
        break;

      case "checkInvalidSymbols":
        if (value == null) return key;
        value = value.toUpperCase();
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
      case "checkCompilerLookupRules":
        if (value == null) return key;
        value = value.toUpperCase();
        switch (value) {
          case "ERROR":
          case "WARNING":
          case "INFO":
          case "OFF":
            checkCompilerLookupRules = value;
            break;
          default:
            error(`Invalid option for checkCompilerLookupRules: ${value}`);
        }
        break;
      case "checkTypes":
        if (value == null) return key;
        value = value.toUpperCase();
        switch (value) {
          case "ERROR":
          case "WARNING":
          case "INFO":
          case "OFF":
            checkTypes = value;
            break;
          default:
            error(`Invalid option for checkCompilerLookupRules: ${value}`);
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
      case "trustDeclaredTypes":
        if (value == null) return key;
        trustDeclaredTypes = /^false|0$/i.test(value) ? false : true;
        break;
      case "propagateTypes":
        if (value == null) return key;
        propagateTypes = /^false|0$/i.test(value) ? false : true;
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
        if (!value || /^true|1$/i.test(value)) {
          testBuild = true;
        } else if (/^false|0$/i.test(value)) {
          testBuild = false;
        } else {
          testBuild = value;
        }
        break;
      case "showInfo":
        showInfo = !value || /^true|1$/i.test(value);
        break;
      case "skipRemote":
        skipRemote = !value || /^true|1$/i.test(value);
        break;
      case "covarianceWarnings":
        covarianceWarnings = !value || /^true|1$/i.test(value);
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
      .then(() => fetchGitProjects(rp, !!testBuild, skipRemote))
      .then((j) => {
        console.log(
          `${new Date().toLocaleString()} - Finished updating projects`
        );
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
    return !opt || opt !== "-O0";
  })();
  const failures: [string, unknown][] = [];
  const runOne = (
    promise: Promise<unknown>,
    serializeSim: { promise: Promise<unknown> },
    logger: (line: unknown, err?: boolean) => void,
    products: string[],
    jungleInfo: JungleInfo
  ) => {
    const genOnly = jungleInfo.build === false || generateOnly;
    const jungleOptions = jungleInfo.options || {};
    const jungleFiles = jungleInfo.jungle
      .split(";")
      .map((j) => path.resolve(j))
      .join(";");
    const workspace = path.dirname(jungleFiles.split(";")[0]);
    if (!outputPath) outputPath = defaultConfig.outputPath;
    const options: BuildConfig = {
      jungleFiles,
      workspace,
      developerKeyPath,
      outputPath,
      products,
      releaseBuild,
      testBuild: testBuild !== false,
      compilerWarnings,
      typeCheckLevel,
      skipOptimization,
      checkInvalidSymbols,
      trustDeclaredTypes,
      propagateTypes,
      checkTypes,
      checkCompilerLookupRules,
      sizeBasedPRE,
      ...jungleOptions,
      returnCommand: true,
      checkManifest: true,
      checkBuildPragmas,
      covarianceWarnings,
    };
    let extraArgs = extraMonkeycArgs;
    if (jungleInfo.garminOptLevel != null && supportsCompiler2) {
      extraArgs = extraArgs
        .filter((arg) => !arg.startsWith("-O"))
        .concat(`-O${jungleInfo.garminOptLevel}`);
    }
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k as keyof typeof options]
    );
    let start = 0;
    return promise
      .then(
        () => (
          (start = Date.now()),
          analyzeOnly
            ? get_jungle(options.jungleFiles!, options).then(
                ({ targets, xml }) =>
                  getProjectAnalysis(targets, null, xml, options).then(
                    (analysis) =>
                      "state" in analysis
                        ? reportDiagnostics(
                            analysis.state.diagnostics,
                            logger,
                            extraArgs
                          )
                        : null
                  )
              )
            : genOnly
            ? runTaskInPool({
                type: "generateOptimizedProject",
                data: {
                  options,
                },
              }).then(({ diagnostics }) =>
                reportDiagnostics(diagnostics, logger, extraArgs)
              )
            : runTaskInPool({
                type: "buildOptimizedProject",
                data: {
                  product: products ? products[0] : null,
                  options,
                },
              }).then(
                ({ exe, args, program, product, hasTests, diagnostics }) => {
                  reportDiagnostics(diagnostics, logger, extraArgs);
                  args.push(...extraArgs);
                  logger(
                    [exe, ...args].map((a) => JSON.stringify(a)).join(" ")
                  );
                  return spawnByLine(exe, args, logger, {
                    cwd: workspace,
                  }).then(() => ({
                    program,
                    product,
                    hasTests,
                  }));
                }
              )
        )
      )
      .then((res) => {
        if (showInfo && res && res.program) {
          return readPrg(res.program).then((info) => {
            logger(
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
          logger(
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
              const match = line.match(/^((\w|\.)+)\s*(PASS|FAIL|ERROR)\s*$/);
              if (match) {
                if (match[1].match(/crashCompiler2/i)) {
                  if (usesCompiler2 && match[3] === "ERROR") {
                    line = line.replace(/ERROR\s*$/, "EXPECTED ERROR");
                    expectedErrors++;
                  }
                } else {
                  const m = match[1].match(/(ExpectedFail|crash)(.*?)(U)?$/i);
                  if (m && (!m[2] || checkCompilerVersion(m[2], sdkVersion))) {
                    if (m[1].toLowerCase() === "crash") {
                      if (match[3] === "ERROR") {
                        line = line.replace(/ERROR\s*$/, "EXPECTED ERROR");
                        expectedErrors++;
                      } else if (
                        m[2] &&
                        match[3] === "PASS" &&
                        (!m[3] || options.skipOptimization)
                      ) {
                        line = line.replace(/PASS\s*$/, "UNEXPECTED PASS");
                        pass = false;
                      }
                    } else if (match[3] === "FAIL") {
                      line = line.replace(/FAIL\s*$/, "EXPECTED FAIL");
                      expectedFailures++;
                    } else if (
                      match[3] === "PASS" &&
                      (!m[3] || options.skipOptimization)
                    ) {
                      line = line.replace(/PASS\s*$/, "UNEXPECTED PASS");
                      pass = false;
                    }
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
            logger(line);
          };
          const serializePromise = serializeSim.promise
            .then(() => launchSimulator(pass !== undefined))
            .then(() =>
              simulateProgram(
                res.program,
                res.product!,
                pass === undefined ? testBuild : false,
                [handler, handler]
              )
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

          serializeSim.promise = serializePromise.catch(() => {
            // swallow the failure so the next simulator
            // user gets a clean start.
          });
          // but return the original promise, including the failure
          return serializePromise;
        }
        return null;
      })
      .then(() =>
        logger(
          `Done: ${new Date().toLocaleString()} (${
            Date.now() - start
          }ms) - ${jungleFiles}`
        )
      )
      .catch((ex: unknown) => {
        if (ex instanceof Error) {
          const e = ex as Error & {
            products?: string[];
            location?: NonNullable<mctree.Node["loc"]>;
          };
          const products = e.products && e.products.join(",");
          logger(
            `While building '${jungleFiles}${
              products ? ` for ${products}` : ""
            }`,
            true
          );
          if (e.name && e.message && e.location) {
            const source = e.location.source
              ? cleanPath(options.workspace, e.location.source)
              : "<unknown>";
            ex = `${e.name}: ${source}:${e.location.start.line},${e.location.start.column}: ${e.message}`;
            logger(`ERROR: ${ex}`, true);
          } else {
            ex = e.toString();
            logger(e, true);
          }
        }
        failures.push([jungleFiles, ex]);
      });
  };
  const serializeSim = { promise: Promise.resolve() };
  const start = Date.now();
  if (parallelism == null) {
    parallelism = Math.min(Math.ceil(os.cpus().length / 2), jungles.length);
  }
  startPool(parallelism);
  await promiseAll((index: number) => {
    if (index >= jungles.length) return null;
    const jungleFiles = jungles[index];
    const parts: { line: unknown; err: boolean | undefined }[] = [];
    const logger =
      jungles.length > 1
        ? (line: unknown, err?: boolean) => {
            parts.push({ line, err });
          }
        : (line: unknown, err?: boolean) =>
            err ? console.error(line) : console.log(line);
    const jf =
      typeof jungleFiles === "string"
        ? {
            jungle: jungleFiles,
            build: null,
            options: null,
            garminOptLevel: null,
          }
        : jungleFiles;

    const promise = testBuild
      ? products!.reduce(
          (promise, product) =>
            runOne(promise, serializeSim, logger, [product], jf),
          Promise.resolve()
        )
      : runOne(Promise.resolve(), serializeSim, logger, products!, jf);

    return promise.then(() =>
      parts.forEach((part) =>
        part.err ? console.error(part.line) : console.log(part.line)
      )
    );
  }, parallelism).finally(stopPool);
  console.log(`Total runtime: ${Date.now() - start}ms`);
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

function reportDiagnostics(
  diagnostics: ProgramState["diagnostics"],
  logger: (line: string) => void,
  extraArgs: string[]
) {
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
          logger(
            `${diag.type}: ${diag.message} at ${file}:${diag.loc.start.line}`
          );
          forEach(diag.related, (rel) => {
            logger(
              `        - ${rel.message} at ${rel.loc.source}:${rel.loc.start.line}`
            );
          });
        });
      });
  if (hasErrors && !extraArgs.includes("--Eno-invalid-symbol")) {
    throw new Error("'ERROR' level diagnostics were reported");
  }
  return null;
}
