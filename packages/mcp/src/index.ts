// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP service entry (breatic#1488 §13): external agents call it, it
 * exchanges their tokens with the server and sends commands to collab
 * through Redis DB 4.
 */

import { mcpEnv } from "@mcp/bootstrap-config.js";
import {
  createLogger,
  createRedisClient,
  getMcpConfig,
  getNodeTaskConfig,
  loadLocales,
  runGracefulShutdown,
  startHealthServer,
  type HealthCheck,
} from "@breatic/core";
import { serve } from "@hono/node-server";
import { createMcpApp, type AgentCall } from "@mcp/app.js";
import { createCommandChannel } from "@mcp/command-channel.js";
import { redisAnswers, serverAnswers, waitUntilReady } from "@mcp/probes.js";
import { createServerApi } from "@mcp/server-api.js";
import { ALL_TOOLS, INSTRUCTIONS } from "@mcp/tools/index.js";
import { createTaskTracker } from "@mcp/tools/task-tracker.js";
import { createNewAssignments } from "@mcp/tools/new-assignments.js";
import { buildToolServer } from "@mcp/tools/tool-server.js";
import { createTokenExchanger, discoverTokenEndpoint } from "@mcp/token-exchange.js";

const logger = createLogger("main");

/**
 * Flush buffered log lines before an explicit exit; resolves after 500 ms at most.
 * @returns Resolves once flushed or timed out.
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

/**
 * Log, flush and exit.
 * @param code - The exit code.
 * @returns Never resolves.
 */
async function exit(code: number): Promise<never> {
  await flushLogger();
  process.exit(code);
}

/**
 * Start the service: check what it depends on, then serve MCP and health.
 * @returns Resolves once started.
 */
async function main(): Promise<void> {
  const commandRedis = createRedisClient(mcpEnv.REDIS_MCP_URL, { name: "mcp-commands" });
  commandRedis.on("error", (err) => logger.error({ err }, "mcp_redis_error"));

  // The server as this service reaches it; OAUTH_ISSUER is its public name.
  const serverOrigin = new URL(mcpEnv.MCP_API_BASE_URL).origin;
  const checks: HealthCheck[] = [
    { name: "server", check: serverAnswers(serverOrigin) },
    { name: "redis_mcp", check: redisAnswers(commandRedis) },
  ];
  const mcpConfig = getMcpConfig();
  const deadlineAt = Date.now() + mcpConfig.startup_wait_ms;
  for (const { name, check } of checks) {
    const ready = await waitUntilReady(check, { deadlineAt, intervalMs: mcpConfig.startup_retry_interval_ms });
    if (ready instanceof Error) {
      logger.fatal({ err: ready, check: name }, "mcp_startup_dependency_unreachable");
      await exit(1);
    } else if (!ready) {
      logger.fatal({ check: name }, "mcp_startup_dependency_unhealthy");
      await exit(1);
    }
  }

  // Template names and words are read from the locale catalogs.
  loadLocales();
  const doneSubscriber = createRedisClient(mcpEnv.REDIS_MCP_URL, { name: "mcp-done" });
  doneSubscriber.on("error", (err) => logger.error({ err }, "mcp_done_subscriber_error"));
  const commands = await createCommandChannel({
    redis: commandRedis,
    subscriber: doneSubscriber,
    prefix: mcpEnv.REDIS_KEY_PREFIX,
    operationTtlSeconds: Math.ceil(mcpConfig.call_timeout_ms / 1000) + mcpConfig.reply_ttl_seconds,
  });

  // A task can run for its whole budget, and its outcome stays readable a while after.
  const taskListTtlSeconds = Math.ceil(getNodeTaskConfig().default_budget_ms / 1000) + mcpConfig.reply_ttl_seconds;
  const tokenEndpoint = await discoverTokenEndpoint(serverOrigin, mcpConfig.call_timeout_ms);
  const app = createMcpApp({
    resourceUrl: new URL(mcpEnv.MCP_PUBLIC_URL),
    issuer: mcpEnv.OAUTH_ISSUER,
    exchange: createTokenExchanger({ tokenEndpoint, clientSecret: mcpEnv.MCP_CLIENT_SECRET, timeoutMs: mcpConfig.call_timeout_ms }),
    buildServer: (call: AgentCall) => {
      const who = { userId: call.userId, connectionId: call.connectionId };
      return buildToolServer(
        {
          call,
          api: createServerApi({ baseUrl: mcpEnv.MCP_API_BASE_URL, token: call.downstreamToken, deadlineAt: call.startedAt + mcpConfig.call_timeout_ms }),
          commands,
          tasks: createTaskTracker({
            redis: commandRedis,
            prefix: mcpEnv.REDIS_KEY_PREFIX,
            connectionId: call.connectionId,
            ttlSeconds: taskListTtlSeconds,
            maxIdsPerQuery: mcpConfig.task_query_max_ids,
          }),
          newAssignments: createNewAssignments({ redis: commandRedis, prefix: mcpEnv.REDIS_KEY_PREFIX, connectionId: call.connectionId }),
          config: mcpConfig,
          report: (err, context) => logger.error({ err, ctx: { ...context, ...who } }, "mcp_tool_background_failed"),
        },
        ALL_TOOLS,
        { instructions: INSTRUCTIONS, onError: (err, tool) => logger.error({ err, ctx: { tool, ...who } }, "mcp_tool_failed") },
      );
    },
    onError: (err) => logger.error({ err }, "mcp_handler_error"),
  });
  const httpServer = serve({ fetch: app.fetch, port: mcpEnv.MCP_PORT }, (info) => logger.info({ port: info.port }, "mcp_listening"));

  const healthServer = startHealthServer({
    port: mcpEnv.MCP_HEALTH_PORT,
    serviceName: "mcp",
    checks,
    onEvent: (event) => {
      if (event.type === "listening") logger.info({ port: event.port }, "healthz_listening");
      else if (event.type === "check_fail") logger.warn({ checks: event.checks }, "healthz_fail");
      else if (event.type === "handler_unexpected_error") logger.error({ err: event.err }, "healthz_handler_unexpected_error");
      else if (event.type === "listen_error") {
        logger.fatal({ port: event.port, err: event.err }, "healthz_listen_error");
        void exit(1);
      }
    },
  });

  /**
   * Stop serving, close connections and exit.
   * @param signal - The signal that asked for it.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "Shutting down...");
    let httpClosed: Promise<void> = Promise.resolve();
    await runGracefulShutdown({
      // Stop taking requests; the ones in flight finish before the channel closes.
      releaseListenSocket: () => {
        httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      },
      drains: [() => healthServer.stop(), async () => {
        await httpClosed;
        await commands.close();
        await commandRedis.quit();
      }],
      // A call in flight lasts at most this long.
      deadlineMs: mcpConfig.call_timeout_ms,
    });
    logger.info("Shutdown complete");
    await exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch(async (err: unknown) => {
  logger.fatal({ err }, "mcp_startup_failed");
  await exit(1);
});
