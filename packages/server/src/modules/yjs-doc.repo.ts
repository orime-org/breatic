/**
 * `yjs_documents` repository — narrow helpers for the API server.
 *
 * Hocuspocus owns the table for read/write at the Yjs binary layer
 * during the lifetime of a project. The API server only writes here
 * in two situations:
 *
 *   1. Project creation — seed the meta doc with a default Space via
 *      {@link insertInitialState}. Safe because no client can be
 *      connected to the meta doc before the creating transaction
 *      commits.
 *   2. Soft-delete on Space / project removal via
 *      {@link softDeleteByName}.
 *
 * Helpers are exposed here so route handlers / project.service don't
 * reach into Drizzle internals across the package boundary (which
 * trips on drizzle-orm version-mismatch type errors).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { db } from "@breatic/core";
import { yjsDocuments } from "@breatic/core";

/**
 * Drizzle transaction handle as it appears inside a `db.transaction(...)`
 * callback. We type it loosely (`unknown` schemas) because the
 * underlying generic is internal to drizzle-orm and not part of the
 * public surface.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgTransaction<any, any, any>;

/**
 * Soft-delete the `yjs_documents` row that backs the named Yjs doc.
 *
 * No-op if the row is already soft-deleted or does not exist (idempotent).
 *
 * @param docName - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @returns `true` if a row was newly soft-deleted, `false` otherwise
 */
export async function softDeleteByName(docName: string): Promise<boolean> {
  const rows = await db
    .update(yjsDocuments)
    .set({ deletedAt: sql`now()` })
    .where(
      and(eq(yjsDocuments.name, docName), isNull(yjsDocuments.deletedAt)),
    )
    .returning({ name: yjsDocuments.name });
  return rows.length > 0;
}

/**
 * Insert a fresh `yjs_documents` row with a precomputed initial Yjs
 * update payload.
 *
 * Used by `project.service.create` to seed the project's meta doc
 * (`project-{pid}/meta`) with a default Space inside the same
 * transaction that creates the project + owner row. The atomic
 * write guarantees: project exists ⇒ meta doc with at least one
 * Space exists.
 *
 * The caller is responsible for the doc name format and the binary
 * layout — this repo only persists what it's given. `core/db/yjs-bootstrap.ts`
 * is the only call site that produces these bytes today.
 *
 * Idempotency: the table's primary key is `name`, so a repeat insert
 * with the same docName will throw a unique-violation. Since project
 * creation is the only caller and `project.id` is freshly generated,
 * collisions don't happen in practice. The function does NOT swallow
 * the error — the caller's transaction must roll back.
 *
 * @param tx - Drizzle transaction handle from a surrounding
 *   `db.transaction(async tx => ...)` block
 * @param docName - Full Hocuspocus doc name (use the helpers in
 *   `@breatic/shared/yjs-doc-names`, never assemble by string concat)
 * @param data - Encoded initial Yjs update; see
 *   `core/db/yjs-bootstrap.ts:encodeInitialMetaState`
 */
export async function insertInitialState(
  tx: Tx,
  docName: string,
  data: Uint8Array,
): Promise<void> {
  // Drizzle's bytea binding accepts Buffer or Uint8Array directly via
  // postgres-js — pass the typed array through unchanged. The `data`
  // column is NOT NULL so a zero-length Uint8Array is rejected by
  // Postgres's bytea encoder anyway; bootstrap callers always produce
  // non-empty updates (Y.encodeStateAsUpdate of a non-empty doc).
  await tx.insert(yjsDocuments).values({
    name: docName,
    data: Buffer.from(data),
  });
}
