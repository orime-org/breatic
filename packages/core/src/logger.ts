/**
 * Application logger (pino).
 *
 * Outputs to both console and daily-rotated log files.
 * Directory structure:
 *   logs/api/api.log          ← current day
 *   logs/api/api.2026-04-08.log ← archived
 *   logs/collab/collab.log
 *   logs/worker/worker.log
 *
 * Rotation: daily at midnight (00:00).
 * Console: pretty-printed in dev, JSON in production.
 */

import pino from "pino";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { env } from "./config/env.js";

/** Service name — set via SERVICE_NAME env var in docker-compose. */
const SERVICE_NAME = process.env.SERVICE_NAME ?? "api";

/** Logs root at monorepo root. */
const LOGS_ROOT = resolve(import.meta.dirname, "../../../logs");

/** Per-service logs directory: logs/api/, logs/collab/, logs/worker/. */
const SERVICE_LOGS_DIR = resolve(LOGS_ROOT, SERVICE_NAME);

// Ensure per-service logs directory exists
try {
  mkdirSync(SERVICE_LOGS_DIR, { recursive: true });
} catch {
  // May fail in read-only environments — console-only logging
}

function buildTransport(): pino.TransportMultiOptions {
  const targets: pino.TransportTargetOptions[] = [];

  // Console output
  if (env.ENV === "dev") {
    targets.push({
      target: "pino-pretty",
      options: { colorize: true },
      level: "debug",
    });
  } else {
    targets.push({
      target: "pino/file",
      options: { destination: 1 }, // stdout
      level: "info",
    });
  }

  // File output with daily rotation at midnight
  // Current: logs/api/api.log → Archived: logs/api/api.2026-04-08.log
  targets.push({
    target: "pino-roll",
    options: {
      file: resolve(SERVICE_LOGS_DIR, `${SERVICE_NAME}.log`),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      mkdir: true,
      // pino-roll renames current file to {name}.{date}.log at midnight
    },
    level: env.DEBUG ? "debug" : "info",
  });

  return { targets };
}

/** Singleton pino logger instance. */
export const logger = pino({
  level: env.DEBUG ? "debug" : "info",
  timestamp: () => `,"time":${Date.now()},"timestamp":"${new Date().toISOString()}"`,
  transport: buildTransport(),
});
