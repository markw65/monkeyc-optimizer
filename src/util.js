import * as child_process from "child_process";
import * as fsc from "fs";
import * as fs from "fs/promises";
import glob from "glob";
import * as path from "path";
import * as readline from "readline";

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

export function pushUnique(arr, value) {
  if (arr.find((v) => v === value) != null) return;
  arr.push(value);
}

// return a promise that will process the output of command
// line-by-line via lineHandlers.
export function spawnByLine(command, args, lineHandlers, options) {
  const [lineHandler, errHandler] = Array.isArray(lineHandlers)
    ? lineHandlers
    : [lineHandlers, (data) => console.error(data.toString())];
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      ...(options || {}),
      shell: false,
    });
    const rl = readline.createInterface({
      input: proc.stdout,
    });
    const rle = readline.createInterface({
      input: proc.stderr,
    });
    proc.on("error", reject);
    rle.on("line", errHandler);
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
  const results = [];
  const capture = (r, i) => (results[i] = r);
  promises.forEach((p, i) => {
    const cap = () => p.then((r) => capture(r, i));
    if (serializer.length < parallelism) {
      serializer.push(cap());
    } else {
      serializer[i % parallelism] = serializer[i % parallelism].then(cap);
    }
  });
  return Promise.all(serializer).then(() => results);
}

export async function copyRecursiveAsNeeded(source, target, filter) {
  const fstat = fs.stat;
  const sstat = await fstat(source);
  if (sstat.isDirectory()) {
    const stat = await fstat(target).catch(() => null);

    if (!stat || !stat.isDirectory()) {
      stat && (await fs.rm(target, { force: true }));
      await fs.mkdir(target, { recursive: true });
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
