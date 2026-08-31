// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Upload dedup service (asset slice 2, #1609) — the server-side business
 * rules around instant upload dedup (spec 2026-07-04-asset-layer-v1 §4.1
 * + B.2 decision 2026-07-07: same studio + same content = the SAME URL).
 *
 * Two rules live here (routes stay translation-only):
 *   - the ticket-time dedup check: a hash lookup scoped to the PROJECT's
 *     studio (attribution #1839 — never the acting user's own) with SIZE
 *     DISTRUST, so a hash claim whose declared size differs from the ledger
 *     row is refused dedup and falls through to a real upload (spec §8:
 *     never trust the client's content claim alone);
 *   - what a hit means for the node: its history row, and the event that
 *     ends its handling — no Worker reports on an upload that never
 *     happened, so nothing else would.
 */

import {
  assetRepo,
  assetService,
  emitNodeStateDone,
  nodeHistoryService,
} from "@breatic/domain";
import { storageKey, getStreamRedis, logger } from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
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
 * Ticket-time dedup check: does the PROJECT's owner studio already hold this
 * content (#1839 — never the acting user's own studio)? A hit with a MATCHING
 * declared size skips the upload entirely; a size mismatch refuses dedup
 * (content claim not trusted) so the caller falls through to a real upload.
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
 * Carry out what a dedup hit means: nothing uploads, and the node now holds
 * content it did not hold before (design §7).
 *
 * The node opened handling before this request was made, and no Worker will
 * report on an upload that never happened — so this is the only thing that can
 * bring it back out. A failure to publish therefore fails the request: the
 * browser is still the one holding this attempt, and it writes the node's
 * failure itself (design §5.5).
 *
 * The history row is best-effort in the other direction. Its loss costs an
 * audit line, and turning that into a failed upload would cost the user the
 * content they can see is already there.
 * @param params - What was matched and where it lands.
 * @param params.projectId - The project the node lives in.
 * @param params.hit - The asset being reused.
 * @param params.userId - Who asked.
 * @param params.leaseGen - The node's fencing gen, which the event carries.
 * @param params.metadata - The picked file's facts, for the history row.
 * @param params.metadata.filename - The name the file was picked under.
 * @param params.metadata.size - The file's byte size as the browser declared it.
 * @param params.metadata.mimeType - The file's content type.
 * @param params.nodeId - The node, when this upload has one.
 * @param params.spaceId - The space that node lives in.
 * @throws {unknown} When the event cannot be published.
 */
export async function settleDedupHit(params: {
  projectId: string;
  hit: DedupHit;
  userId: string;
  leaseGen: number;
  metadata: { filename: string; size: number; mimeType: string };
  nodeId?: string | undefined;
  spaceId?: string | undefined;
}): Promise<void> {
  if (params.nodeId !== undefined) {
    try {
      await nodeHistoryService.recordUpload({
        projectId: params.projectId,
        nodeId: params.nodeId,
        userId: params.userId,
        content: params.hit.fileUrl,
        metadata: params.metadata,
      });
    } catch (err) {
      logger.warn(
        { err, projectId: params.projectId, nodeId: params.nodeId },
        "upload_ticket_dedup_history_failed",
      );
    }
  }

  // A focus crop asks with no node. It reads its result from this request's
  // own answer, so there is nothing to announce and nowhere to announce it.
  if (params.nodeId === undefined || params.spaceId === undefined) return;
  await emitNodeStateDone(
    getStreamRedis(),
    canvasSpaceDocName(params.projectId, params.spaceId),
    params.nodeId,
    { content: params.hit.fileUrl },
    params.leaseGen,
  );
}

/**
 * Mint a tenant-neutral storage key for an upload that missed dedup and record
 * its upload grant (#1826, design §2.2). Called by the ticket endpoint AFTER
 * the dedup check misses: resolves the owner studio (#1839 — the PROJECT's),
 * mints K,
 * and writes the grant row the ingest Worker's report is later checked
 * against. The dedup-hit path never calls this (no key, no grant).
 *
 * The context travels onto the grant rather than being asked of the report,
 * because the report comes from the Worker, which knows only what the ticket
 * told it. Checking it here — while we hold the user's session and their
 * access to the project — is what makes it ours rather than the client's.
 * @param params - The upload claim + key components.
 * @param params.projectId - Project the upload targets.
 * @param params.actingUserId - Authenticated uploader.
 * @param params.declaredSize - Client-declared byte size (UX pre-check only).
 * @param params.taskType - The detected kind, used as the key's task segment.
 * @param params.ext - The dotted file extension for the key.
 * @param params.expiresAt - When the ticket stops being usable.
 * @param params.leaseGen - The node's fencing gen at the moment handling opened.
 * @param params.context - Node, space, and provenance for the report to use.
 * @param params.context.nodeId - Node the bytes land on, when there is one.
 * @param params.context.spaceId - Canvas space holding that node.
 * @param params.context.source - What started this upload.
 * @param params.context.toolName - Mini-tool that produced the bytes, if any.
 * @param params.context.derived - True when the bytes came out of another asset.
 * @param params.context.filename - Original file name, shown in history.
 * @returns The minted storage key K and the owner studio it was attributed to.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
export async function issueUploadGrant(params: {
  projectId: string;
  actingUserId: string;
  declaredSize: number;
  taskType: string;
  ext: string;
  expiresAt: Date;
  leaseGen: number;
  context: {
    nodeId?: string | null;
    spaceId?: string | null;
    source?: string | null;
    toolName?: string | null;
    derived?: boolean | null;
    filename?: string | null;
  };
}): Promise<{ key: string; studioId: string }> {
  const studioId = await assetService.resolveOwnerStudioId(params.projectId);
  const key = storageKey({ taskType: params.taskType, ext: params.ext });
  await issueGrant({
    userId: params.actingUserId,
    studioId,
    storageKey: key,
    declaredSize: params.declaredSize,
    expiresAt: params.expiresAt,
    leaseGen: params.leaseGen,
    context: { ...params.context, projectId: params.projectId },
  });
  return { key, studioId };
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
