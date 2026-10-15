// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions the Space content-row repair makes, apart from the database so
 * they run under `node --test` (inner#1140).
 */

/**
 * How long a content row must have gone untouched before the repair may
 * soft-delete it. A new Space writes its content row first and its meta entry
 * reaches the database on the next store, at most ten seconds later; a restore
 * moves `updated_at` too. An hour leaves every such row alone.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Soft-deletes one row, rechecking in the same statement that it is still live
 * and still untouched for an hour, so a row restored or edited between the
 * report and the apply is left as it is. The interval is `STALE_AFTER_MS`.
 */
export const APPLY_SQL =
  "UPDATE yjs_documents SET deleted_at = now() " +
  "WHERE name = $1 AND deleted_at IS NULL AND updated_at < now() - interval '1 hour'";

/** A Space content doc name: `project-{projectId}/{kind}-{spaceId}`. */
const CONTENT_DOC_NAME = /^project-[^/]+\/(?:canvas|document|timeline)-(.+)$/;

/**
 * The live content rows of one project that its meta doc does not list and
 * nobody has touched for an hour. These are the rows that make the project's
 * live row count, which the Space cap reads, larger than its Spaces.
 * @param {{ metaSpaceIds: Set<string>, rows: { name: string, updatedAt: Date, deletedAt: Date | null }[], now: number }} input -
 *   The Space ids the project's meta lists, the project's rows, and the time to measure from.
 * @returns {string[]} The names of the rows to soft-delete.
 */
export function staleContentRows({ metaSpaceIds, rows, now }) {
  return rows
    .filter((row) => {
      if (row.deletedAt !== null) return false;
      const match = CONTENT_DOC_NAME.exec(row.name);
      if (!match) return false;
      if (metaSpaceIds.has(match[1])) return false;
      return now - row.updatedAt.getTime() > STALE_AFTER_MS;
    })
    .map((row) => row.name);
}
