// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hocuspocus collaboration server entry point.
 *
 * Starts the Yjs document sync server on port 1234 (configurable)
 * and the Redis task result listener for Worker → Yjs writes.
 *
 * Run with: `pnpm dev:collab` or `tsx src/index.ts`
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@collab/bootstrap-config.js";
import { exitProcess, initSentry } from "@collab/sentry.js";
import {
  env,
  createLogger,
  createRedisClient,
  getRedis,
  getStreamRedis,
  getCollabRedis,
  closeCollabRedis,
  initLogger,
  pingDb,
  pingRedis,
  yjsRawPg,
  checkInfraReady,
  startHealthServer,
  runGracefulShutdown,
  InfraNotReadyError,
  flushServerAnalytics,
  adsConversionState,
  initServerAnalytics,
  taskEventsStreamKey,
  lifecycleStreamKey,
  listenProjectMemberChanges,
  projectAuthService,
  type MemberChangeListener,
} from "@breatic/core";
import { getCollabConfig } from "@collab/config.js";
import { buildCollabHealthChecks } from "@collab/infra/health-checks.js";
import { createCollabServer } from "@collab/hocuspocus.js";
import { startTaskListener } from "@collab/services/task-listener.js";
import { startLifecycleListener } from "@collab/services/lifecycle-listener.js";
import { startProjectControlSync } from "@collab/services/project-control-sync.js";
import { startMemberChangeSync } from "@collab/services/member-change-sync.js";

// Initialize the root logger with the collab service name before any child
// (`createLogger("main")` below) is created — otherwise children would bind
// to the lazy default ("api") logger instead of the collab one.
// Error monitoring starts before the first log line, so error logs from
// startup are already reported.
const monitoring = initSentry();

initLogger("collab");

const logger = createLogger("main");
if (monitoring === "invalid_dsn") logger.error({}, "sentry_dsn_invalid");
const analytics = initServerAnalytics({
  apiKey: env.AMPLITUDE_API_KEY,
  onError: (message) => {
    logger.warn({ message }, "analytics_events_rejected");
  },
});
if (analytics === "invalid") logger.error({}, "amplitude_api_key_invalid");
if (adsConversionState() === "invalid") logger.error({}, "google_ads_config_invalid");

/**
 * Deadline (ms) for the concurrent teardown drains.
 *
 * A hung drain — a Redis quit that never returns, say — must not hold the
 * process open. Every document's final store runs inside `server.destroy()`,
 * the first drain, so it shares this deadline: the unload gate reads the
 * absolute moment it ends and stops retrying a store in time to rescue the
 * content before it.
 */
const SHUTDOWN_DEADLINE_MS = 4000;

/**
 * Sentinel document the healthz end-to-end probe loads. Deliberately NOT a
 * project doc name so `parseDocName` rejects it and the auth hook skips it.
 */
const HEALTHZ_PROBE_DOC = "__healthz_probe__";

/**
 * Max time the healthz end-to-end probe waits for a sentinel round-trip before
 * declaring the WS processing path wedged.
 */
const HEALTHZ_PROBE_TIMEOUT_MS = 2000;

/**
 * Max time the healthz member-listen probe waits for its nonce to come back
 * over the project_members listen connection (inner#911).
 */
const MEMBER_LISTEN_PROBE_TIMEOUT_MS = 1000;

/**
 * Flush the pino transport's worker-thread buffer before an explicit
 * `process.exit`, so the shutdown / fatal trace oncall needs isn't
 * dropped (pino #1338). Best-effort and time-bounded: resolves on flush
 * completion, on a flush error, or after 500ms — never hangs shutdown.
 * @returns Resolves once flushed, errored, or timed out.
 */
function flushLogger(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 500);
    timer.unref();
    try {
      logger.flush(() => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// Last-resort process handlers. A realtime server's worst failure mode is
// "alive but no longer serving" (the throttle-ban incident): the process stays
// up, healthz can stay green, yet nothing works. An uncaught exception leaves
// the process in an undefined state, and an unhandled rejection is always a bug
// here — in both cases we log with full context, flush, and exit(1) so the
// supervisor (tsx watch / docker) restarts a clean process rather than letting
// it limp on silently. Registered at module load so they cover startup too.
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught_exception");
  void flushLogger().then(() => exitProcess(1));
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled_rejection");
  void flushLogger().then(() => exitProcess(1));
});

