import * as fs from "fs/promises";
import assert from "node:assert";
import * as crypto from "node:crypto";

import { Context, SectionKinds } from "./bytecode";

export function getPrgSignature(context: Context) {
  if (!context.key) return;
  delete context.sections[SectionKinds.SIGNATURE];
  delete context.sections[SectionKinds.STORE_SIG];

  const signature = signatureFromContext(context);
  if (!signature) return;
  const keyInfo = context.key.export({ format: "jwk" });
  assert(keyInfo.n && keyInfo.e);
  const modulusBuf = Buffer.from(keyInfo.n, "base64");
  const publicExponent = Array.from(Buffer.from(keyInfo.e, "base64")).reduce(
    (value, n) => (value << 8) + n,
    0
  );
  const delta = modulusBuf.length > 512 && modulusBuf[0] === 0 ? 1 : 0;
  const modulus = new DataView(
    modulusBuf.buffer,
    modulusBuf.byteOffset + delta,
    modulusBuf.byteLength - delta
  );
  assert(modulus.byteLength === 512 && signature.length === 512);
  const sectionLength = signature.length + modulus.byteLength + 4;
  const buffer = new DataView(new ArrayBuffer(sectionLength + 8));
  buffer.setInt32(0, SectionKinds.SIGNATURE);
  buffer.setInt32(4, sectionLength);
  let offset = 8;
  signature.forEach((b, i) => {
    buffer.setUint8(offset + 512, modulus.getUint8(i));
    buffer.setUint8(offset++, b);
  });
  buffer.setInt32(offset + 512, publicExponent);
  const max = Object.values(context.sections).reduce(
    (max, cur) =>
      cur.offset + cur.length > max ? cur.offset + cur.length : max,
    0
  );
  context.sections[SectionKinds.SIGNATURE] = {
    offset: max + 8,
    length: sectionLength,
    view: new DataView(buffer.buffer, 8, sectionLength),
  };
  return signature;
}

export function getDevKey(file: string) {
  return fs.readFile(file).then((privateKeyBytes) =>
    crypto.createPrivateKey({
      key: privateKeyBytes,
      format: "der",
      type: "pkcs8",
    })
  );
}

export function signatureFromContext(context: Context) {
  if (!context.key) return null;
  const signer = crypto.createSign("SHA1");
  Object.entries(context.sections)
    .filter(
      ([section]) =>
        Number(section) !== SectionKinds.SIGNATURE &&
        Number(section) !== SectionKinds.STORE_SIG
    )
    .sort((a, b) => a[1].offset - b[1].offset)
    .forEach((section) => {
      const view = section[1].view;
      const sectionView = new Uint8Array(
        view.buffer,
        view.byteOffset - 8,
        view.byteLength + 8
      );
      signer.update(sectionView);
    });
  signer.end();
  return signer.sign(context.key);
}

export function signView(key: crypto.KeyObject, view: DataView) {
  const signer = crypto.createSign("SHA1");
  signer.update(view);
  signer.end();
  return signer.sign(key);
}
