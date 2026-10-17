// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * BullMQ Worker entry point.
 *
 * Standalone process that consumes tasks from the "tasks" queue.
 * All shared modules (db, redis, services) come from `@breatic/core`.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@worker/bootstrap-config.js";
import { exitProcess, initSentry } from "@worker/sentry.js";
import {
  env,
  initLogger,
  loadLocales,
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
  getAgentConfig,
  assertKnownQueues,
  installDeadlineBoundDispatcher,
  flushServerAnalytics,
  adsConversionState,
  initServerAnalytics,
  ADS_CONVERSION_QUEUE,
  scheduleAdsUploadSweep,
  unscheduleAdsUploadSweep,
  adsConversionConfig,
  type AdsConversionJob,
} from "@breatic/core";
import { googleDataManagerSink, runAdsConversion, type AdsConversionSink } from "@worker/handlers/ads-conversion.js";
import {
  modelCatalog,
  USAGE_LOOKUP_QUEUE,
  MEDIA_READ_QUEUE,
  MAIL_QUEUE,
  UPLOAD_FINISH_QUEUE,
  type MailJob,
  type MediaReadJob,
  type UploadFinishJob,
  type UsageLookupJob,
} from "@breatic/domain";

// Error monitoring starts before the first log line, so error logs from the
// config checks below are already reported.
const monitoring = initSentry();

initLogger("worker");
if (monitoring === "invalid_dsn") logger.error({}, "sentry_dsn_invalid");
const analytics = initServerAnalytics({
  apiKey: env.AMPLITUDE_API_KEY,
  onError: (message) => {
    logger.warn({ message }, "analytics_events_rejected");
  },
});
if (analytics === "invalid") logger.error({}, "amplitude_api_key_invalid");
if (adsConversionState() === "invalid") logger.error({}, "google_ads_config_invalid");
// i18n: register the catalogs before anything can throw. `t()` echoes the key
// back when no catalog is loaded, so without this a failed node reads a
// message key where a sentence belongs.
//
// The sentence is English whoever is looking, and deliberately so. A job has
// no request behind it, so nothing pins a locale the way `localeMiddleware`
// does for the server; and a node's `errorMessage` goes into the Yjs doc every
// collaborator reads, which must not carry one person's language — the same
// rule `CanvasSpace.tsx` states for the upload path. Loading the catalogs buys
// a sentence instead of a key, not a translated one.
loadLocales();


// Route the AI SDK's warnings into our logger. Without this the SDK writes
// them to console, and our logs are JSON on disk — console output lands
// nowhere anyone reads at 3am. Warnings are exactly what matters then: a
// provider silently dropping a parameter, a model ignoring a setting. The
// call still succeeds, so nothing else says so.
globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
  logger.warn({ warnings, provider, model }, "ai_sdk_warning");
};

// Read config/agent.yaml now rather than on the first job: the model calls a
// job makes read their retry count from it (`llm_max_retries`). A file that no
// longer parses would otherwise surface as a job failure BullMQ retries into
// the same wall.
try {
  getAgentConfig();
} catch (err) {
  logger.error({ err }, "agent_config_invalid");
  await exitProcess(1);
}

// Same preflight for config/models/*.yaml (#1966). Every model must declare
// `takes_prompt`, and the catalog is lazy like agent.yaml above —
// lazy here means a missing declaration surfaces inside whichever job first
// resolves a model, which BullMQ then retries into the same wall. Loading it
// here puts that in front of whoever edited the file.
try {
  modelCatalog.getModelCatalog();
} catch (err) {
  logger.error({ err }, "model_catalog_invalid");
  await exitProcess(1);
}
import { runTask } from "@worker/handlers/dispatch.js";
import { reclaimFailedJobById } from "@worker/handlers/failed-job-cleanup.js";
import { runUrlIngest, type UrlIngestJobData } from "@worker/handlers/url-ingest.js";
import { settleStalledIngest } from "@worker/handlers/abort-ingest.js";
import { runUsageLookup } from "@worker/handlers/usage-lookup.js";
import { runMediaRead } from "@worker/handlers/media-read.js";
import { runUploadFinish } from "@worker/handlers/upload-finish.js";
import { runMail } from "@worker/handlers/mail.js";

/** Every BullMQ queue this process runs a worker for. */
const WORKER_QUEUES: readonly string[] = [
  "tasks",
  "url-ingest",
  UPLOAD_FINISH_QUEUE,
  USAGE_LOOKUP_QUEUE,
  MEDIA_READ_QUEUE,
  MAIL_QUEUE,
  ADS_CONVERSION_QUEUE,
];

/** Cap graceful shutdown so a stuck drain can't hold the process. */
const SHUTDOWN_DEADLINE_MS = 4000;
import type { TaskJobData } from "@worker/handlers/dispatch.js";
import type { Job } from "bullmq";

// Health probe port from the validated config (default 9101).
const HEALTH_PORT = env.WORKER_HEALTH_PORT;

/**
 * Settle a failed ingest job whose handler never ran because it stalled; a
 * failure to settle is logged, since a failed listener has no caller to tell.
 * @param job - The failed job, when the queue still has it.
 */
function settleWhenStalled(job: Job<{ storageKey: string }> | undefined): void {
  if (job === undefined) return;
  settleStalledIngest(job).catch((err: unknown) => {
    logger.error(
      { err, queue: job.queueName, jobId: job.id, key: job.data.storageKey },
      "ingest_stalled_settle_failed",
    );
  });
}

/**
 * Start the worker process: install production error logging on the shared
 * Redis singletons, then begin consuming the BullMQ task queue.
 */
