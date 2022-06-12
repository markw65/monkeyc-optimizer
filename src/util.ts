import * as child_process from "child_process";
import * as fsc from "fs";
import * as fs from "fs/promises";
import * as glob from "glob";
import * as path from "path";
import * as readline from "readline";

// Write it this way so that webpack.DefinePlugin doesn't
// recognize global.lastModifiedSource.
// @ts-ignore
global["lastModifiedSource" + ""] = 0;

export function globa(
  pattern: string,
  options?: glob.IOptions
): Promise<Array<string>> {
  return new Promise((resolve, reject) => {
    glob.glob(pattern, options || {}, (er, files) => {
      if (er) {
        reject(files);
      } else {
        resolve(files);
      }
    });
  });
}

async function modified_times(inputs: string[], missing: number) {
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

export async function last_modified(inputs: string[]) {
  return Math.max(...(await modified_times(inputs, Infinity)));
}

export async function first_modified(inputs: string[]) {
  return Math.min(...(await modified_times(inputs, 0)));
}

export function pushUnique<T, U extends T>(arr: T[], value: U) {
  if (arr.find((v) => v === value) != null) return;
  arr.push(value);
}

export function sameArrays<T>(
  a1: T[],
  a2: T[],
  check: (a: T, b: T) => boolean
) {
  return a1.length === a2.length && a1.every((e, i) => check(e, a2[i]));
}

export type LineHandler = (line: string) => void;
// return a promise that will process the output of command
// line-by-line via lineHandlers.
export function spawnByLine(
  command: string,
  args: string[],
  lineHandlers: LineHandler | LineHandler[],
  options?: { [key: string]: unknown }
): Promise<void> {
  const [lineHandler, errHandler] = Array.isArray(lineHandlers)
    ? lineHandlers
    : [lineHandlers, (line: string) => console.error(line)];
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
export function readByLine(file: string, lineHandler: LineHandler) {
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

export async function promiseAll<T>(
  promiseFn: (i: number) => Promise<T>,
  parallelism: number
) {
  parallelism = parallelism || 4;
  const serializer = [];
  const results: T[] = [];
  let done = false;
  let i = 0;
  const next = (): Promise<T | null> | null => {
    const index = i++;
    if (done) return null;
    const promise = promiseFn(index);
    if (!promise) {
      done = true;
      return null;
    }
    return promise
      .then((r) => {
        results[index] = r;
      })
      .then(next);
  };
  while (i < parallelism) {
    serializer.push(next());
  }
  return Promise.all(serializer).then(() => results);
}

export async function copyRecursiveAsNeeded(
  source: string,
  target: string,
  filter?: (src: string, tgt: string) => boolean
): Promise<void> {
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
    ).then(() => {});
  } else {
    if (filter && !filter(source, target)) {
      return;
    }
    const tstat = await fstat(target).catch(() => null);
    if (!tstat || tstat.mtimeMs < sstat.mtimeMs) {
      return fs.copyFile(source, target, fsc.constants.COPYFILE_FICLONE);
    }
  }
}
