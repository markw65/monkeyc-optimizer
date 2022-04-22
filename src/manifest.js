import { parseStringPromise, Builder } from "xml2js";
import * as fs from "fs/promises";
import { connectiq, globa } from "./util.js";

export async function readManifest(manifest) {
  const data = await fs.readFile(manifest);
  return parseStringPromise(data.toString(), { trim: true });
}

export async function writeManifest(filename, xml) {
  let builder = new Builder();
  let text = builder.buildObject(xml);
  return fs.writeFile(filename, text);
}

export function manifestProducts(manifest) {
  const app =
    manifest["iq:manifest"]["iq:application"] ||
    manifest["iq:manifest"]["iq:barrel"];
  return app[0]["iq:products"][0]["iq:product"]
    .map((p) => p["$"]["id"])
    .sort()
    .filter((p, i, a) => !i || p !== a[i - 1]);
}

async function getDeviceInfo() {
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

export async function checkManifest(manifest, products) {
  let ok = true;
  if (!manifest["iq:manifest"]["$"]["xmlns:iq"]) {
    manifest["iq:manifest"]["$"]["xmlns:iq"] =
      "http://www.garmin.com/xml/connectiq";
    ok = false;
  }
  const app = manifest["iq:manifest"]["iq:application"];
  if (!app) return ok;

  const elm = app[0];
  const type = elm.$.type.replace(/-/, "").toLowerCase();
  const deviceInfo = await getDeviceInfo();
  const allowedProducts = products.sort().filter(
    (p) =>
      deviceInfo[p] &&
      deviceInfo[p].appTypes.find((at) => {
        return at.type.toLowerCase() === type;
      })
  );
  if (
    JSON.stringify(allowedProducts) !=
    JSON.stringify(manifestProducts(manifest))
  ) {
    ok = false;
    elm["iq:products"][0]["iq:product"] = allowedProducts.map((id) => {
      return { $: { id } };
    });
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
      delete elm[key];
    }
  });

  return ok;
}
