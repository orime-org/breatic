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
import { logger } from "@breatic/core";

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
