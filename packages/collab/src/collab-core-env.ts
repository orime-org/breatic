// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The environment collab hands core (inner#2043): the process environment
 * with `DATABASE_URL` set to collab's own login from `COLLAB_DATABASE_URL`,
 * so core's `db`, health check and startup probe, and anything else in the
 * process that reads `DATABASE_URL`, connect as collab, as in collab's
 * integration suite.
 */

import { withoutPassword } from "@breatic/core";

/**
 * Point the environment collab passes to `initCore` at collab's own login.
 * @param raw - The process environment, changed in place.
 * @returns The same object, with `DATABASE_URL` set to `COLLAB_DATABASE_URL`.
 * @throws {Error} When `COLLAB_DATABASE_URL` is missing or blank.
 */
export function collabCoreEnv(raw: Record<string, string | undefined>): Record<string, string | undefined> {
  const collabUrl = raw.COLLAB_DATABASE_URL?.trim();
  if (collabUrl === undefined || collabUrl === "") {
    throw new Error("COLLAB_DATABASE_URL is required: collab connects to the product database only with its own login");
  }
  raw.DATABASE_URL = collabUrl;
  return raw;
}

/**
 * What to check when collab's startup cannot reach the product database with its own login.
 * @param collabUrl - The URL collab connected with (`COLLAB_DATABASE_URL`).
 * @returns The hint for the `infra_not_ready` log line, without the password.
 */
export function collabPostgresHint(collabUrl: string): string {
  return `Check COLLAB_DATABASE_URL=${withoutPassword(collabUrl)}; its login is created by pnpm db:migrate `
    + "(the migrate service under docker compose), or run: docker compose up -d postgres";
}
