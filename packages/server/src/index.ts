// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Application entry point.
 *
 * Starts the Hono HTTP server and registers graceful shutdown handlers
 * to close database, Redis, and queue connections.
 */

// MUST be first: reads process.env + initCore before any env.* read.
import "@server/bootstrap-config.js";
import { exitProcess, initSentry } from "@server/sentry.js";
import { serve } from "@hono/node-server";
import { createApp } from "@server/app.js";
import { createInternalApp } from "@server/internal-app.js";
import {
  env,
  getAgentConfig,
  onDatabaseWaitTimeout,
  adsConversionState,
  closeDb,
  flushServerAnalytics,
  initServerAnalytics,
  closeRedis,
  closeQueues,
  getRedis,
  getQueueRedis,
  getStreamRedis,
  checkInfraReady,
  InfraNotReadyError,
  installDeadlineBoundDispatcher,
  startHealthServer,
  getStorageConfig,
  getTimelineConfig,
  runGracefulShutdown,
  logger,
  initLogger,
  loadLocales,
  getCommerceConfig,
} from "@breatic/core";
import { getTrialGrantCredits } from "@server/config/credits.js";
import { getMaintenanceConfig } from "@server/config/maintenance.js";
import { startMaintenanceLoop } from "@server/modules/maintenance/maintenance-loop.js";
import { renderMetrics } from "@server/infra/metrics.js";
import { startLifecycleRelay } from "@server/modules/project/lifecycle-relay.js";
import { startCommerceRelay } from "@server/modules/commerce/commerce-relay.js";
import { settleAfterReply, pendingAfterReply } from "@server/utils/after-reply.js";
import { getServerShutdownDeadlineMs } from "@server/config/limits.js";
import { markShuttingDown } from "@server/agent/shutdown-flag.js";
import { closeChatSubscriberRedis, getChatSubscriberRedis } from "@server/agent/run-stream.js";
import { serverHealthChecks } from "@server/health-checks.js";
import { agentModelIds, initProvider, modelCatalog, provider } from "@breatic/domain";
import { textToolModels } from "@server/config/text-tools.js";

// Tag this process's logs as "server" (file dir logs/server/, `name:"server"`).
// Runs after initCore (bootstrap-config) and before the first log below;
// the HTTP routes stay mounted under /api/v1 — only the log identity changes.
// Error monitoring starts before the first log line, so error logs from the
// config checks below are already reported.
const monitoring = initSentry();

initLogger("server");
onDatabaseWaitTimeout((event) => logger.error(event, "db_wait_timeout"));
if (monitoring === "invalid_dsn") logger.error({}, "sentry_dsn_invalid");
const analytics = initServerAnalytics({
  apiKey: env.AMPLITUDE_API_KEY,
  onError: (message) => {
    logger.warn({ message }, "analytics_events_rejected");
  },
});
if (analytics === "invalid") logger.error({}, "amplitude_api_key_invalid");
if (adsConversionState() === "invalid") logger.error({}, "google_ads_config_invalid");

// Route the AI SDK's warnings into our logger. Without this the SDK writes
// them to console, and our logs are JSON on disk — console output lands
// nowhere anyone reads at 3am. Warnings are exactly what matters then: a
// provider silently dropping a parameter, a model ignoring a setting. The
// call still succeeds, so nothing else says so.
globalThis.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
  logger.warn({ warnings, provider, model }, "ai_sdk_warning");
};

// The agent's save of a user's link waits on the ingest Worker inside a
// request, held to its grant's two hours (inner#1367), so undici's 300-second
// wait for an answer must not cut it first.
installDeadlineBoundDispatcher();

// Health probe port from the validated config (default 3001).
const HEALTH_PORT = env.SERVER_HEALTH_PORT;

