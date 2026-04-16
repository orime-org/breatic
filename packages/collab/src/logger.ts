/**
 * Collab service logger (pino).
 *
 * Mirrors the core logger configuration: console + daily-rotated files.
 * Directory: logs/collab/collab.log
 */

import pino from "pino";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const ENV = process.env.ENV ?? "dev";
const DEBUG = process.env.DEBUG === "true";

const LOGS_ROOT = resolve(import.meta.dirname, "../../../logs");
const SERVICE_LOGS_DIR = resolve(LOGS_ROOT, "collab");

try {
  mkdirSync(SERVICE_LOGS_DIR, { recursive: true });
} catch {
  // May fail in read-only environments — console-only logging
}

function buildTransport(): pino.TransportMultiOptions {
  const targets: pino.TransportTargetOptions[] = [];

  if (ENV === "dev") {
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
      file: resolve(SERVICE_LOGS_DIR, "collab.log"),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      mkdir: true,
    },
    level: DEBUG ? "debug" : "info",
  });

  return { targets };
}

/** Create a child logger with a specific component name. */
export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ component: name });
}

const rootLogger = pino({
  name: "collab",
  level: DEBUG ? "debug" : "info",
  timestamp: () => `,"time":${Date.now()},"timestamp":"${new Date().toISOString()}"`,
  transport: buildTransport(),
});

export { rootLogger as logger };
