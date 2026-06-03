// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Drizzle schema for the SEPARATE Yjs document store database.
 *
 * `yjs_documents` lives in its own Postgres database (`YJS_DATABASE_URL`,
 * see `@core/db/client.ts` `yjsDb`), apart from the business schema in
 * `schema.ts`. The two databases cannot share a transaction, so this
 * table is deliberately isolated in its own schema file + its own
 * migration set (`migrations-yjs/` + `drizzle-yjs.config.ts`) with an
 * independent Drizzle ledger — bundling it into the business migrations
 * would corrupt the `__drizzle_migrations` journal once the URLs differ.
 *
 * The query repository that touches this table lives in `@breatic/collab`
 * (collab is the sole runtime owner of the Yjs store); collab imports
 * this table definition + the `yjsDb` connection from core. The driver,
 * pool, schema, and migrations stay in core.
 */

import { pgTable, text, timestamp, customType } from "drizzle-orm/pg-core";

/** Postgres `bytea` column typed as a Node `Buffer` (the Yjs CRDT state). */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Yjs document store: one row per Hocuspocus document, keyed by its
 * document name (`project-{id}/meta`, `project-{id}/canvas-{spaceId}`).
 * `data` is the serialized Yjs CRDT binary state. Soft-deleted via
 * `deleted_at` when the owning project is removed (collab filters it
 * out on fetch so a stale client cannot reload a deleted doc).
 */
export const yjsDocuments = pgTable("yjs_documents", {
  name: text("name").primaryKey(),
  data: bytea("data").notNull(),
  // `createdAt` aligns with the project-wide rule: every PG table has
  // a createdAt timestamp (see CLAUDE.md "key conventions").
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  // Intentionally NULLABLE (unlike the business-table convention): set
  // only by the persistence layer's upsert-on-store, not on initial seed.
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Soft-delete support — aligns with the project-wide "soft delete only"
  // rule. Set by the collab delete-cascade consumer when the owning
  // project is deleted.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});
