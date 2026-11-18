// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The MCP service entry (breatic#1488 §13): external agents call it, it
 * exchanges their tokens with the server and sends commands to collab
 * through Redis DB 4.
 */

import { mcpEnv } from "@mcp/bootstrap-config.js";
import { createLogger, createRedisClient, getMcpConfig, runGracefulShutdown, startHealthServer, type HealthCheck } from "@breatic/core";
import { redisAnswers, serverAnswers } from "@mcp/probes.js";

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
 * Start the service: check what it depends on, then serve health.
 * @returns Resolves once started.
 */
async function main(): Promise<void> {
  const commandRedis = createRedisClient(mcpEnv.REDIS_MCP_URL, { name: "mcp-commands" });
  commandRedis.on("error", (err) => logger.error({ err }, "mcp_redis_error"));

  const checks: HealthCheck[] = [
    { name: "server", check: serverAnswers(mcpEnv.OAUTH_ISSUER) },
    { name: "redis_mcp", check: redisAnswers(commandRedis) },
  ];
  for (const { name, check } of checks) {
    const ok = await check().catch((err: unknown) => {
      logger.fatal({ err, check: name }, "mcp_startup_dependency_unreachable");
      return false;
    });
    if (!ok) {
      logger.fatal({ check: name }, "mcp_startup_dependency_unhealthy");
      await exit(1);
    }
  }

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
    await runGracefulShutdown({
      releaseListenSocket: () => {},
      drains: [() => healthServer.stop(), () => commandRedis.quit()],
      // A call in flight lasts at most this long.
      deadlineMs: getMcpConfig().call_timeout_ms,
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
