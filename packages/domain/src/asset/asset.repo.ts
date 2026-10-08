// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asset repository — data access for the `studio_assets` table.
 *
 * A studio_asset is one physical stored object owned by a studio. The
 * `content_hash` is a dedup column only (never part of the URL). Within
 * one studio the same content dedups to a single row (spec
 * 2026-07-04-asset-layer-v1); across studios each owns its own copy.
 * Attribution (which studio a row belongs to) is decided by the caller
 * (asset.service.resolveOwnerStudioId); this repo is attribution-agnostic.
 */

import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, studioAssets } from "@breatic/core";
import type { StudioAssetEntity } from "@breatic/shared";

/**
 * Map a Drizzle row to a StudioAssetEntity.
 * @param row - Raw row selected from `studio_assets`.
 * @returns The mapped `StudioAssetEntity`.
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
 * The live asset owned by a studio with a given content hash, or null.
 * @param studioId - Owner studio.
 * @param contentHash - sha256 hex of the content.
 * @returns The `StudioAssetEntity`, or null when none exists.
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
 * @returns The `StudioAssetEntity`, or null when there is no live row with
 *   that id in that studio.
 */
export async function findLiveInStudio(
  studioId: string,
  assetId: string,
): Promise<StudioAssetEntity | null> {
  const rows = await db
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
 * An asset row by id, deleted or not.
 * @param assetId - The row's id.
 * @returns The `StudioAssetEntity`, or null when no row has that id.
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
 * The content hash of the bytes stored under a key, from any studio's live
 * asset row. Storage keys are tenant-neutral, so every row under one key holds
 * the same hash.
 * @param storageKey - The object's storage key.
 * @returns The sha256 hex, or null when no live asset is stored under it.
 */
export async function findHashByStorageKey(storageKey: string): Promise<string | null> {
  const [row] = await db
    .select({ contentHash: studioAssets.contentHash })
    .from(studioAssets)
    .where(and(eq(studioAssets.storageKey, storageKey), isNull(studioAssets.deletedAt)))
    .limit(1);
  return row?.contentHash ?? null;
}

/**
 * The kind of the bytes stored under a key, from any studio's live asset row.
 * The kind is read off the stored bytes, so every row under one key holds the
 * same one.
 * @param storageKey - The object's storage key.
 * @returns The kind, or null when no live asset is stored under it.
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
