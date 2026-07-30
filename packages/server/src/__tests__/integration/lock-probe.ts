// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * Block until some backend is parked waiting on a row lock over the given
 * table.
 *
 * @param sql - a connection separate from the ones under test
 * @param table - substring matched against the waiting backend's query text
 * @throws {Error} when nothing blocks within {@link BLOCK_TIMEOUT_MS} — the
 *   interleaving the caller depends on never happened, so letting it continue
 *   would produce a meaningless pass
 */
export async function waitUntilBlockedOn(
  sql: Sql,
  table: string,
): Promise<void> {
  const deadline = Date.now() + BLOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND state = 'active'
        AND query ILIKE ${"%" + table + "%"}
    `;
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`no backend ever blocked on a ${table} row lock`);
}
