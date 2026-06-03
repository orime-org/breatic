// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `yjs_documents` repository — the single home for every SQL query
 * against the Yjs binary-document table.
 *
 * `yjs_documents` is shared infrastructure, not a service-private table:
 *
 *   - the collab process reads / writes it on every document load +
 *     debounced save (persistence extension), on the auth-hook
 *     space-existence check, and on Space lifecycle RPCs (space-rpc
 *     soft-delete / restore);
 *   - the API server seeds the meta doc at project creation and
 *     cascades soft-delete / duplicate-with-prefix-rewrite when a
 *     project is removed / copied.
 *
 * Per the "one table, one repo home" mandate every one of those queries
 * lives here, in `@breatic/core` — the db layer's home and the only
 * package allowed to touch the postgres.js driver — so the table's
 * access can never scatter (and drift) across services again. Before
 * 2026-06-02 the SQL was split between two server repos (Drizzle) and a
 * hand-rolled collab postgres.js pool; this module is that split's
 * single replacement.
 *
 * Runtime callers (collab persistence / auth / space-rpc) use the
 * process-wide {@link db} singleton — each separately-deployed process
 * (server / worker / collab) gets its own lazily-built pool. Callers
 * inside a larger atomic unit (server project create / delete /
 * duplicate) pass their `tx` so the yjs write participates in the
 * surrounding transaction.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@core/db/client.js";
import type { DbTx } from "@core/db/client.js";
import { yjsDocuments } from "@core/db/yjs-schema.js";

/**
 * Fetch the latest binary state of a live (non-soft-deleted) Yjs doc.
 *
 * The `deleted_at IS NULL` filter is load-bearing: a stale client
 * reconnecting after its project was soft-deleted must NOT recover the
 * old content, so a soft-deleted row reads as absent.
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @returns The stored Yjs update bytes, or `null` when no live row exists
 */
export async function fetchDocData(name: string): Promise<Uint8Array | null> {
  const rows = await db
    .select({ data: yjsDocuments.data })
    .from(yjsDocuments)
    .where(and(eq(yjsDocuments.name, name), isNull(yjsDocuments.deletedAt)))
    .limit(1);
  return rows[0]?.data ?? null;
}

/**
 * Upsert the binary state of a Yjs doc (Hocuspocus persistence `store`).
 *
 * On conflict the row's `deleted_at` is cleared, so a `store` after a
 * soft-delete resurrects the doc. In practice this cannot happen — a
 * soft-deleted project refuses WebSocket auth before Hocuspocus ever
 * calls `store` — but the explicit clear keeps the upsert semantics
 * simple and self-consistent (defense in depth).
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @param data - Encoded Yjs update bytes to persist
 */
export async function upsertDocData(
  name: string,
  data: Uint8Array,
): Promise<void> {
  const buf = Buffer.from(data);
  await db
    .insert(yjsDocuments)
    .values({ name, data: buf })
    .onConflictDoUpdate({
      target: yjsDocuments.name,
      set: { data: buf, updatedAt: sql`now()`, deletedAt: null },
    });
}

/**
 * Insert a fresh row with a precomputed initial Yjs update payload,
 * inside the caller's transaction.
 *
 * Used by `project.service.create` to seed the project's meta doc
 * (`project-{pid}/meta`) with a default Space in the same transaction
 * that creates the project + owner row, so "project exists ⇒ meta doc
 * with at least one Space exists" holds atomically.
 *
 * The primary key is `name`, so a repeat insert with the same name
 * raises a unique-violation; the function does NOT swallow it — the
 * caller's transaction must roll back. The caller owns the doc-name
 * format and the binary layout (see `core/db/yjs-bootstrap.ts`).
 * @param tx - Drizzle transaction handle from the surrounding
 *   `db.transaction(async tx => ...)` block
 * @param name - Full doc name (build via `@breatic/shared/yjs-doc-names`)
 * @param data - Encoded initial Yjs update; see
 *   `core/db/yjs-bootstrap.ts:encodeInitialMetaState`
 */
