import * as path from "path";
import { getSdkPath, isWin } from "./sdk-util.js";
import { spawnByLine } from "./util.js";

export async function build_project(product, options, lineCallback) {
  const {
    workspace,
    program,
    jungleFiles,
    developerKeyPath,
    simulatorBuild,
    releaseBuild,
    compilerOptions,
    compilerWarnings,
    typeCheckLevel,
    returnCommand,
  } = options;
  const sdk = await getSdkPath();
  let extraArgs = [];
  if (compilerOptions) {
    extraArgs.push(...compilerOptions.split(/\s+/));
  }
  if (compilerWarnings) {
    extraArgs.push("-w");
  }
  if (releaseBuild) {
    extraArgs.push("-r");
  }
  if (!product) {
    extraArgs.push("-e");
  }
  switch (typeCheckLevel) {
    case "Off":
      extraArgs.push("-l", "0");
      break;
    case "Gradual":
      extraArgs.push("-l", "1");
      break;
    case "Informative":
      extraArgs.push("-l", "2");
      break;
    case "Strict":
      extraArgs.push("-l", "3");
      break;
  }
  if (product) {
    extraArgs.push("-d", simulatorBuild !== false ? `${product}_sim` : product);
  }
  const exe = path.resolve(sdk, "bin", isWin ? "monkeyc.bat" : "monkeyc");
  const args = [
    ["-o", program],
    ["-f", jungleFiles],
    ["-y", developerKeyPath],
    extraArgs,
  ].flat();

  const handlers = [
    lineCallback || ((line) => console.log(line)),
    (line) => console.error(line),
  ];
  return returnCommand
    ? { exe, args }
    : spawnByLine(exe, args, handlers, {
        cwd: workspace,
      });
}
