/**
 * PostgreSQL persistence for Hocuspocus documents.
 *
 * Uses the `@hocuspocus/extension-database` extension with
 * raw postgres.js queries for storing/loading Yjs documents.
 */

import { Database } from "@hocuspocus/extension-database";
import { createPgClient } from "@breatic/core";
import {
  fetchDocumentData,
  storeDocument,
} from "@collab/services/yjs-documents.repo.js";

/**
 * Create a Database extension for Hocuspocus using PostgreSQL.
 *
 * Documents are stored as binary blobs in the `yjs_documents` table.
 * @param databaseUrl - PostgreSQL connection string
 * @returns Configured Database extension
 */
export function createPersistenceExtension(databaseUrl: string): Database {
  const sql = createPgClient(databaseUrl, {
    name: "collab-persistence",
    max: 5,
  });

  return new Database({
    fetch: async ({ documentName }) => {
      // Filter soft-deleted docs so a stale client reconnecting after
      // its project was deleted can't recover the old content.
      return fetchDocumentData(sql, documentName);
    },

    store: async ({ documentName, state }) => {
      // The repo upsert clears deleted_at so a store after soft-delete
      // would resurrect the doc. In practice this can't happen because
      // soft-delete cascades from project deletion, and a deleted project
      // refuses WebSocket auth before Hocuspocus ever calls store. The
      // explicit clear is defense-in-depth.
      await storeDocument(sql, documentName, state);
    },
  });
}

// Table creation is handled by Drizzle migration (0000_dear_hardball.sql).
// No ensureTable() needed — migrate service runs before all app services.
