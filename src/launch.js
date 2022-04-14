import path from "path";
import { execFile } from "child_process";
import { getSdkPath, isWin } from "./util.js";

export function launchSimulator() {
  return getSdkPath().then((sdk) => {
    const child = execFile(
      path.resolve(sdk, "bin", isWin ? "simulator" : "connectiq")
    );
    child.unref();
  });
}