export function startWorker(): void {
  // Every call this process makes on a task's chain is bounded by the task's
  // own deadline (inner#1367), so undici's 300-second wait for an answer must
  // not cut one first.
  installDeadlineBoundDispatcher();

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

  // A per-queue figure for a queue this process does not run is a typo that
  // would leave the queue it meant at the default.
  assertKnownQueues(WORKER_QUEUES);

  const worker = createWorker<TaskJobData>("tasks", runTask);

  // Its own queue, because `runTask` is a generation: past the dispatch it
  // records a provider result, bills the studio and writes a generation
  // activity row whatever ran, and none of those belong to a pasted link.
  //
  // Delivered once. `attempts` bounds retries after a throw; a worker judged
  // to have died is counted separately, and a re-run there is a second full
  // transfer of what may be two gigabytes, against a grant the first run may
  // already have settled.
  const urlIngest = createWorker<UrlIngestJobData>(
    "url-ingest",
    runUrlIngest,
    { maxStalledCount: 0 },
  );

  urlIngest.on("failed", (job, err) => {
    logger.error(
      { err, jobId: job?.id, key: job?.data.storageKey },
      "url_ingest_job_failed",
    );
    // Any failure other than a stall is the handler's own settling failing;
    // the node keeps a running row until its deadline.
    settleWhenStalled(job);
  });

  // Finishing a browser upload (inner#1367 §4.2a). Delivered again after a
  // process goes away: the Worker answers a repeat of the same upload from the
  // object it already assembled, and registration answers a registered grant
  // as already registered.
  const uploadFinish = createWorker<UploadFinishJob>(UPLOAD_FINISH_QUEUE, (job) =>
    runUploadFinish(job),
  );

  uploadFinish.on("failed", (job, err) => {
    logger.error(
      {
        err,
        key: job?.data.storageKey,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "upload_finish_job_failed",
    );
    settleWhenStalled(job);
  });

  // The later lookup of an OpenRouter call whose cost was not in hand (#296). Its retries
  // are the waiting: the job throws until OpenRouter has the cost.
  const usageLookup = createWorker<UsageLookupJob>(USAGE_LOOKUP_QUEUE, (job) => runUsageLookup(job));

  usageLookup.on("failed", (job, err) => {
    logger.warn(
      {
        err,
        generationId: job?.data.generationId,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "usage_lookup_attempt_failed",
    );
  });

  // A cover's or an avatar's media numbers, read after its upload returned
  // (#299). Its retries are the shared ones; what is left after the last is a
  // row with no numbers, which is what a container timeout leaves too.
  const mediaRead = createWorker<MediaReadJob>(MEDIA_READ_QUEUE, (job) => runMediaRead(job));

  mediaRead.on("failed", (job, err) => {
    logger.error(
      {
        err,
        assetId: job?.data.assetId,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "media_read_job_failed",
    );
  });

  // Notification mail a request queued instead of waiting on SMTP (#1232).
  // A send that throws retries on the shared options, except one the server
  // refused for good; what is left after that is a mail never sent, and the
  // bell already told the user.
  const mail = createWorker<MailJob>(MAIL_QUEUE, (job) => runMail(job));

  mail.on("failed", (job, err) => {
    logger.error(
      {
        err,
        subject: job?.data.ctx.subject,
        userId: job?.data.ctx.userId,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "mail_send_failed",
    );
  });

  // Ad conversions a request or webhook queued (inner#1442 §4.9). The sink is
  // built on the first job, so a deployment without Google Ads configured
  // never constructs a client.
  let adsSink: AdsConversionSink | undefined;
  const adsConversion = createWorker<AdsConversionJob>(ADS_CONVERSION_QUEUE, (job) =>
    runAdsConversion(job, (config) => (adsSink ??= googleDataManagerSink(config))),
  );
  // Queues again any upload whose job was lost between the claim and the add.
  (adsConversionConfig() ? scheduleAdsUploadSweep() : unscheduleAdsUploadSweep()).catch((err: unknown) =>
    logger.error({ err }, "ads_conversion_sweep_schedule_failed"),
  );

  adsConversion.on("failed", (job, err) => {
    logger.error(
      {
        err,
        conversion: job?.data.conversion,
        transactionId: job?.data.transactionId,
        attemptsMade: job?.attemptsMade,
        attemptsAllowed: job?.opts?.attempts,
      },
      "ads_conversion_failed",
    );
  });

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
        err,
        jobId: job?.id,
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
  // #1580 #7); past that, the row waits to be judged against its budget.
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


  logger.info(
    {
      queues: WORKER_QUEUES,
    },
    "BullMQ workers started",
  );

  // Health probe - a load balancer or orchestrator replaces the
  // instance after N consecutive 503s when its Redis or Postgres pool
  // has drifted; single-host docker compose does not
  // (AGENTS.md#health-checks).
  const health = startHealthServer({
    port: HEALTH_PORT,
    serviceName: "worker",
    // Forward health-server lifecycle events to our logger. Per
    // AGENTS.md#library-packages-do-not-log, the library
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
        void exitProcess(1);
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

  // Graceful shutdown - per AGENTS.md#graceful-shutdown
  // any long-running process must drain in-flight work
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
      drains: [
        () => worker.close(),
        () => urlIngest.close(),
        () => uploadFinish.close(),
        () => usageLookup.close(),
        () => mediaRead.close(),
        () => mail.close(),
        () => adsConversion.close(),
        () => flushServerAnalytics(),
      ],
      deadlineMs: SHUTDOWN_DEADLINE_MS,
    });
    logger.info("worker_shutdown_complete");
    await exitProcess(0);
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
  await exitProcess(1);
}
startWorker();
