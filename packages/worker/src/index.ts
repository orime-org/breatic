/**
 * BullMQ Worker entry point.
 *
 * Standalone process that consumes tasks from the "tasks" queue.
 * All shared modules (db, redis, services) come from @breatic/core.
 */

import {
  initLogger,
  createWorker,
  checkInfraReady,
  logger,
  getRedis,
  rawPg,
  startHealthServer,
} from "@breatic/core";

initLogger("worker");
import { runTask } from "./handlers.js";
import type { TaskJobData } from "./handlers.js";

const HEALTH_PORT = Number(process.env["WORKER_HEALTH_PORT"] ?? "9101");

export function startWorker(): void {
  const worker = createWorker<TaskJobData>("tasks", runTask);

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, "job_completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, error: err.message }, "job_failed");
  });

  logger.info("BullMQ worker started, listening on 'tasks' queue");

  // Health probe — docker / LB / k8s healthcheck kills the
  // instance on N consecutive 503s so a worker whose Redis or
  // Postgres pool has drifted is replaced automatically. Per
  // CLAUDE.md "服务器端工业级标准" mandate.
  startHealthServer({
    port: HEALTH_PORT,
    serviceName: "worker",
    checks: [
      {
        name: "redis_general",
        check: async () => (await getRedis().ping()) === "PONG",
      },
      {
        name: "postgres",
        check: async () => {
          const rows = await rawPg<Array<{ ok: number }>>`SELECT 1 AS ok`;
          return rows[0]?.ok === 1;
        },
      },
    ],
  });
}

// Fail-fast: verify PG + Redis are reachable before consuming jobs.
await checkInfraReady();
startWorker();
