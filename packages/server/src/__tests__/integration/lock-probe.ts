// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Row-lock probe for concurrency integration tests.
 *
 * Interleaving two service calls with `Promise.allSettled` proves nothing: the
 * ordering that breaks an invariant may simply never occur, and the test then
 * passes for the wrong reason. These tests instead hold a row lock from a
 * separate connection to park one transaction at a chosen point, and use this
 * probe to turn "the other side has reached its first write" into an observed
 * fact rather than a sleep.
 */

import type postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/** How long to wait for a backend to park on a lock before giving up. */
const BLOCK_TIMEOUT_MS = 10_000;

/** How often to re-check `pg_stat_activity`. */
const POLL_INTERVAL_MS = 25;

/**
 * Block until `expected` backends are parked waiting on a lock, each running a
 * statement that matches every one of `queryLike`.
 *
 * Two parameters exist because a probe that answers "is anyone blocked?" cannot
 * be called twice in a row: the first parked backend keeps answering yes, so
 * the second call returns whether or not the second party ever arrived, and the
 * test claims an interleaving it never observed. Waiting for a count instead
 * makes each call name how many parties must be in the queue by then.
 *
 * `queryLike` is a set of substrings that must ALL appear, because a table name
 * on its own does not identify a statement: an append parked on
 * `SELECT ... FROM conversations ... FOR UPDATE` and one parked on
 * `UPDATE conversations SET updated_at` are the same string match but different
 * facts, and only one of them is the lock a test is pinning.
 * @param sql - a connection separate from the ones under test
 * @param queryLike - substrings that must all appear in the waiting backend's
 *   query text
 * @param expected - how many backends must be parked before returning
 * @throws {Error} when the count is not reached within {@link BLOCK_TIMEOUT_MS}
 *   — the interleaving the caller depends on never happened, so letting it
 *   continue would produce a meaningless pass
 */
export async function waitUntilBlockedOn(
  sql: Sql,
  queryLike: readonly string[],
  expected = 1,
): Promise<void> {
  const needles = queryLike.map((s) => s.toLowerCase());
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // Filtered here rather than in SQL: matching a set of substrings is a
    // multi-pattern ILIKE, and spelling that as a parameterised array buys
    // nothing over reading the handful of parked statements back.
    const rows = await sql<{ query: string }[]>`
      SELECT query FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND state = 'active'
    `;
    const parked = rows.filter((r) => {
      const q = r.query.toLowerCase();
      return needles.every((n) => q.includes(n));
    });
    if (parked.length >= expected) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(
    `only fewer than ${expected} backend(s) ever blocked on a statement matching ${queryLike.join(" + ")}`,
  );
}
