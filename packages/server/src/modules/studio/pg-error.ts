// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Postgres error helpers shared across the studio module's services.
 *
 * Extracted so the studio + invite services share one correct
 * unique-violation check instead of each re-implementing it (the older
 * `shareLink.service` copy only inspects the top-level `code`, which misses
 * the drizzle-wrapped case — tracked separately).
 */

/**
 * Detect a PostgreSQL unique-violation (SQLSTATE 23505), walking the `.cause`
 * chain.
 *
 * Inside a `db.transaction`, drizzle 0.45 wraps the driver error in a
 * `DrizzleQueryError` and hangs the original postgres error (carrying
 * `code: '23505'`) on `.cause` — so a flat `err.code` check is not enough; we
 * walk the cause chain (bounded depth, no cycles).
 * @param err - Caught error of unknown shape
 * @returns True if any error in the cause chain carries the `23505` SQLSTATE code
 */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (
      typeof cur === "object" &&
      "code" in cur &&
      (cur as { code: unknown }).code === "23505"
    ) {
      return true;
    }
    cur =
      typeof cur === "object" && "cause" in cur
        ? (cur as { cause: unknown }).cause
        : null;
  }
  return false;
}
