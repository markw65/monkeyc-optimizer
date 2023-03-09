import { AsyncResource } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import * as os from "node:os";
import type { WorkerTask, WorkerTaskResult } from "./worker-task";
import { performTask } from "./worker-task";

const kTaskInfo = Symbol("kTaskInfo");
const kWorkerFreedEvent = Symbol("kWorkerFreedEvent");

type Task = WorkerTask;
type TaskResult = unknown;
type TaskError = Error;
type TaskCallback = (err: TaskError | null, result: TaskResult | null) => void;
type RunTask = { task: Task; callback: TaskCallback };
type TaskWorker = Worker & { [kTaskInfo]?: WorkerPoolTaskInfo | null };

class WorkerPoolTaskInfo extends AsyncResource {
  constructor(private callback: TaskCallback) {
    super("WorkerPoolTaskInfo");
  }

  done(err: TaskError | null, result: TaskResult | null) {
    this.runInAsyncScope(this.callback, null, err, result);
    this.emitDestroy(); // `TaskInfo`s are used only once.
  }
}

class WorkerPool extends EventEmitter {
  public workers: TaskWorker[];
  public freeWorkers: TaskWorker[];
  public tasks: RunTask[];

  constructor(private numThreads: number) {
    super();
    this.numThreads = numThreads;
    this.workers = [];
    this.freeWorkers = [];
    this.tasks = [];

    for (let i = 0; i < numThreads; i++) this.addNewWorker();

    // Any time the kWorkerFreedEvent is emitted, dispatch
    // the next task pending in the queue, if any.
    this.on(kWorkerFreedEvent, () => {
      if (this.tasks.length > 0) {
        const { task, callback } = this.tasks.shift()!;
        this.runTask(task, callback);
      }
    });
  }

  addNewWorker() {
    const worker: TaskWorker = new Worker(
      //new URL("worker-thread.cjs", import.meta.url)
      `${__dirname}/worker-thread.cjs`
    );
    worker.on("message", (result) => {
      // In case of success: Call the callback that was passed to `runTask`,
      // remove the `TaskInfo` associated with the Worker, and mark it as free
      // again.
      worker[kTaskInfo]!.done(null, result);
      worker[kTaskInfo] = null;
      this.freeWorkers.push(worker);
      this.emit(kWorkerFreedEvent);
    });
    worker.on("error", (err) => {
      // In case of an uncaught exception: Call the callback that was passed to
      // `runTask` with the error.
      if (worker[kTaskInfo]) worker[kTaskInfo].done(err, null);
      else this.emit("error", err);
      // Remove the worker from the list and start a new Worker to replace the
      // current one.
      this.workers.splice(this.workers.indexOf(worker), 1);
      this.addNewWorker();
    });
    this.workers.push(worker);
    this.freeWorkers.push(worker);
    this.emit(kWorkerFreedEvent);
  }

  runTask(task: Task, callback: TaskCallback) {
    const worker = this.freeWorkers.pop();
    if (!worker) {
      // No free threads, wait until a worker thread becomes free.
      this.tasks.push({ task, callback });
      return;
    }

    worker[kTaskInfo] = new WorkerPoolTaskInfo(callback);
    worker.postMessage(task);
  }

  close() {
    for (const worker of this.workers) worker.terminate();
  }
}

let pool: WorkerPool | null = null;

export function startPool(parallelism?: number) {
  if (pool) return false;
  if (!parallelism) {
    parallelism = os.cpus().length;
    parallelism = parallelism / (parallelism > 4 ? 4 : 2);
  }
  const workers = Math.ceil(parallelism);
  if (workers <= 1) return false;
  pool = new WorkerPool(workers);
  return true;
}

export function stopPool() {
  if (pool) {
    pool.close();
    pool = null;
  }
}

export function runTaskInPool<T extends WorkerTask>(
  task: T
): Promise<WorkerTaskResult<T>> {
  const p = pool;
  if (p) {
    return new Promise((resolve, reject) =>
      p.runTask(task, (err, result) => {
        if (err) reject(err);
        else resolve(result as WorkerTaskResult<T>);
      })
    );
  }
  return performTask(task);
}
