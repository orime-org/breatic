// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one read of `yjs_documents` a service other than collab makes: a live
 * row's stored bytes. Collab's `yjs-documents.repo.ts` holds every other query
 * and answers its own `fetchDocData` through this one, so the read is written
 * once. The worker reads a Project's meta document here to tell whether a
 * Timeline Space still exists (inner#1711).
 */

import { and, eq, isNull } from "drizzle-orm";
import { yjsDb } from "@core/db/client.js";
import { yjsDocuments } from "@core/db/yjs-schema.js";

/**
 * Fetch the latest binary state of a live (non-soft-deleted) Yjs doc.
 *
 * The `deleted_at IS NULL` filter is load-bearing: a stale client
 * reconnecting after its project was soft-deleted must NOT recover the
 * old content, so a soft-deleted row reads as absent.
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`).
 * @returns The stored Yjs update bytes, or `null` when no live row exists.
 * @throws {Error} When the Yjs database read fails.
 */
export async function fetchLiveDocData(name: string): Promise<Uint8Array | null> {
  const rows = await yjsDb
    .select({ data: yjsDocuments.data })
    .from(yjsDocuments)
    .where(and(eq(yjsDocuments.name, name), isNull(yjsDocuments.deletedAt)))
    .limit(1);
  return rows[0]?.data ?? null;
}
