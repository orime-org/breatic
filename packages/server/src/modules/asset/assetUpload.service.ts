// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Upload dedup service (asset slice 2, #1609) — the server-side business
 * rules around instant upload dedup (spec 2026-07-04-asset-layer-v1 §4.1
 * + B.2 decision 2026-07-07: same studio + same content = the SAME URL).
 *
 * Two rules live here (routes stay translation-only):
 *   - presign dedup check: studio-scoped hash lookup (D9 attribution)
 *     with SIZE DISTRUST — a hash claim whose declared size differs from
 *     the ledger row is refused dedup and falls through to a normal
 *     upload (spec §8: never trust the client's content claim alone);
 *   - dedup-report verification: the `/assets/uploaded` dedup path
 *     re-derives the (studio, hash) row server-side instead of trusting
 *     the client's URL — stronger than the key-prefix anti-spoof check
 *     it replaces on this path.
 */

import { assetRepo, assetService } from "@breatic/domain";

/** A dedup hit: the canonical asset the client should reuse. */
export interface DedupHit {
  /** The existing asset's public URL (the one the node reuses — B.2). */
  fileUrl: string;
  /** The existing asset's kind (image / video / audio / document / file). */
  kind: string;
}

/**
 * Presign-time dedup check: does the acting user's owner studio (D9)
 * already hold this content? A hit with a MATCHING declared size skips
 * the upload entirely; a size mismatch refuses dedup (content claim not
 * trusted) so the caller falls through to a normal presign.
 * @param params - The dedup claim.
 * @param params.projectId - Project the upload targets.
 * @param params.actingUserId - Authenticated uploader.
 * @param params.contentHash - Client-computed sha256 hex.
 * @param params.sizeBytes - Client-declared file size.
 * @returns The hit to reuse, or null (no row / size mismatch).
 * @throws {NotFoundError} When the project (or the acting user's
 *   personal studio) does not exist.
 */
export async function checkUploadDedup(params: {
  projectId: string;
  actingUserId: string;
  contentHash: string;
  sizeBytes: number;
}): Promise<DedupHit | null> {
  const studioId = await assetService.resolveOwnerStudioId(
    params.projectId,
    params.actingUserId,
  );
  const existing = await assetRepo.findByStudioAndHash(
    studioId,
    params.contentHash,
  );
  if (!existing) return null;
  if (existing.sizeBytes !== params.sizeBytes) return null;
  return { fileUrl: existing.fileUrl, kind: existing.kind };
}

/**
 * Verify a dedup upload report: the row the client claims to reuse must
 * actually exist in the acting user's owner studio (D9). Server-side
 * re-derivation — the client's URL is never trusted on this path.
 * @param params - The dedup report.
 * @param params.projectId - Project the report targets.
 * @param params.actingUserId - Authenticated reporter.
 * @param params.contentHash - The claimed content hash.
 * @returns The verified asset to record, or null (nothing to reuse).
 * @throws {NotFoundError} When the project (or the acting user's
 *   personal studio) does not exist.
 */
export async function verifyDedupUpload(params: {
  projectId: string;
  actingUserId: string;
  contentHash: string;
}): Promise<DedupHit | null> {
  const studioId = await assetService.resolveOwnerStudioId(
    params.projectId,
    params.actingUserId,
  );
  const existing = await assetRepo.findByStudioAndHash(
    studioId,
    params.contentHash,
  );
  return existing ? { fileUrl: existing.fileUrl, kind: existing.kind } : null;
}
