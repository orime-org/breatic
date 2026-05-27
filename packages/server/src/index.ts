/**
 * Application entry point.
 *
 * Starts the Hono HTTP server and registers graceful shutdown handlers
 * to close database, Redis, and queue connections.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { env } from "@breatic/core";
import { closeDb } from "@breatic/core";
import { closeRedis } from "@breatic/core";
import { closeQueues } from "@breatic/core";
import { getRedis, getQueueRedis, getStreamRedis } from "@breatic/core";
import { checkInfraReady, InfraNotReadyError } from "@breatic/core";
import { logger } from "@breatic/core";
import { loadLocales } from "@breatic/shared/i18n-node";

// Fail-fast: verify PG + Redis are reachable before starting the
// server. `checkInfraReady` throws InfraNotReadyError per the
// "进程生命周期(library 层禁)" mandate — application entry catches,
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
// responsible for the real logging per the "core 和 shared 不写
// 任何日志" mandate.
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

/** Graceful shutdown handler. */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);

  server.close();
  await Promise.allSettled([closeDb(), closeRedis(), closeQueues()]);

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
