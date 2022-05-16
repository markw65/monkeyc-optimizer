import * as fs from "fs/promises";
import * as path from "path";
import { parseStringPromise } from "xml2js";
import { globa } from "./util";

export const isWin = process.platform == "win32";

export const appSupport = isWin
  ? `${process.env.APPDATA}`.replace(/\\/g, "/")
  : `${process.env.HOME}/Library/Application Support`;

export const connectiq = `${appSupport}/Garmin/ConnectIQ`;

export function getSdkPath() {
  return fs
    .readFile(connectiq + "/current-sdk.cfg")
    .then((contents) => contents.toString().replace(/^\s*(.*?)\s*$/s, "$1"));
}

export async function getDeviceInfo(): Promise<{
  [key: string]: {
    appTypes: { memoryLimit: number; type: string }[];
    deviceFamily: string;
  };
}> {
  const files = await globa(`${connectiq}/Devices/*/compiler.json`);
  return Promise.all(
    files.map((file) => {
      return fs.readFile(file).then((data) => {
        const { deviceId, appTypes, deviceFamily } = JSON.parse(
          data.toString()
        );
        return [deviceId, { appTypes, deviceFamily }];
      });
    })
  ).then((info) => {
    return Object.fromEntries(info);
  });
}

async function getProjectInfo() {
  const sdk = await getSdkPath();
  const data = await fs.readFile(path.join(sdk, "bin", "projectInfo.xml"));
  return parseStringPromise(data.toString(), { trim: true });
}

export async function getLanguages() {
  const projectInfo = await getProjectInfo();
  return projectInfo["monkeybrains"]["languages"][0]["language"].map(
    (p: { $: { id: string; name: string } }) => ({
      id: p.$.id,
      name: p.$.name,
    })
  );
}
