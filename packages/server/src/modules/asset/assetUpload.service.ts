// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload dedup service (asset slice 2, #1609) — the server-side business
 * rules around instant upload dedup (spec 2026-07-04-asset-layer-v1 §4.1
 * + B.2 decision 2026-07-07: same studio + same content = the SAME URL).
 *
 * Two rules live here (routes stay translation-only):
 *   - presign dedup check: hash lookup scoped to the PROJECT's studio
 *     (attribution #1839 — never the acting user's own)
 *     with SIZE DISTRUST — a hash claim whose declared size differs from
 *     the ledger row is refused dedup and falls through to a normal
 *     upload (spec §8: never trust the client's content claim alone);
 *   - dedup-report verification: the `/assets/uploaded` dedup path
 *     re-derives the (studio, hash) row server-side instead of trusting
 *     the client's URL — stronger than the key-prefix anti-spoof check
 *     it replaces on this path.
 */

import { assetRepo, assetService } from "@breatic/domain";
import { storageKey } from "@breatic/core";
import {
  issueGrant,
  findLiveGrant,
  consumeGrant,
} from "@server/modules/asset/upload-grant.repo.js";

/** A dedup hit: the canonical asset the client should reuse. */
export interface DedupHit {
  /** The existing asset's public URL (the one the node reuses — B.2). */
  fileUrl: string;
  /** The existing asset's kind (image / video / audio / document / file). */
  kind: string;
}

/**
 * Presign-time dedup check: does the PROJECT's owner studio already hold
 * this content (#1839 — never the acting user's own studio)? A hit with a
 * MATCHING declared size skips the upload entirely; a size mismatch refuses
 * dedup (content claim not trusted) so the caller falls through to a normal
 * presign.
 * @param params - The dedup claim.
 * @param params.projectId - Project the upload targets; it alone decides the
 *   studio whose content is searched.
 * @param params.contentHash - Client-computed sha256 hex.
 * @param params.sizeBytes - Client-declared file size.
 * @returns The hit to reuse, or null (no row / size mismatch).
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
export async function checkUploadDedup(params: {
  projectId: string;
  contentHash: string;
  sizeBytes: number;
}): Promise<DedupHit | null> {
  const studioId = await assetService.resolveOwnerStudioId(params.projectId);
  const existing = await assetRepo.findByStudioAndHash(
    studioId,
    params.contentHash,
  );
  if (!existing) return null;
  if (existing.sizeBytes !== params.sizeBytes) return null;
  return { fileUrl: existing.fileUrl, kind: existing.kind };
}

/**
 * Resolve a content hash to the live asset row that holds it in a given
 * studio. Two callers on `/uploaded`, both server-side re-derivations that
 * never trust a client-supplied URL:
 *   - the dedup report ("I am reusing content I already have");
 *   - the video report's cover reference (`cover_hash` → the cover's canonical).
 *
 * The studio is passed IN rather than derived here (Gate-2 R9). The caller
 * already holds the authoritative one — the grant's studio on the regular
 * path, the project-derived one on the dedup path (which has no grant, by
 * design: an instant-dedup report uploads nothing). Deriving it again inside
 * this function meant the cover lookup silently used the CLIENT's project_id
 * while the video beside it used the grant's studio: one report, two studios.
 * @param params - The lookup.
 * @param params.studioId - The AUTHORITATIVE owner studio, resolved by the caller.
 * @param params.contentHash - The claimed content hash.
 * @returns The live asset to reuse, or null when that studio holds no such content.
 */
export async function verifyDedupUpload(params: {
  studioId: string;
  contentHash: string;
}): Promise<DedupHit | null> {
  const existing = await assetRepo.findByStudioAndHash(
    params.studioId,
    params.contentHash,
  );
  return existing
    ? { fileUrl: existing.fileUrl, kind: existing.kind }
    : null;
}

/**
 * Mint a tenant-neutral storage key for an upload that missed dedup and record
 * its upload grant (#1826, design §2.2). Called by /presign AFTER the dedup
 * check misses: resolves the owner studio (#1839 — the PROJECT's), mints K,
 * and writes the grant
 * row (user + studio + declared hash + K) that the upload endpoints later
 * re-check for authenticity. The dedup-hit path never calls this (no key, no
 * grant).
 * @param params - The upload claim + key components.
 * @param params.projectId - Project the upload targets.
 * @param params.actingUserId - Authenticated uploader.
 * @param params.contentHash - Client-declared sha256 hex. Mandatory: presign
 *   refuses a request without one (#1826 §0 rule 4). Recorded on the grant so
 *   the later `/uploaded` report can be bound to the SAME content
 *   ({@link resolveGrantForReport}) — ownership checks still ignore it.
 * @param params.declaredSize - Client-declared byte size (UX pre-check only).
 * @param params.taskType - The detected kind, used as the key's task segment.
 * @param params.ext - The dotted file extension for the key.
 * @returns The minted storage key K.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
export async function issueUploadGrant(params: {
  projectId: string;
  actingUserId: string;
  contentHash: string;
  declaredSize: number;
  taskType: string;
  ext: string;
}): Promise<{ key: string }> {
  const studioId = await assetService.resolveOwnerStudioId(params.projectId);
  const key = storageKey({ taskType: params.taskType, ext: params.ext });
  await issueGrant({
    userId: params.actingUserId,
    studioId,
    contentHash: params.contentHash,
    storageKey: key,
    declaredSize: params.declaredSize,
  });
  return { key };
}

/**
 * /local-upload write-time gate (#1826, design §3.2): is this key issued to
 * this user and not yet consumed? Does NOT consume (a local upload is a two-hop
 * PUT-then-report on ONE grant). Ownership is user-only; the studio is recorded
 * on the grant, not a query condition.
 * @param params - The ownership claim.
 * @param params.storageKey - The key being written to.
 * @param params.actingUserId - The authenticated caller.
 * @returns True when a live grant authorises the write.
 */
export async function authorizeUploadWrite(params: {
  storageKey: string;
  actingUserId: string;
}): Promise<boolean> {
  const grant = await findLiveGrant({
    storageKey: params.storageKey,
    userId: params.actingUserId,
  });
  return grant !== null;
}

/**
 * Authorise an `/uploaded` report and read the AUTHORITATIVE owner studio off
 * the grant (#1826 §2.2 v15). One lookup answers both questions.
 *
 * Two things must hold, and BOTH come from the grant row:
 *
 * 1. Ownership — a live grant for (key, user). The studio was resolved
 *    server-side at presign, so `/uploaded` attributes the asset to THAT
 *    studio rather than re-deriving one from the client's `project_id`. A
 *    member of two studios could otherwise presign inside studio A's project
 *    and report completion with studio B's project id, charging the storage to
 *    B (shifting personal cost onto a team).
 * 2. Content identity — the report's hash must be the one the grant was issued
 *    for. A grant authorises ONE upload of ONE piece of content, and the hash
 *    is what names that content (Gate-2 R7). Without this, two concurrent
 *    reports on a single key can register TWO rows with DIFFERENT hashes:
 *    `studio_assets` is unique on (studio_id, content_hash), NOT on
 *    storage_key, so the second report resolves as a dedup hit against some
 *    unrelated existing row and hands the key to the offline reclaim queue —
 *    while the first report's row is live and a node is pinned to that very
 *    key. The offline job then deletes bytes a node points at: a 404 the
 *    design declares impossible.
 *
 * The write-time gate (`authorizeUploadWrite`) deliberately does NOT check the
 * hash: `/local-upload` is a bare byte PUT with no hash in scope. Authenticity
 * stays (key, user, not-consumed); this adds the report-only binding.
 * @param params - The report's claim.
 * @param params.storageKey - The key being registered.
 * @param params.actingUserId - The authenticated caller.
 * @param params.contentHash - The sha256 the report declares for those bytes.
 * @returns The grant's owner studio id, or null when no live grant matches the
 *   caller or the grant was issued for different content.
 */
export async function resolveGrantForReport(params: {
  storageKey: string;
  actingUserId: string;
  contentHash: string;
}): Promise<string | null> {
  const grant = await findLiveGrant({
    storageKey: params.storageKey,
    userId: params.actingUserId,
  });
  if (!grant) return null;
  if (grant.contentHash !== params.contentHash) return null;
  return grant.studioId;
}

/**
 * /uploaded single-shot consume (#1826, design §3.2 / §4.1 step 6): mark the
 * grant consumed exactly once, AFTER the studio_assets INSERT (so the physical
 * object always has an unconsumed grant as an in-flight signal until it is
 * claimed by its ledger row). Concurrent callers on one key → exactly one wins.
 * @param params - The ownership claim.
 * @param params.storageKey - The key being registered.
 * @param params.actingUserId - The authenticated caller.
 * @returns True when this call consumed the grant; false on replay / foreign.
 */
export async function consumeUploadGrant(params: {
  storageKey: string;
  actingUserId: string;
}): Promise<boolean> {
  return consumeGrant({
    storageKey: params.storageKey,
    userId: params.actingUserId,
  });
}
