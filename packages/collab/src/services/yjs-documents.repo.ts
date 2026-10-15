// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * collab only owns the queries. `breatic/no-postgres-outside-core` stays
 * satisfied — this module imports core's Drizzle connection, never the
 * bare `postgres` driver.
 *
 * Because the two databases cannot share a transaction, the project
 * lifecycle operations are no longer atomic with the business write:
 * delete + duplicate arrive asynchronously via the outbox stream and
 * run here idempotently; create is handled by lazy-seed on first load.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import * as Y from "yjs";
import { listedContentDocNames, yjsDb, yjsDocuments } from "@breatic/core";
import { projectMetaDocName, spaceContentRowPattern } from "@breatic/shared";

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
 * On conflict only the content and `updated_at` change; `deleted_at` is left
 * as it is. A Space deleted while its document is still loaded gets one more
 * store when the document unloads, and that store must not bring the row
 * back: the Space count the cap and the delete floor read would then exceed
 * the Spaces in meta. The late content lands in the deleted row, so a restore
 * brings back the latest edits.
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
      set: { data: buf, updatedAt: sql`now()` },
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
 * unambiguous (project ids are fixed-length UUIDs anchored by the `/`).
 *
 * LIKE-injection safety relies on an IMPLICIT upstream guarantee: a
 * caller only reaches here after `onAuthenticate` resolved the project
 * role, which queries the `uuid`-typed `project_members.project_id`
 * column — a `projectId` carrying LIKE wildcards (`%` / `_`) fails PG's
 * uuid parse and the connection is refused before any RPC dispatches. If
 * a non-authenticated call site is ever added, assert UUID shape here.
 *
 * Read under the Space count lock (`space-count-lock.ts`) by the delete floor
 * ("a project always keeps >=1 Space") and by the create / restore cap
 * (`MAX_SPACES_PER_PROJECT`), against PG rather than a possibly-stale
 * in-memory doc.
 * @param projectId - Project whose live Spaces are counted.
 * @returns The number of live content docs (Spaces) for the project.
 */
export async function countLiveSpaceDocs(projectId: string): Promise<number> {
  const rows = await yjsDb
    .select({ count: sql<number>`count(*)::int` })
    .from(yjsDocuments)
    .where(
      and(
        sql`${yjsDocuments.name} ~ ${spaceContentRowPattern(projectId)}`,
        isNull(yjsDocuments.deletedAt),
      ),
    );
  return rows[0]?.count ?? 0;
}

/**
 * Restore (clear `deleted_at` on) the row backing a named Yjs doc, and mark it
 * touched now.
 *
 * The mirror image of {@link softDeleteByName}, down to the return value:
 * idempotent, and it reports whether THIS call is the one that brought the
 * row back. A restore that fails partway has to put back only what it
 * actually changed, and it can only know that if each step says so.
 *
 * `updated_at` moves so the repair script, which only touches rows nobody
 * changed for an hour, never soft-deletes a Space restored moments ago whose
 * meta entry has not been stored yet.
 * @param name - Full doc name (e.g. `project-{pid}/canvas-{sid}`)
 * @returns `true` if a row was newly restored, `false` otherwise
 */
export async function restoreByName(name: string): Promise<boolean> {
  const rows = await yjsDb
    .update(yjsDocuments)
    .set({ deletedAt: null, updatedAt: sql`now()` })
    .where(and(eq(yjsDocuments.name, name), isNotNull(yjsDocuments.deletedAt)))
    .returning({ name: yjsDocuments.name });
  return rows.length > 0;
}

/**
 * The content docs a stored meta doc lists.
 * @param projectId - Project the meta doc belongs to.
 * @param metaData - The stored meta doc state.
 * @returns The content doc names, one per listed Space.
 */
function listedInStoredMeta(projectId: string, metaData: Uint8Array): string[] {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, metaData);
    return [...listedContentDocNames(projectId, doc.getMap("spaces"))];
  } finally {
    doc.destroy();
  }
}

/**
 * Copy a source project's meta doc and the content of the Spaces it lists to
 * a new project id, rewriting the `project-{sourceId}/` name prefix to
 * `project-{newId}/`. The whole copy runs in one yjs-DB transaction, meta doc
 * LAST so a Space never becomes visible before its canvas doc exists.
 *
 * The source meta is read once, and that one read is both what is copied as
 * the new meta and what decides the content rows: the rows copied are exactly
 * the ones the copied meta lists, and they arrive live whatever state the
 * source row is in. The stored meta lags the live one by up to one store
 * interval, so a source row's `deleted_at` can disagree with it: a Space
 * deleted moments ago is soft-deleted but still listed, one created moments
 * ago is live but not yet listed. Following the copied meta keeps the
 * duplicate's live content rows equal to its Spaces; rows in the source's
 * trash are not copied.
 *
 * Driven by the lifecycle stream consumer on a `project:duplicated`
 * command. Conflict handling is asymmetric so the result is correct even
 * if a client raced in and lazy-seeded the new project's meta first:
 *   - canvas (non-meta) docs use `DO NOTHING`. lazy-seed now DOES create
 *     the first Space's content-doc row, but under the deterministic
 *     `deriveId(newId)` spaceId — never a SOURCE spaceId the copy carries
 *     over — so a conflict here is still only a redelivery; skipping it is
 *     the idempotent no-op. (A racing lazy-seed leaves an orphaned content
 *     doc the meta `DO UPDATE` below never references; it holds one place
 *     under the Space cap until the repair script clears it, inner#1557.)
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
    const [meta] = await tx
      .select({ data: yjsDocuments.data })
      .from(yjsDocuments)
      .where(eq(yjsDocuments.name, metaName))
      .limit(1);
    if (!meta) return;
    const listed = listedInStoredMeta(sourceId, meta.data);
    // Content docs first — idempotent on redelivery.
    if (listed.length > 0) {
      await tx.execute(sql`
        INSERT INTO yjs_documents (name, data, updated_at)
        SELECT ${newPrefix} || substring(name from ${cut}), data, NOW()
        FROM yjs_documents
        WHERE ${inArray(yjsDocuments.name, listed)}
        ON CONFLICT (name) DO NOTHING
      `);
    }
    // Meta doc last, from the bytes read above, and it WINS over a racing
    // lazy-seed default so the copy reflects the source's Spaces.
    await tx.execute(sql`
      INSERT INTO yjs_documents (name, data, updated_at)
      VALUES (${projectMetaDocName(newId)}, ${meta.data}, NOW())
      ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW(), deleted_at = NULL
    `);
  });
}
