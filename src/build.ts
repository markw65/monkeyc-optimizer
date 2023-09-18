import * as path from "path";
import { BuildConfig } from "./optimizer-types";
import { getSdkPath } from "./sdk-util";
import { log, spawnByLine } from "./util";

export async function build_project(
  product: string | null,
  options: BuildConfig,
  lineCallback?: (line: string) => void
) {
  const {
    workspace,
    program,
    jungleFiles,
    developerKeyPath,
    simulatorBuild,
    releaseBuild,
    testBuild,
    compilerOptions,
    compilerWarnings,
    typeCheckLevel,
    optimizationLevel,
    returnCommand,
  } = options;
  const sdk = await getSdkPath();
  const extraArgs = [];
  if (compilerOptions) {
    extraArgs.push(...compilerOptions.split(/\s+/));
  }
  if (compilerWarnings) {
    extraArgs.push("-w");
  }
  if (testBuild) {
    extraArgs.push("-t");
  } else if (releaseBuild) {
    extraArgs.push("-r");
  }
  if (!product) {
    extraArgs.push("-e");
  }
  switch (typeCheckLevel?.toLowerCase()) {
    case "off":
      extraArgs.push("-l", "0");
      break;
    case "gradual":
      extraArgs.push("-l", "1");
      break;
    case "informative":
      extraArgs.push("-l", "2");
      break;
    case "strict":
      extraArgs.push("-l", "3");
      break;
  }
  switch (optimizationLevel?.toLowerCase()) {
    case "none":
      extraArgs.push("-O0");
      break;
    case "basic":
      extraArgs.push("-O1");
      break;
    case "fast":
      extraArgs.push("-O2");
      break;
    case "slow":
      extraArgs.push("-O3");
      break;
  }
  if (product) {
    extraArgs.push(
      "-d",
      testBuild || simulatorBuild !== false ? `${product}_sim` : product
    );
  } else if (testBuild) {
    throw new Error("Building for tests requires a device to build for!");
  }
  if (!program || !jungleFiles || !developerKeyPath || !workspace) {
    throw new Error("Required arguments were missing!");
  }
  const exe = "java";
  const args = [
    ["-Xms1g", "-Dfile.encoding=UTF-8", "-Dapple.awt.UIElement=true"],
    ["-cp", path.resolve(sdk, "bin", "monkeybrains.jar")],
    ["com.garmin.monkeybrains.Monkeybrains"],
    ["-o", program],
    ["-f", jungleFiles],
    ["-y", developerKeyPath],
    extraArgs,
  ].flat();

  if (!returnCommand) {
    const handlers = [
      lineCallback || ((line: string) => log(line)),
      (line: string) => console.error(line),
    ];
    await spawnByLine(exe, args, handlers, {
      cwd: workspace,
    });
  }
  return { exe, args, program: path.resolve(workspace, program), product };
}
