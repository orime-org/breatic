/**
 * `yjs_documents` repository — narrow helpers for the API server.
 *
 * Hocuspocus owns the table for read/write at the Yjs binary layer.
 * The API server only needs to soft-delete rows when a Space (or
 * later: a project) is removed — exposed here so route handlers
 * don't reach into Drizzle internals across the package boundary
 * (which trips on drizzle-orm version-mismatch type errors).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { yjsDocuments } from "../db/schema.js";

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
