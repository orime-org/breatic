// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the ingest Worker's report means (#173, design §5).
 *
 * The Worker holds the bytes and nothing else. It knows the key it was told to
 * write to, what it computed over what landed, and whether the upload finished
 * — so those facts are all a report may carry. Everything that decides
 * consequences (which studio pays, which node updates, whose upload this was,
 * which generation its event is fenced on) is read off the grant row the ticket
 * endpoint wrote.
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
  videoCoverJobId,
  VIDEO_COVER_JOB,
  VIDEO_COVER_QUEUE,
  type VideoCoverJobData,
} from "@breatic/domain";
import {
  createQueue,
  defaultJobOpts,
  getStorageAdapter,
  getStorageConfig,
  getStreamRedis,
  logger,
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

/**
 * The queue the worker takes cover extractions off.
 *
 * Built on first use, not at import: `createQueue` reads the Redis URL out
 * of the validated config, and this module is reachable from imports that
 * run before an entry point has called `initCore`.
 */
let coverQueue: ReturnType<typeof createQueue> | null = null;

/**
 * The cover queue, created on first use.
 * @returns The shared BullMQ queue handle.
 */
function getCoverQueue(): ReturnType<typeof createQueue> {
  coverQueue ??= createQueue(VIDEO_COVER_QUEUE);
  return coverQueue;
}

/**
 * What the Worker says happened.
 *
 * A success and an abort carry different things, so they are different shapes:
 * what a success reports is the only account of the stored object anyone gets,
 * and making those fields optional would put a fallback where the fact belongs.
 */
export type IngestReport =
  | {
      storageKey: string;
      outcome: "completed";
      /** What the Worker computed over the stored bytes. */
      sha256: string;
      /** What actually landed, which is the authority over what was declared. */
      sizeBytes: number;
      contentType: string;
    }
  | {
      storageKey: string;
      outcome: "aborted";
      /** Why the Worker gave up. */
      reason?: string;
    };

/** What the report handler decided, for the route to answer with. */
export type IngestOutcome =
  | { status: "registered"; fileUrl: string; kind: string; deduped: boolean }
  | { status: "already_registered"; fileUrl: string; kind: string }
  | { status: "rejected"; reason: "over_cap" }
  | { status: "voided" };

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
 * Ask the worker to extract this video's cover.
 *
 * Refuses when the upload has no node behind it: there is then nobody to show
 * a cover to, and the job payload has no place for the fields the worker
 * writes its downstreams from. The caller falls through to the ordinary path,
 * which for a node-less upload is registration and nothing else.
 * @param grant - The consumed grant, carrying where the node lives.
 * @param asset - The registered video row.
 * @param asset.id - Its ledger id, which the cover is linked back onto.
 * @param asset.fileUrl - Its canonical URL, which the worker extracts from.
 * @param asset.sizeBytes - What it weighs, for the history row's metadata.
 * @param contentType - The video's measured mime type.
 * @returns Whether the job was queued.
 */
async function queueVideoCover(
  grant: UploadGrant,
  asset: { id: string; fileUrl: string; sizeBytes: number },
  contentType: string,
): Promise<boolean> {
  if (
    grant.projectId === null ||
    grant.spaceId === null ||
    grant.nodeId === null
  ) {
    return false;
  }
  await getCoverQueue().add(
    VIDEO_COVER_JOB,
    {
      storageKey: grant.storageKey,
      videoAssetId: asset.id,
      // The registered row's URL, which a dedup hit resolves to a different
      // object than this upload stored.
      videoUrl: asset.fileUrl,
      ownerStudioId: grant.studioId,
      userId: grant.userId,
      projectId: grant.projectId,
      spaceId: grant.spaceId,
      nodeId: grant.nodeId,
      leaseGen: grant.leaseGen,
      sizeBytes: asset.sizeBytes,
      mimeType: contentType,
      filename: grant.filename,
      source: grant.source,
      toolName: grant.toolName,
    } satisfies VideoCoverJobData,
    // The id makes a retried report reuse the job already queued rather than
    // start a second extraction of the same video.
    { ...defaultJobOpts(), jobId: videoCoverJobId(grant.storageKey) },
  );
  return true;
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
  // An `aborted` report names no type, and what it becomes is what a browser
  // would have been sent for bytes of unknown type. Only the already-consumed
  // branch below reads it on that path.
  const contentType =
    report.outcome === "completed"
      ? report.contentType
      : "application/octet-stream";

  // A retry. The Durable Object keeps its alarm until we answer, so the most
  // likely reason it is asking again is that our answer — or the event that
  // went with it — never arrived. Publishing again is the point: collab
  // applies these last-write-wins, so a duplicate costs nothing while a lost
  // one leaves the node spinning.
  if (grant.consumedAt !== null) {
    const existing =
      report.outcome === "completed"
        ? await assetRepo.findByStudioAndHash(grant.studioId, report.sha256)
        : null;
    const fileUrl = existing?.fileUrl ?? adapter.publicUrl(grant.storageKey);
    const settledKind = existing?.kind ?? assetService.detectAssetKind(contentType);
    // A video's event belongs to the cover job, which sends one carrying both
    // URLs. Sending a video-only one here would put a cover-less video on
    // screen and have the job replace it a moment later — and if the job has
    // already finished, this would undo the cover it just showed. Either the
    // job is still coming, or it failed for good and the queue's own net
    // (`reclaimFailedCoverJobById`) has already announced the video without a
    // cover; both leave the node told.
    if (settledKind !== "video") {
      await announceSuccess(grant, fileUrl);
    }
    return { status: "already_registered", fileUrl, kind: settledKind };
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
  const sizeBytes = report.sizeBytes;
  if (sizeBytes > upload.max_upload_bytes) {
    await voidGrant(grant.storageKey);
    await announceFailure(grant, "Upload failed");
    return { status: "rejected", reason: "over_cap" };
  }

  const kind = assetService.detectAssetKind(contentType);
  // The hash the Worker computed is the one the ledger keys on. The browser's
  // claim answered "have we got this already?" before a byte moved; only this
  // one names what is actually stored.
  const { asset, deduped, reclaimQueueFailed } = await assetService.register({
    projectId: grant.projectId ?? "",
    actingUserId: grant.userId,
    // Both come off the same row, and the row got its studio by resolving that
    // very project — so this is the one already-known answer rather than a
    // second, differing one. Passing it saves `register` the lookup.
    ownerStudioId: grant.studioId,
    contentHash: report.sha256,
    storageKey: grant.storageKey,
    fileUrl: adapter.publicUrl(grant.storageKey),
    sizeBytes,
    mimeType: contentType,
    kind,
    // Every upload that comes through a ticket is one. A cover is registered
    // by the worker that extracted it, which calls `register` directly.
    source: "upload",
  });

  // The object this upload wrote is a duplicate of one the studio already
  // holds, and the row that would have had it collected could not be written.
  // Nothing else records that, so without this the extra object is simply lost
  // to whoever has to reclaim it.
  if (reclaimQueueFailed === true) {
    logger.error(
      { storageKey: grant.storageKey, studioId: grant.studioId },
      "ingest_report_reclaim_queue_failed",
    );
  }

  // A video is not finished here. Its cover has to be pulled out of it first,
  // which needs ffmpeg and takes longer than a request should wait, so the
  // worker does that and writes everything the node sees — history row, feed
  // row, and the one event carrying both URLs. Writing any of them now would
  // mean a history row with a thumbnail it can never gain and an event putting
  // a cover-less video on screen a moment before the real one.
  const coverQueued =
    kind === "video" && (await queueVideoCover(grant, asset, contentType));

  // After the ledger row exists AND the job that owns the rest of a video's
  // outcome is queued, so an interruption anywhere above leaves the grant
  // unconsumed and the retry finishes the job. It is also what lets the
  // already-consumed branch take a queued cover job as given.
  // The answer is a CAS: false means another delivery of this same report got
  // there first. Both are then doing the work below against one registered
  // asset, which every downstream keys on — so the loser has nothing to undo
  // and nothing to say.
  await consumeGrant({ storageKey: grant.storageKey, userId: grant.userId });

  if (coverQueued) {
    return { status: "registered", fileUrl: asset.fileUrl, kind: asset.kind, deduped };
  }

  // Whether the node history row is new. It gates the feed write below,
  // which has no key of its own: on this path the grant's `consumedAt` already
  // turns a repeat report away long before here, so it is only ever true —
  // but the video job writes the same two downstreams and does get replayed,
  // and reading the flag in both places keeps one rule instead of two.
  let historyIsNew = true;
  if (grant.nodeId !== null && grant.projectId !== null) {
    const recorded = await nodeHistoryService.recordUpload({
      projectId: grant.projectId,
      nodeId: grant.nodeId,
      userId: grant.userId,
      content: asset.fileUrl,
      storageKey: grant.storageKey,
      metadata: {
        ...(grant.filename !== null && { filename: grant.filename }),
        size: sizeBytes,
        mimeType: contentType,
      },
    });
    historyIsNew = recorded.inserted;
  }

  // The project feed. A byproduct — today a focus crop — is in the ledger for
  // attribution and dedup, and is not an event anyone watching the project
  // wants announced.
  if (historyIsNew && grant.projectId !== null && grant.derived !== true) {
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
