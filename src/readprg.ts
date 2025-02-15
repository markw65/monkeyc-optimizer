import * as fscb from "fs";
import * as fs from "fs/promises";
import * as crypto from "node:crypto";
import * as path from "path";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import { hasProperty } from "./ast";
import { BuildConfig } from "./optimizer-types";
import {
  Context,
  offsetAfter,
  optimizeBytecode,
  SectionInfo,
  SectionKinds,
} from "./readprg/bytecode";
import { parseData } from "./readprg/data";
import { parseExceptions } from "./readprg/exceptions";
import { parseHeader } from "./readprg/header";
import { parseLineNum } from "./readprg/linenum";
import { parseCode } from "./readprg/opcodes";
import { getDevKey, getPrgSignature, signView } from "./readprg/signer";
import { SymbolTable } from "./readprg/symbols";
import { getDeviceInfo, getSdkPath, xmlUtil } from "./sdk-util";
import { logger } from "./util";
import { runTaskInPool, startPool, stopPool } from "./worker-pool";

export async function readPrg(path: string) {
  const { sections } = await readPrgFromFile(path);
  return Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, value.length])
  );
}

export async function readPrgFromFile(prg: string) {
  return readPrgWithOffsets(new DataView((await fs.readFile(prg)).buffer));
}

export function readPrgWithOffsets(view: DataView) {
  const sections: Record<number, SectionInfo> = {};
  let offset = 0;
  while (view.byteLength - offset > 8) {
    const type = view.getInt32(offset);
    offset += 4;
    const length = view.getInt32(offset);
    offset += 4;
    if (length > view.byteLength - offset) {
      throw new Error(`Invalid length for section ${type}`);
    }
    sections[type] = {
      offset,
      length,
      view: new DataView(view.buffer, offset, length),
    };
    offset += length;
  }
  return { view, sections };
}

export async function optimizeProgram(
  filepath: string,
  devKey?: string | undefined,
  output?: string,
  config?: BuildConfig
) {
  if (/\.iq$/i.test(filepath)) {
    return optimizePackage(filepath, devKey, output, config);
  }
  const removeExt = (filepath: string, ext: string) =>
    path.join(path.dirname(filepath), path.basename(filepath, ext));

  if (!output) {
    output = removeExt(filepath, ".prg") + ".opt.prg";
  }

  const [debugXml, apiDebugXml, key, view] = await Promise.all([
    fs
      .readFile(filepath + ".debug.xml")
      .catch(() => "")
      .then((xmlBytes) => xmlUtil.parseXml(xmlBytes.toString())),

    getSdkPath()
      .then((sdk) => fs.readFile(`${sdk}bin/api.debug.xml`))
      .catch(() => "")
      .then((xmlBytes) => xmlUtil.parseXml(xmlBytes.toString())),

    devKey ? getDevKey(devKey) : undefined,

    fs.readFile(filepath).then((prgData) => new DataView(prgData.buffer)),
  ]);

  const { signature, buffer } = optimizeProgramBuffer(
    filepath,
    view,
    debugXml,
    apiDebugXml,
    key,
    config
  );
  const promises: Promise<unknown>[] = [];
  promises.push(fs.writeFile(output, buffer));

  if (!(debugXml.body instanceof Error)) {
    const contents = Buffer.from(xmlUtil.writeXml(debugXml));
    promises.push(fs.writeFile(output + ".debug.xml", contents));
  }
  const jsonIn = removeExt(filepath, ".prg");
  const jsonOut = removeExt(output, ".prg");
  promises.push(
    fs
      .readFile(jsonIn + "-settings.json")
      .then((data) => fs.writeFile(jsonOut + "-settings.json", data))
      .catch(() => "")
  );
  promises.push(
    fs
      .readFile(jsonIn + "-fit_contributions.json")
      .then((data) => fs.writeFile(jsonOut + "-fit_contributions.json", data))
      .catch(() => "")
  );

  await Promise.all(promises);

  return { signature, output };
}

