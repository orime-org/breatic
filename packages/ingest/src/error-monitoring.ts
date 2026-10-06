// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where every failure this Worker answers for is written down, and what it
 * hands its error monitoring.
 *
 * One outlet, so a failure added later is reported without anyone having to
 * remember to: each one goes to the log, and each one also goes to Sentry
 * unless its caller says it came from the reader's own input — a link they
 * handed us that we cannot take, or bytes of a kind we do not store. Those are
 * answered with a reason the reader can act on and are nothing for us to fix.
 */

import * as Sentry from "@sentry/cloudflare";
import {
  errorMonitoringDataCollection,
  errorMonitoringEnvironmentName,
  errorMonitoringRelease,
  type ErrorMonitoringDataCollection,
  type ErrorMonitoringEnvironment,
} from "@breatic/shared";

/** The monitoring settings a deployment may carry; none is required. */
export interface MonitoringEnv {
  /** Where events go; blank or absent turns reporting off. */
  SENTRY_DSN?: string;
  /** The full commit this deployment was built from. */
  SENTRY_RELEASE?: string;
  /** `production`, `staging` or `development`. */
  SENTRY_ENVIRONMENT?: string;
}

/** What the SDK is started with on each request. */
export interface MonitoringOptions {
  dsn: string;
  release: string | undefined;
  environment: ErrorMonitoringEnvironment;
  dataCollection: ErrorMonitoringDataCollection;
}

/**
 * The SDK options for this deployment.
 *
 * Both `release` and `environment` are always present: the SDK fills either
 * from the same variables when the key is missing, which would carry a
 * malformed value through unchecked. A release that is not a full commit is
 * left unset, and an environment that is not one of the shared names becomes
 * `development`.
 * @param env - The Worker's bindings.
 * @returns The options.
 */
export function monitoringOptions(env: MonitoringEnv): MonitoringOptions {
  return {
    dsn: env.SENTRY_DSN ?? "",
    release: errorMonitoringRelease(env.SENTRY_RELEASE),
    environment: errorMonitoringEnvironmentName(env.SENTRY_ENVIRONMENT) ?? "development",
    dataCollection: errorMonitoringDataCollection(),
  };
}

/** How a caller describes the failure it is writing down. */
export interface FailureKind {
  /** The reader's own input caused it; it is logged and not reported. */
  userInput?: boolean;
}

/**
 * Write down a failure this Worker turns into an answer of its own.
 *
 * The answer says what the browser can do about it; the reason it happened
 * exists nowhere else. Without this an operator cannot tell a wrong URL from a
 * refused claim from R2 turning an assembly down — every one of them reads as
 * the same 502 in Cloudflare's logs.
 * @param label - What failed, as one searchable token.
 * @param ctx - The key, ids and status that name this attempt.
 * @param err - The error that said so, when there was one.
 * @param kind - Whether the reader's own input caused it.
 */
export function noteFailure(
  label: string,
  ctx: Record<string, unknown>,
  err?: unknown,
  kind: FailureKind = {},
): void {
  console.error(
    label,
    err === undefined ? ctx : { ...ctx, err: err instanceof Error ? err.stack : String(err) },
  );
  if (kind.userInput === true) return;
  if (err === undefined) {
    Sentry.captureMessage(label, { level: "error", tags: { label } });
  } else {
    Sentry.captureException(err, { tags: { label } });
  }
}

/**
 * Turn a rejected promise into null, writing down what it was.
 * @param label - What failed, as one searchable token.
 * @param ctx - The key and ids that name this attempt.
 * @param kind - Whether the reader's own input caused it.
 * @returns A catch handler answering null.
 */
export function noted(
  label: string,
  ctx: Record<string, unknown>,
  kind: FailureKind = {},
): (err: unknown) => null {
  return (err: unknown): null => {
    noteFailure(label, ctx, err, kind);
    return null;
  };
}
