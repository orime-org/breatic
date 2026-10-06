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
