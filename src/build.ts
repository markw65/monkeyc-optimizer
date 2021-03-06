import * as path from "path";
import { getSdkPath, isWin } from "./sdk-util";
import { spawnByLine } from "./util";
import { BuildConfig } from "./optimizer-types";

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
  const exe = path.resolve(sdk, "bin", isWin ? "monkeyc.bat" : "monkeyc");
  const args = [
    ["-o", program],
    ["-f", jungleFiles],
    ["-y", developerKeyPath],
    extraArgs,
  ].flat();

  if (!returnCommand) {
    const handlers = [
      lineCallback || ((line: string) => console.log(line)),
      (line: string) => console.error(line),
    ];
    await spawnByLine(exe, args, handlers, {
      cwd: workspace,
    });
  }
  return { exe, args, program: path.resolve(workspace, program), product };
}
