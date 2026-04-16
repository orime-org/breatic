/**
 * BullMQ Worker entry point.
 *
 * Standalone process that consumes tasks from the "tasks" queue.
 * All shared modules (db, redis, services) come from @breatic/core.
 */

import { initLogger, createWorker, runMigrations, logger } from "@breatic/core";

initLogger("worker");
import { runTask } from "./handlers.js";
import type { TaskJobData } from "./handlers.js";

export function startWorker(): void {
  const worker = createWorker<TaskJobData>("tasks", runTask);

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, "job_completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, "job_failed");
  });

  logger.info("BullMQ worker started, listening on 'tasks' queue");
}

await runMigrations();
startWorker();
