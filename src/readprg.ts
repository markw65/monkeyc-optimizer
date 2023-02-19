import * as fscb from "fs";
import * as fs from "fs/promises";
import * as crypto from "node:crypto";
import * as path from "path";
import * as yauzl from "yauzl";
import * as yazl from "yazl";
import { hasProperty } from "./ast";
import {
  Context,
  optimizeBytecode,
  SectionInfo,
  SectionKinds,
} from "./readprg/bytecode";
import { parseData } from "./readprg/data";
import { parseExceptions } from "./readprg/exceptions";
import { parseLineNum } from "./readprg/linenum";
import { parseCode } from "./readprg/opcodes";
import { getDevKey, getPrgSignature, signView } from "./readprg/signer";
import { SymbolTable } from "./readprg/symbols";
import { xmlUtil } from "./sdk-util";
import { logger } from "./util";

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
  output?: string
) {
  if (/\.iq$/i.test(filepath)) {
    return optimizePackage(filepath, devKey, output);
  }
  if (!output) {
    output =
      path.join(path.dirname(filepath), path.basename(filepath, ".prg")) +
      ".opt.prg";
  }

  const xmlBytes = await fs.readFile(filepath + ".debug.xml").catch(() => "");
  const debugXml = xmlUtil.parseXml(xmlBytes.toString());

  const key = devKey ? await getDevKey(devKey) : undefined;

  const view = new DataView((await fs.readFile(filepath)).buffer);
  const { signature, buffer } = await optimizeProgramBuffer(
    filepath,
    view,
    debugXml,
    key
  );
  await fs.writeFile(output, buffer);

  if (!(debugXml.body instanceof Error)) {
    const contents = Buffer.from(xmlUtil.writeXml(debugXml));
    await fs.writeFile(output + ".debug.xml", contents);
  }

  return { signature, output };
}

export function optimizeProgramBuffer(
  filepath: string,
  view: DataView,
  debugXml: xmlUtil.Document,
  key: crypto.KeyObject | undefined
) {
  const { sections } = readPrgWithOffsets(view);
  logger("readprg", 5, sections);
  const symbolTable = new SymbolTable();
  if (hasProperty(sections, SectionKinds.SYMBOLS.toString())) {
    symbolTable.parse(sections[SectionKinds.SYMBOLS].view);
  }
  symbolTable.parseXml(debugXml);
  parseData(sections[SectionKinds.DATA].view, symbolTable);
  const lineTable = parseLineNum(sections[SectionKinds.LINENUM].view);
  const exceptionsMap = parseExceptions(sections[SectionKinds.EXCEPTIONS].view);
  const bytecodes = parseCode(sections[SectionKinds.TEXT].view);

  const context: Context = {
    filepath,
    sections,
    bytecodes,
    lineTable,
    symbolTable,
    exceptionsMap,
    key,
    debugXml,
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

  // need 8 trailing zeros as a sentinal "section"
  buffers.push(Buffer.from(new ArrayBuffer(8)));
  return { signature, buffer: Buffer.concat(buffers) };
}

function optimizePackage(
  filepath: string,
  devKey?: string | undefined,
  output?: string
) {
  if (!devKey) {
    throw new Error(`Can't sign ${filepath} without a developer key`);
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

  return getDevKey(devKey).then(
    (key) =>
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

          const doOptimize = (
            prgName: string,
            prgBuffer: Buffer,
            xmlName: string,
            xmlBuffer: Buffer
          ) => {
            const debugXml = xmlUtil.parseXml(xmlBuffer.toString(), xmlName);
            if (debugXml.body instanceof Error) {
              reject(debugXml.body);
              unzip.close();
              return;
            }
            const { buffer: outbuf, signature } = optimizeProgramBuffer(
              prgName,
              new DataView(prgBuffer.buffer),
              debugXml,
              key
            );
            if (!signature) {
              reject(new Error(`Unable to generate signature for ${prgName}`));
              unzip.close();
              return;
            }
            const name = rename(prgName);
            sigs.set(name, signature);
            zipfile.addBuffer(outbuf, name);
            const contents = Buffer.from(xmlUtil.writeXml(debugXml));
            zipfile.addBuffer(contents, xmlName);
          };

          unzip.readEntry();

          unzip.on("entry", function (entry) {
            if (/\/$/.test(entry.fileName)) {
              unzip.readEntry();
            } else {
              if (entry.fileName === "manifest.sig") {
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
                  if (/\.prg$/i.test(entry.fileName)) {
                    const p = pending.get(path.dirname(entry.fileName));
                    if (p) {
                      doOptimize(entry.fileName, buffer, p.name, p.buffer);
                    } else {
                      pending.set(path.dirname(entry.fileName), {
                        name: entry.fileName,
                        buffer,
                      });
                    }
                    return;
                  }
                  if (/debug.xml$/i.test(entry.fileName)) {
                    const p = pending.get(path.dirname(entry.fileName));
                    if (p) {
                      doOptimize(p.name, p.buffer, entry.fileName, buffer);
                    } else {
                      pending.set(path.dirname(entry.fileName), {
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

          unzip.on("end", () => {
            try {
              if (!manifest) {
                throw new Error("No manifest file found");
              }
              const xml = xmlUtil.parseXml(manifest);
              if (xml.body instanceof Error) {
                throw xml.body;
              }
              xml.body
                .children("iq:application")
                .children("iq:products")
                .children("iq:product")
                .attrs()
                .forEach((attr) => {
                  const id = attr.id?.value.value;
                  if (!id) {
                    throw new Error(
                      `Product with missing id found in manifest`
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
                  attr.sig.value.value = sig.toString("hex").toUpperCase();
                });
              const contents = Buffer.from(xmlUtil.writeXml(xml));
              zipfile.addBuffer(contents, "manifest.xml");
              const sig = signView(
                key,
                new DataView(
                  contents.buffer,
                  contents.byteOffset,
                  contents.byteLength
                )
              );
              zipfile.addBuffer(sig, "manifest.sig");
            } catch (e) {
              reject(e);
            }
            zipfile.end();
          });
        });
      })
  );
}
