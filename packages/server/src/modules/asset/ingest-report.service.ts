// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the ingest Worker's report means (#173, design §5).
 *
 * The Worker holds the bytes and nothing else. It knows the key it was told to
 * write to, what it computed over what landed, and whether the upload finished
 * — so those four facts are all a report may carry. Everything that decides
 * consequences (which studio pays, which node updates, whose upload this was)
 * is read off the grant row the ticket endpoint wrote.
 *
 * Three outcomes, and each one ends with the node hearing about it:
 *
 *   - the bytes are good     → register, consume the grant, tell the node
 *   - the bytes are too big  → void the grant, tell the node it failed
 *   - the upload never       → void the grant, tell the node it failed
 *     finished
 *
 * The event is not optional on any of them. A node enters handling before the
 * first byte moves and only leaves it when something says so; if this service
 * returns without publishing, the node spins until collab's hour-long sweeper
 * reclaims it.
 */

import {
  assetRepo,
  assetService,
  nodeHistoryService,
  emitNodeStateDone,
  emitNodeStateFailed,
} from "@breatic/domain";
import {
  getStorageAdapter,
  getStorageConfig,
  getStreamRedis,
  NotFoundError,
} from "@breatic/core";
import { canvasSpaceDocName, t } from "@breatic/shared";
import { recordProjectActivity } from "@server/modules/activity/projectActivity.service.js";
import {
  findGrantByKey,
  consumeGrant,
  voidGrant,
  type UploadGrant,
} from "@server/modules/asset/upload-grant.repo.js";

/** What the Worker says happened. */
export interface IngestReport {
  storageKey: string;
  outcome: "completed" | "aborted";
  leaseGen: number;
  /** Present on `completed`: what the Worker computed over the stored bytes. */
  sha256?: string;
  /** Present on `completed`: what actually landed, which is the authority. */
  sizeBytes?: number;
  contentType?: string;
  /** Present on `aborted`: why the Worker gave up. */
  reason?: string;
}

/** What the report handler decided, for the route to answer with. */
export type IngestOutcome =
  | { status: "registered"; fileUrl: string; kind: string; deduped: boolean }
  | { status: "already_registered"; fileUrl: string; kind: string }
  | { status: "rejected"; reason: "over_cap" }
  | { status: "voided" };

/**
 * Classify an upload into the coarse asset kind the ledger stores.
 * @param contentType - The MIME type signed into the ticket.
 * @returns The asset kind.
 */
function detectKind(
  contentType: string,
): "image" | "video" | "audio" | "document" | "file" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/") || contentType === "application/pdf") {
    return "document";
  }
  return "file";
}

/**
 * Tell the node this upload succeeded, and hand it the URL to pin.
 * @param grant - The grant, which carries where the node lives and its gen.
 * @param fileUrl - The registered row's canonical URL.
 */
async function announceSuccess(
  grant: UploadGrant,
  fileUrl: string,
): Promise<void> {
  if (grant.projectId === null || grant.spaceId === null || grant.nodeId === null) {
    return;
  }
  await emitNodeStateDone(
    getStreamRedis(),
    canvasSpaceDocName(grant.projectId, grant.spaceId),
    grant.nodeId,
    { content: fileUrl },
    grant.leaseGen,
  );
}

/**
 * Tell the node this upload failed.
 * @param grant - The grant, which carries where the node lives and its gen.
 * @param message - What the node shows.
 */
async function announceFailure(
  grant: UploadGrant,
  message: string,
): Promise<void> {
  if (grant.projectId === null || grant.spaceId === null || grant.nodeId === null) {
    return;
  }
  await emitNodeStateFailed(
    getStreamRedis(),
    canvasSpaceDocName(grant.projectId, grant.spaceId),
    grant.nodeId,
    message,
    grant.leaseGen,
  );
}

/**
 * Apply one report from the ingest Worker.
 * @param report - What the Worker says happened.
 * @returns What was decided, for the route to answer with.
 * @throws {NotFoundError} When the key names no grant we ever issued.
 */
