/**
 * BullMQ Worker entry point.
 *
 * Standalone process that consumes tasks from the "tasks" queue.
 * Shared modules (db, redis, services) come from @breatic/core.
 */

import { createWorker, runMigrations, logger } from "@breatic/core";
import { runTask } from "./handlers.js";
import type { TaskJobData } from "./handlers.js";

/** Start the task worker. */
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
