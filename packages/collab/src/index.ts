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
  createPgClient,
  startHealthServer,
  InfraNotReadyError,
} from "@breatic/core";
import { buildCollabHealthChecks } from "@collab/infra/health-checks.js";
import { createLogger } from "@collab/infra/logger.js";
import { createCollabServer } from "@collab/hocuspocus.js";
import { startTaskListener } from "@collab/services/task-listener.js";
import { startMembersSync } from "@collab/services/members-sync.js";
import { getCollabConfig } from "@collab/config.js";
import { checkCollabInfraReady } from "@collab/infra/connectivity-check.js";

const logger = createLogger("main");

// All from the validated config (injected by bootstrap-config's
// initCore). DATABASE_URL is required; REDIS_* / ENV / health port
// carry schema defaults. The connectivity check + core factories
// still take these as explicit args - collab just sources them from
// the one validated config instead of re-reading raw process.env.
const DATABASE_URL = env.DATABASE_URL;
const REDIS_URL = env.REDIS_URL;
const REDIS_STREAM_URL = env.REDIS_STREAM_URL;
const ENV_PREFIX = env.ENV;
const HEALTH_PORT = env.COLLAB_HEALTH_PORT;

/**
 *
 */
async function main(): Promise<void> {
  // Fail-fast: verify PG + Redis are reachable before starting the
  // server. `checkCollabInfraReady` throws InfraNotReadyError per
  // the "process lifecycle (forbidden in the library layer)" mandate - application entry
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
  // application entry attaches the real logger per the "core and shared must not log" mandate.
  controlRedis.on("error", (err) => {
    logger.error(
      { err, client: "collab-members-sync-control" },
      "redis_error",
    );
  });
  const stopMembersSync = startMembersSync(hocuspocus, controlRedis);

  // Dedicated single-connection Postgres client for health probes.
  // collab persists every Yjs document to PG (persistence.ts) and
  // authenticates against it (auth.ts), so PG is a critical
  // dependency the probe MUST cover. A dedicated `max: 1` client
  // (named for pg_stat_activity visibility) keeps probe traffic off
  // the persistence pool; postgres.js connects lazily, so this costs
  // nothing until the first probe.
  const healthPg = createPgClient(DATABASE_URL, {
    name: "collab-healthz",
    max: 1,
  });

  // Health probe server - separate port so probe traffic doesn't
  // touch the WS port. Probes all three critical dependencies: the
  // members-sync control Redis, Postgres (Yjs doc store + auth), and
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
      pingRedisStream: async () => (await controlRedis.ping()) === "PONG",
      pingPostgres: async () => {
        const rows = await healthPg<Array<{ ok: number }>>`SELECT 1 AS ok`;
        return rows[0]?.ok === 1;
      },
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
    await healthServer.stop();
    await stopMembersSync();
    await controlRedis.quit();
    await healthPg.end();
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