// All from the validated config (injected by bootstrap-config's
// initCore). REDIS_STREAM_URL / ENV / health port carry schema
// defaults; collab sources them from the one validated config instead
// of re-reading raw process.env. (The boot connectivity check now uses
// the core Redis singletons directly, so it needs no URL args.)
const REDIS_STREAM_URL = env.REDIS_STREAM_URL;
const REDIS_COLLAB_URL = env.REDIS_COLLAB_URL;
// Namespace for collab's Redis PUB/SUB CHANNELS only. Resolved by the core
// schema (unset => ENV), so this is `dev` unless a deployment sharing a Redis
// instance with another one sets it (#1831).
const REDIS_KEY_PREFIX = env.REDIS_KEY_PREFIX;

// Namespace of the cursor keys the single-instance reader kept. Each consumer
// group is created at the position its cursor records (inner#1497 §6.9), and the
// key is left in place for a rollback to the single-instance reader. Like the
// stream keys (core's `taskEventsStreamKey()` / `lifecycleStreamKey()`), it is
// `ENV`, not `REDIS_KEY_PREFIX`.
const STREAM_CURSOR_PREFIX = env.ENV;
const HEALTH_PORT = env.COLLAB_HEALTH_PORT;

/**
 * Collab service entry point: fail-fast on infra connectivity, then start the
 * Hocuspocus realtime server (log + exit(1) on a startup failure).
 */