export async function applyIngestReport(
  report: IngestReport,
): Promise<IngestOutcome> {
  const grant = await findGrantByKey(report.storageKey);
  if (grant === null) throw new NotFoundError(t("server.error.not_found"));

  const adapter = await getStorageAdapter();

  // A retry. The Durable Object keeps its alarm until we answer, so the most
  // likely reason it is asking again is that our answer — or the event that
  // went with it — never arrived. Publishing again is the point: collab
  // applies these last-write-wins, so a duplicate costs nothing while a lost
  // one leaves the node spinning.
  if (grant.consumedAt !== null) {
    const existing = report.sha256
      ? await assetRepo.findByStudioAndHash(grant.studioId, report.sha256)
      : null;
    const fileUrl = existing?.fileUrl ?? adapter.publicUrl(grant.storageKey);
    await announceSuccess(grant, fileUrl);
    return {
      status: "already_registered",
      fileUrl,
      kind: existing?.kind ?? detectKind(report.contentType ?? ""),
    };
  }

  if (report.outcome === "aborted") {
    await voidGrant(grant.storageKey);
    await announceFailure(grant, "Upload failed");
    return { status: "voided" };
  }

  // The declared size got the ticket issued; this is the first time anyone has
  // measured what actually arrived. The object is already in storage, so this
  // refusal leaves it there and lets the voided grant name it as an orphan.
  const { upload } = getStorageConfig();
  const sizeBytes = report.sizeBytes ?? 0;
  if (sizeBytes > upload.max_upload_bytes) {
    await voidGrant(grant.storageKey);
    await announceFailure(grant, "Upload failed");
    return { status: "rejected", reason: "over_cap" };
  }

  const contentType = report.contentType ?? "application/octet-stream";
  const kind = detectKind(contentType);
  // The hash the Worker computed is the one the ledger keys on. The browser's
  // claim answered "have we got this already?" before a byte moved; only this
  // one names what is actually stored.
  const { asset, deduped } = await assetService.register({
    projectId: grant.projectId ?? "",
    actingUserId: grant.userId,
    // Both come off the same row, and the row got its studio by resolving that
    // very project — so this is the one already-known answer rather than a
    // second, differing one. Passing it saves `register` the lookup.
    ownerStudioId: grant.studioId,
    contentHash: report.sha256 ?? "",
    storageKey: grant.storageKey,
    fileUrl: adapter.publicUrl(grant.storageKey),
    sizeBytes,
    mimeType: contentType,
    kind,
    source: grant.derived === true ? "cover" : "upload",
  });

  // After the ledger row exists, so an interrupted registration leaves the
  // grant unconsumed and the retry can finish the job.
  await consumeGrant({ storageKey: grant.storageKey, userId: grant.userId });

  if (grant.nodeId !== null && grant.projectId !== null) {
    await nodeHistoryService.recordUpload({
      projectId: grant.projectId,
      nodeId: grant.nodeId,
      userId: grant.userId,
      content: asset.fileUrl,
      metadata: {
        ...(grant.filename !== null && { filename: grant.filename }),
        size: sizeBytes,
        mimeType: contentType,
      },
    });
  }

  // The project feed. A derived byproduct (a video's cover) is in the ledger
  // but is not an event anyone watching the project wants announced.
  if (grant.projectId !== null && grant.derived !== true) {
    await recordProjectActivity({
      projectId: grant.projectId,
      actorUserId: grant.userId,
      type: grant.source === "mini_tool" ? "generation:succeeded" : "asset:uploaded",
      spaceId: grant.spaceId,
      nodeId: grant.nodeId,
      payload:
        grant.source === "mini_tool"
          ? {
              source: "mini_tool",
              ...(grant.toolName !== null && { toolName: grant.toolName }),
              executedOn: "frontend",
              fileUrl: asset.fileUrl,
              kind: asset.kind,
            }
          : { fileUrl: asset.fileUrl, kind: asset.kind },
    });
  }

  await announceSuccess(grant, asset.fileUrl);
  return { status: "registered", fileUrl: asset.fileUrl, kind: asset.kind, deduped };
}
