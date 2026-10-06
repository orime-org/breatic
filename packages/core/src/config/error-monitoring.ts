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
import type { CoreConfig } from "@core/config/schema.js";

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/**
 * The environment name error events carry for a deployment.
 * @param deployment - The `ENV` value the service was started with.
 * @returns `production`, `staging` or `development`.
 */
export function errorMonitoringEnvironment(deployment: CoreConfig["ENV"]): string {
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
  const revision = (parsed as { revision?: unknown }).revision;
  return typeof revision === "string" && FULL_COMMIT.test(revision) ? revision : undefined;
}

/** Header names whose values identify a person or a network path. */
const IDENTIFYING_HEADERS = ["forwarded", "-ip", "remote-", "via", "-user"];

/**
 * What the SDK may collect on its own. Version 11 collects everything when
 * this is left unset; this is the restrictive baseline from Sentry's v10→v11
 * migration guide with query strings switched off as well, because some of
 * our links carry tokens in the query.
 */
const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: {
    request: { deny: IDENTIFYING_HEADERS },
    response: { deny: IDENTIFYING_HEADERS },
  },
  httpBodies: [],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  graphQL: { document: false, variables: false },
} as const;

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
  environment: string;
  release: string | undefined;
  initialScope: { tags: { service: MonitoredService } };
  dataCollection: typeof DATA_COLLECTION;
}

/**
 * The SDK options a backend service starts error monitoring with.
 * @param input - DSN, deployment, service name and build-info location.
 * @returns The options, or `null` when no DSN is configured.
 */
export function errorMonitoringOptions(input: ErrorMonitoringInput): ErrorMonitoringOptions | null {
  if (input.dsn === "") return null;
  return {
    dsn: input.dsn,
    environment: errorMonitoringEnvironment(input.deployment),
    release: readBuildRelease(input.buildInfoPath),
    initialScope: { tags: { service: input.service } },
    dataCollection: DATA_COLLECTION,
  };
}
