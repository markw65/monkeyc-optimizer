import * as fs from "fs/promises";
import * as path from "path";
import { globa } from "./util";
import { parseXml, Element } from "./xml-util";

export { readPrg, optimizeProgram, readPrgWithOffsets } from "./readprg";
export { SectionKinds } from "./readprg/bytecode";
export * as xmlUtil from "./xml-util";

export const isWin = process.platform === "win32";

export const appSupport = isWin
  ? `${process.env.APPDATA}`.replace(/\\/g, "/")
  : process.platform === "linux"
  ? `${process.env.HOME}/.config`
  : `${process.env.HOME}/Library/Application Support`;

export const connectiq =
  process.platform === "linux"
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
  const file = path.join(await getSdkPath(), "bin", "projectInfo.xml");
  const data = await fs.readFile(file);
  return parseXml(data.toString(), file);
}

export async function getLanguages() {
  const projectInfo = await getProjectInfo();
  if (projectInfo.body instanceof Error) {
    throw projectInfo.body;
  }
  return projectInfo.body
    .children("languages")
    .children("language")
    .attrs()
    .map(
      ({ id, name }) =>
        id &&
        name && {
          id: id.value.value,
          name: name.value.value,
        }
    )
    .filter((s): s is NonNullable<typeof s> => s != null);
}

export async function getFunctionDocumentation() {
  const file = path.join(await getSdkPath(), "bin", "api.debug.xml");
  const data = await fs.readFile(file);
  const xml = parseXml(data.toString(), file);
  if (xml.body instanceof Error) {
    return null;
  }
  const entries = xml.body
    .children("functions")
    .children("functionEntry")
    .elements.map((e) => ({
      name: e.attr.name?.value.value,
      parent: e.attr.parent?.value.value,
      doc:
        e.children
          ?.filter(
            (child): child is Element =>
              child.type === "element" &&
              child.name === "documentation" &&
              child.children != null
          )
          .map(
            (doc) =>
              doc.children?.map((c) =>
                c.type === "chardata" || c.type === "cdata" ? c.value : ""
              ) || ""
          )
          .join("") || "",
    }))
    .filter(
      (x): x is { name: string; parent: string; doc: string } =>
        x.name != null && x.parent != null && x.doc !== ""
    );

  return entries;
}
