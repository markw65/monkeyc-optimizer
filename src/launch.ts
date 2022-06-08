import * as path from "path";
import { execFile } from "child_process";
import { getSdkPath, isWin } from "./sdk-util";
import { spawnByLine, LineHandler } from "./util";

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
  test: boolean = false,
  logger?: LineHandler | LineHandler[]
): Promise<void> {
  const args = [prg, device];
  if (test) args.push("-t");
  return getSdkPath().then((sdk) =>
    spawnByLine(
      path.resolve(sdk, "bin", "monkeydo"),
      args,
      logger || ((line: string) => console.log(line))
    ).then(() => {})
  );
}
