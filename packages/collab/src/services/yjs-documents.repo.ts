/**
 * Data access for the collab-owned `yjs_documents` table.
 *
 * `yjs_documents` is collab's private table: Hocuspocus documents are
 * stored as binary blobs keyed by `name`. Per CLAUDE.md "one table, one
 * repo home", every raw SQL query against it lives here — the persistence
 * extension (fetch / store), the space-RPC soft-delete / restore, and the
 * auth-hook space-existence read all call these functions instead of
 * inlining SQL. Soft-delete (`deleted_at`) is honoured per the project
 * soft-delete mandate.
 */

import type postgres from "postgres";

/** Postgres client bound to the collab-owned `yjs_documents` table. */
type Sql = ReturnType<typeof postgres>;

/**
 * Fetch a document's binary blob by name, skipping soft-deleted rows.
 * @param sql - Postgres client targeting the collab-owned `yjs_documents` table.
 * @param name - Hocuspocus document name (e.g. `project-{id}/meta`).
 * @returns The stored Yjs update bytes, or null when no live row exists.
 */
export async function fetchDocumentData(
  sql: Sql,
  name: string,
): Promise<Uint8Array | null> {
  const rows = await sql<{ data: Uint8Array }[]>`
    SELECT data
    FROM yjs_documents
    WHERE name = ${name} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows[0]?.data ?? null;
}

/**
 * Upsert a document's binary blob, clearing any soft-delete marker.
 * @param sql - Postgres client targeting the collab-owned `yjs_documents` table.
 * @param name - Hocuspocus document name.
 * @param state - Yjs document state to persist.
 * @returns A promise that resolves once the row is written.
 */
export async function storeDocument(
  sql: Sql,
  name: string,
  state: Uint8Array,
): Promise<void> {
  await sql`
    INSERT INTO yjs_documents (name, data, updated_at, deleted_at)
    VALUES (${name}, ${state}, NOW(), NULL)
    ON CONFLICT (name) DO UPDATE
    SET data = EXCLUDED.data, updated_at = NOW(), deleted_at = NULL
  `;
}

/**
 * Soft-delete a document row by name (idempotent — only marks live rows).
 * @param sql - Postgres client targeting the collab-owned `yjs_documents` table.
 * @param name - Hocuspocus document name to mark deleted.
 * @returns A promise that resolves once the row is marked deleted.
 */
export async function softDeleteDocument(sql: Sql, name: string): Promise<void> {
  await sql`
    UPDATE yjs_documents
    SET deleted_at = now()
    WHERE name = ${name} AND deleted_at IS NULL
  `;
}

/**
 * Restore a soft-deleted document row (clear its `deleted_at`).
 * @param sql - Postgres client targeting the collab-owned `yjs_documents` table.
 * @param name - Hocuspocus document name to restore.
 * @returns A promise that resolves once the row is restored.
 */
export async function restoreDocument(sql: Sql, name: string): Promise<void> {
  await sql`
    UPDATE yjs_documents
    SET deleted_at = NULL
    WHERE name = ${name}
  `;
}
