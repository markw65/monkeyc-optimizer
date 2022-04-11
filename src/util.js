import * as child_process from "child_process";
import * as fsc from "fs";
import * as fs from "fs/promises";
import glob from "glob";
import * as path from "path";
import * as readline from "readline";

const isWin = process.platform == "win32";

export const appSupport = isWin
  ? `${process.env.APPDATA}`.replace(/\\/g, "/")
  : `${process.env.HOME}/Library/Application Support`;

export const connectiq = `${appSupport}/Garmin/ConnectIQ`;

export function getSdkPath() {
  return fs
    .readFile(connectiq + "/current-sdk.cfg")
    .then((contents) => contents.toString().replace(/^\s*(.*?)\s*$/s, "$1"));
}

export function globa(pattern, options) {
  return new Promise((resolve, reject) => {
    glob.glob(pattern, options, (er, files) => {
      if (er) {
        reject(files);
      } else {
        resolve(files);
      }
    });
  });
}

async function modified_times(inputs, missing) {
  return Promise.all(
    inputs.map(async (path) => {
      try {
        const stat = await fs.stat(path);
        return stat.mtimeMs;
      } catch (e) {
        return missing;
      }
    })
  );
}

export async function last_modified(inputs) {
  return Math.max(...(await modified_times(inputs, Infinity)));
}

export async function first_modified(inputs) {
  return Math.min(...(await modified_times(inputs, 0)));
}

// return a promise that will process the output of command
// line-by-line via lineHandler.
export function spawnByLine(command, args, lineHandler, options) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      ...(options || {}),
      shell: false,
    });
    const rl = readline.createInterface({
      input: proc.stdout,
    });
    proc.on("error", reject);
    proc.stderr.on("data", (data) => console.error(data.toString()));
    rl.on("line", lineHandler);
    proc.on("close", (code) => {
      if (code == 0) resolve();
      reject(code);
    });
  });
}

// return a promise that will process file
// line-by-line via lineHandler.
export function readByLine(file, lineHandler) {
  return fs.open(file, "r").then(
    (fh) =>
      new Promise((resolve, _reject) => {
        const stream = fh.createReadStream();
        const rl = readline.createInterface({
          input: stream,
        });
        rl.on("line", lineHandler);
        stream.on("close", resolve);
      })
  );
}

export async function promiseAll(promises, parallelism) {
  parallelism = parallelism || 4;
  const serializer = [];
  promises.forEach((p, i) => {
    if (serializer.length < parallelism) {
      serializer.push(p);
    } else {
      serializer[i % parallelism].then(() => p);
    }
  });
  return Promise.all(serializer);
}

export async function copyRecursiveAsNeeded(source, target, filter) {
  const fstat = fs.stat;
  const sstat = await fstat(source);
  if (sstat.isDirectory()) {
    const stat = await fstat(target).catch(() => null);

    if (!stat || !stat.isDirectory()) {
      stat && (await fs.rm(target, { force: true }));
      await fs.mkdir(target);
    }

    const files = await fs.readdir(source);
    return Promise.all(
      files.map((file) => {
        var src = path.join(source, file);
        var tgt = path.join(target, file);
        return copyRecursiveAsNeeded(src, tgt, filter);
      })
    );
  } else {
    if (filter && !filter(source, target)) {
      return;
    }
    const tstat = await fstat(target).catch(() => null);
    if (!tstat || tstat.mtimeMs < sstat.mtimeMs) {
      console.log(`Copying ${source} to ${target}...`);
      return fs.copyFile(source, target, fsc.constants.COPYFILE_FICLONE);
    }
  }
}