function optimizeProgramBuffer(
  filepath: string,
  view: DataView,
  debugXml: xmlUtil.Document,
  apiDebugXml: xmlUtil.Document | null,
  key: crypto.KeyObject | undefined,
  config: BuildConfig | undefined
) {
  const { sections } = readPrgWithOffsets(view);
  logger("readprg", 5, sections);
  const symbolTable = new SymbolTable();
  if (hasProperty(sections, SectionKinds.SYMBOLS.toString())) {
    symbolTable.parse(sections[SectionKinds.SYMBOLS].view);
  }
  symbolTable.parseXml(debugXml);
  if (apiDebugXml) {
    symbolTable.parseXml(apiDebugXml);
  }
  const header = parseHeader(
    (sections[SectionKinds.HEADER] ?? sections[SectionKinds.HEADER_VERSIONED])
      .view
  );
  parseData(sections[SectionKinds.DATA].view, symbolTable);
  const lineTable = parseLineNum(sections[SectionKinds.LINENUM].view, debugXml);
  const exceptionsMap = parseExceptions(sections[SectionKinds.EXCEPTIONS].view);
  const bytecodes = parseCode(sections[SectionKinds.TEXT].view, lineTable);

  if (!config) config = {};
  const context: Context = {
    config,
    filepath,
    sections,
    bytecodes,
    header,
    lineTable,
    symbolTable,
    exceptionsMap,
    key,
    debugXml,
    nextOffset: bytecodes[bytecodes.length - 1]
      ? offsetAfter(bytecodes[bytecodes.length - 1])
      : 0,
    nextLocalId: 0,
  };
  optimizeBytecode(context);

  const signature = getPrgSignature(context);
  const buffers: Buffer[] = [];
  Object.values(sections)
    .sort((a, b) => a.offset - b.offset)
    .forEach((section) => {
      const view = section.view;
      buffers.push(
        Buffer.from(view.buffer, view.byteOffset - 8, view.byteLength + 8)
      );
    });

  // need 8 trailing zeros as a sentinel "section"
  buffers.push(Buffer.from(new ArrayBuffer(8)));
  return { signature, buffer: Buffer.concat(buffers) };
}

