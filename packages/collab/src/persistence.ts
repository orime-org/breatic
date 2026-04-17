/**
 * PostgreSQL persistence for Hocuspocus documents.
 *
 * Uses the `@hocuspocus/extension-database` extension with
 * raw postgres.js queries for storing/loading Yjs documents.
 */

import { Database } from "@hocuspocus/extension-database";
import postgres from "postgres";

/**
 * Create a Database extension for Hocuspocus using PostgreSQL.
 *
 * Documents are stored as binary blobs in the `yjs_documents` table.
 *
 * @param databaseUrl - PostgreSQL connection string
 * @returns Configured Database extension
 */
export function createPersistenceExtension(databaseUrl: string): Database {
  const sql = postgres(databaseUrl, { max: 5 });

  return new Database({
    fetch: async ({ documentName }) => {
      const rows = await sql`
        SELECT data FROM yjs_documents WHERE name = ${documentName} LIMIT 1
      `;
      return rows[0]?.data as Uint8Array | null;
    },

    store: async ({ documentName, state }) => {
      await sql`
        INSERT INTO yjs_documents (name, data, updated_at)
        VALUES (${documentName}, ${state}, NOW())
        ON CONFLICT (name) DO UPDATE
        SET data = EXCLUDED.data, updated_at = NOW()
      `;
    },
  });
}

// Table creation is handled by Drizzle migration (0000_dear_hardball.sql).
// No ensureTable() needed — API runs migrations before Collab serves requests.
