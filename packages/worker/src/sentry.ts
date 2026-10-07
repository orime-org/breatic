// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Error monitoring for the job worker.
 *
 * Error and fatal log lines become Sentry events through the pino
 * integration, so every `logger.error({ err })` the application already
 * writes is reported without a second call. A blank `SENTRY_DSN` leaves the
 * SDK unstarted, which is how a self-hosted instance runs.
 */

import { resolve } from "node:path";
import * as Sentry from "@sentry/node";
import { env, errorMonitoringOptions, MONOREPO_ROOT, type ErrorMonitoringStart } from "@breatic/core";

/** How long an exit waits for pending events, in milliseconds. */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Start error monitoring when a DSN is configured.
 *
 * Called right after config bootstrap and before the first log line.
 * Unhandled rejections are reported and then end the process, which keeps
 * the crash-and-restart behaviour the worker had before monitoring. The SDK
 * ignores two by name, `AbortError` and `AI_NoOutputGeneratedError`: those
 * are neither reported nor fatal while monitoring is on.
 * @returns `started`, `off` when no DSN is set, or `invalid_dsn` when the
 *   DSN is not one; the entry logs the last once its logger is up.
 */
export function initSentry(): ErrorMonitoringStart {
  const options = errorMonitoringOptions({
    dsn: env.SENTRY_DSN,
    deployment: env.ENV,
    service: "worker",
    buildInfoPath: resolve(MONOREPO_ROOT, "build-info.json"),
  });
  if (options === null) return env.SENTRY_DSN === "" ? "off" : "invalid_dsn";
  Sentry.init({
    ...options,
    integrations: [
      Sentry.pinoIntegration({ log: { levels: [] }, error: { levels: ["error", "fatal"] } }),
      Sentry.onUnhandledRejectionIntegration({ mode: "strict" }),
    ],
  });
  return "started";
}

/**
 * End the process after pending error events are sent.
 *
 * Every exit in the entry goes through here: a log line reported just before
 * exiting is only queued, and `process.exit` alone would drop it.
 * @param code - The process exit code.
 * @returns Never; the process ends.
 */
export async function exitProcess(code: number): Promise<never> {
  await Sentry.flush(FLUSH_TIMEOUT_MS);
  process.exit(code);
}
