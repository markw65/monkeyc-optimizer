import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkCompilerVersion, parseSdkVersion } from "./api";
import { getFileASTs, optimizeMonkeyC } from "./mc-rewrite";
import {
  defaultConfig,
  getConfig,
  getFnMapAnalysis,
  getProjectAnalysis,
  get_jungle,
  launchSimulator,
  mctree,
  simulateProgram,
} from "./optimizer";
import {
  BuildConfig,
  DiagnosticType,
  FilesToOptimizeMap,
  ProgramState,
} from "./optimizer-types";
import { RemoteProject, fetchGitProjects, githubProjects } from "./projects";
import { SectionKinds, getSdkPath, optimizeProgram, readPrg } from "./sdk-util";
import {
  forEach,
  globa,
  log,
  logPromise,
  promiseAll,
  spawnByLine,
} from "./util";
import { runTaskInPool, startPool, stopPool } from "./worker-pool";
import { parseXml } from "./xml-util";

type JungleInfo = {
  jungle: string;
  build: boolean | null;
  options: BuildConfig | null;
  garminOptLevel: number | null;
  products: string[] | null;
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
  let typeCheckLevel: "Off" | "Default" | "Gradual" | "Informative" | "Strict" =
    "Off";
  let strictTypeCheck: "On" | "Off" | "Default" = "Default";
  let optimizationLevel: "None" | "Basic" | "Fast" | "Slow" | undefined;
  let promise = Promise.resolve();
  let remoteProjects: RemoteProject[] | undefined;
  let generateOnly: boolean | undefined;
  let jungleOnly: boolean | undefined;
  let analyzeOnly: boolean | undefined;
  let skipOptimization: boolean | undefined;
  let ignore_settings_files: boolean | undefined;
  const extraMonkeycArgs: string[] = [];
  let execute = false;
  let testBuild: string | boolean = false;
  let checkInvalidSymbols: DiagnosticType | "OFF" = "ERROR";
  let checkCompilerLookupRules: DiagnosticType | "OFF" = "ERROR";
  let sizeBasedPRE: string | boolean = true;
  let preSkipLiterals = false;
  let checkBuildPragmas: boolean | undefined;
  let showInfo = false;
  let parallelism: number | undefined = undefined;
  let propagateTypes = true;
  let trustDeclaredTypes = true;
  let minimizeLocals = true;
  let minimizeModules = true;
  let singleUseCopyProp = true;
  let checkTypes: DiagnosticType | "OFF" | undefined;
  let skipRemote = false;
  let covarianceWarnings: boolean | undefined;
  let postOptimize = false;
  let iterateOptimizer = false;
  let postProcess: string | null = null;
  let postProcessTarget: string | undefined;
  let removeArgc: boolean | undefined = true;
  let postBuildPRE: boolean | undefined = true;
  let profile: string | undefined;
  let extraExcludes: string | undefined;
  let allowForbiddenOpts: boolean | undefined;
  const sourceFiles: string[] = [];

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
      case "profile":
        if (value == null) return key;
        profile = value;
        break;
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
        releaseBuild = !value || /^(true|1)$/i.test(value);
        break;
      case "postOptimize":
        postOptimize = !value || /^(true|1)$/i.test(value);
        break;
      case "iterateOptimizer":
        iterateOptimizer = !value || /^(true|1)$/i.test(value);
        break;
      case "postProcess":
        if (value == null) return key;
        postProcess = value;
        break;
      case "postProcessTarget":
        if (value == null) return key;
        postProcessTarget = value;
        break;
      case "warnings":
        compilerWarnings = !value || /^(true|1)$/i.test(value);
        break;
      case "generate-only":
        generateOnly = !value || /^(true|1)$/i.test(value);
        break;
      case "jungle-only":
        jungleOnly = !value || /^(true|1)$/i.test(value);
        break;
      case "analyze-only":
        analyzeOnly = !value || /^(true|1)$/i.test(value);
        break;
      case "typeCheckLevel":
        switch (value?.toLowerCase() ?? null) {
          case null:
            return key;
          case "off":
          case "default":
          case "gradual":
          case "informative":
          case "strict":
            typeCheckLevel = (value[0].toUpperCase() +
              value.slice(1).toLowerCase()) as typeof typeCheckLevel;
            break;
        }
        break;
      case "strictTypeCheck":
        switch (value?.toLowerCase() ?? null) {
          case null:
            return key;
          case "off":
          case "on":
          case "default":
            strictTypeCheck = (value[0].toUpperCase() +
              value.slice(1).toLowerCase()) as typeof strictTypeCheck;
            break;
        }
        break;
      case "optimizationLevel":
        if (!supportsCompiler2) {
          error("optimizationLevel requires a more recent sdk");
        }
        switch (value?.toLowerCase() ?? null) {
          case null:
            return key;
          case "none":
          case "basic":
          case "fast":
          case "slow":
            optimizationLevel = value as typeof optimizationLevel;
            break;
        }
        break;
      case "skipOptimization":
        skipOptimization = !value || /^(true|1)$/i.test(value);
        break;
      case "ignore-settings-files":
        ignore_settings_files = !value || /^(true|1)$/i.test(value);
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
            error(`Invalid option for checkTypes: ${value}`);
        }
        break;
      case "sizeBasedPRE":
        if (value == null) return key;
        sizeBasedPRE = /^(true|1)$/i.test(value)
          ? true
          : /^(false|0)$/i.test(value)
          ? false
          : value;
        break;
      case "preSkipLiterals":
        preSkipLiterals = !value || /^(true|1)$/i.test(value);
        break;
      case "trustDeclaredTypes":
        if (value == null) return key;
        trustDeclaredTypes = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "propagateTypes":
        if (value == null) return key;
        propagateTypes = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "singleUseCopyProp":
        if (value == null) return key;
        singleUseCopyProp = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "minimizeLocals":
        if (value == null) return key;
        minimizeLocals = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "minimizeModules":
        if (value == null) return key;
        minimizeModules = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "ignoreInvalidSymbols":
        if (!value || /^(true|1)$/i.test(value)) {
          extraMonkeycArgs.push("--Eno-invalid-symbol");
        }
        break;
      case "checkBuildPragmas":
        checkBuildPragmas = !value || /^(true|1)$/i.test(value);
        break;
      case "allowForbiddenOpts":
        allowForbiddenOpts = !value || /^(true|1)$/i.test(value);
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
        execute = !value || /^(true|1)$/i.test(value);
        break;
      case "testBuild":
        testBuild = !value || /^(true|1)$/i.test(value);
        break;
      case "run-tests":
        if (!value || /^(true|1)$/i.test(value)) {
          testBuild = true;
        } else if (/^(false|0)$/i.test(value)) {
          testBuild = false;
        } else {
          testBuild = value;
        }
        if (testBuild) execute = true;
        break;
      case "showInfo":
        showInfo = !value || /^(true|1)$/i.test(value);
        break;
      case "skipRemote":
        skipRemote = !value || /^(true|1)$/i.test(value);
        break;
      case "covarianceWarnings":
        covarianceWarnings = !value || /^(true|1)$/i.test(value);
        break;
      case "removeArgc":
        removeArgc = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "postBuildPRE":
        postBuildPRE = /^(false|0)$/i.test(value) ? false : true;
        break;
      case "sourceFile":
        if (value == null) return key;
        promise = promise
          .then(() => globa(value))
          .then((files) => {
            sourceFiles.push(...files);
          });
        break;
      case "extraExcludes":
        if (value == null) return key;
        extraExcludes = value;
        break;

      default:
        error(`Unknown argument: ${match ? match[0] : value}`);
    }
    return null;
  }, null);
  if (prev) error(`Missing arg for '${prev}'`);
  if (checkTypes == null) {
    checkTypes =
      typeCheckLevel.toLowerCase() === "strict" ? "ERROR" : "WARNING";
  }
  if (strictTypeCheck == null) {
    strictTypeCheck = typeCheckLevel.toLowerCase() === "strict" ? "On" : "Off";
  }
  const getOptions = (options: BuildConfig) => {
    options = {
      developerKeyPath,
      outputPath,
      products,
      releaseBuild,
      testBuild: testBuild !== false,
      compilerWarnings,
      typeCheckLevel,
      strictTypeCheck,
      optimizationLevel,
      skipOptimization,
      ignore_settings_files,
      checkInvalidSymbols,
      trustDeclaredTypes,
      propagateTypes,
      singleUseCopyProp,
      minimizeLocals,
      minimizeModules,
      checkTypes,
      checkCompilerLookupRules,
      sizeBasedPRE,
      preSkipLiterals,
      returnCommand: true,
      checkManifest: true,
      checkBuildPragmas,
      covarianceWarnings,
      extraExcludes,
      iterateOptimizer,
      removeArgc,
      postBuildPRE,
      allowForbiddenOpts,
      ...options,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k as keyof typeof options]
    );
    return options;
  };

  if (!developerKeyPath) {
    developerKeyPath = (await getConfig({})).developerKeyPath;
  }
  if (postProcess) {
    await optimizeProgram(
      postProcess,
      developerKeyPath,
      postProcessTarget,
      getOptions({})
    );
  }
  if (remoteProjects) {
    const rp = remoteProjects;
    promise = promise
      .then(() => fetchGitProjects(rp, !!testBuild, skipRemote))
      .then((j) => {
        log(`${new Date().toLocaleString()} - Finished updating projects`);
        jungles.push(...j);
      });
  }
  await promise;
  if (!jungles.length) {
    if (postProcess) return;
    if (sourceFiles.length) {
      await sourceFiles.reduce(async (promise, sourceFile) => {
        await promise;
        log(`Starting ${sourceFile}`);
        const diagnosticArray = await analyzeSourceFile(sourceFile, {
          trustDeclaredTypes,
          propagateTypes,
          typeCheckLevel,
          strictTypeCheck,
          checkTypes,
          checkBuildPragmas: true,
          checkInvalidSymbols,
          iterateOptimizer,
        });
        Promise.allSettled(
          diagnosticArray.map((diagnostics, index) => {
            let started = false;
            Promise.resolve().then(() =>
              reportDiagnostics(
                diagnostics,
                (line: unknown, err?: boolean) => {
                  if (!started) {
                    log(`Diagnostics from ${index ? "Analysis" : "Optimizer"}`);
                    started = true;
                  }
                  err ? console.error(line) : log(line);
                },
                []
              )
            );
          })
        ).then((results) => {
          const e = results.find(
            (r): r is PromiseRejectedResult => r.status === "rejected"
          );
          if (e) throw e.reason;
        });
        log(`${sourceFile} complete`);
      }, Promise.resolve());
      return;
    }
    throw new Error("No inputs!");
  }
  if (!testBuild && !execute && products) {
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
    products: string[] | undefined,
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
    const strictTypeCheck =
      jungleOptions.typeCheckLevel?.toLowerCase() === "strict"
        ? "On"
        : "Default";
    const options = getOptions({
      jungleFiles,
      workspace,
      strictTypeCheck,
      ...jungleOptions,
    });
    let extraArgs = extraMonkeycArgs;
    if (jungleInfo.garminOptLevel != null && supportsCompiler2) {
      extraArgs = extraArgs
        .filter((arg) => !arg.startsWith("-O"))
        .concat(`-O${jungleInfo.garminOptLevel}`);
    }
    const showInfoFn = <
      T extends {
        program: string;
        product: string | null;
        hasTests: boolean;
      } | null
    >(
      res: T
    ) => {
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
    };
    let start = 0;
    const profileWithBlocking = <T>(
      name: string,
      callback: () => Promise<T>
    ) => {
      if (profile !== name && profile !== "all") {
        return callback();
      }
      const start = Date.now();
      let prev: number | null = start;
      const histogram: number[] = [];
      const blockers: number[] = [];
      return Promise.all([
        Promise.resolve()
          .then(async () => {
            while (prev != null) {
              const now = Date.now();
              const delay = now - prev;
              histogram[delay] = (histogram[delay] ?? 0) + 1;
              if (delay > 20) {
                blockers[prev - start] = delay;
              }
              prev = now;
              await (now - start > -1
                ? new Promise((resolve) => setTimeout(() => resolve(null), 0))
                : Promise.resolve());
            }
          })
          .then(() => {
            log(`${name}: Total time: ${Date.now() - start}`);
            histogram.forEach((count, delay) =>
              log(`${name}: Blocked for ${delay}ms ${count} times`)
            );
            blockers.forEach((delay, start) =>
              log(`${name}: At time ${start}ms, block for ${delay}ms`)
            );
          }),
        (() => {
          console.profile();
          return callback();
        })()
          .then((result) => {
            console.profileEnd();
            return result;
          })
          .finally(() => {
            prev = null;
            log(`${name}: Profiling done in ${Date.now() - start}ms`);
          }),
      ]).then((results) => results[1]);
    };
    const doAnalyzeOnly = () => {
      return profileWithBlocking("jungle", () =>
        get_jungle(options.jungleFiles!, options)
      )
        .then(({ targets, xml }) =>
          profileWithBlocking("analysis", () =>
            getProjectAnalysis(targets, null, xml, options)
          )
        )
        .then((analysis) => {
          if ("state" in analysis) {
            reportDiagnostics(analysis.state.diagnostics, logger, extraArgs);
            return null;
          }
          throw new Error(
            `Analysis failed:\n${Object.values(analysis.fnMap)
              .filter((fn) => fn.parserError != null)
              .map((fn) => ` - ${fn.parserError!.toString()}\n`)}`
          );
        });
    };
    return promise
      .then(
        () => (
          (start = Date.now()),
          analyzeOnly
            ? doAnalyzeOnly()
            : genOnly
            ? profileWithBlocking("generate", () =>
                runTaskInPool({
                  type: "generateOptimizedProject",
                  data: {
                    options,
                  },
                })
              ).then(({ diagnostics }) =>
                reportDiagnostics(diagnostics, logger, extraArgs)
              )
            : profileWithBlocking("build", () =>
                runTaskInPool({
                  type: "buildOptimizedProject",
                  data: {
                    product: products ? products[0] : null,
                    options,
                  },
                })
              )
                .then(
                  ({ exe, args, program, product, hasTests, diagnostics }) => {
                    reportDiagnostics(diagnostics, logger, extraArgs);
                    args.push(...extraArgs);
                    logger(
                      [exe, ...args].map((a) => JSON.stringify(a)).join(" ")
                    );
                    return Promise.all([
                      {
                        program,
                        product,
                        hasTests,
                      },
                      spawnByLine(exe, args, logger, {
                        cwd: workspace,
                      }),
                    ]);
                  }
                )
                .then(([res]) => (postOptimize ? showInfoFn(res) : res))
                .then((res) => {
                  return Promise.all([
                    postOptimize
                      ? {
                          program:
                            path.join(
                              path.dirname(res.program),
                              path.basename(res.program, ".prg")
                            ) + ".opt.prg",
                          product: res.product,
                          hasTests: res.hasTests,
                        }
                      : res,
                    postOptimize &&
                      optimizeProgram(
                        res.program,
                        developerKeyPath,
                        undefined,
                        options
                      ),
                  ]).then(([res]) => res);
                })
        )
      )
      .then((res) => showInfoFn(res))
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
              line = line.replace(/(\S)(PASS|FAIL|ERROR)\s*$/, "$1 $2");
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
          const sim = () =>
            trySim(
              res.program,
              res.product!,
              pass === undefined ? testBuild : false,
              handler
            );
          const serializePromise = serializeSim.promise
            .then(sim)
            .catch((e) => {
              handler(`\n\n\nSimulate program failed: ${e}\n\n\nRetrying...\n`);
              return sim();
            })
            .catch((e) => {
              handler(`\n\n\nSimulate program failed: ${e}\n\n\nRetrying...\n`);
              return sim();
            })
            .catch((e) => handler(`Simulate program failed: ${e}`))
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
            });

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
  if (parallelism > 1 && !profile) {
    startPool(parallelism);
  }
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
            err ? console.error(line) : log(line);
    const jf =
      typeof jungleFiles === "string"
        ? {
            jungle: jungleFiles,
            build: null,
            options: null,
            garminOptLevel: null,
            products: null,
          }
        : jungleFiles;

    const curProducts =
      jf.products &&
      (!products || (products.length === 1 && products[0] === "pick-one"))
        ? jf.products
        : products;

    const promise =
      testBuild && curProducts
        ? curProducts.reduce(
            (promise, product) =>
              runOne(promise, serializeSim, logger, [product], jf),
            Promise.resolve()
          )
        : runOne(Promise.resolve(), serializeSim, logger, curProducts, jf);

    return promise
      .then(() =>
        parts.forEach((part) =>
          part.err ? console.error(part.line) : log(part.line)
        )
      )
      .then(() => logPromise);
  }, parallelism).finally(stopPool);
  log(`Total runtime: ${Date.now() - start}ms`);
  await logPromise;
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

