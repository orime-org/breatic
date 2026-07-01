// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * `yjs_documents` repository — the single home for every SQL query
 * against the Yjs binary-document table.
 *
 * The Yjs document store lives in its OWN Postgres database
 * (`YJS_DATABASE_URL`); this repo runs all of its queries against
 * core's `yjsDb` connection. After the two-DB cutover collab is the
 * sole runtime owner of the store (the server's project create / delete
 * / duplicate no longer touch yjs_documents directly — they go through
 * the transactional outbox + lifecycle stream consumer below), so the
 * repo lives here in `@breatic/collab`, not in core. The driver, pool,
 * table schema, and migrations stay in core (`yjsDb`, `yjsDocuments`);
 * collab only owns the queries. `lint:no-postgres-outside-core` stays
 * satisfied — this module imports core's Drizzle connection, never the
 * bare `postgres` driver.
 *
 * Because the two databases cannot share a transaction, the project
 * lifecycle operations are no longer atomic with the business write:
 * delete + duplicate arrive asynchronously via the outbox stream and
 * run here idempotently; create is handled by lazy-seed on first load.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { yjsDb, yjsDocuments } from "@breatic/core";
import { projectMetaDocName } from "@breatic/shared";

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
  const rows = await yjsDb
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
  await yjsDb
    .insert(yjsDocuments)
    .values({ name, data: buf })
    .onConflictDoUpdate({
      target: yjsDocuments.name,
      set: { data: buf, updatedAt: sql`now()`, deletedAt: null },
    });
}

/**
 * Idempotently seed a fresh doc with a precomputed initial Yjs update.
 *
 * Used by collab's lazy-seed on the first load of a project's meta doc
 * (`project-{pid}/meta`) — the create path no longer eager-seeds in the
 * business transaction (the yjs store is a separate DB). `ON CONFLICT
 * (name) DO NOTHING` makes concurrent first-loads converge to one row:
 * the loser of the race no-ops instead of raising a unique violation.
 * @param name - Full doc name (build via `@breatic/shared/yjs-doc-names`)
 * @param data - Encoded initial Yjs update (see core `encodeInitialMetaState`)
 * @returns `true` if this call inserted the row, `false` if it already existed
 */
export async function seedInitialState(
  name: string,
  data: Uint8Array,
): Promise<boolean> {
  const rows = await yjsDb
    .insert(yjsDocuments)
    .values({ name, data: Buffer.from(data) })
    .onConflictDoNothing({ target: yjsDocuments.name })
    .returning({ name: yjsDocuments.name });
  return rows.length > 0;
}

/**
 * Soft-delete the row backing a named Yjs doc.
 *
 * Idempotent: no-op when the row is already soft-deleted or absent.
 * Used by collab's space-rpc delete handler.
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @returns `true` if a row was newly soft-deleted, `false` otherwise
 */
export async function softDeleteByName(name: string): Promise<boolean> {
  const rows = await yjsDb
    .update(yjsDocuments)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(yjsDocuments.name, name), isNull(yjsDocuments.deletedAt)))
    .returning({ name: yjsDocuments.name });
  return rows.length > 0;
}

/**
 * Count the live (non-soft-deleted) CONTENT docs of a project — i.e. its
 * live Space count.
 *
 * Each Space has exactly one content doc (`project-{id}/{type}-{spaceId}`),
 * seeded on create and soft-deleted on delete, so counting content-doc
 * rows is the authoritative, strongly consistent Space count shared by
 * every collab instance — unlike the eventually-consistent in-memory
 * `meta.spaces` CRDT, which lags behind cross-instance deletes by the
 * pub/sub propagation window. The project's meta doc (`project-{id}/meta`)
 * is excluded — it is not a Space. The `project-{id}/` prefix is
 * unambiguous (project ids are fixed-length UUIDs anchored by the `/`),
 * matching {@link softDeleteByProjectPrefix}.
 *
 * LIKE-injection safety relies on an IMPLICIT upstream guarantee: a
 * caller only reaches here after `onAuthenticate` resolved the project
 * role, which queries the `uuid`-typed `project_members.project_id`
 * column — a `projectId` carrying LIKE wildcards (`%` / `_`) fails PG's
 * uuid parse and the connection is refused before any RPC dispatches. If
 * a non-authenticated call site is ever added, assert UUID shape here.
 *
 * Used by the `space:delete` guard (under the cross-instance lock in
 * `space-delete-lock.ts`) to enforce "a project always keeps >=1 Space"
 * against PG rather than a possibly-stale in-memory doc.
 * @param projectId - Project whose live Spaces are counted.
 * @returns The number of live content docs (Spaces) for the project.
 */
