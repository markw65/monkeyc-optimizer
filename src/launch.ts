import * as path from "path";
import { execFile } from "child_process";
import { getSdkPath, isWin } from "./sdk-util";
import { spawnByLine } from "./util";

export function launchSimulator(): Promise<void> {
  return getSdkPath().then((sdk) => {
    const child = execFile(
      path.resolve(sdk, "bin", isWin ? "simulator" : "connectiq")
    );
    child.unref();
  });
}

export function simulateProgram(
  prg: string,
  device: string,
  test?: boolean
): Promise<void> {
  const args = [prg, device];
  if (test) args.push("-t");
  return getSdkPath().then((sdk) =>
    spawnByLine(path.resolve(sdk, "bin", "monkeydo"), args, (line: string) =>
      console.log(line)
    ).then(() => {})
  );
}
