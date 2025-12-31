import SevenZip from "7z-wasm";
import * as path from "node:path";

export type SevenZipHandler = {
  refresh: (filename: string, data?: Buffer) => void;
  writeArchive: (filepath: string, t?: string) => void;
};

export async function unzip7(
  filepath: string,
  destination: string
): Promise<null>;
export async function unzip7(
  filepath: string,
  process: (
    fileName: string,
    data: Buffer<ArrayBuffer>,
    refresh: (filename: string, data?: Buffer) => void
  ) => void
): Promise<SevenZipHandler>;
export async function unzip7(
  filepath: string,
  destinationOrProcess:
    | string
    | ((
        fileName: string,
        data: Buffer<ArrayBuffer>,
        refresh: (filename: string, data?: Buffer) => void
      ) => void)
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
    return path.posix.resolve(mountRoot, path.basename(filepath));
  };
  const tmpRoot = "/outdir";
  const zippedFile = mount(filepath, "/nodefs-in");

  if (typeof destinationOrProcess === "string") {
    const output = mount(destinationOrProcess, tmpRoot);
    sevenZip.callMain(["x", `-o${output}`, zippedFile]);
    return Promise.resolve(null);
  }

  sevenZip.FS.mkdir(tmpRoot);
  sevenZip.FS.chdir(tmpRoot);
  sevenZip.callMain(["x", zippedFile]);

  const findFiles = (dirpath: string) => {
    const entries = sevenZip.FS.readdir(dirpath);
    return entries.flatMap((entry): string | string[] => {
      if (entry === "." || entry === "..") {
        return [];
      }
      let full = path.posix.join(dirpath !== "." ? dirpath : "", entry);
      if (entry.includes("\\")) {
        const tmp = full.replace(/\\/g, "/");
        try {
          sevenZip.FS.mkdir(path.posix.dirname(tmp));
        } catch {
          /* directory may already exist */
        }
        sevenZip.FS.rename(full, tmp);
        full = tmp;
      }
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

  const fileNames = findFiles(".");
  fileNames.forEach((filepath) => {
    const data = sevenZip.FS.readFile(filepath) as Uint8Array<ArrayBuffer>;
    destinationOrProcess(
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
    const args = ["-ms=off"];
    if (process.platform !== "win32") {
      args.push(`-t${t ?? type}`);
    }
    sevenZip.callMain(["a", ...args, archive, ...files]);
  };
  return Promise.resolve<SevenZipHandler>({ refresh, writeArchive });
}
