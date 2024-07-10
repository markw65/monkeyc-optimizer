import * as crypto from "node:crypto";
import { JungleQualifier } from "./jungles";
import {
  BuildConfig,
  buildOptimizedProject,
  generateOneConfig,
  generateOptimizedProject,
} from "./optimizer";
import { optimizePrgAndDebug } from "./readprg";
import { xmlUtil } from "./sdk-util";
import { logPromise } from "./logger";

interface BaseNode {
  type: string;
  data: unknown;
}

interface BuildOptimizedProject extends BaseNode {
  type: "buildOptimizedProject";
  data: { product: string | null; options: BuildConfig };
}

interface GenerateOneConfig extends BaseNode {
  type: "generateOneConfig";
  data: {
    buildConfig: JungleQualifier;
    manifestXML: xmlUtil.Document;
    dependencyFiles: string[];
    config: BuildConfig;
    key: string;
  };
}

interface GenerateOptimizedProject extends BaseNode {
  type: "generateOptimizedProject";
  data: { options: BuildConfig };
}

interface OptimizePrgAndDebug extends BaseNode {
  type: "optimizePrgAndDebug";
  data: {
    prgName: string;
    prgBuffer: ArrayBuffer;
    prgOffset: number;
    prgLength: number;
    xmlName: string;
    xmlBuffer: ArrayBuffer;
    xmlOffset: number;
    xmlLength: number;
    key: crypto.KeyObject;
    config: BuildConfig | undefined;
  };
}

export type WorkerTask =
  | BuildOptimizedProject
  | GenerateOptimizedProject
  | GenerateOneConfig
  | OptimizePrgAndDebug;

function restoreQualifier(qualifier: JungleQualifier) {
  if (qualifier.resourceMap) {
    Object.values(qualifier.resourceMap).forEach((doc) => restoreDocument(doc));
  }
  if (qualifier.barrelMap) {
    Object.values(qualifier.barrelMap).forEach((barrel) => {
      restoreQualifier(barrel.qualifier);
      restoreDocument(barrel.xml);
    });
  }
}

function restoreDocument(obj: unknown) {
  Object.setPrototypeOf(obj, xmlUtil.Document.prototype);
  const doc = obj as xmlUtil.Document;
  if ((doc.body as { elements?: Array<xmlUtil.Element> }).elements) {
    Object.setPrototypeOf(doc.body, xmlUtil.Nodes.prototype);
  } else {
    Object.setPrototypeOf(doc.body, Error.prototype);
  }
}

export const workerTaskHandlers = {
  buildOptimizedProject(data: BuildOptimizedProject["data"]) {
    return buildOptimizedProject(data.product, data.options);
  },
  generateOptimizedProject(data: GenerateOptimizedProject["data"]) {
    return generateOptimizedProject(data.options);
  },
  generateOneConfig(data: GenerateOneConfig["data"]) {
    restoreQualifier(data.buildConfig);
    if (data.manifestXML) {
      restoreDocument(data.manifestXML);
    }
    return generateOneConfig(
      data.buildConfig,
      data.manifestXML,
      data.dependencyFiles,
      data.config,
      data.key
    );
  },
  optimizePrgAndDebug(data: OptimizePrgAndDebug["data"]) {
    return optimizePrgAndDebug(
      data.prgName,
      data.prgBuffer,
      data.prgOffset,
      data.prgLength,
      data.xmlName,
      data.xmlBuffer,
      data.xmlOffset,
      data.xmlLength,
      data.key,
      data.config
    );
  },
} as const;

type RemovePromise<T> = T extends Promise<infer U> ? U : T;

export type WorkerTaskResult<T> = T extends WorkerTask
  ? RemovePromise<ReturnType<(typeof workerTaskHandlers)[T["type"]]>>
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
  return Promise.resolve(handler(task.data)).then((result) =>
    logPromise.then(() => result)
  );
}
