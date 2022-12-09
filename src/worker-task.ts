import {
  BuildConfig,
  buildOptimizedProject,
  generateOptimizedProject,
} from "./optimizer";

interface BaseNode {
  type: string;
  data: unknown;
}

interface BuildOptimizedProject extends BaseNode {
  type: "buildOptimizedProject";
  data: { product: string | null; options: BuildConfig };
}

interface GenerateOptimizedProject extends BaseNode {
  type: "generateOptimizedProject";
  data: { options: BuildConfig };
}

export type WorkerTask = BuildOptimizedProject | GenerateOptimizedProject;

export const workerTaskHandlers = {
  buildOptimizedProject(data: BuildOptimizedProject["data"]) {
    return buildOptimizedProject(data.product, data.options);
  },
  generateOptimizedProject(data: GenerateOptimizedProject["data"]) {
    return generateOptimizedProject(data.options);
  },
} as const;

type RemovePromise<T> = T extends Promise<infer U> ? U : T;

export type WorkerTaskResult<T> = T extends WorkerTask
  ? RemovePromise<ReturnType<typeof workerTaskHandlers[T["type"]]>>
  : never;

export async function performTask<T extends WorkerTask>(
  task: T
): Promise<WorkerTaskResult<T>> {
  const type: T["type"] = task.type;
  const handler: false | undefined | ((data: unknown) => WorkerTaskResult<T>) =
    Object.prototype.hasOwnProperty.call(workerTaskHandlers, type) &&
    (workerTaskHandlers[type] as (data: unknown) => WorkerTaskResult<T>);
  if (!handler) {
    throw new Error(`Invalid task type ${type}`);
  }
  return handler(task.data);
}