function trySim(
  program: string,
  product: string,
  runTests: boolean | string,
  handler: (line: string) => void
) {
  return (
    process.platform === "darwin"
      ? spawnByLine(
          "pkill",
          ["-f", "Contents/MacOS/simulator"],
          [handler, handler]
        ).catch(() => {
          /**/
        })
      : Promise.resolve()
  )
    .then(() => launchSimulator(!runTests))
    .then(() =>
      simulateProgram(program, product!, runTests, [handler, handler])
    )
    .catch((e) => {
      if (e === 1) return;
      throw e;
    });
}

async function analyzeSourceFile(sourceFile: string, config: BuildConfig) {
  config = await getConfig(config);
  const source = (await fs.readFile(sourceFile)).toString();
  const fnMap: FilesToOptimizeMap = {
    [sourceFile]: {
      monkeyCSource: source,
      output: "",
      excludeAnnotations: {},
      barrel: "",
    },
  };
  await getFileASTs(fnMap);
  const manifestXML = parseXml(
    '<?xml version="1.0"?><iq:manifest version="3" xmlns:iq="http://www.garmin.com/xml/connectiq"/>'
  );
  const { state } = await getFnMapAnalysis(
    fnMap,
    {},
    manifestXML,
    config ?? {}
  );

  await log();

  const { diagnostics } = await optimizeMonkeyC(
    fnMap,
    {},
    manifestXML,
    config ?? {}
  );

  return [diagnostics, state.diagnostics];
}
