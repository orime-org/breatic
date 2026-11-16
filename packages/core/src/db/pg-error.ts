// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Postgres error helpers shared across the backend.
 *
 * One correct unique-violation check instead of each service re-implementing
 * it — several earlier copies only inspected the top-level `code`, which misses
 * the drizzle-wrapped case (see {@link isUniqueViolation}).
 */

/**
 * Whether any error in the `.cause` chain carries this SQLSTATE.
 *
 * Inside a `db.transaction`, drizzle 0.45 wraps the driver error in a
 * `DrizzleQueryError` and hangs the original postgres error (carrying its
 * `code`) on `.cause` — so a flat top-level `err.code` check is not enough;
 * we walk the cause chain (bounded depth, no cycles).
 * @param err - Caught error of unknown shape
 * @param code - The SQLSTATE
 * @returns True if any error in the cause chain carries it
 */
function hasSqlState(err: unknown, code: string): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (typeof cur === "object" && "code" in cur && cur.code === code) {
      return true;
    }
    cur =
      typeof cur === "object" && "cause" in cur ? cur.cause : null;
  }
  return false;
}

/**
 * Detect a PostgreSQL unique-violation (SQLSTATE 23505), walking the `.cause`
 * chain.
 * @param err - Caught error of unknown shape
 * @returns True if any error in the cause chain carries the `23505` SQLSTATE code
 */
export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, "23505");
}

/**
 * Detect a PostgreSQL deadlock (SQLSTATE 40P01), walking the `.cause` chain.
 * @param err - Caught error of unknown shape
 * @returns True if any error in the cause chain carries the `40P01` SQLSTATE code
 */
export function isDeadlock(err: unknown): boolean {
  return hasSqlState(err, "40P01");
}