// Fail-fast on config/storage.yaml, for the same reason env is validated
// before anything runs. The routes that need it read it lazily, so without
// this the first upload of a deployment is where a bad file surfaces: a 500
// for whoever happened to be uploading, and a stack trace the operator has to
// go looking for. Parsing it here moves that to the one moment the person who
// edited the file is watching. The library throws and this decides the
// process's fate, per the lifecycle mandate.
try {
  getStorageConfig();
} catch (err) {
  logger.error({ err }, "storage_config_invalid");
  await exitProcess(1);
}

// And config/agent.yaml, which provider reads its retry count from, and
// which rejects a memory reserve at or above memory_keep_tokens — a fold
// would have no line to run down to. Lazy like the rest, so without this the
// first person to say something is the one who finds out, mid-request, with
// a 500 and a healthy-looking process behind it.
try {
  getAgentConfig();
} catch (err) {
  logger.error({ err }, "agent_config_invalid");
  await exitProcess(1);
}

// Every model call goes through provider (inner#1743); its configuration is
// checked whole when it is built, so a bad upstream, route or binding fails
// here, naming every problem, instead of inside the first call that needs it.
// Built before the catalog below, whose entries carry provider's availability
// and pricing rules.
try {
  initProvider();
} catch (err) {
  logger.error({ err }, "provider_config_invalid");
  await exitProcess(1);
}

// Same preflight for config/models/*.yaml (#1966). Every model must declare
// `takes_prompt`, and the catalog is as lazy as the configs above — lazy here
// means a missing declaration surfaces on the first `GET /api/v1/models`,
// which under the readiness gate is every user's Generate panel refusing to
// open while the process stays up and healthz stays green. Loading it here
// puts that in front of whoever edited the file.
try {
  modelCatalog.getModelCatalog();
} catch (err) {
  logger.error({ err }, "model_catalog_invalid");
  await exitProcess(1);
}

// The Timeline config is lazy like the ones above; a default frame outside the presets (#1502) would otherwise
// surface on the first Timeline request instead of at startup.
try {
  getTimelineConfig();
} catch (err) {
  logger.error({ err }, "timeline_config_invalid");
  await exitProcess(1);
}

// Every model the agent runs on has to be priceable (#296). One reached
// directly reports tokens but no cost, and is priced from its upstream's
// prices in config/provider/llm.yaml; lazily, a missing price would surface
// as the first call that spent money failing to record what it spent.
try {
  provider().llm.assertModelsPriced([...agentModelIds(), ...textToolModels()]);
} catch (err) {
  logger.error({ err }, "usage_pricing_incomplete");
  await exitProcess(1);
}

// The trial grant is the deployment's own file (`config/credits.yaml`, written
// from the `.template` beside it). Loading it here fails a deployment that
// forgot it at boot instead of at the first sign-up, and only where credits
// are charged: a deployment that charges nothing never reads it.
if (env.CHARGING_ENABLED) {
  try {
    getTrialGrantCredits();
  } catch (err) {
    logger.error({ err }, "credits_config_invalid");
    await exitProcess(1);
  }
}

// The internal listener's settings are read lazily; a malformed file must
// stop the boot, not the first request.
if (env.INTERNAL_API_ENABLED) {
  try {
    getMaintenanceConfig();
    if (env.SELLING) getCommerceConfig();
  } catch (err) {
    logger.error({ err }, "internal_api_config_invalid");
    await exitProcess(1);
  }
}

