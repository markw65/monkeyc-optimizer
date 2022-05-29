import * as fs from "fs/promises";
import * as path from "path";
import { parseStringPromise } from "xml2js";
import { globa } from "./util";

export const isWin = process.platform == "win32";

export const appSupport = isWin
  ? `${process.env.APPDATA}`.replace(/\\/g, "/")
  : process.platform == "linux"
  ? `${process.env.HOME}/.config`
  : `${process.env.HOME}/Library/Application Support`;

export const connectiq =
  process.platform == "linux"
    ? `${process.env.HOME}/.Garmin/ConnectIQ`
    : `${appSupport}/Garmin/ConnectIQ`;

export function getSdkPath() {
  return fs
    .readFile(connectiq + "/current-sdk.cfg")
    .then((contents) => contents.toString().replace(/^\s*(.*?)\s*$/s, "$1"))
    .catch(() => {
      throw new Error(
        `No sdk found at '${connectiq}'. Check your sdk is correctly installed`
      );
    });
}

export type DeviceInfo = {
  [key: string]: {
    appTypes: { memoryLimit: number; type: string }[];
    deviceFamily: string;
    displayName: string;
    languages: Record<string, true>;
  };
};

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const files = await globa(`${connectiq}/Devices/*/compiler.json`);
  if (!files.length) {
    throw new Error(
      `No devices found at '${connectiq}/Devices'. Check your sdk is correctly installed`
    );
  }
  return Promise.all(
    files.map((file) => {
      return fs.readFile(file).then((data) => {
        const { deviceId, appTypes, deviceFamily, displayName, partNumbers } =
          JSON.parse(data.toString()) as {
            deviceId: string;
            appTypes: { memoryLimit: number; type: string }[];
            deviceFamily: string;
            displayName: string;
            partNumbers: Array<{
              connectIqVersion: string;
              firmwareVersion: string;
              languages: Array<{ code: string; fontSet: string }>;
            }>;
          };
        const languages = Object.fromEntries(
          partNumbers
            .map((part) =>
              part.languages.map((lang) => [lang.code, true] as const)
            )
            .flat(1)
        );
        return [
          deviceId,
          { appTypes, deviceFamily, displayName, languages },
        ] as const;
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
