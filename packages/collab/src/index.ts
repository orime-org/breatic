/**
 * Hocuspocus collaboration server entry point.
 *
 * Starts the Yjs document sync server on port 1234 (configurable)
 * and the Redis task result listener for Worker → Yjs writes.
 *
 * Run with: `pnpm dev:collab` or `tsx src/index.ts`
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from monorepo root (shared by all packages)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import { createLogger } from "./logger.js";
import { createCollabServer } from "./server.js";
import { startTaskListener } from "./task-listener.js";
import { getCollabConfig } from "./config.js";

const logger = createLogger("main");

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://breatic:breatic@localhost:5432/breatic";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/0";
const ENV_PREFIX = process.env["ENV"] ?? "dev";

async function main(): Promise<void> {
  const cfg = getCollabConfig();

  // Create and start Hocuspocus server
  const { server, hocuspocus } = await createCollabServer({
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    envPrefix: ENV_PREFIX,
  });

  await server.listen();
  logger.info({ port: cfg.port }, "Hocuspocus collaboration server started");

  // Start task result listener (Worker → Yjs)
  const stopListener = startTaskListener(hocuspocus, REDIS_URL, ENV_PREFIX);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    await stopListener();
    await server.destroy();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start collaboration server");
  process.exit(1);
});