function optimizePackage(
  filepath: string,
  devKey?: string | undefined,
  output?: string,
  config?: BuildConfig
) {
  if (!devKey) {
    throw new Error(`Can't sign ${filepath} without a developer key`);
  }

  if (config?.allowForbiddenOpts) {
    config = { ...config, allowForbiddenOpts: false };
  }

  const inBase = path.basename(filepath, ".iq");

  if (!output) {
    output = path.join(path.dirname(filepath), inBase) + ".opt.iq";
  }

  const inName = inBase + ".prg";
  const outName = path.basename(output, ".iq") + ".prg";

  const rename = (name: string) =>
    path.basename(name) === inName
      ? path.join(path.dirname(name), outName)
      : name;

  const poolStarted = startPool();
  return Promise.all([
    getDevKey(devKey),
    getDeviceInfo().then((deviceInfo) =>
      Object.fromEntries(
        Object.entries(deviceInfo).flatMap(([id, info]) =>
          info.partNumbers.map((part) => [part.number, id] as const)
        )
      )
    ),
  ])
    .then(
      ([key, deviceInfo]) =>
        new Promise((resolve, reject) => {
          let manifest: string | null = null;
          const sigs: Map<string, Buffer> = new Map();
          const zipfile = new yazl.ZipFile();
          const pending: Map<
            string,
            {
              name: string;
              buffer: Buffer;
            }
          > = new Map();
          zipfile.outputStream
            .pipe(fscb.createWriteStream(output!))
            .on("close", () => {
              resolve({ output });
            });

          yauzl.open(filepath, { lazyEntries: true }, function (err, unzip) {
            if (err) {
              reject(err);
              return;
            }

            const promises: Promise<unknown>[] = [];
            const doOptimize = (
              prgName: string,
              prgBuffer: Buffer,
              xmlName: string,
              xmlBuffer: Buffer
            ) => {
              promises.push(
                runTaskInPool({
                  type: "optimizePrgAndDebug",
                  data: {
                    prgName,
                    prgBuffer: prgBuffer.buffer,
                    prgOffset: prgBuffer.byteOffset,
                    prgLength: prgBuffer.byteLength,
                    xmlName,
                    xmlBuffer: xmlBuffer.buffer,
                    xmlOffset: xmlBuffer.byteOffset,
                    xmlLength: xmlBuffer.byteLength,
                    key,
                    config,
                  },
                }).then(
                  ({
                    prgBuffer,
                    prgOffset,
                    prgLength,
                    sigBuffer,
                    sigOffset,
                    sigLength,
                    debugXml,
                  }) => {
                    if (
                      sigBuffer == null ||
                      sigOffset == null ||
                      sigLength == null
                    ) {
                      reject(
                        new Error(`Unable to generate signature for ${prgName}`)
                      );
                      unzip.close();
                      return;
                    }
                    const name = rename(prgName);
                    sigs.set(
                      name,
                      Buffer.from(sigBuffer, sigOffset, sigLength)
                    );
                    zipfile.addBuffer(
                      Buffer.from(prgBuffer, prgOffset, prgLength),
                      name
                    );
                    zipfile.addBuffer(Buffer.from(debugXml), xmlName);
                  }
                )
              );
            };

            unzip.readEntry();

            let hasSig2 = false;
            unzip.on("entry", function (entry) {
              if (/\/$/.test(entry.fileName)) {
                unzip.readEntry();
              } else {
                if (entry.fileName.startsWith("manifest.sig")) {
                  if (entry.fileName === "manifest.sig2") {
                    hasSig2 = true;
                  }
                  unzip.readEntry();
                  return;
                }
                unzip.openReadStream(entry, (err, readStream) => {
                  if (err) {
                    reject(err);
                    unzip.close();
                    return;
                  }
                  const buffers: Buffer[] = [];
                  readStream.on("end", function () {
                    unzip.readEntry();
                    const buffer = Buffer.concat(buffers);
                    if (entry.fileName === "manifest.xml") {
                      manifest = buffer.toString("utf-8");
                      return;
                    }
                    const dirname = path.dirname(entry.fileName);
                    if (/\.prg$/i.test(entry.fileName)) {
                      const p = pending.get(dirname);
                      if (p) {
                        doOptimize(entry.fileName, buffer, p.name, p.buffer);
                        pending.delete(dirname);
                      } else {
                        pending.set(dirname, {
                          name: entry.fileName,
                          buffer,
                        });
                      }
                      return;
                    }
                    if (/debug.xml$/i.test(entry.fileName)) {
                      const p = pending.get(dirname);
                      if (p) {
                        doOptimize(p.name, p.buffer, entry.fileName, buffer);
                        pending.delete(dirname);
                      } else {
                        pending.set(dirname, {
                          name: entry.fileName,
                          buffer,
                        });
                      }
                      return;
                    }
                    zipfile.addBuffer(buffer, entry.fileName);
                  });
                  readStream.on("data", (data: Buffer) => {
                    buffers.push(data);
                  });
                });
              }
            });

            unzip.on("end", async () => {
              try {
                if (!manifest) {
                  throw new Error("No manifest file found");
                }
                const xml = xmlUtil.parseXml(manifest);
                const body = xml.body;
                if (body instanceof Error) {
                  throw body;
                }
                await Promise.all(promises).then(() => {
                  body
                    .children("iq:application")
                    .children("iq:products")
                    .children("iq:product")
                    .attrs()
                    .forEach((attr) => {
                      const part = attr.partNumber?.value.value;
                      if (!part) {
                        throw new Error(
                          `Missing partNumber for product in manifest`
                        );
                      }
                      const id = deviceInfo[part];
                      if (!id) {
                        throw new Error(
                          `No id found for partNumber '${part}' in manifest`
                        );
                      }
                      const filename = attr.filename?.value.value;
                      if (!filename) {
                        throw new Error(
                          `Product ${id} was missing a filename in the manifest`
                        );
                      }
                      const newName = rename(filename);
                      const sig = sigs.get(newName);
                      if (!sig) {
                        throw new Error(
                          `${newName}, listed in the manifest for product ${id}, was not found`
                        );
                      }
                      if (!attr.sig) {
                        throw new Error(
                          `${newName}, listed in the manifest had no signature`
                        );
                      }
                      attr.filename!.value.value = newName;
                      attr.sig.value.value = sig
                        .subarray(0, 512)
                        .toString("hex")
                        .toUpperCase();
                      if (attr.sig2 && sig.length === 1024) {
                        attr.sig2.value.value = sig
                          .subarray(512)
                          .toString("hex")
                          .toUpperCase();
                      } else {
                        delete attr.sig2;
                      }
                    });
                  const contents = Buffer.from(xmlUtil.writeXml(xml));
                  zipfile.addBuffer(contents, "manifest.xml");
                  const contentView = new DataView(
                    contents.buffer,
                    contents.byteOffset,
                    contents.byteLength
                  );
                  zipfile.addBuffer(signView(key, contentView), "manifest.sig");
                  if (hasSig2) {
                    zipfile.addBuffer(
                      signView(key, contentView, "SHA256"),
                      "manifest.sig2"
                    );
                  }
                  zipfile.end();
                });
              } catch (e) {
                reject(e);
              }
            });
          });
        })
    )
    .finally(() => poolStarted && stopPool());
}

export function optimizePrgAndDebug(
  prgName: string,
  prgBuffer: ArrayBuffer,
  prgOffset: number,
  prgLength: number,
  xmlName: string,
  xmlBuffer: ArrayBuffer,
  xmlOffset: number,
  xmlLength: number,
  key: crypto.KeyObject,
  config: BuildConfig | undefined
) {
  const xmlString = Buffer.from(xmlBuffer, xmlOffset, xmlLength).toString();
  const debugXml = xmlUtil.parseXml(xmlString, xmlName);
  if (debugXml.body instanceof Error) {
    return Promise.reject(debugXml.body);
  }
  const result = optimizeProgramBuffer(
    prgName,
    new DataView(prgBuffer, prgOffset, prgLength),
    debugXml,
    null,
    key,
    config
  );
  return Promise.resolve({
    sigBuffer: result.signature?.buffer,
    sigOffset: result.signature?.byteOffset,
    sigLength: result.signature?.byteLength,
    prgBuffer: result.buffer.buffer,
    prgOffset: result.buffer.byteOffset,
    prgLength: result.buffer.byteLength,
    debugXml: Buffer.from(xmlUtil.writeXml(debugXml)).toString(),
  });
}