export async function insertInitialState(
  tx: DbTx,
  name: string,
  data: Uint8Array,
): Promise<void> {
  // postgres-js binds Buffer / Uint8Array to bytea directly; the `data`
  // column is NOT NULL so a zero-length array is rejected by Postgres
  // anyway (bootstrap callers always produce a non-empty update).
  await tx.insert(yjsDocuments).values({
    name,
    data: Buffer.from(data),
  });
}

/**
 * Soft-delete the row backing a named Yjs doc.
 *
 * Idempotent: no-op when the row is already soft-deleted or absent.
 * Used by the server on Space / project removal and by collab's
 * space-rpc delete handler.
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @returns `true` if a row was newly soft-deleted, `false` otherwise
 */
export async function softDeleteByName(name: string): Promise<boolean> {
  const rows = await db
    .update(yjsDocuments)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(yjsDocuments.name, name), isNull(yjsDocuments.deletedAt)))
    .returning({ name: yjsDocuments.name });
  return rows.length > 0;
}

/**
 * Restore (clear `deleted_at` on) the row backing a named Yjs doc.
 *
 * Unconditional by design: collab's space-rpc restore handler reverses
 * a prior soft-delete, and the row is known to exist (the restore path
 * rebuilt its `meta.spaces` entry from the deletion snapshot first).
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 */
export async function restoreByName(name: string): Promise<void> {
  await db
    .update(yjsDocuments)
    .set({ deletedAt: null })
    .where(eq(yjsDocuments.name, name));
}

/**
 * Soft-delete every live row whose name belongs to a project, inside
 * the caller's transaction.
 *
 * `yjs_documents` has no FK to `projects` — only a string `name` shaped
 * `project-{id}/...` (the v10 multi-doc layout: meta + per-space docs).
 * The server's `deleteProject` cascade calls this so meta + every Space
 * doc are soft-deleted in the same transaction as the project row. The
 * `deleted_at IS NULL` guard avoids overwriting an earlier timestamp.
 * @param tx - Drizzle transaction handle from the surrounding
 *   `db.transaction(async tx => ...)` block
 * @param projectId - Project whose `project-{id}/...` docs are removed
 */
export async function softDeleteByProjectPrefix(
  tx: DbTx,
  projectId: string,
): Promise<void> {
  await tx
    .update(yjsDocuments)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        sql`${yjsDocuments.name} LIKE ${`project-${projectId}/%`}`,
        isNull(yjsDocuments.deletedAt),
      ),
    );
}

/**
 * Copy every Yjs doc of a source project to a new project id, rewriting
 * the `project-{sourceId}/` name prefix to `project-{newId}/`, inside
 * the caller's transaction.
 *
 * Used by the server's `duplicateProject` so the copy carries over meta
 * + every Canvas Space doc. Asset URLs inside the blobs continue to
 * point at the original storage objects (duplication is metadata-only
 * at the storage layer; OSS de-dupes by content hash).
 * @param tx - Drizzle transaction handle from the surrounding
 *   `db.transaction(async tx => ...)` block
 * @param sourceId - Project being duplicated
 * @param newId - Freshly created destination project id
 */
export async function duplicateByProjectPrefix(
  tx: DbTx,
  sourceId: string,
  newId: string,
): Promise<void> {
  const oldPrefix = `project-${sourceId}/`;
  const newPrefix = `project-${newId}/`;
  // `${...}::int` is load-bearing: Drizzle/postgres-js binds the
  // interpolated JS number as a TEXT param, and Postgres dispatches
  // `substring(text FROM text)` to the REGEX overload — which returns
  // NULL for any row whose name doesn't match the position as a pattern,
  // violating the NOT NULL `name` column. The `::int` cast forces the
  // `substring(text FROM int)` position overload (strip the old prefix).
  await tx.execute(sql`
    INSERT INTO yjs_documents (name, data, updated_at)
    SELECT ${newPrefix} || substring(name from ${oldPrefix.length + 1}::int),
           data,
           NOW()
    FROM yjs_documents
    WHERE name LIKE ${oldPrefix + "%"}
  `);
}
