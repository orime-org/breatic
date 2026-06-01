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

/**
 * Build a pino logger that writes to `logs/{serviceName}/` with daily
 * rotation, pretty console in dev and JSON file output in production.
 * @param serviceName - the service tag used for the log directory and file name
 * @returns the configured pino logger
 */
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
 * @param serviceName - the service tag (e.g. `"worker"`) used for log file routing
 */
export function initLogger(serviceName: string): void {
  logger = buildLogger(serviceName);
}

/**
 * Lazily-built default "api" logger, returned by the {@link logger}
 * Proxy until {@link initLogger} replaces it. Building it reads
 * `env.ENV` / `env.DEBUG`, so it must be deferred past `initCore` —
 * the same reason db / Redis / LLM providers are lazy.
 */
let _defaultLogger: pino.Logger | null = null;

/**
 * Build (once) and return the lazily-initialised default `"api"` logger.
 * @returns the process-wide default pino logger
 */
function getDefaultLogger(): pino.Logger {
  if (_defaultLogger === null) {
    _defaultLogger = buildLogger("api");
  }
  return _defaultLogger;
}

/**
 * Logger instance — defaults to "api", call initLogger() to override.
 *
 * The initial value is a Proxy over the lazily-built default logger
 * so that importing this module (and therefore the `@breatic/core`
 * barrel) reads no env at eval time — config is injected via
 * `initCore` at startup, before the app entry calls `initLogger` or
 * logs anything. Once `initLogger` runs, this binding is reassigned
 * to a concrete pino logger.
 */
// eslint-disable-next-line import/no-mutable-exports
export let logger: pino.Logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    const real = getDefaultLogger() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(real)
      : value;
  },
});
