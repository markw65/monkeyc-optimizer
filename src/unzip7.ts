import * as yauzl from "yauzl";
import SevenZip from "7z-wasm";
import * as path from "node:path";
export function unzipYauzl(
  filepath: string,
  process: (fileName: string, data: Buffer) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, function (err, unzip) {
      if (err) {
        reject(err);
        return;
      }

      unzip.readEntry();
      unzip.on("entry", function (entry) {
        if (/\/$/.test(entry.fileName)) {
          // it's a directory, just move on to the next file
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
            process(entry.fileName, buffer);
          });
          readStream.on("data", (data: Buffer) => {
            buffers.push(data);
          });
        });
      });

      unzip.on("end", () => {
        resolve();
      });
    });
  });
}

export async function unzip7(
  filepath: string,
  process: (fileName: string, data: Buffer) => void
): Promise<void> {
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
  const mountRoot = "/nodefs";
  const tmpRoot = "/outdir";
  sevenZip.FS.mkdir(mountRoot);
  sevenZip.FS.mkdir(tmpRoot);
  sevenZip.FS.mount(
    sevenZip.NODEFS,
    {
      root: path.dirname(filepath),
    },
    mountRoot
  );
  sevenZip.FS.chdir(tmpRoot);
  const zippedFile = path.resolve(mountRoot, path.basename(filepath));
  /*
   * It would be nice to use the `-ba` option and only get the lines describing
   * the contents of the archive, but there's a bug that causes some extra bogus
   * info on the first line that's hard to parse out.
   *
   * Instead, we get the full output, and look for the table separator lines,
   * which look like "-------- -- ------ (etc)"
   */
  sevenZip.callMain(["l", zippedFile]);
  const fileNames: string[] = [];
  output.reduce((enabled, line) => {
    if (/^[- ]{53,}$/.test(line)) {
      return !enabled;
    }
    if (enabled) {
      fileNames.push(line.substring(53));
    }
    return enabled;
  }, false);
  sevenZip.callMain(["x", zippedFile]);

  fileNames.forEach((filepath) => {
    const data = sevenZip.FS.readFile(filepath);
    process(
      filepath,
      Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    );
  });
  return Promise.resolve();
}
