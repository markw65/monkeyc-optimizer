import * as fs from "fs/promises";
import { getDeviceInfo, xmlUtil } from "./sdk-util";

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
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  return manifest.body
    .children()
    .filter((c) => c.name === "iq:application" || c.name === "iq:barrel")
    .children("iq:products")
    .children("iq:product")
    .attrs()
    .map((p) => p.id?.value.value)
    .filter((p): p is string => p != null)
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

export function manifestBarrels(manifest: ManifestXML): string[] {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  return manifest.body
    .children("iq:application")
    .children("iq:barrels")
    .children("iq:depends")
    .attrs()
    .map((p) => p.name?.value.value)
    .filter((p): p is string => p != null)
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

export function manifestDropBarrels(manifest: ManifestXML): void {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  manifest.body.children("iq:application").deleteChildren("iq:barrels");
}

export function manifestBarrelName(
  manifestName: string,
  manifest: ManifestXML
): string {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  const barrel = manifest.body.children("iq:barrel");
  if (!barrel.elements.length) {
    throw new xmlUtil.PeggyError(
      `Missing 'iq:barrel' in manifest`,
      manifest.body.elements[0].loc
    );
  }
  const modules = barrel
    .attrs()
    .map((a) => a.module)
    .filter((a): a is NonNullable<typeof a> => a != null);
  if (!modules.length) {
    throw new xmlUtil.PeggyError(
      `Missing 'module' attribute in barrel manifest`,
      barrel.elements[0].loc
    );
  }
  if (modules.length !== 1) {
    throw new xmlUtil.PeggyError(
      `Manifest defines multiple modules`,
      modules[0].loc
    );
  }
  return modules[0].value.value;
}

export function manifestAnnotations(
  manifest: ManifestXML
): string[] | undefined {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  return manifest.body
    .children("iq:barrel")
    .children("iq:annotations")
    .children("iq:annotation")
    .text();
}

export function manifestLanguages(manifest: ManifestXML): string[] | undefined {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  return manifest.body
    .children()
    .filter((c) => c.name === "iq:application" || c.name === "iq:barrel")
    .children("iq:languages")
    .children("iq:language")
    .text();
}

export async function checkManifest(
  manifest: ManifestXML,
  products: string[]
): Promise<boolean> {
  if (manifest.body instanceof Error) {
    throw manifest.body;
  }
  let ok = true;
  const mattrs = manifest.body.attrs();
  if (
    mattrs.length !== 1 ||
    mattrs[0]["xmlns:iq"]?.value.value !== "http://www.garmin.com/xml/connectiq"
  ) {
    ok = false;
  }
  const app = manifest.body.children("iq:application");
  if (!app.length()) return ok;
  if (app.length() !== 1) return false;

  const attrs = app.attrs()[0];
  const id = attrs.id?.value.value;
  if (typeof id !== "string" || id.length < 32 || !/^[-_0-9a-f.]+$/.test(id)) {
    ok = false;
    attrs.id = xmlUtil.makeAttribute(
      "id",
      "08070f9d-8b4e-40a4-9c49-fe67a2a55dec"
    );
  }
  const type = attrs.type?.value.value.replace(/-/g, "").toLowerCase();
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
        return {
          type: "element",
          name: "iq:product",
          attr: {
            id: xmlUtil.makeAttribute("id", id),
          },
        };
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
