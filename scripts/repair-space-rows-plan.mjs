// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions the Space content-row repair makes, apart from the database so
 * they run under `node --test` (inner#1158). The apply statement itself runs
 * against a real database in collab's space-row-repair integration test.
 */

/**
 * How long a content row must have gone untouched before the repair may
 * soft-delete it. A new Space writes its content row first and its meta entry
 * reaches the database on the next store, at most ten seconds later; a restore
 * moves `updated_at` too. An hour leaves every such row alone.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Soft-deletes one row (`$1`), rechecking in the same statement that it is
 * still live and still untouched for `$2` milliseconds, so a row restored or
 * edited between the report and the apply is left as it is. Called with
 * `[name, STALE_AFTER_MS]`.
 */
export const APPLY_SQL =
  "UPDATE yjs_documents SET deleted_at = now() " +
  "WHERE name = $1 AND deleted_at IS NULL AND updated_at < now() - $2::bigint * interval '1 millisecond'";

/**
 * The live content rows of one project that its meta doc does not list and
 * nobody has touched for {@link STALE_AFTER_MS}. These are the rows that make
 * the project's live row count, which the Space cap reads, larger than its
 * Spaces — including a row of another kind under a listed Space's id.
 * @param {{ listedNames: Set<string>, rows: { name: string, updatedAt: Date, deletedAt: Date | null }[], now: number }} input -
 *   The content doc names the project's meta lists, the project's content rows, and the time to measure from.
 * @returns {string[]} The names of the rows to soft-delete.
 */
export function staleContentRows({ listedNames, rows, now }) {
  return rows
    .filter(
      (row) =>
        row.deletedAt === null &&
        !listedNames.has(row.name) &&
        now - row.updatedAt.getTime() > STALE_AFTER_MS,
    )
    .map((row) => row.name);
}

/**
 * Report one project's stale rows and, with `apply`, soft-delete them one by
 * one through `softDelete`, which answers how many rows it changed.
 * @param {{ listedNames: Set<string>, rows: { name: string, updatedAt: Date, deletedAt: Date | null }[], now: number, apply: boolean, softDelete: (name: string) => Promise<number> }} input -
 *   The project's listed names and content rows, the time to measure from, whether to write, and the writer.
 * @returns {Promise<{ stale: string[], softDeleted: string[], leftAlone: string[] }>}
 *   The stale rows; of those, the ones soft-deleted and the ones that changed since the report.
 */
export async function repairProject({ listedNames, rows, now, apply, softDelete }) {
  const stale = staleContentRows({ listedNames, rows, now });
  const softDeleted = [];
  const leftAlone = [];
  if (apply) {
    for (const name of stale) {
      ((await softDelete(name)) === 1 ? softDeleted : leftAlone).push(name);
    }
  }
  return { stale, softDeleted, leftAlone };
}
