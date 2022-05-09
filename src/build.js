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
    testBuild,
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
  if (testBuild) {
    extraArgs.push("-t");
  } else if (releaseBuild) {
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
    extraArgs.push(
      "-d",
      testBuild || simulatorBuild !== false ? `${product}_sim` : product
    );
  } else if (testBuild) {
    throw new Error("Building for tests requires a device to build for!");
  }
  const exe = path.resolve(sdk, "bin", isWin ? "monkeyc.bat" : "monkeyc");
  const args = [
    ["-o", program],
    ["-f", jungleFiles],
    ["-y", developerKeyPath],
    extraArgs,
  ].flat();

  if (!returnCommand) {
    const handlers = [
      lineCallback || ((line) => console.log(line)),
      (line) => console.error(line),
    ];
    await spawnByLine(exe, args, handlers, {
      cwd: workspace,
    });
  }
  return { exe, args, program: path.resolve(workspace, program), product };
}
