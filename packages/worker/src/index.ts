// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * BullMQ Worker entry point.
 *
 * Standalone process that consumes tasks from the "tasks" queue.
 * All shared modules (db, redis, services) come from `@breatic/core`.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@worker/bootstrap-config.js";
import {
  env,
  initLogger,
  createWorker,
  createQueue,
  createQueueEvents,
  checkInfraReady,
  InfraNotReadyError,
  logger,
  getRedis,
  getQueueRedis,
  getStreamRedis,
  pingDb,
  pingRedis,
  yjsRawPg,
  startHealthServer,
  runGracefulShutdown,
} from "@breatic/core";

initLogger("worker");
import { runTask } from "@worker/handlers/dispatch.js";
import { reclaimFailedJobById } from "@worker/handlers/failed-job-cleanup.js";

/** Cap graceful shutdown so a stuck drain can't hold the process. */
const SHUTDOWN_DEADLINE_MS = 4000;
import type { TaskJobData } from "@worker/handlers/dispatch.js";

// Health probe port from the validated config (default 9101).
const HEALTH_PORT = env.WORKER_HEALTH_PORT;

/**
 * Start the worker process: install production error logging on the shared
 * Redis singletons, then begin consuming the BullMQ task queue.
 */
export function startWorker(): void {
  // Production error logging for shared Redis singletons. The core
  // `createRedisClient` factory installs a no-op `error` listener so
  // emitted errors don't crash the process; the application entry is
  // responsible for the real logging per the "core and shared must not log" mandate.
  for (const [client, instance] of [
    ["general", getRedis()],
    ["queue", getQueueRedis()],
  ] as const) {
    instance.on("error", (err) => {
      logger.error({ err, client }, "redis_error");
    });
  }

  const worker = createWorker<TaskJobData>("tasks", runTask);

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id, taskId: job.data.taskId }, "job_completed");
  });

  // Local telemetry only. The node write-back is NOT done here:
  // `worker.on('failed')` is process-local, so it cannot cover the case
  // this net exists for — a worker that hard-crashed runs no callback. The
  // cross-process `QueueEvents` handler below owns the write-back (#1580 #6).
  worker.on("failed", (job, err) => {
    // #1628: attempt counters make retry progression visible ("attempt 2/3"),
    // distinguishing a retry-in-progress from a terminal failure in logs.
    logger.error(
      {
        jobId: job?.id,
        error: err.message,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "job_failed",
    );
  });

  // #1569 hole ② / #1580 #6 — cross-process failed-job node write-back.
  // `QueueEvents` 'failed' reaches every LIVE instance (a Worker callback
  // dies with its process), so a job whose own worker crashed is still
  // cleaned up here. The event carries only { jobId, failedReason }; we
  // re-fetch the job (retained by `removeOnFail` age) via a read-side Queue
  // for its data + terminal `finishedOn`. Runs once per instance (idempotent
  // + gen-fenced, #1580 #7); the collab lease sweeper is the final backstop.
  const tasksQueue = createQueue("tasks");
  const queueEvents = createQueueEvents("tasks");
  queueEvents.on("failed", ({ jobId, failedReason }) => {
    void reclaimFailedJobById(tasksQueue, getStreamRedis(), jobId, failedReason)
      .then((emitted) => {
        if (emitted > 0) {
          logger.warn(
            { jobId, emitted, reason: "failed_job_node_cleanup" },
            "failed_job_nodes_reclaimed",
          );
        }
      })
      .catch((cleanupErr) => {
        logger.error(
          { err: cleanupErr, jobId },
          "failed_job_node_cleanup_error",
        );
      });
  });

  logger.info("BullMQ worker started, listening on 'tasks' queue");

  // Health probe - docker / LB / k8s healthcheck kills the
  // instance on N consecutive 503s so a worker whose Redis or
  // Postgres pool has drifted is replaced automatically. Per
  // CLAUDE.md "industrial-grade server standards" mandate.
  const health = startHealthServer({
    port: HEALTH_PORT,
    serviceName: "worker",
    // Forward health-server lifecycle events to our logger. Per
    // CLAUDE.md "core and shared must not log" mandate, the library
    // emits events; the application entry routes them.
    onEvent: (event) => {
      if (event.type === "listening") {
        logger.info(
          { service: event.serviceName, port: event.port },
          "healthz_listening",
        );
      } else if (event.type === "check_fail") {
        logger.warn(
          { service: event.serviceName, checks: event.checks },
          "healthz_fail",
        );
      } else if (event.type === "handler_unexpected_error") {
        logger.error(
          { service: event.serviceName, err: event.err },
          "healthz_handler_unexpected_error",
        );
      } else if (event.type === "listen_error") {
        logger.fatal(
          { service: event.serviceName, port: event.port, err: event.err },
          "healthz_listen_error",
        );
        process.exit(1);
      }
    },
    checks: [
      {
        name: "redis_general",
        // Single PING liveness helper, shared across all services.
        check: () => pingRedis(getRedis()),
      },
      {
        name: "postgres",
        // Single SELECT-1 liveness helper, shared across all services.
        check: () => pingDb(),
      },
      {
        name: "postgres_yjs",
        // Liveness for the separate Yjs-store Postgres DB.
        check: () => pingDb(yjsRawPg),
      },
    ],
  });

  // Graceful shutdown - per CLAUDE.md "industrial-grade server standards"
  // mandate any long-running process must drain in-flight work
  // before exiting on SIGTERM. BullMQ's `worker.close(force?)`
  // (force=false, the default) stops accepting new jobs and
  // waits for the currently-running job's handler to resolve,
  // which is exactly what docker `stop --time=30` / k8s
  // preStop expects. SIGINT (Ctrl+C in dev) follows the same
  // path so `pnpm dev:worker` shutdown in a terminal isn't
  // SIGKILL-equivalent either.
  /**
   * Drain the worker and health probe, then exit, on a termination signal.
   * @param signal - The received signal name (e.g. "SIGTERM", "SIGINT")
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "worker_shutdown_starting");
    // Stop health probe first so the LB rotates this instance out, then ask
    // BullMQ to drain (its `close()` resolves once the in-flight job, if any,
    // has finished). Bounded by the shared deadline so a stuck close can't hold
    // the process past the grace window.
    await health.stop();
    await runGracefulShutdown({
      releaseListenSocket: () => {},
      drains: [() => worker.close()],
      deadlineMs: SHUTDOWN_DEADLINE_MS,
    });
    logger.info("worker_shutdown_complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Fail-fast: verify PG + Redis are reachable before consuming jobs.
// `checkInfraReady` throws InfraNotReadyError per the "process lifecycle (forbidden in the library layer)" mandate - application entry catches, logs, exits.
try {
  await checkInfraReady({
    general: getRedis(),
    queue: getQueueRedis(),
    stream: getStreamRedis(),
  });
} catch (err) {
  if (err instanceof InfraNotReadyError) {
    logger.error(
      { component: err.component, hint: err.hint, err: err.cause },
      "infra_not_ready",
    );
  } else {
    logger.error({ err }, "infra_check_unexpected_error");
  }
  process.exit(1);
}
startWorker();
