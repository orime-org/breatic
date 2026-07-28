// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
