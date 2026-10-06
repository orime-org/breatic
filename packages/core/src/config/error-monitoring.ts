// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Values the backend services hand to their error monitoring.
 *
 * The web build and the ingest Worker report the same release and the same
 * environment names, so one Sentry release spans all three projects and a
 * filter on `production` catches every one of them.
 */

import { readFileSync } from "node:fs";
import {
  errorMonitoringDataCollection,
  errorMonitoringRelease,
  isSentryDsn,
  requestWithoutQuery,
  type ErrorMonitoringDataCollection,
  type ErrorMonitoringEnvironment,
} from "@breatic/shared";
import type { CoreConfig } from "@core/config/schema.js";

/**
 * The environment name error events carry for a deployment.
 * @param deployment - The `ENV` value the service was started with.
 * @returns `production`, `staging` or `development`.
 */
export function errorMonitoringEnvironment(deployment: CoreConfig["ENV"]): ErrorMonitoringEnvironment {
  if (deployment === "prod") return "production";
  if (deployment === "dev") return "development";
  return "staging";
}

/**
 * The commit an image was built from, read from the build-info file the
 * release pipeline writes into it.
 *
 * Images built outside the release pipeline record `unknown`, and a local
 * checkout has no file at all; both yield nothing, so their events carry no
 * release instead of a shared placeholder.
 * @param path - Location of `build-info.json`.
 * @returns The full lowercase commit hash, or `undefined`.
 */
export function readBuildRelease(path: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // A missing or unreadable file means the image carries no release.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  return errorMonitoringRelease((parsed as { revision?: unknown }).revision);
}

/** How starting error monitoring went: running, not configured, or a DSN the SDK would not send to. */
export type ErrorMonitoringStart = "started" | "off" | "invalid_dsn";

/** The backend services that report to the shared backend project. */
export type MonitoredService = "server" | "worker" | "collab";

/** Inputs to {@link errorMonitoringOptions}. */
export interface ErrorMonitoringInput {
  /** The configured DSN; blank turns monitoring off. */
  dsn: string;
  /** The `ENV` value the service was started with. */
  deployment: CoreConfig["ENV"];
  /** Which service the events come from. */
  service: MonitoredService;
  /** Location of the image's `build-info.json`. */
  buildInfoPath: string;
}

/** SDK options every backend service shares. */
export interface ErrorMonitoringOptions {
  dsn: string;
  environment: ErrorMonitoringEnvironment;
  release: string | undefined;
  initialScope: { tags: { service: MonitoredService } };
  dataCollection: ErrorMonitoringDataCollection;
  beforeSend: typeof requestWithoutQuery;
}

/**
 * The SDK options a backend service starts error monitoring with.
 * @param input - DSN, deployment, service name and build-info location.
 * @returns The options, or `null` when no DSN is configured or it is not a DSN.
 */
export function errorMonitoringOptions(input: ErrorMonitoringInput): ErrorMonitoringOptions | null {
  if (input.dsn === "" || !isSentryDsn(input.dsn)) return null;
  return {
    dsn: input.dsn,
    environment: errorMonitoringEnvironment(input.deployment),
    release: readBuildRelease(input.buildInfoPath),
    initialScope: { tags: { service: input.service } },
    dataCollection: errorMonitoringDataCollection(),
    beforeSend: requestWithoutQuery,
  };
}
