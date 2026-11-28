// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The environment collab hands core (inner#2043): the same values, except
 * that `DATABASE_URL` is collab's own login from `COLLAB_DATABASE_URL`, so
 * core's `db`, health check and startup probe all connect as collab.
 */

/**
 * Build the environment collab passes to `initCore`.
 * @param raw - The process environment.
 * @returns A copy with `DATABASE_URL` set to `COLLAB_DATABASE_URL`.
 * @throws {Error} When `COLLAB_DATABASE_URL` is missing or blank.
 */
export function collabCoreEnv(raw: Record<string, string | undefined>): Record<string, string | undefined> {
  const collabUrl = raw.COLLAB_DATABASE_URL?.trim();
  if (collabUrl === undefined || collabUrl === "") {
    throw new Error("COLLAB_DATABASE_URL is required: collab connects to the product database only with its own login");
  }
  return { ...raw, DATABASE_URL: collabUrl };
}
