import * as path from "path";
import * as net from "net";

import { execFile } from "child_process";
import { getSdkPath, isWin } from "./sdk-util";
import { spawnByLine, LineHandler } from "./util";

export function launchSimulator(): Promise<void> {
  return checkIfSimulatorRunning().then((running) =>
    running
      ? Promise.resolve()
      : getSdkPath().then((sdk) => {
          const child = execFile(
            path.resolve(sdk, "bin", isWin ? "simulator" : "connectiq")
          );
          child.unref();
        })
  );
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
  test = false,
  logger?: LineHandler | LineHandler[]
): Promise<void> {
  const args = [prg, device];
  if (test) args.push("-t");
  return getSdkPath().then((sdk) =>
    spawnByLine(
      path.resolve(sdk, "bin", "monkeydo"),
      args,
      logger || ((line: string) => console.log(line))
    ).then(() => {
      return;
    })
  );
}
