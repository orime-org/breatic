// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * PostgreSQL persistence for Hocuspocus documents.
 *
 * Wires `@hocuspocus/extension-database` to the shared core
 * `yjsDocumentsRepo` (Drizzle, over the process-wide `db` singleton) so
 * the Yjs binary store goes through the single `yjs_documents` repo home
 * like every other access to that table — no collab-private postgres.js
 * pool. The collab process's pool is the core `db` singleton, built
 * lazily after `initCore` (one per-process pool, same as server /
 * worker).
 */

import { Database } from "@hocuspocus/extension-database";
import { yjsDocumentsRepo } from "@breatic/core";

/**
 * Load a document's latest binary state (Hocuspocus `fetch`).
 *
 * Soft-deleted rows read as absent (the repo filters `deleted_at`), so
 * a stale client reconnecting after its project was deleted cannot
 * recover the old content.
 * @param args - Hocuspocus fetch payload.
 * @param args.documentName - Full Yjs doc name (the `yjs_documents.name` key).
 * @returns The stored Yjs update bytes, or null when no live row exists.
 */
export async function fetchDoc({
  documentName,
}: {
  documentName: string;
}): Promise<Uint8Array | null> {
  return yjsDocumentsRepo.fetchDocData(documentName);
}

/**
 * Persist a document's binary state (Hocuspocus `store`).
 *
 * The upsert clears `deleted_at`, so a store after a soft-delete would
 * resurrect the doc; in practice a soft-deleted project refuses
 * WebSocket auth before `store` is ever called (defense in depth).
 * @param args - Hocuspocus store payload.
 * @param args.documentName - Full Yjs doc name (the `yjs_documents.name` key).
 * @param args.state - Encoded Yjs update bytes to persist.
 */
export async function storeDoc({
  documentName,
  state,
}: {
  documentName: string;
  state: Uint8Array;
}): Promise<void> {
  await yjsDocumentsRepo.upsertDocData(documentName, state);
}

/**
 * Create a Database extension for Hocuspocus backed by `yjs_documents`.
 *
 * Documents are stored as binary blobs; all SQL lives in the core
 * `yjsDocumentsRepo`. Table creation is handled by the Drizzle
 * migration (0000_dear_hardball.sql) — the migrate service runs before
 * any app service, so no `ensureTable()` is needed here.
 * @returns Configured Database extension delegating to the core repo.
 */
export function createPersistenceExtension(): Database {
  return new Database({ fetch: fetchDoc, store: storeDoc });
}
