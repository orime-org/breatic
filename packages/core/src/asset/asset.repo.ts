// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asset repository — the studio ledger and permanent Project asset references.
 *
 * A studio_asset is one physical stored object owned by a studio. The
 * `content_hash` is a dedup column only (never part of the URL). Within
 * one studio the same content dedups to a single row (spec
 * 2026-07-04-asset-layer-v1); across studios each owns its own copy.
 * Attribution (which studio a row belongs to) is decided by the caller
 * (asset.service.resolveOwnerStudioId); this repo is attribution-agnostic.
 */

import { and, desc, eq, gt, isNotNull, isNull, inArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type DbTx } from "@core/db/client.js";
import { projectAssetRefs, studioAssets } from "@core/db/schema.js";
import type { ProjectAssetReferenceEntity, ProjectRegisteredAsset, StudioAssetEntity } from "@breatic/shared";

/**
 * Map a Drizzle row to a StudioAssetEntity.
 * @param row - Raw row selected from `studio_assets`.
 * @returns The mapped `StudioAssetEntity`.
 * @throws {never} Never.
 */
function toEntity(row: typeof studioAssets.$inferSelect): StudioAssetEntity {
  return {
    id: row.id,
    studioId: row.studioId,
    contentHash: row.contentHash,
    storageKey: row.storageKey,
    fileUrl: row.fileUrl,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    kind: row.kind as StudioAssetEntity["kind"],
    source: row.source as StudioAssetEntity["source"],
    producedByUserId: row.producedByUserId,
    generationTaskId: row.generationTaskId,
    width: row.width,
    height: row.height,
    durationSeconds: row.durationSeconds,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

/** Fields required to register a physical asset row. */
export interface RegisterAssetInput {
  studioId: string;
  /** Who first brought this content in — see StudioAssetEntity. */
  producedByUserId: string;
  contentHash: string;
  storageKey: string;
  fileUrl: string;
  sizeBytes: number;
  mimeType: string;
  kind: StudioAssetEntity["kind"];
  source: StudioAssetEntity["source"];
  generationTaskId?: string;
  /** What the media container read; null for anything it had no number for. */
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  /**
   * The cover this row points at, set on the insert so a video is never
   * readable without the frame that was cut for it (#187).
   */
  coverAssetId?: string | null;
}

/**
 * Scan live registered assets carrying a generation-task provenance identity.
 * @param cursor - The last emitted asset identity, or the first page.
 * @param limit - The configured bounded batch size.
 * @returns Canonical ledger rows in immutable-id order.
 * @throws {Error} When the database read fails.
 */
export async function scanGenerationMediaAssets(cursor: string | null, limit: number): Promise<StudioAssetEntity[]> {
  const rows = await db.select().from(studioAssets).where(and(
    isNotNull(studioAssets.generationTaskId), isNull(studioAssets.deletedAt), cursor === null ? undefined : gt(studioAssets.id, cursor),
  )).orderBy(studioAssets.id).limit(limit);
  return rows.map(toEntity);
}

/**
 * The live asset owned by a studio with a given content hash, or null.
 * @param studioId - Owner studio.
 * @param contentHash - sha256 hex of the content.
 * @returns The `StudioAssetEntity`, or null when none exists.
 * @throws {Error} When the database query fails.
 */
export async function findByStudioAndHash(
  studioId: string,
  contentHash: string,
): Promise<StudioAssetEntity | null> {
  const rows = await db
    .select()
    .from(studioAssets)
    .where(
      and(
        eq(studioAssets.studioId, studioId),
        eq(studioAssets.contentHash, contentHash),
        isNull(studioAssets.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * A live asset row by id, only when it belongs to `studioId`.
 * @param studioId - The studio the row must belong to.
 * @param assetId - The row's id.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns The `StudioAssetEntity`, or null when there is no live row with
 *   that id in that studio.
 * @throws {Error} When the database query fails.
 */
export async function findLiveInStudio(
  studioId: string,
  assetId: string,
  tx?: DbTx,
): Promise<StudioAssetEntity | null> {
  const rows = await (tx ?? db)
    .select()
    .from(studioAssets)
    .where(
      and(
        eq(studioAssets.id, assetId),
        eq(studioAssets.studioId, studioId),
        isNull(studioAssets.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * A live asset row by its storage key, only when it belongs to `studioId`.
 *
 * What an address in our storage names: a key, and the ledger row registered
 * under it. An agent's proposal hands material over by address (inner#1315),
 * so this is how the check learns whether the address is this studio's and
 * what it holds.
 * @param studioId - The studio the row must belong to.
 * @param storageKey - The object's storage key.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns The `StudioAssetEntity`, or null when no live row of that studio
 *   has the key.
 * @throws {Error} When the database query fails.
 */
export async function findLiveByKeyInStudio(
  studioId: string,
  storageKey: string,
  tx?: DbTx,
): Promise<StudioAssetEntity | null> {
  const rows = await (tx ?? db)
    .select()
    .from(studioAssets)
    .where(
      and(
        eq(studioAssets.storageKey, storageKey),
        eq(studioAssets.studioId, studioId),
        isNull(studioAssets.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * An asset row by id, deleted or not.
 * @param assetId - The row's id.
 * @returns The `StudioAssetEntity`, or null when no row has that id.
 * @throws {Error} When the database query fails.
 */
export async function findById(assetId: string): Promise<StudioAssetEntity | null> {
  const rows = await db
    .select()
    .from(studioAssets)
    .where(eq(studioAssets.id, assetId))
    .limit(1);
  return rows[0] ? toEntity(rows[0]) : null;
}

/**
 * Write the media numbers read after a row was registered (#299).
 *
 * Only a live row with none of the three is written: one that has any of them
 * was measured at finish, or by an earlier delivery of this same job, and that
 * reading stands.
 * @param assetId - The row's id.
 * @param numbers - What the media container read.
 * @param numbers.width - Pixel width, or null.
 * @param numbers.height - Pixel height, or null.
 * @param numbers.durationSeconds - Running time, or null.
 * @returns True when the row was written.
 * @throws {Error} When the database query fails.
 */
export async function fillMediaNumbers(
  assetId: string,
  numbers: {
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
  },
): Promise<boolean> {
  const written = await db
    .update(studioAssets)
    .set(numbers)
    .where(
      and(
        eq(studioAssets.id, assetId),
        isNull(studioAssets.width),
        isNull(studioAssets.height),
        isNull(studioAssets.durationSeconds),
        isNull(studioAssets.deletedAt),
      ),
    )
    .returning({ id: studioAssets.id });
  return written.length === 1;
}

/**
 * A live asset row stored under a key, from any studio. Storage keys are
 * tenant-neutral, so every row under one key describes the same bytes.
 * @param storageKey - The object's storage key.
 * @returns One such row, or null when no live asset is stored under it.
 * @throws {Error} When the database query fails.
 */
export async function findLiveByStorageKey(storageKey: string): Promise<StudioAssetEntity | null> {
  const [row] = await db
    .select()
    .from(studioAssets)
    .where(and(eq(studioAssets.storageKey, storageKey), isNull(studioAssets.deletedAt)))
    .limit(1);
  return row ? toEntity(row) : null;
}

/**
 * The content hash of the bytes stored under a key, from any studio's live
 * asset row.
 * @param storageKey - The object's storage key.
 * @returns The sha256 hex, or null when no live asset is stored under it.
 * @throws {Error} When the database query fails.
 */
export async function findHashByStorageKey(storageKey: string): Promise<string | null> {
  return (await findLiveByStorageKey(storageKey))?.contentHash ?? null;
}

/**
 * The kind of the bytes stored under a key, from any studio's live asset row.
 * The kind is read off the stored bytes, so every row under one key holds the
 * same one.
 * @param storageKey - The object's storage key.
 * @returns The kind, or null when no live asset is stored under it.
 * @throws {Error} When the database query fails.
 */
export async function findKindByStorageKey(storageKey: string): Promise<string | null> {
  const [row] = await db
    .select({ kind: studioAssets.kind })
    .from(studioAssets)
    .where(and(eq(studioAssets.storageKey, storageKey), isNull(studioAssets.deletedAt)))
    .limit(1);
  return row?.kind ?? null;
}

/**
 * Register a physical asset with WITHIN-STUDIO dedup. If the studio
 * already has a live asset with this content hash, nothing new is stored
 * and the existing row is returned (`deduped: true`); otherwise the new
 * row is inserted (`deduped: false`). Concurrency-safe: the insert uses
 * `ON CONFLICT DO NOTHING` on the `(studio_id, content_hash)` partial
 * unique (WHERE deleted_at IS NULL), so two racing callers converge on
 * one row.
 * @param input - The asset fields (studioId is the resolved owner).
 * @returns The asset entity plus whether it was a dedup hit.
 * @throws {Error} If the insert conflicts but no existing row is found
 *   (should be impossible - indicates index/predicate drift).
 */
export async function registerWithDedup(
  input: RegisterAssetInput,
): Promise<{ asset: StudioAssetEntity; deduped: boolean }> {
  const inserted = await db
    .insert(studioAssets)
    .values({
      studioId: input.studioId,
      // Only lands on an INSERT. A dedup hit takes the onConflictDoNothing
      // path and returns the EXISTING row, so the first producer is kept —
      // see StudioAssetEntity.producedByUserId.
      producedByUserId: input.producedByUserId,
      contentHash: input.contentHash,
      storageKey: input.storageKey,
      fileUrl: input.fileUrl,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      kind: input.kind,
      source: input.source,
      generationTaskId: input.generationTaskId ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      durationSeconds: input.durationSeconds ?? null,
      coverAssetId: input.coverAssetId ?? null,
    })
    .onConflictDoNothing({
      target: [studioAssets.studioId, studioAssets.contentHash],
      where: sql`deleted_at IS NULL`,
    })
    .returning();
  if (inserted[0]) return { asset: toEntity(inserted[0]), deduped: false };
  const existing = await findByStudioAndHash(input.studioId, input.contentHash);
  if (!existing) {
    throw new Error(
      "studio_assets dedup conflict but no existing row (index/predicate drift)",
    );
  }
  return { asset: existing, deduped: true };
}

/**
 * Point a video row at the cover extracted for it (#173).
 *
 * Written after the cover is registered rather than alongside the video,
 * because the cover row does not exist when the video's row is written: both
 * come out of the same report, and the cover has to be filed before anything
 * can point at it. A column left null reads as "no cover" — the same state an
 * extraction failure leaves, and the same Film icon.
 *
 * Idempotent: a replayed report reaches a cover key derived from the video's
 * own key, so the edge answers the object it already holds and the dedup
 * resolves to the same cover row, which writes the same id again.
 * @param videoAssetId - The video row to annotate.
 * @param coverAssetId - The registered cover's row id.
 * @throws {Error} When the database query fails.
 */
export async function setCoverAsset(
  videoAssetId: string,
  coverAssetId: string,
): Promise<void> {
  await db
    .update(studioAssets)
    .set({ coverAssetId })
    .where(
      and(eq(studioAssets.id, videoAssetId), isNull(studioAssets.deletedAt)),
    );
}

/**
 * The live cover a video points at, or null when it has none (#173).
 *
 * The dedup paths read a cover through this: they resolve to an existing video
 * row and hold nothing else that names its cover. A cover that has been
 * soft-deleted reads as absent rather than as a row nobody may serve.
 * @param videoAssetId - The video row to read the cover of.
 * @returns The cover's `StudioAssetEntity`, or null when there is none.
 * @throws {Error} When the database query fails.
 */
export async function findCoverOf(
  videoAssetId: string,
): Promise<StudioAssetEntity | null> {
  const cover = alias(studioAssets, "cover");
  const rows = await db
    .select({ cover })
    .from(studioAssets)
    .innerJoin(cover, eq(cover.id, studioAssets.coverAssetId))
    .where(and(eq(studioAssets.id, videoAssetId), isNull(cover.deletedAt)))
    .limit(1);
  return rows[0] ? toEntity(rows[0].cover) : null;
}

/**
 * Total live storage a studio uses, in bytes (sum of its assets' sizes).
 * @param studioId - Studio to sum.
 * @returns The byte total (0 when the studio owns no live assets).
 * @throws {Error} When the database query fails.
 */
export async function usageByStudio(studioId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${studioAssets.sizeBytes}), 0)`,
    })
    .from(studioAssets)
    .where(
      and(eq(studioAssets.studioId, studioId), isNull(studioAssets.deletedAt)),
    );
  return Number(rows[0]?.total ?? 0);
}

/**
 * Total live storage a SET of studios uses, in bytes (raw SUM, no
 * cross-studio dedup). Backs the account-level roll-up (#1826 §5.3):
 * an account's usage is the sum over its personal ∪ administered team
 * studios. Since dedup is per-studio, identical content in two of the
 * given studios is two physical rows and is counted twice — this is the
 * intended raw-sum semantics.
 * @param studioIds - Studios to sum (empty → 0, no query issued).
 * @returns The byte total across all given studios' live assets.
 * @throws {Error} When the database query fails.
 */
export async function usageByStudios(studioIds: string[]): Promise<number> {
  if (studioIds.length === 0) return 0;
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${studioAssets.sizeBytes}), 0)`,
    })
    .from(studioAssets)
    .where(
      and(inArray(studioAssets.studioId, studioIds), isNull(studioAssets.deletedAt)),
    );
  return Number(rows[0]?.total ?? 0);
}

/** A keyset boundary retaining PostgreSQL timestamp precision. */
export interface ProjectAssetCursor { createdAt: string; id: string }

/** A scoped read from the one canonical registered-media projection. */
export interface ProjectMediaQuery {
  projectId: string;
  studioId: string;
  assetId?: string;
  cursor?: ProjectAssetCursor;
  limit: number;
}

/** A canonical API projection alongside its full-precision page boundary. */
export interface ProjectMediaRow { media: ProjectRegisteredAsset; cursorAt: string }

/**
 * Read a batch of live registered identities in one Studio.
 * @param studioId - The Project's actual owning Studio.
 * @param assetIds - The unique identities to validate together.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns The canonical live ledger records.
 * @throws {Error} When the database query fails.
 */
export async function findLiveManyInStudio(studioId: string, assetIds: readonly string[], tx?: DbTx): Promise<StudioAssetEntity[]> {
  if (assetIds.length === 0) return [];
  const rows = await (tx ?? db).select().from(studioAssets)
    .where(and(eq(studioAssets.studioId, studioId), inArray(studioAssets.id, [...assetIds]), isNull(studioAssets.deletedAt)));
  return rows.map(toEntity);
}

/**
 * Resolve declared identities in bulk so the service can classify their scope.
 * @param assetIds - Valid UUID identities explicitly stored as media sources.
 * @param storageKeys - Keys resolved by the existing storage URL classifier.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns Live canonical ledger rows, including foreign rows for classification only.
 * @throws {Error} When the database read fails.
 */
export async function findLiveMediaIdentities(assetIds: readonly string[], storageKeys: readonly string[], tx?: DbTx): Promise<StudioAssetEntity[]> {
  if (assetIds.length === 0 && storageKeys.length === 0) return [];
  const rows = await (tx ?? db).select().from(studioAssets).where(and(
    isNull(studioAssets.deletedAt),
    or(
      assetIds.length === 0 ? undefined : inArray(studioAssets.id, [...assetIds]),
      storageKeys.length === 0 ? undefined : inArray(studioAssets.storageKey, [...storageKeys]),
    ),
  ));
  return rows.map(toEntity);
}

/**
 * Map a physical association row without exporting Drizzle-inferred types.
 * @param row - The stored association row.
 * @returns The handwritten Project reference entity.
 * @throws {never} Never.
 */
function toReferenceEntity(row: typeof projectAssetRefs.$inferSelect): ProjectAssetReferenceEntity {
  return {
    id: row.id, projectId: row.projectId, assetId: row.assetId, displayName: row.displayName,
    createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt,
  };
}

/**
 * Read copyable live references through the canonical owning ledger.
 * @param projectId - The authorized source Project.
 * @param studioId - Its current live owning Studio.
 * @param tx - The caller's Project-copy transaction.
 * @returns Only live source references to live assets in that Studio.
 * @throws {Error} When the database read fails.
 */
export async function readLiveProjectReferences(projectId: string, studioId: string, tx: DbTx): Promise<ProjectAssetReferenceEntity[]> {
  const rows = await tx.select({ reference: projectAssetRefs }).from(projectAssetRefs)
    .innerJoin(studioAssets, eq(studioAssets.id, projectAssetRefs.assetId))
    .where(and(
      eq(projectAssetRefs.projectId, projectId), isNull(projectAssetRefs.deletedAt),
      eq(studioAssets.studioId, studioId), isNull(studioAssets.deletedAt),
    )).orderBy(projectAssetRefs.assetId);
  return rows.map((row) => toReferenceEntity(row.reference));
}

/**
 * Ensure a previously validated batch in the caller's business transaction.
 * @param projectId - The Project accepting use of the assets.
 * @param assetIds - Canonical, unique asset ids in stable order.
 * @param displayNames - Verified original names, when known.
 * @param tx - The transaction containing validation and association writes.
 * @returns The live durable relationships in asset-id order.
 * @throws {Error} When the database insert or read fails.
 */
export async function ensureProjectReferences(
  projectId: string,
  assetIds: readonly string[],
  displayNames: Readonly<Record<string, string>>,
  tx: DbTx,
): Promise<ProjectAssetReferenceEntity[]> {
  return (await ensureProjectReferencesDetailed(projectId, assetIds, displayNames, tx)).references;
}

/** Canonical relationships and the identities inserted by this SQL statement. */
export interface ProjectReferenceAcceptance {
  references: ProjectAssetReferenceEntity[];
  insertedAssetIds: string[];
}

/**
 * Ensure a validated batch and distinguish actual inserts from existing rows.
 * @param projectId - The Project accepting the assets.
 * @param assetIds - Canonical, unique asset identities in stable order.
 * @param displayNames - Verified original names, when known.
 * @param tx - The transaction containing validation and association writes.
 * @returns Live relationships and identities returned by PostgreSQL's insert.
 * @throws {Error} When the database insert or read fails.
 */
export async function ensureProjectReferencesDetailed(
  projectId: string,
  assetIds: readonly string[],
  displayNames: Readonly<Record<string, string>>,
  tx: DbTx,
): Promise<ProjectReferenceAcceptance> {
  if (assetIds.length === 0) return { references: [], insertedAssetIds: [] };
  const inserted = await tx.insert(projectAssetRefs).values(assetIds.map((assetId) => ({
    projectId, assetId, displayName: displayNames[assetId] || null,
  }))).onConflictDoNothing({
    target: [projectAssetRefs.projectId, projectAssetRefs.assetId],
    where: sql`deleted_at IS NULL`,
  }).returning({ assetId: projectAssetRefs.assetId });
  // A Space can accept a URL before an upload supplies its first verified name.
  for (const assetId of assetIds) {
    const displayName = displayNames[assetId];
    if (!displayName) continue;
    await tx.update(projectAssetRefs).set({
      displayName, updatedAt: sql`${projectAssetRefs.updatedAt}`,
    }).where(and(
      eq(projectAssetRefs.projectId, projectId), eq(projectAssetRefs.assetId, assetId),
      isNull(projectAssetRefs.deletedAt), isNull(projectAssetRefs.displayName),
    ));
  }
  return {
    references: await findLiveProjectReferences(projectId, assetIds, tx),
    insertedAssetIds: inserted.map((row) => row.assetId).sort(),
  };
}

/**
 * Read existing live relationships for a bounded canonical asset batch.
 * @param projectId - The Project whose relationships are inspected.
 * @param assetIds - The resolved identities belonging to this Project's Studio.
 * @param tx - The transaction providing the inspection snapshot.
 * @returns Only this batch's live relationships in asset-id order.
 * @throws {Error} When the database read fails.
 */
export async function findLiveProjectReferences(projectId: string, assetIds: readonly string[], tx: DbTx): Promise<ProjectAssetReferenceEntity[]> {
  if (assetIds.length === 0) return [];
  const rows = await tx.select().from(projectAssetRefs)
    .where(and(eq(projectAssetRefs.projectId, projectId), inArray(projectAssetRefs.assetId, [...assetIds]), isNull(projectAssetRefs.deletedAt)))
    .orderBy(projectAssetRefs.assetId);
  return rows.map(toReferenceEntity);
}

/**
 * Resolve lists and individual assets with one live Project-media projection.
 * @param input - The owning scope, optional asset identity and page boundary.
 * @param tx - An enclosing business transaction, when supplied.
 * @returns Canonical media with PostgreSQL-precision cursor instants.
 * @throws {Error} When the database query fails.
 */
export async function readProjectMedia(input: ProjectMediaQuery, tx?: DbTx): Promise<ProjectMediaRow[]> {
  const cover = alias(studioAssets, "project_asset_cover");
  const conditions = [
    eq(projectAssetRefs.projectId, input.projectId),
    eq(studioAssets.studioId, input.studioId),
    isNull(projectAssetRefs.deletedAt),
    isNull(studioAssets.deletedAt),
  ];
  if (input.assetId !== undefined) conditions.push(eq(studioAssets.id, input.assetId));
  else conditions.push(eq(studioAssets.kind, "video"));
  if (input.cursor !== undefined) {
    conditions.push(sql`(${projectAssetRefs.createdAt}, ${projectAssetRefs.id}) < (${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`);
  }
  const rows = await (tx ?? db).select({
    reference: projectAssetRefs,
    asset: studioAssets,
    coverUrl: cover.fileUrl,
    cursorAt: sql<string>`${projectAssetRefs.createdAt}::text`,
  }).from(projectAssetRefs)
    .innerJoin(studioAssets, eq(studioAssets.id, projectAssetRefs.assetId))
    .leftJoin(cover, and(eq(cover.id, studioAssets.coverAssetId), eq(cover.studioId, studioAssets.studioId), isNull(cover.deletedAt)))
    .where(and(...conditions))
    .orderBy(desc(projectAssetRefs.createdAt), desc(projectAssetRefs.id))
    .limit(input.limit);
  return rows.map(({ reference, asset, coverUrl, cursorAt }) => ({
    media: {
      assetId: asset.id, projectReferenceId: reference.id, displayName: reference.displayName,
      kind: asset.kind as StudioAssetEntity["kind"], fileUrl: asset.fileUrl, coverUrl,
      width: asset.width, height: asset.height, durationSeconds: asset.durationSeconds,
      mimeType: asset.mimeType, sizeBytes: asset.sizeBytes,
    },
    cursorAt,
  }));
}

/**
 * Compose the reclaim queue's atomic live-ledger exclusion from its owner.
 * @param storageKey - The key proposed for offline reclaim.
 * @returns The SQL existence predicate to include in the reclaim insert.
 * @throws {never} Never.
 */
export function liveAssetExistsForStorageKey(storageKey: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${studioAssets} WHERE ${studioAssets.storageKey} = ${storageKey} AND ${studioAssets.deletedAt} IS NULL)`;
}
