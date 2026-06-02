/**
 * Application entry point.
 *
 * Starts the Hono HTTP server and registers graceful shutdown handlers
 * to close database, Redis, and queue connections.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@server/bootstrap-config.js";
import { serve } from "@hono/node-server";
import { createApp } from "@server/app.js";
import { env } from "@breatic/core";
import { closeDb } from "@breatic/core";
import { closeRedis } from "@breatic/core";
import { closeQueues } from "@breatic/core";
import { getRedis, getQueueRedis, getStreamRedis, pingDb, pingRedis } from "@breatic/core";
import { checkInfraReady, InfraNotReadyError } from "@breatic/core";
import { startHealthServer } from "@breatic/core";
import { logger } from "@breatic/core";
import { loadLocales } from "@breatic/core";

// Health probe port from the validated config (default 3001).
const HEALTH_PORT = env.SERVER_HEALTH_PORT;

// Fail-fast: verify PG + Redis are reachable before starting the
// server. `checkInfraReady` throws InfraNotReadyError per the
// "process lifecycle (forbidden in the library layer)" mandate - application entry catches,
// logs with full application context, and exits with code 1.
try {
  await checkInfraReady();
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

// Production error logging for shared Redis singletons. The core
// `createRedisClient` factory installs a no-op `error` listener so
// emitted errors don't crash the process; the application entry is
// responsible for the real logging per the "core and shared must not log" mandate.
for (const [client, instance] of [
  ["general", getRedis()],
  ["queue", getQueueRedis()],
  ["stream", getStreamRedis()],
] as const) {
  instance.on("error", (err) => {
    logger.error({ err, client }, "redis_error");
  });
}

// i18n: register all locale catalogs once at boot so `t()` callers
// in services/middleware have messages available on the first request.
loadLocales();

const app = createApp();

const server = serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    logger.info(`Server running on http://localhost:${info.port}`);
  },
);

// Health probe - separate port so probe traffic stays off the main
// hono port and per-port failure semantics in the LB stay clean.
// docker / k8s / LB healthcheck kills the instance on N consecutive
// 503s so an api whose Redis or Postgres pool has drifted gets a
// fresh process automatically. Per CLAUDE.md "industrial-grade server standards"
// mandate; mirrors worker (port 9101) + collab (port 1235) shape so
// all three services expose `GET /healthz` on a `primary+1` style port.
const health = startHealthServer({
  port: HEALTH_PORT,
  serviceName: "server",
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
    }
  },
  checks: [
    {
      name: "postgres",
      // Single SELECT-1 liveness helper, shared across all services.
      check: () => pingDb(),
    },
    {
      name: "redis_general",
      // Single PING liveness helper, shared across all services.
      check: () => pingRedis(getRedis()),
    },
  ],
});

/**
 * Graceful shutdown handler.
 * @param signal - The OS signal name that triggered shutdown (e.g. `SIGTERM`, `SIGINT`).
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);

  // Stop health probe first so the LB stops sending traffic to this
  // instance while it drains in-flight HTTP requests; failing health
  // early is the explicit signal to the LB "rotate me out".
  await health.stop();
  server.close();
  await Promise.allSettled([closeDb(), closeRedis(), closeQueues()]);

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