async function main(): Promise<void> {
  // Fail-fast: verify PG + Redis are reachable before starting the
  // server. `checkInfraReady` (the unified core check) throws
  // InfraNotReadyError per the "process lifecycle (forbidden in the
  // library layer)" mandate - application entry catches, logs with full
  // application context, and exits with code 1. Collab probes the
  // general (session, DB0) + stream (DB2) + collab-coordination (DB3)
  // Redis singletons it uses.
  try {
    await checkInfraReady({
      general: getRedis(),
      stream: getStreamRedis(),
      collab: getCollabRedis(),
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
    await flushLogger();
    await exitProcess(1);
  }

  // Set when shutdown reaches the concurrent drains.
  let shutdownDeadlineAt: number | undefined;

  // Create and start Hocuspocus server
  const { server, hocuspocus, seatHandover, storeLoop, instanceId } =
    await createCollabServer({
    collabRedisUrl: REDIS_COLLAB_URL,
    port: env.COLLAB_PORT,
    redisKeyPrefix: REDIS_KEY_PREFIX,
    shutdownDeadline: () => shutdownDeadlineAt,
  });

  /**
   * End-to-end "can collab actually process a document" health probe. Opens a
   * server-side direct connection to a sentinel doc (a non-project name, so
   * the auth hook skips it), loads it, and tears it down within
   * a timeout. The infra probes (PG / Redis / listen socket) all stay green when
   * the process is alive but has stopped serving connections (throttle-ban /
   * doc-pipeline wedge); this walks the real load-and-process path, so such a
   * wedge makes it hang past the timeout → false → healthz red → LB recycles the
   * process. Resolves false (never throws) so one stuck probe can't crash the
   * health handler.
   * @returns True when the sentinel round-trip completed within the timeout.
   */
  const probeDocProcessing = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = await Promise.race([
        hocuspocus.openDirectConnection(HEALTHZ_PROBE_DOC),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("healthz_probe_timeout")),
            HEALTHZ_PROBE_TIMEOUT_MS,
          );
        }),
      ]);
      // The document loaded → the load-and-process pipeline is alive, which is
      // exactly what this probe verifies. Tear the sentinel connection down
      // best-effort; a hiccup while UNLOADING it (e.g. the store on
      // unload_immediately) must NOT flip the probe red — the pipeline already
      // proved healthy by loading.
      void connection.disconnect().catch(() => undefined);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // Surface a WS listen-bind failure (EADDRINUSE etc.) cleanly instead of
  // letting Node crash on the unhandled `'error'` event; the app entry logs
  // + exits (the library layer never logs / exits itself).
  server.httpServer.on("error", (err) => {
    logger.fatal({ err, port: env.COLLAB_PORT }, "ws_listen_error");
    void flushLogger().then(() => exitProcess(1));
  });

  // Membership changes, from the trigger on project_members (inner#911).
  // Started before the WebSocket port opens, so a failed first LISTEN ends
  // startup with no client connected, like the infra check above.
  let memberChanges: MemberChangeListener;
  try {
    memberChanges = await startMemberChangeSync(hocuspocus, {
      listen: listenProjectMemberChanges,
      loadRole: projectAuthService.loadProjectRole,
    });
  } catch (err) {
    logger.error({ err }, "member_change_listen_failed");
    await flushLogger();
    await exitProcess(1);
    return;
  }

  await server.listen();
  logger.info({ port: env.COLLAB_PORT }, "Hocuspocus collaboration server started");

  // Both cross-service streams are read as consumer groups this instance
  // joins under its instance id (inner#1497 §6.1, §6.2).
  const cfg = getCollabConfig();
  const consumerSettings = {
    maxHeld: cfg.event_max_held,
    keyConcurrency: cfg.event_doc_concurrency,
    blockMs: cfg.event_block_ms,
    leaseRetryMs: cfg.event_lease_retry_ms,
    claimIntervalMs: cfg.event_claim_interval_ms,
    claimIdleMs: cfg.event_claim_idle_ms,
    retryMinMs: cfg.event_retry_min_ms,
    retryMaxMs: cfg.event_retry_max_ms,
    maxFailures: cfg.event_max_failures,
    stopDeadlineMs: cfg.event_stop_deadline_ms,
    forgetIdleConsumerMs: cfg.event_forget_idle_consumer_ms,
  };

  // Task events (server, worker → canvas documents).
  const taskConsumer = startTaskListener({
    hocuspocus,
    streamUrl: REDIS_STREAM_URL,
    streamKey: taskEventsStreamKey(),
    legacyCursorKey: `${STREAM_CURSOR_PREFIX}:collab:task-events:last-id`,
    keyPrefix: REDIS_KEY_PREFIX,
    instanceId,
    coordination: getCollabRedis(),
    settings: {
      ...consumerSettings,
      docLeaseMs: cfg.event_doc_lease_ms,
      handoffPollMs: cfg.event_handoff_poll_ms,
      handoffWaitMs: cfg.event_handoff_wait_ms,
    },
  });

  // Project-lifecycle commands (server outbox relay → yjs-DB copy and the
  // connection close every instance does).
  const lifecycleConsumer = startLifecycleListener({
    streamUrl: REDIS_STREAM_URL,
    streamKey: lifecycleStreamKey(),
    legacyCursorKey: `${STREAM_CURSOR_PREFIX}:collab:project-lifecycle:last-id`,
    keyPrefix: REDIS_KEY_PREFIX,
    instanceId,
    coordination: getCollabRedis(),
    settings: consumerSettings,
  });

  // Start the control-plane subscriber (activity, project connection closes).
  // Same Redis instance as the streams (DB2); it .duplicate()s the connection
  // for its dedicated subscriber. The client uses the core factory so it
  // inherits the production-safety knobs (keepAlive,
  // commandTimeout: undefined for the subscribe path's blocking
  // semantics, READONLY-aware reconnect, error log tagging).
  const controlRedis = createRedisClient(REDIS_STREAM_URL, {
    name: "collab-project-control",
    lazyConnect: false,
    commandTimeout: undefined,
  });
  // Production error logging. The core factory installs a no-op
  // `error` listener so emitted errors don't crash the process; the
  // application entry attaches the real logger per the "core and shared must not log" mandate.
  controlRedis.on("error", (err) => {
    logger.error(
      { err, client: "collab-project-control" },
      "redis_error",
    );
  });
  const stopProjectControlSync = startProjectControlSync(hocuspocus, controlRedis);

  // Health probe server - separate port so probe traffic doesn't
  // touch the WS port. Probes every critical dependency; the list is
  // `buildCollabHealthChecks` in infra/health-checks.ts. A load balancer or
  // orchestrator replaces the instance after N consecutive 503s; single-host
  // docker compose does not, so there recovery relies on alerts
  // (AGENTS.md#health-checks).
  const healthServer = startHealthServer({
    port: HEALTH_PORT,
    serviceName: "collab",
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
        void flushLogger().then(() => exitProcess(1));
      }
    },
    // Wiring lives in `health-checks.ts` (`buildCollabHealthChecks`)
    // so the probe set is unit-tested - both that PG is covered and
    // that `hocuspocus_listening` reads the right field. Bug history:
    // PR #155/#156 read `hocuspocus.server?.listening` (wrong variable
    // AND wrong field - the http server is `server.httpServer`, not on
    // the Hocuspocus instance), so the check was `undefined?.listening`
    // → always false → /healthz always 503; with the docker
    // `healthcheck:` that would have looped-restarted prod collab.
    checks: buildCollabHealthChecks({
      // DB0 holds sessions and drives `auth.ts`. The bug this closes: a
      // drifted DB0 connection rejected every WS auth while /healthz
      // stayed green (it never probed DB0), so the LB never recycled the
      // process — users saw a stuck "session invalid" banner with no red
      // health signal. server/worker already probe this; collab didn't.
      pingRedisGeneral: () => pingRedis(getRedis()),
      pingRedisStream: () => pingRedis(controlRedis),
      // DB3: collab cross-instance coordination (Hocuspocus pub/sub +
      // Space count lock). A drifted connection silently breaks
      // cross-instance sync while everything else looks healthy —
      // healthz must catch it (same class as the DB0-drift gap).
      pingRedisCollab: () => pingRedis(getCollabRedis()),
      // Single SELECT-1 liveness helper, shared across all services,
      // over the process-wide `db` singleton (same pool collab uses for
      // persistence + auth — no dedicated probe pool).
      pingPostgres: () => pingDb(),
      // Liveness for the separate Yjs-store Postgres DB.
      pingYjsPostgres: () => pingDb(yjsRawPg),
      // `.listening` flips false the instant the listen socket closes
      // (graceful shutdown or crash) - a dead hocuspocus with a live
      // healthz is the worst possible state for the LB.
      isHocuspocusListening: () => server.httpServer.listening,
      // End-to-end "can collab actually process a doc" probe — the only check
      // that catches "alive but not serving" (the throttle-ban / doc-wedge
      // failure mode that the infra probes above all miss).
      probeWsProcessing: probeDocProcessing,
      probeMemberListen: () => memberChanges.probe(MEMBER_LISTEN_PROBE_TIMEOUT_MS),
    }),
  });

  // Graceful shutdown
  /**
   * Gracefully tear down the collab process: stop the two stream consumers
   * and hand over what they still hold, then stop the Hocuspocus server, the
   * health server, the control-plane subscriber, the member-change listener and
   * the Redis clients
   * together, then exit with code 0.
   * @param signal - Name of the OS signal that triggered shutdown (`SIGTERM` / `SIGINT`), logged for traceability.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down...");
    // Stop starting new store rounds. A round already in flight finishes on
    // its own, and each document gets its own last attempt when the library
    // unloads it — `server.destroy()` is the first drain below, and it closes
    // the client connections, which is what makes the documents unload.
    storeLoop.stop();

    // Free :1234 before anything slow runs, so a restart can rebind straight
    // away. `runGracefulShutdown` asks for the same release below and swallows
    // the error from closing twice.
    try {
      server.httpServer.close();
    } catch {
      // Best effort — a release error must not stop the teardown below.
    }

    // The stream consumers stop first. Each waits up to
    // `event_stop_deadline_ms` for its running rounds and marks everything
    // else it holds as idle, so this one's successor takes it on its first
    // sweep at startup, or another instance once its sweep reaches it. A round still running past that
    // keeps running into the drains below; if it cannot finish there, it stays
    // pending and is taken over after `event_claim_idle_ms`.
    await Promise.all([taskConsumer.stop(), lifecycleConsumer.stop()]);

    // Onto disk before the teardown, not after it: if the platform loses
    // patience and kills the process mid-drain, everything logged up to here
    // is already safe.
    await flushLogger();

    shutdownDeadlineAt = Date.now() + SHUTDOWN_DEADLINE_MS;
    await runGracefulShutdown({
      // Release the WS listen socket first so a restart can rebind :1234
      // immediately, instead of holding it behind the drains below — the old
      // sequential order freed it last, which on a dev tsx-watch restart
      // overran the 5s window → EADDRINUSE on the new process.
      releaseListenSocket: () => server.httpServer.close(),
      drains: [
        () => server.destroy(),
        () => flushServerAnalytics(),
        () => healthServer.stop(),
        () => stopProjectControlSync(),
        () => memberChanges.stop(),
        // Stop answering demote requests. This unsubscribes and nothing more
        // — the SUBSCRIBE client it rides on is made inside
        // createCollabServer, is not exposed here, and goes when the process
        // does. Listed for the same reason as the other drains: whatever
        // this instance is still doing on the way out, it stops doing.
        () => seatHandover.stop(),
        () => controlRedis.quit(),
        () => closeCollabRedis(),
      ],
      deadlineMs: SHUTDOWN_DEADLINE_MS,
    });
    logger.info("Shutdown complete");
    await flushLogger();
    await exitProcess(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (err) => {
  logger.fatal({ err }, "Failed to start collaboration server");
  await flushLogger();
  await exitProcess(1);
});
