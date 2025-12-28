import SevenZip from "7z-wasm";
import * as path from "node:path";

export type SevenZipHandler = {
  refresh: (filename: string, data?: Buffer) => void;
  writeArchive: (filepath: string, t?: string) => void;
};

export async function unzip7(
  filepath: string,
  process: (
    fileName: string,
    data: Buffer,
    refresh: (filename: string, data?: Buffer) => void
  ) => void
) {
  const output: string[] = [];
  const sevenZip = await SevenZip({
    print: (data) => {
      output.push(data);
      // console.log(`>>> ${data}`);
    },
    printErr: (_data) => {
      // console.error(`==> ${data}`);
    },
  });
  const refresh = (filename: string, data?: Buffer) =>
    data ? sevenZip.FS.writeFile(filename, data) : sevenZip.FS.unlink(filename);
  const mount = (filepath: string, mountRoot: string) => {
    sevenZip.FS.mkdir(mountRoot);
    sevenZip.FS.mount(
      sevenZip.NODEFS,
      {
        root: path.dirname(filepath),
      },
      mountRoot
    );
    return path.resolve(mountRoot, path.basename(filepath));
  };
  const tmpRoot = "/outdir";
  sevenZip.FS.mkdir(tmpRoot);
  sevenZip.FS.chdir(tmpRoot);
  const zippedFile = mount(filepath, "/nodefs-in");

  const findFiles = (path: string) => {
    const entries = sevenZip.FS.readdir(path);
    return entries.flatMap((entry): string | string[] => {
      if (entry === "." || entry === "..") {
        return [];
      }
      const full = path !== "." ? path + "/" + entry : entry;
      const stat = sevenZip.FS.stat(full, true);
      if (sevenZip.FS.isFile(stat.mode)) {
        return full;
      }
      if (sevenZip.FS.isDir(stat.mode)) {
        return findFiles(full);
      }
      return [];
    });
  };

  const type = output.reduce((type, line) => {
    const m = line.match(/^Type = (\S+)\s*$/);
    if (m) {
      type = m[1];
    }

    return type;
  }, "7z");
  sevenZip.callMain(["x", zippedFile]);

  const fileNames = findFiles(".");
  fileNames.forEach((filepath) => {
    const data = sevenZip.FS.readFile(filepath);
    process(
      filepath,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      refresh
    );
  });
  const writeArchive = (filepath: string, t?: string) => {
    const archive = mount(filepath, "/nodefs-out");
    try {
      sevenZip.FS.unlink(archive);
    } catch {
      /* the archive may not exist */
    }
    const files = findFiles(".");
    sevenZip.callMain(["a", `-t${t ?? type}`, "-ms=off", archive, ...files]);
  };
  return Promise.resolve<SevenZipHandler>({ refresh, writeArchive });
}
