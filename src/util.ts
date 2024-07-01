import * as child_process from "child_process";
import glob from "fast-glob";
import * as fsc from "fs";
import * as fs from "fs/promises";
import * as path from "path";
import PriorityQueue from "priorityqueuejs";
import * as readline from "readline";

export {
  bumpLogging,
  log,
  logPromise,
  logger,
  setBanner,
  wouldLog,
} from "./logger";

export function globa(
  pattern: string,
  options?: glob.Options & { mark?: boolean }
): Promise<Array<string>> {
  if (options?.mark) {
    options.markDirectories = true;
    options.onlyFiles = false;
  }
  return glob(pattern.replace(/\\/g, "/"), options || {});
}

export function globSome(
  pattern: string,
  predicate: (path: string) => boolean,
  options?: glob.Options & { mark?: boolean }
): Promise<boolean> {
  return new Promise<boolean>((resolve, _reject) => {
    const stream = glob.stream(
      pattern.replace(/\\/g, "/"),
      options || {}
    ) as NodeJS.ReadableStream & {
      destroy: () => void;
    };
    let result = false;
    const resolver = () => {
      resolve(result);
    };
    stream.on("close", resolver);
    stream.on("data", (str: string) => {
      if (predicate(str)) {
        result = true;
        stream.destroy();
      }
    });
  });
}

export function forEach<T>(
  val: T | T[] | null | undefined,
  fn: (v: T) => void
) {
  if (!val) return;
  if (Array.isArray(val)) {
    val.forEach(fn);
  } else {
    fn(val);
  }
}

export function map<T, U>(val: T | T[] | null | undefined, fn: (v: T) => U) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.map(fn);
  } else {
    return [fn(val)];
  }
}

export function every<T>(
  val: T | T[] | null | undefined,
  fn: (v: T) => boolean
) {
  if (!val) return true;
  if (Array.isArray(val)) {
    return val.every(fn);
  } else {
    return fn(val);
  }
}

export function some<T>(
  val: T | T[] | null | undefined,
  fn: (v: T) => boolean
) {
  if (!val) return false;
  if (Array.isArray(val)) {
    return val.some(fn);
  } else {
    return fn(val);
  }
}

export function reduce<T, U>(
  val: T | T[] | null | undefined,
  fn: (p: U, v: T) => U,
  init: U
) {
  if (!val) return init;
  if (Array.isArray(val)) {
    return val.reduce(fn, init);
  } else {
    return fn(init, val);
  }
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
  if (arr.find((v) => v === value) != null) return false;
  arr.push(value);
  return true;
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
      if (code === 0) resolve();
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
  promiseFn: (i: number) => Promise<T> | null,
  parallelism: number
) {
  parallelism = parallelism || 4;
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
  const serializer: ReturnType<typeof next>[] = [];
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
  if (filter && !filter(source, target)) {
    return;
  }
  if (sstat.isDirectory()) {
    const stat = await fstat(target).catch(() => null);

    if (!stat || !stat.isDirectory()) {
      stat && (await fs.rm(target, { force: true }));
      await fs.mkdir(target, { recursive: true });
    }

    const files = await fs.readdir(source);
    return Promise.all(
      files.map((file) => {
        const src = path.join(source, file);
        const tgt = path.join(target, file);
        return copyRecursiveAsNeeded(src, tgt, filter);
      })
    ).then(() => {
      return;
    });
  } else {
    const tstat = await fstat(target).catch(() => null);
    if (!tstat || tstat.mtimeMs < sstat.mtimeMs) {
      return fs.copyFile(source, target, fsc.constants.COPYFILE_FICLONE);
    }
  }
}

export function popcount(x: number) {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  x += x >> 8;
  x += x >> 16;

  return x & 0x7f;
}

export class GenericQueue<Block> {
  private enqueued = new Set<Block>();
  private queue;
  constructor(sort: (a: Block, b: Block) => number) {
    this.queue = new PriorityQueue<Block>(sort);
  }
  enqueue(block: Block) {
    if (!this.enqueued.has(block)) {
      this.enqueued.add(block);
      this.queue.enq(block);
    }
  }
  dequeue() {
    const block = this.queue.deq();
    this.enqueued.delete(block);
    return block;
  }
  empty() {
    return this.queue.isEmpty();
  }
}

export class AwaitedError extends Error {
  constructor(private messagePromise: Promise<string>) {
    super();
  }
  resolve() {
    return this.messagePromise.then((message) => {
      this.message = message;
      return this;
    });
  }
}
