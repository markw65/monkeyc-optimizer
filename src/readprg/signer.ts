import * as fs from "fs/promises";
import assert from "node:assert";
import * as crypto from "node:crypto";

import { Context, SectionKinds } from "./bytecode";

export function getPrgSignature(context: Context) {
  if (!context.key) return;
  const withSha256 =
    context.sections[SectionKinds.SIGNATURE]?.length === 1036 + 512 - 8;
  delete context.sections[SectionKinds.SIGNATURE];
  delete context.sections[SectionKinds.STORE_SIG];

  const signature = signatureFromContext(context);
  if (!signature) return;
  const signature2 = withSha256
    ? signatureFromContext(context, "SHA256")
    : null;
  if (withSha256 && !signature2) return;
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
  assert(!signature2 || signature2.length === 512);
  const sectionLength =
    signature.length + modulus.byteLength + 4 + (signature2?.length ?? 0);
  const buffer = new DataView(new ArrayBuffer(sectionLength + 8));
  const asUint = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  buffer.setInt32(0, SectionKinds.SIGNATURE);
  buffer.setInt32(4, sectionLength);
  asUint.set(signature, 8);
  asUint.set(
    new Uint8Array(modulus.buffer, modulus.byteOffset, modulus.byteLength),
    520
  );
  buffer.setInt32(1032, publicExponent);
  if (signature2) {
    asUint.set(signature2, 1036);
  }
  const max = Math.max(
    ...Object.values(context.sections).map((cur) => cur.offset + cur.length)
  );
  context.sections[SectionKinds.SIGNATURE] = {
    offset: max + 8,
    length: sectionLength,
    view: new DataView(buffer.buffer, 8, sectionLength),
  };
  return signature2 ? Buffer.concat([signature, signature2]) : signature;
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

export function signatureFromContext(context: Context, method = "SHA1") {
  if (!context.key) return null;
  const signer = crypto.createSign(method);
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

export function signView(
  key: crypto.KeyObject,
  view: DataView,
  method = "SHA1"
) {
  const signer = crypto.createSign(method);
  signer.update(view);
  signer.end();
  return signer.sign(key);
}
