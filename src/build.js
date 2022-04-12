import * as path from "path";
import { getSdkPath, spawnByLine } from "./util.js";

export async function build_project(product, options, lineCallback) {
  const {
    workspace,
    program,
    jungleFiles,
    developerKeyPath,
    forSimulator,
    forRelease,
    compilerOptions,
    compilerWarnings,
    typeCheckLevel,
  } = options;
  const sdk = await getSdkPath();
  let extraArgs = [];
  if (compilerOptions) {
    extraArgs.push(...compilerOptions.split(/\s+/));
  }
  if (compilerWarnings) {
    extraArgs.push("-w");
  }
  if (forRelease) {
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
    extraArgs.push("-d", forSimulator !== false ? `${product}_sim` : product);
  }
  return spawnByLine(
    path.resolve(sdk, "bin", "monkeyc"),
    [
      ["-o", program],
      ["-f", jungleFiles],
      ["-y", developerKeyPath],
      extraArgs,
    ].flat(),
    lineCallback || ((line) => console.log(line)),
    { cwd: workspace }
  );
}
