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
  const health = startHealthServer({
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

  // Graceful shutdown — per CLAUDE.md "服务器端工业级标准"
  // mandate any long-running process must drain in-flight work
  // before exiting on SIGTERM. BullMQ's `worker.close(force?)`
  // (force=false, the default) stops accepting new jobs and
  // waits for the currently-running job's handler to resolve,
  // which is exactly what docker `stop --time=30` / k8s
  // preStop expects. SIGINT (Ctrl+C in dev) follows the same
  // path so `pnpm dev:worker` shutdown in a terminal isn't
  // SIGKILL-equivalent either.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker_shutdown_starting");
    try {
      // Stop health probe first so the LB stops sending traffic
      // to this instance while it drains the in-flight job;
      // failing health early is the explicit signal to the LB
      // "rotate me out".
      await health.stop();
      // Then ask BullMQ to drain. `close()` resolves once the
      // current job (if any) has finished and the connection
      // is closed — safe even if no job is running.
      await worker.close();
      logger.info("worker_shutdown_complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "worker_shutdown_error");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Fail-fast: verify PG + Redis are reachable before consuming jobs.
await checkInfraReady();
startWorker();