export async function countLiveSpaceDocs(projectId: string): Promise<number> {
  const rows = await yjsDb
    .select({ count: sql<number>`count(*)::int` })
    .from(yjsDocuments)
    .where(
      and(
        sql`${yjsDocuments.name} LIKE ${`project-${projectId}/%`}`,
        sql`${yjsDocuments.name} <> ${projectMetaDocName(projectId)}`,
        isNull(yjsDocuments.deletedAt),
      ),
    );
  return rows[0]?.count ?? 0;
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
  await yjsDb
    .update(yjsDocuments)
    .set({ deletedAt: null })
    .where(eq(yjsDocuments.name, name));
}

/**
 * Soft-delete every live row whose name belongs to a project.
 *
 * `yjs_documents` has no FK to `projects` — only a string `name` shaped
 * `project-{id}/...` (the v10 multi-doc layout: meta + per-space docs).
 * Driven by the lifecycle stream consumer on a `project:deleted` command
 * (the business-DB project soft-delete already committed separately).
 * The `deleted_at IS NULL` guard makes redelivery a safe no-op.
 * @param projectId - Project whose `project-{id}/...` docs are removed
 */
export async function softDeleteByProjectPrefix(
  projectId: string,
): Promise<void> {
  await yjsDb
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
 * the `project-{sourceId}/` name prefix to `project-{newId}/`. The whole
 * copy runs in one yjs-DB transaction, meta doc LAST so a Space never
 * becomes visible before its canvas doc exists.
 *
 * Driven by the lifecycle stream consumer on a `project:duplicated`
 * command. Conflict handling is asymmetric so the result is correct even
 * if a client raced in and lazy-seeded the new project's meta first:
 *   - canvas (non-meta) docs use `DO NOTHING`. lazy-seed now DOES create
 *     the first Space's content-doc row, but under the deterministic
 *     `deriveId(newId)` spaceId — never a SOURCE spaceId the copy carries
 *     over — so a conflict here is still only a redelivery; skipping it is
 *     the idempotent no-op. (A racing lazy-seed leaves a harmless orphaned
 *     content doc the meta `DO UPDATE` below never references.)
 *   - the meta doc uses `DO UPDATE` — it MUST win over a lazy-seeded
 *     default meta so the duplicate reflects the SOURCE's Spaces, not a
 *     fresh default one. The consumer kicks the new project's live
 *     connections afterwards so an already-connected client reloads the
 *     corrected meta.
 *
 * Residual (acceptable, temporary-feature scope): a consumer crash
 * between copy and outbox mark-sent, followed by user edits to the new
 * project's meta, then redelivery, would revert those edits via the meta
 * `DO UPDATE`. The window is sub-second and pre-edit in practice; the
 * full duplicate UX is reworked when the Studio page is built properly.
 * @param sourceId - Project being duplicated
 * @param newId - Freshly created destination project id
 */
export async function duplicateByProjectPrefix(
  sourceId: string,
  newId: string,
): Promise<void> {
  const oldPrefix = `project-${sourceId}/`;
  const newPrefix = `project-${newId}/`;
  const metaName = `${oldPrefix}meta`;
  // `${...}::int` is load-bearing: Drizzle/postgres-js binds the
  // interpolated JS number as a TEXT param, and Postgres dispatches
  // `substring(text FROM text)` to the REGEX overload — which returns
  // NULL for any row whose name doesn't match the position as a pattern,
  // violating the NOT NULL `name` column. The `::int` cast forces the
  // `substring(text FROM int)` position overload (strip the old prefix).
  const cut = sql`${oldPrefix.length + 1}::int`;
  await yjsDb.transaction(async (tx) => {
    // Canvas (and any non-meta) docs first — idempotent on redelivery.
    await tx.execute(sql`
      INSERT INTO yjs_documents (name, data, updated_at)
      SELECT ${newPrefix} || substring(name from ${cut}), data, NOW()
      FROM yjs_documents
      WHERE name LIKE ${oldPrefix + "%"} AND name <> ${metaName}
      ON CONFLICT (name) DO NOTHING
    `);
    // Meta doc last, and it WINS over a racing lazy-seed default so the
    // copy reflects the source's Spaces.
    await tx.execute(sql`
      INSERT INTO yjs_documents (name, data, updated_at)
      SELECT ${newPrefix} || substring(name from ${cut}), data, NOW()
      FROM yjs_documents
      WHERE name = ${metaName}
      ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), deleted_at = NULL
    `);
  });
}
