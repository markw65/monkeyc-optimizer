import { parentPort } from "node:worker_threads";
import { performTask, WorkerTask } from "./worker-task";

if (parentPort) {
  parentPort.on("message", async (task: WorkerTask) => {
    return parentPort!.postMessage(await performTask(task));
  });
}
