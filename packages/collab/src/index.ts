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
import {
  createRedisClient,
  startHealthServer,
  InfraNotReadyError,
} from "@breatic/core";
import { createLogger } from "@collab/logger.js";
import { createCollabServer } from "@collab/hocuspocus.js";
import { startTaskListener } from "@collab/task-listener.js";
import { startMembersSync } from "@collab/members-sync.js";
import { getCollabConfig } from "@collab/config.js";
import { checkCollabInfraReady } from "@collab/connectivity-check.js";

const logger = createLogger("main");

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://breatic:breatic@localhost:5432/breatic";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379/0";
const REDIS_STREAM_URL = process.env["REDIS_STREAM_URL"] ?? "redis://localhost:6379/2";
const ENV_PREFIX = process.env["ENV"] ?? "dev";
const HEALTH_PORT = Number(process.env["COLLAB_HEALTH_PORT"] ?? "1235");

async function main(): Promise<void> {
  // Fail-fast: verify PG + Redis are reachable before starting the
  // server. `checkCollabInfraReady` throws InfraNotReadyError per
  // the "进程生命周期(library 层禁)" mandate — application entry
  // catches, logs with full application context, and exits with code 1.
  try {
    await checkCollabInfraReady(DATABASE_URL, REDIS_URL, REDIS_STREAM_URL);
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
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    streamRedisUrl: REDIS_STREAM_URL,
    envPrefix: ENV_PREFIX,
  });

  await server.listen();
  logger.info({ port: cfg.port }, "Hocuspocus collaboration server started");

  // Start task result listener (Worker → Yjs)
  // streamRedisUrl: consume Redis Streams (DB 2)
  const stopListener = startTaskListener(hocuspocus, REDIS_STREAM_URL, ENV_PREFIX);

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
  // application entry attaches the real logger per the "core 和
  // shared 不写任何日志" mandate.
  controlRedis.on("error", (err) => {
    logger.error(
      { err, client: "collab-members-sync-control" },
      "redis_error",
    );
  });
  const stopMembersSync = startMembersSync(hocuspocus, controlRedis);

  // Health probe server — separate port so probe traffic doesn't
  // touch the WS port. Probes PG (via the controlRedis side — a
  // PG ping would require yet another client; instead we ping the
  // two long-lived Redis clients we already own + the WS server
  // status). LB / docker healthcheck kills the instance on N
  // consecutive 503s so a drifted connection pool gets a fresh
  // process automatically — per CLAUDE.md "服务器端工业级标准"
  // and memory `feedback_dev_collab_long_running_drift`.
  const healthServer = startHealthServer({
    port: HEALTH_PORT,
    serviceName: "collab",
    // Forward health-server lifecycle events to our logger. Per
    // CLAUDE.md "core 和 shared 不写任何日志" mandate, the library
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
      }
    },
    checks: [
      {
        name: "redis_stream",
        check: async () => (await controlRedis.ping()) === "PONG",
      },
      {
        name: "hocuspocus_listening",
        // server.httpServer is the underlying node:http.Server
        // instance (see @hocuspocus/server `Server` class line 29
        // `httpServer: HTTPServer`). `.listening` flips false
        // the instant the listen socket closes (graceful shutdown
        // or crash). A dead hocuspocus with live healthz would be
        // the worst possible state for the LB.
        //
        // Bug history: PR #155 / #156 incorrectly read
        // `hocuspocus.server?.listening`. Two errors stacked:
        // (1) wrong variable — `createCollabServer` returns
        // `{ server: Server, hocuspocus: Hocuspocus }`, and the
        // http server lives on `Server`, not on `Hocuspocus`;
        // (2) wrong field — even on `Server` the public field
        // is `httpServer`, not `server`. The check was therefore
        // reading `undefined?.listening === true` → always false
        // → /healthz always 503. Combined with the docker
        // `healthcheck:` wired in #156, production collab
        // containers would have been marked `unhealthy` and
        // infinitely restarted by docker. Caught locally before
        // any deploy by `curl :1235/healthz` smoke.
        check: async () => server.httpServer.listening,
      },
    ],
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    await healthServer.stop();
    await stopMembersSync();
    await controlRedis.quit();
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
