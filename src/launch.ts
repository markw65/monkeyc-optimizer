import * as path from "path";
import * as net from "net";

import { execFile } from "child_process";
import { getSdkPath, isWin } from "./sdk-util";
import { spawnByLine, LineHandler } from "./util";

export async function launchSimulator(force = true): Promise<void> {
  if (!force && (await checkIfSimulatorRunning())) return;
  const sdk = await getSdkPath();
  const child = execFile(
    path.resolve(sdk, "bin", isWin ? "simulator" : "connectiq")
  );
  child.unref();
  for (let i = 0; ; i++) {
    if (await checkIfSimulatorRunning()) return;
    if (i === 5) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function checkIfSimulatorRunning(): Promise<boolean> {
  return Promise.all(
    [1234, 1235, 1236, 1237, 1238].map(checkIfSimulatorRunningOn)
  ).then((results) => results.some((v) => v));
}

export function checkIfSimulatorRunningOn(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let listening = false;
    const socket = new net.Socket();
    socket.on(
      "data",
      (data) => (listening = data.toString().includes("A garmin device"))
    );
    socket.on("error", () => resolve(false));
    socket.on("end", () => resolve(listening));
    socket.connect(port, "localhost");
    socket.end();
  });
}

export function simulateProgram(
  prg: string,
  device: string,
  test: boolean | string = false,
  logger?: LineHandler | LineHandler[]
): Promise<void> {
  const args = [prg, device];
  if (test) {
    args.push(isWin ? "/t" : "-t");
    if (typeof test === "string") {
      args.push(test);
    }
  }
  return getSdkPath().then((sdk) =>
    spawnByLine(
      path.resolve(sdk, "bin", isWin ? "monkeydo.bat" : "monkeydo"),
      args,
      logger || ((line: string) => console.log(line))
    ).then(() => {
      return;
    })
  );
}
