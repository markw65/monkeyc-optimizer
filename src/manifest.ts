import * as fs from "fs/promises";
import { getDeviceInfo, xmlUtil } from "./sdk-util";

/*
interface iqApplication
  extends Element<
    "iq:application",
    | Element<"iq:products", iqProduct>
    | Element<"iq:barrels", iqDepends>
    | Element<"iq:permissions", iqPermission>
    | Element<"iq:languages", iqLanguage>
  > {
  attrs: {
    id: string;
    entry: string;
    launcherIcon: string;
    minSdkVersion: string;
    name: string;
    type: string;
    version: string;
  };
}

interface iqProduct extends LeafElement<"iq:product"> {
  attrs: { id: string };
}

interface iqDepends extends LeafElement<"iq:depends"> {
  attrs: { name: string; version: string };
}

interface iqPermission extends LeafElement<"iq:uses-permission"> {
  attrs: { id: string };
}

type iqLanguage = Element<"iq:language", never>;

type iqAnnotation = Element<"iq:annotation", never>;

interface iqBarrel
  extends Element<
    "iq:barrel",
    Element<"iq:products", iqProduct> | Element<"iq:annotations", iqAnnotation>
  > {
  attrs: { id: string; module: string; version: string };
}
*/
export type ManifestXML = xmlUtil.Document;

export async function readManifest(manifest: string): Promise<ManifestXML> {
  const data = await fs.readFile(manifest);
  return xmlUtil.parseXml(data.toString(), manifest);
}

export async function writeManifest(
  filename: string,
  xml: ManifestXML
): Promise<void> {
  return fs.writeFile(filename, xmlUtil.writeXml(xml));
}

export function manifestProducts(manifest: ManifestXML): string[] {
  return manifest.body
    .children()
    .filter((c) => c.name === "iq:application" || c.name === "iq:barrel")
    .children("iq:products")
    .children("iq:product")
    .attrs()
    .map((p) => p.id)
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

export function manifestBarrels(manifest: ManifestXML): string[] {
  return manifest.body
    .children("iq:application")
    .children("iq:barrels")
    .children("iq:depends")
    .attrs()
    .map((p) => p.name)
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

export function manifestDropBarrels(manifest: ManifestXML): void {
  manifest.body.children("iq:application").deleteChildren("iq:barrels");
}

export function manifestBarrelName(
  manifestName: string,
  manifest: ManifestXML
): string {
  const modules = manifest.body
    .children("iq:barrel")
    .attrs()
    .map((a) => a.module);
  if (!modules.length) {
    throw new Error(`Not a barrel manifest: ${manifestName}`);
  }
  if (modules.length !== 1) {
    throw new Error(`Manifest defines multiple modules`);
  }
  if (typeof modules[0] !== "string") {
    throw new Error("Missing barrel name in manifest");
  }
  return modules[0];
}

export function manifestAnnotations(
  manifest: ManifestXML
): string[] | undefined {
  return manifest.body
    .children("iq:barrel")
    .children("iq:annotations")
    .children("iq:annotation")
    .text();
}

export async function checkManifest(
  manifest: ManifestXML,
  products: string[]
): Promise<boolean> {
  let ok = true;
  const mattrs = manifest.body.attrs();
  if (
    mattrs.length !== 1 ||
    mattrs[0]["xmlns:iq"] !== "http://www.garmin.com/xml/connectiq"
  ) {
    ok = false;
  }
  const app = manifest.body.children("iq:application");
  if (!app.length()) return ok;
  if (app.length() !== 1) return false;

  const attrs = app.attrs()[0];
  const id = attrs.id;
  if (typeof id !== "string" || id.length < 32 || !/^[-_0-9a-f.]+$/.test(id)) {
    ok = false;
    attrs.id = "08070f9d-8b4e-40a4-9c49-fe67a2a55dec";
  }
  const type = attrs.type.replace(/-/g, "").toLowerCase();
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
    const products = app.children("iq:products");
    products.deleteChildren("iq:product");
    products.addChildren(
      allowedProducts.map((id) => {
        return { type: "element", name: "iq:product", attr: { id } };
      })
    );
  }

  app.deleteChildren((c) => {
    if (
      [
        "iq:permissions",
        "iq:languages",
        "iq:products",
        "iq:barrels",
        "iq:trialMode",
      ].includes(c.name)
    ) {
      return false;
    }
    ok = false;
    return true;
  });

  return ok;
}
