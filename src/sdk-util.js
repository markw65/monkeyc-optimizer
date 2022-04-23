import * as fs from "fs/promises";
import * as path from "path";
import { parseStringPromise } from "xml2js";
import { connectiq, getSdkPath, globa } from "./util.js";

export async function getDeviceInfo() {
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
  return projectInfo["monkeybrains"]["languages"][0]["language"].map((p) => ({
    id: p.$.id,
    name: p.$.name,
  }));
}
