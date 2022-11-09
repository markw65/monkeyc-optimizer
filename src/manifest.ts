import { parseStringPromise, Builder } from "xml2js";
import * as fs from "fs/promises";
import { getDeviceInfo } from "./sdk-util";

type iqApplication = {
  $: {
    id: string;
    entry: string;
    launcherIcon: string;
    minSdkVersion: string;
    name: string;
    type: string;
    version: string;
  };
  "iq:products"?: Array<{
    "iq:product"?: Array<{ $: { id: string } }>;
  }>;
  "iq:barrels"?: Array<{
    "iq:depends"?: Array<{ $: { name: string; version: string } }>;
  }>;
  "iq:permissions"?: Array<{
    "iq:uses-permission"?: Array<{ $: { id: string } }>;
  }>;
  "iq:languages"?: Array<{
    "iq:language"?: Array<string>;
  }>;
};
type iqBarrel = {
  $: { id: string; module: string; version: string };
  "iq:products"?: Array<{
    "iq:product"?: Array<{ $: { id: string } }>;
  }>;
  "iq:annotations"?: Array<{
    "iq:annotation"?: Array<string>;
  }>;
};
export type ManifestXML = {
  "iq:manifest": {
    $: { "xmlns:iq": string };
    "iq:application"?: Array<iqApplication>;
    "iq:barrel"?: Array<iqBarrel>;
  };
};

export async function readManifest(manifest: string): Promise<ManifestXML> {
  const data = await fs.readFile(manifest);
  return parseStringPromise(data.toString(), { trim: true });
}

export async function writeManifest(
  filename: string,
  xml: ManifestXML
): Promise<void> {
  const builder = new Builder();
  return fs.writeFile(filename, builder.buildObject(xml));
}

export function manifestProducts(manifest: ManifestXML): string[] {
  const app =
    manifest["iq:manifest"]["iq:application"] ||
    manifest["iq:manifest"]["iq:barrel"];
  return (app?.[0]["iq:products"]?.[0]["iq:product"] || [])
    .map((p) => p.$.id)
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

export function manifestBarrels(manifest: ManifestXML): string[] {
  const app = manifest["iq:manifest"]["iq:application"];
  if (
    Array.isArray(app) &&
    app.length &&
    app[0] &&
    Array.isArray(app[0]["iq:barrels"]) &&
    app[0]["iq:barrels"].length &&
    Array.isArray(app[0]["iq:barrels"][0]["iq:depends"])
  ) {
    return app[0]["iq:barrels"][0]["iq:depends"]
      .map((p) => p.$.name)
      .sort()
      .filter((p, i, a) => !i || p !== a[i - 1]);
  }
  return [];
}

export function manifestDropBarrels(manifest: ManifestXML): void {
  const app = manifest["iq:manifest"]["iq:application"];
  if (!app) return;
  delete app[0]["iq:barrels"];
}

export function manifestBarrelName(
  manifestName: string,
  manifest: ManifestXML
): string {
  const barrel = manifest["iq:manifest"]["iq:barrel"];
  if (!barrel) throw new Error(`Not a barrel manifest: ${manifestName}`);
  return barrel[0].$.module;
}

export function manifestAnnotations(
  manifest: ManifestXML
): string[] | undefined {
  const barrel = manifest["iq:manifest"]["iq:barrel"];
  if (!barrel) return undefined;
  const annotations = barrel[0]["iq:annotations"];
  return annotations && annotations[0]["iq:annotation"];
}

export async function checkManifest(
  manifest: ManifestXML,
  products: string[]
): Promise<boolean> {
  let ok = true;
  if (!manifest["iq:manifest"]["$"]["xmlns:iq"]) {
    manifest["iq:manifest"]["$"]["xmlns:iq"] =
      "http://www.garmin.com/xml/connectiq";
    ok = false;
  }
  const app = manifest["iq:manifest"]["iq:application"];
  if (!app) return ok;

  const elm = app[0];
  const id = elm.$.id;
  if (id.length < 32 || !/^[-_0-9a-f.]+$/.test(id)) {
    ok = false;
    elm.$.id = "08070f9d-8b4e-40a4-9c49-fe67a2a55dec";
  }
  const type = elm.$.type.replace(/-/g, "").toLowerCase();
  const deviceInfo = await getDeviceInfo();
  const allowedProducts = products.sort().filter(
    (p) =>
      deviceInfo[p] &&
      deviceInfo[p].appTypes.find((at) => {
        const t = at.type.toLowerCase();
        return (
          t === type ||
          `${t}app` === type ||
          (type === "widget" && t === "watchapp")
        );
      })
  );
  if (
    JSON.stringify(allowedProducts) !=
    JSON.stringify(manifestProducts(manifest))
  ) {
    ok = false;
    elm["iq:products"] = [
      {
        "iq:product": allowedProducts.map((id) => {
          return { $: { id } };
        }),
      },
    ];
  }
  Object.keys(elm).forEach((key) => {
    if (
      ![
        "$",
        "iq:permissions",
        "iq:languages",
        "iq:products",
        "iq:barrels",
        "iq:trialMode",
      ].includes(key)
    ) {
      ok = false;
      delete elm[key as keyof iqApplication];
    }
  });

  return ok;
}