// Fail-fast: verify PG + Redis are reachable before starting the
// server. `checkInfraReady` throws InfraNotReadyError per the
// "process lifecycle (forbidden in the library layer)" mandate - application entry catches,
// logs with full application context, and exits with code 1.
try {
  await checkInfraReady({
    general: getRedis(),
    queue: getQueueRedis(),
    stream: getStreamRedis(),
    chat_subscriber: getChatSubscriberRedis(),
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

// Production error logging for shared Redis singletons. The core
// `createRedisClient` factory installs a no-op `error` listener so
// emitted errors don't crash the process; the application entry is
// responsible for the real logging per the "core and shared must not log" mandate.
for (const [client, instance] of [
  ["general", getRedis()],
  ["queue", getQueueRedis()],
  ["stream", getStreamRedis()],
  ["chat_subscriber", getChatSubscriberRedis()],
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

// The internal API for the back office (inner#1410 §4.1): its own port,
// bound to INTERNAL_API_HOST; reachability is decided by where the port is
// published, and every request is signed.
const internalServer = env.INTERNAL_API_ENABLED
  ? serve(
      { fetch: createInternalApp().fetch, port: env.INTERNAL_API_PORT, hostname: env.INTERNAL_API_HOST },
      (info) => {
        logger.info({ port: info.port, host: env.INTERNAL_API_HOST }, "internal_api_listening");
      },
    )
  : null;
internalServer?.on("error", (err) => {
  logger.fatal({ err, port: env.INTERNAL_API_PORT }, "internal_listen_error");
  void exitProcess(1);
});


// Surface a main-port listen-bind failure (EADDRINUSE etc.) cleanly instead of
// letting Node crash on the unhandled `'error'` event; the app entry logs +
// exits (the library layer never logs / exits itself).
server.on("error", (err) => {
  logger.fatal({ err, port: env.PORT }, "http_listen_error");
  void exitProcess(1);
});

// Transactional-outbox relay: forwards project duplicate / archive /
// restore commands from the business DB to collab via the durable
// lifecycle Redis Stream (the yjs store is a separate DB, so their yjs
// side cannot run inside the business transaction).
const lifecycleRelay = startLifecycleRelay();

// The billing service's outbox relay (inner#1993 §5.1): it runs where the
// billing service can call back, which is the internal listener.
const commerceRelay = env.INTERNAL_API_ENABLED && env.SELLING ? startCommerceRelay() : null;

const maintenanceLoop = startMaintenanceLoop();

// Health probe - separate port so probe traffic stays off the main
// hono port and per-port failure semantics in the LB stay clean.
// A load balancer or orchestrator replaces the instance after N
// consecutive 503s when its Redis or Postgres pool has drifted;
// single-host docker compose does not (AGENTS.md#health-checks);
// mirrors worker (port 9101) + collab (port 1235) shape so
// all three services expose `GET /healthz` on a `primary+1` style port.
const health = startHealthServer({
  port: HEALTH_PORT,
  serviceName: "server",
  onMetrics: renderMetrics,
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
  checks: serverHealthChecks(),
});

/**
 * Graceful shutdown handler.
 * @param signal - The OS signal name that triggered shutdown (e.g. `SIGTERM`, `SIGINT`).
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down...`);
  // No Agent chat run starts from here on, and every one running is stopped
  // and stored as failed; what waited stays queued for the next instance
  // (inner#1717).
  markShuttingDown();

  // Stop health probe first so the LB stops sending traffic to this
  // instance while it drains in-flight HTTP requests; failing health
  // early is the explicit signal to the LB "rotate me out".
  await health.stop();
  await runGracefulShutdown({
    // Close the HTTP socket up front (in-flight requests finish within the
    // deadline), then drain the relay + pools concurrently and bounded.
    releaseListenSocket: () => {
      server.close();
      internalServer?.close();
    },
    drains: [
      () => {
        lifecycleRelay.stop();
        commerceRelay?.stop();
        return Promise.resolve();
      },
      // Work a route left running after its reply (an Agent chat run, a
      // password-reset send) still needs the pools, so they close once it has
      // finished.
      () =>
        maintenanceLoop
          .stop()
          .then(() => settleAfterReply())
          .then(() => Promise.allSettled([flushServerAnalytics(), closeDb(), closeRedis(), closeQueues(), closeChatSubscriberRedis()])),
    ],
    deadlineMs: getServerShutdownDeadlineMs(),
  });
  for (const ctx of pendingAfterReply()) {
    logger.error(ctx, "after_reply_cut_off_by_shutdown");
  }

  logger.info("Shutdown complete");
  await exitProcess(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
