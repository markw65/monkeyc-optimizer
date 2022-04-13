import path from "path";
import { getSdkPath, spawnByLine } from "./util.js";

export async function launchSimulator() {
  const sdk = await getSdkPath();
  await spawnByLine(path.resolve(sdk, "bin", "connectiq"), [], console.log);
}
