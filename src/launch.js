import path from "path";
import { execFile } from "child_process";
import { getSdkPath, isWin } from "./sdk-util.js";
import { spawnByLine } from "./util.js";

export function launchSimulator() {
  return getSdkPath().then((sdk) => {
    const child = execFile(
      path.resolve(sdk, "bin", isWin ? "simulator" : "connectiq")
    );
    child.unref();
  });
}

export function simulateProgram(prg, device) {
  return getSdkPath().then((sdk) =>
    spawnByLine(path.resolve(sdk, "bin", "monkeydo"), [prg, device], (line) =>
      console.log(line)
    )
  );
}
