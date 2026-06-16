// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
import {
  env,
  createRedisClient,
  getRedis,
  getStreamRedis,
  pingDb,
  pingRedis,
  yjsRawPg,
  checkInfraReady,
  startHealthServer,
  runGracefulShutdown,
  InfraNotReadyError,
} from "@breatic/core";
import { buildCollabHealthChecks } from "@collab/infra/health-checks.js";
import { createLogger } from "@collab/infra/logger.js";
import { createCollabServer } from "@collab/hocuspocus.js";
import { startTaskListener } from "@collab/services/task-listener.js";
import { startLifecycleListener } from "@collab/services/lifecycle-listener.js";
import { startMembersSync } from "@collab/services/members-sync.js";
import { getCollabConfig } from "@collab/config.js";

const logger = createLogger("main");

/**
 * Overall graceful-shutdown deadline (ms). Kept under the dev `tsx watch` 5s
 * force-kill window so a restart never races a slow drain holding :1234.
 */
const SHUTDOWN_DEADLINE_MS = 4000;

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

// All from the validated config (injected by bootstrap-config's
// initCore). REDIS_STREAM_URL / ENV / health port carry schema
// defaults; collab sources them from the one validated config instead
// of re-reading raw process.env. (The boot connectivity check now uses
// the core Redis singletons directly, so it needs no URL args.)
const REDIS_STREAM_URL = env.REDIS_STREAM_URL;
const ENV_PREFIX = env.ENV;
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
  // general (session, DB0) + stream (DB2) Redis singletons it uses.
  try {
    await checkInfraReady({
      general: getRedis(),
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

  const cfg = getCollabConfig();

  // Create and start Hocuspocus server
  const { server, hocuspocus } = await createCollabServer({
    streamRedisUrl: REDIS_STREAM_URL,
    envPrefix: ENV_PREFIX,
  });

  // Surface a WS listen-bind failure (EADDRINUSE etc.) cleanly instead of
  // letting Node crash on the unhandled `'error'` event; the app entry logs
  // + exits (the library layer never logs / exits itself).
  server.httpServer.on("error", (err) => {
    logger.fatal({ err, port: cfg.port }, "ws_listen_error");
    void flushLogger().then(() => process.exit(1));
  });

  await server.listen();
  logger.info({ port: cfg.port }, "Hocuspocus collaboration server started");

  // Start task result listener (Worker → Yjs)
  // streamRedisUrl: consume Redis Streams (DB 2)
  const stopListener = startTaskListener(hocuspocus, REDIS_STREAM_URL, ENV_PREFIX);

  // Start project-lifecycle listener (API outbox relay → yjs-DB cascade).
  // Same Streams Redis (DB 2) as the task stream; consumes delete /
  // duplicate commands and performs the yjs-DB side + connection kick.
  const stopLifecycle = startLifecycleListener(
    hocuspocus,
    REDIS_STREAM_URL,
    ENV_PREFIX,
  );

  // Start members-sync subscriber (API → kick + broadcastStateless +
  // meta-doc Space CRUD apply). Same Redis instance as the task
  // stream (DB2); members-sync .duplicate()s the connection for its
  // dedicated subscriber.
  // Members-sync subscriber client. Uses the core factory so it
  // inherits the production-safety knobs (keepAlive,
  // commandTimeout: undefined for the subscribe path's blocking
  // semantics, READONLY-aware reconnect, error log tagging).
  const controlRedis = createRedisClient(REDIS_STREAM_URL, {
    name: "collab-members-sync-control",
    lazyConnect: false,
    commandTimeout: undefined,
  });
  // Production error logging. The core factory installs a no-op
  // `error` listener so emitted errors don't crash the process; the
  // application entry attaches the real logger per the "core and shared must not log" mandate.
  controlRedis.on("error", (err) => {
    logger.error(
      { err, client: "collab-members-sync-control" },
      "redis_error",
    );
  });
  const stopMembersSync = startMembersSync(hocuspocus, controlRedis);

  // Health probe server - separate port so probe traffic doesn't
  // touch the WS port. Probes all five critical dependencies: the
  // general Redis (DB0 - sessions + auth), the members-sync control
  // Redis (DB2 stream), both Postgres DBs (Yjs doc store + auth), and
  // the Hocuspocus WS listen socket. LB / docker healthcheck kills
  // the instance on N consecutive 503s so a drifted connection pool
  // gets a fresh process automatically - per CLAUDE.md "industrial-grade server standards" and memory `feedback_dev_collab_long_running_drift`.
  const healthServer = startHealthServer({
    port: HEALTH_PORT,
    serviceName: "collab",
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
        void flushLogger().then(() => process.exit(1));
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
    }),
  });

  // Graceful shutdown
  /**
   * Gracefully tear down the collab process: stop the health server,
   * members-sync subscriber, Redis/Postgres clients, stream listener,
   * and Hocuspocus server, then exit with code 0.
   * @param signal - Name of the OS signal that triggered shutdown (`SIGTERM` / `SIGINT`), logged for traceability.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down...");
    await runGracefulShutdown({
      // Release the WS listen socket first so a restart can rebind :1234
      // immediately, instead of holding it behind the drains below — the old
      // sequential order freed it last, which on a dev tsx-watch restart
      // overran the 5s window → EADDRINUSE on the new process.
      releaseListenSocket: () => server.httpServer.close(),
      drains: [
        () => server.destroy(),
        () => healthServer.stop(),
        () => stopMembersSync(),
        () => controlRedis.quit(),
        () => stopListener(),
        () => stopLifecycle(),
      ],
      deadlineMs: SHUTDOWN_DEADLINE_MS,
    });
    logger.info("Shutdown complete");
    await flushLogger();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (err) => {
  logger.fatal({ err }, "Failed to start collaboration server");
  await flushLogger();
  process.exit(1);
});
