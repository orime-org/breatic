/**
 * Application logger (pino).
 *
 * Call {@link initLogger} at the entry point before any logging:
 *   - API:    initLogger("api")    — or skip (default)
 *   - Worker: initLogger("worker")
 *
 * Log files: logs/{service}/{service}.2026-04-16.1.log
 * Rotation: daily at midnight (pino-roll).
 * Console: pretty-printed in dev, JSON in production.
 */

import pino from "pino";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { env, MONOREPO_ROOT } from "@core/config/env.js";

function buildLogger(serviceName: string): pino.Logger {
  const logsRoot = resolve(MONOREPO_ROOT, "logs");
  const serviceLogsDir = resolve(logsRoot, serviceName);

  try {
    mkdirSync(serviceLogsDir, { recursive: true });
  } catch {
    // May fail in read-only environments — console-only logging
  }

  const targets: pino.TransportTargetOptions[] = [];

  if (env.ENV === "dev") {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true },
      level: "debug",
    });
  } else {
    targets.push({
      target: "pino/file",
      options: { destination: 1 },
      level: "info",
    });
  }

  targets.push({
    target: "pino-roll",
    options: {
      file: resolve(serviceLogsDir, `${serviceName}.log`),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      mkdir: true,
    },
    level: env.DEBUG ? "debug" : "info",
  });

  return pino({
    level: env.DEBUG ? "debug" : "info",
    timestamp: () => `,"timestamp":"${new Date().toISOString()}","time":${Date.now()}`,
    transport: { targets },
  });
}

/**
 * Initialize the logger for a specific service.
 * Must be called before any logging occurs.
 */
export function initLogger(serviceName: string): void {
  logger = buildLogger(serviceName);
}

/** Logger instance — defaults to "api", call initLogger() to override. */
// eslint-disable-next-line import/no-mutable-exports
export let logger: pino.Logger = buildLogger("api");
