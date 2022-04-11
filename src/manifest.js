import { parseStringPromise } from "xml2js";
import * as fs from "fs/promises";

export async function readManifest(manifest) {
  const data = await fs.readFile(manifest);
  return parseStringPromise(data.toString());
}

export function manifestProducts(manifest) {
  return manifest["iq:manifest"]["iq:application"][0]["iq:products"][0][
    "iq:product"
  ].map((p) => p["$"]["id"]);
}
