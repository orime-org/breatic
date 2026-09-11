// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What one upload's outcome means for the ledger (#173, design §5).
 *
 * The report is written here, by whichever of our own processes drove the
 * finish: it carries what the Worker measured over the stored bytes when the
 * object was assembled, and says the upload was given up on when it was not.
 * Those facts are all a report may carry, because the Worker knows nothing
 * else — the key it was told to write to, and what it computed. Everything
 * that decides consequences (which studio pays, which node updates, whose
 * upload this was, which space it lives in) is read off the grant row the
 * ticket endpoint wrote.
 *
 * What a report can be:
 *
 *   - the bytes are good     → register, consume the grant, tell the node
 *   - the bytes are too big  → void the grant, tell the node it failed
 *   - the upload never       → void the grant, tell the node it failed
 *     finished
 *   - nothing landed at all  → void the grant, tell no one: the lanes that
 *     (zero bytes)              can produce this open their grants without a
 *                               node, and the worker settles its own row off
 *                               the refusal
 *   - any of those, on a key → say nothing: the delivery that registered it
 *     already registered        already told the node
 *
 * A node starts counting a task before the first byte moves, and the event
 * carrying that task's outcome is what stops it. A node whose event never got
 * out catches up the moment somebody opens its task list, which harvests the
 * rows against their budgets and republishes the counts (#186 §4.6).
 */

import * as assetRepo from "@domain/asset/asset.repo.js";
import * as assetService from "@domain/asset/asset.service.js";
import * as nodeHistoryService from "@domain/node-history/node-history.service.js";
import * as nodeTaskService from "@domain/node-task/node-task.service.js";
import { emitNodeTaskCounts } from "@domain/canvas-node/node-state-events.js";
import {
  getStorageAdapter,
  getStorageConfig,
  getStreamRedis,
  NotFoundError,
} from "@breatic/core";
import { canvasSpaceDocName, t } from "@breatic/shared";
import type { NodeTaskResult, StudioAssetEntity } from "@breatic/shared";
import { appendProjectActivity } from "@domain/activity/project-activity.service.js";
import * as uploadGrantRepo from "@domain/asset/upload-grant.repo.js";
import type {
  UploadGrant,
  FinalizeClaim,
} from "@domain/asset/upload-grant.repo.js";

const {
  findGrantByKey,
  consumeGrant,
  voidGrant,
  claimFinalize: claimFinalizeGrant,
} = uploadGrantRepo;

/**
 * What happened to one upload.
 *
 * A success and an abort carry different things, so they are different shapes:
 * what a success reports is the only account of the stored object anyone gets,
 * and making those fields optional would put a fallback where the fact belongs.
 * Both are written by the process that drove the finish — the Worker measures,
 * and says nothing.
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
      /**
       * What the media container read off the object (#209). Absent for a
       * medium that has no such number, and equally for a container that could
       * not answer — the two need not be told apart, because neither decides
       * whether this upload succeeded.
       */
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      /**
       * The cover the container cut, already written to the key this server
       * minted for it and hashed at the edge. Absent for anything that is not
       * a video, and equally for a video no frame could be lifted out of.
       */
      cover?: {
        storageKey: string;
        sha256: string;
        sizeBytes: number;
        contentType: string;
      } | null;
    }
  | {
      storageKey: string;
      outcome: "aborted";
    };

/**
 * What happened alongside registration that the caller has to write down.
 *
 * None of it changes the outcome — the report still stands — and none of it
 * can be logged here, because a library holds no logger. A field is present
 * only when it went wrong, so a caller that reads nothing writes nothing.
 */
export interface IngestSideEffects {
  /** The node's recounted numbers did not reach the stream. */
  countsPublishFailed?: boolean;
  /**
   * The duplicate object this upload wrote could not be queued for reclaim.
   * Nothing else records it, so without the log line it is lost to whoever
   * has to collect it.
   */
  reclaimQueueFailed?: boolean;
  /** The project's feed row was not appended. */
  activityAppendFailed?: boolean;
  /**
   * The cover came back but could not be filed. The video stands and is shown
   * without one — storage rule ③ keeps a cover's own failure off the video —
   * so this is the only account anybody gets of the object left behind.
   */
  coverRegisterFailed?: boolean;
}

/**
 * What the row carries about the media itself.
 *
 * On the answer as well as on the row: a caller with no node listening has
 * nothing else to read them from, and a node that measures its own media in
 * the browser shows nothing until the bytes have decoded.
 */
interface RegisteredMedia {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/** What the report handler decided, for the route to answer with. */
export type IngestReportOutcome = IngestSideEffects &
  (
  | ({
      status: "registered";
      assetId: string;
      fileUrl: string;
      kind: string;
      /**
       * The cover filed against this row, for a caller with no node to hear
       * it through — a generation pins this on its own output.
       */
      coverUrl: string | null;
    } & RegisteredMedia)
  | ({
      status: "already_registered";
      /** The row this key registered, found by the hash the Worker sent. */
      assetId: string;
      fileUrl: string;
      kind: string;
      coverUrl: string | null;
    } & RegisteredMedia)
  | { status: "rejected"; reason: "over_cap" | "empty" }
  | { status: "voided" }
  /**
   * Nothing for this report to answer with: a failure for an upload another
   * delivery already registered, or a repeat whose ledger row is gone.
   */
    | { status: "stale" });

/**
 * A grant whose upload has a node behind it.
 *
 * A focus crop (design §9) has no node: its `nodeId` and `spaceId` are null.
 * All three columns are nullable, and all three are judged together so that
 * `canvasSpaceDocName(projectId, spaceId)` gets non-null arguments.
 */
type GrantWithNode = UploadGrant & {
  projectId: string;
  spaceId: string;
  nodeId: string;
};

/**
 * Whether this upload has a node behind it.
 *
 * One predicate for every caller, and the narrowing lets each read the three
 * values without asserting they are there.
 * @param grant - The grant.
 * @returns True when the grant names a node.
 */
function hasNode(grant: UploadGrant): grant is GrantWithNode {
  return (
    grant.projectId !== null && grant.spaceId !== null && grant.nodeId !== null
  );
}

/**
 * What the node is handed when an upload settles as done.
 *
 * Every field spelled out rather than defaulted, so a caller that reaches a
 * new way of settling has to say what the node shows — the three numbers went
 * out as null from every path for as long as they had a default.
 */
interface SettledAsset {
  /** The registered row's canonical URL. */
  fileUrl: string;
  /** The video's cover, once one is registered against the row. */
  coverUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

/**
 * Tell the node this upload succeeded, and hand it what to draw.
 * @param grant - The grant, which carries where the node lives.
 * @param settled - The registered row, as the node needs to see it.
 * @param nodeHistoryId - The history row holding the result, when one was
 *   written on this pass.
 * @returns Whether publishing the node's numbers failed.
 */
async function announceSuccess(
  grant: UploadGrant,
  settled: SettledAsset,
  nodeHistoryId?: string,
): Promise<boolean> {
  if (!hasNode(grant)) return false;
  return settleUploadTask(grant, {
    outcome: "done",
    ...(nodeHistoryId !== undefined && { nodeHistoryId }),
    result: {
      content: settled.fileUrl,
      coverUrl: settled.coverUrl,
      width: settled.width,
      height: settled.height,
      duration: settled.durationSeconds,
    },
  });
}

/**
 * Tell the node this upload failed.
 * @param grant - The grant, which carries where the node lives.
 * @param message - What the node shows.
 * @returns Whether publishing the node's numbers failed.
 */
async function announceFailure(
  grant: UploadGrant,
  message: string,
): Promise<boolean> {
  if (!hasNode(grant)) return false;
  return settleUploadTask(grant, {
    outcome: "failed",
    errorMessage: message,
  });
}

/**
 * Move the task this grant opened to a terminal state and publish the node's
 * recounted numbers (#186, design §3.6).
 *
 * The report names a storage key, which is how this gets from what the Worker
 * said back to the row the ticket opened. An upload with no task behind it —
 * one that predates this table, or a focus crop, which has no node to count
 * on — leaves nothing to settle and nothing to publish.
 * @param grant - The grant, which names the node and the key.
 * @param outcome - Where the row lands, and what rides along.
 * @param outcome.outcome - `done` or `failed`.
 * @param outcome.nodeHistoryId - The history row holding the result.
 * @param outcome.errorMessage - What the list shows for a failure.
 * @param outcome.result - The content fields, on the transition into `done`.
 * @returns Whether publishing the node's numbers failed, when that failure is
 *   this upload's to survive.
 */
async function settleUploadTask(
  grant: GrantWithNode,
  outcome: {
    outcome: "done" | "failed";
    nodeHistoryId?: string;
    errorMessage?: string;
    result?: NodeTaskResult;
  },
): Promise<boolean> {
  const task = await nodeTaskService.findByStorageKey(grant.storageKey);
  if (task === null) return false;

  const settled = await nodeTaskService.settle({
    taskId: task.id,
    outcome: outcome.outcome,
    ...(outcome.nodeHistoryId !== undefined && {
      nodeHistoryId: outcome.nodeHistoryId,
    }),
    ...(outcome.errorMessage !== undefined && {
      errorMessage: outcome.errorMessage,
    }),
  });

  // The content rides along whenever the row holds this outcome, a repeated
  // finish included — the browser delivers one again when it heard no answer,
  // and that retry is the whole recovery for a result that never reached the
  // node. A row that settled some OTHER way leaves the node's content alone:
  // the user may have retried, and choosing for them is not ours to do.
  const content = settled.landed ? outcome.result : undefined;
  const docName = canvasSpaceDocName(grant.projectId, grant.spaceId);

  // Which of the two this is decides who owns a failure to publish, and it is
  // decided here rather than by which function called us: a failure and a
  // report that arrived after the row settled some other way both come
  // through carrying nothing. The one carrying nothing survives its own
  // failure — the row already settled, and the numbers are recounted whenever
  // somebody opens the list — so it is reported to the caller, which holds the
  // logger. The one carrying content does not: without it the node keeps
  // showing an upload that has ended.
  if (content === undefined) {
    return emitNodeTaskCounts(
      getStreamRedis(),
      docName,
      grant.nodeId,
      settled.counts,
      undefined,
    ).then(
      () => false,
      () => true,
    );
  }
  await emitNodeTaskCounts(
    getStreamRedis(),
    docName,
    grant.nodeId,
    settled.counts,
    content,
  );
  return false;
}

/**
 * Decide whether one multipart upload may finish on a key (#186, design §6.4).
 *
 * Our own server asks this before it tells the Worker to assemble the object,
 * because the ledger is the only place that knows whether another delivery is
 * already finishing this key. What comes back decides whether R2 is touched at
 * all.
 * @param params - The key and the upload asking to finish on it.
 * @param params.storageKey - The key being finished.
 * @param params.uploadId - The multipart upload the browser is holding.
 * @returns Granted, or the reason it was refused.
 */
export async function claimFinalize(params: {
  storageKey: string;
  uploadId: string;
}): Promise<FinalizeClaim> {
  return claimFinalizeGrant(params);
}

/**
 * File the cover the container cut, and point the video row at it.
 *
 * Never fails the upload (storage rule ③: a cover is its own asset, and a
 * video whose frame could not be lifted or filed is still a video). The frame
 * itself may be missing for two reasons that need not be told apart — nothing
 * decodable in the video, or a container that did not answer — and both leave
 * the node showing the Film icon.
 *
 * Filed BEFORE the video, so the video row can be inserted already pointing at
 * it and is never readable without one. A dedup hit resolves to that row and
 * has nothing else to read a cover from, which is the window #187 lived in.
 * @param report - The completed report, which carries the cover when there is
 *   one.
 * @param grant - The grant, for who the cover is attributed to.
 * @returns The cover's ledger row and URL, or nothing when there is no frame
 *   to file, and whether filing one failed.
 */
async function fileCover(
  report: Extract<IngestReport, { outcome: "completed" }>,
  grant: UploadGrant,
): Promise<{
  id: string | null;
  url: string | null;
  failed: boolean;
  reclaimQueueFailed: boolean;
}> {
  const cover = report.cover;
  if (cover === undefined || cover === null) {
    return { id: null, url: null, failed: false, reclaimQueueFailed: false };
  }
  const adapter = await getStorageAdapter();
  try {
    const registered = await assetService.register({
      projectId: grant.projectId ?? "",
      actingUserId: grant.userId,
      ownerStudioId: grant.studioId,
      contentHash: cover.sha256,
      storageKey: cover.storageKey,
      fileUrl: adapter.publicUrl(cover.storageKey),
      sizeBytes: cover.sizeBytes,
      mimeType: cover.contentType,
      kind: assetService.detectAssetKind(cover.contentType),
      source: "cover",
      // The frame's own size, which is the video's as it will be shown. ffmpeg
      // autorotates on decode, so a portrait phone video's frame comes out
      // turned — and the pair reported alongside it is turned to match, which
      // is what keeps this row true about its own bytes (measured on a square
      // pixel video, an anamorphic one and a rotated one).
      width: report.width ?? null,
      height: report.height ?? null,
      ...(grant.generationTaskId !== null && {
        generationTaskId: grant.generationTaskId,
      }),
    });
    return {
      id: registered.asset.id,
      url: registered.asset.fileUrl,
      failed: false,
      // Two uploads of the same video cut byte-identical frames, so the second
      // one dedups and hands the loser to the reclaim queue. When that write
      // fails nothing else records the object, and the operator who has to
      // collect it hears about it through the caller's log line or not at all.
      reclaimQueueFailed: registered.reclaimQueueFailed === true,
    };
  } catch {
    return { id: null, url: null, failed: true, reclaimQueueFailed: false };
  }
}

/**
 * Which cover a row that already stood ends up showing.
 *
 * Repointing a row that already carries one would swap a cover every node
 * shows for one nobody has seen. A row with none takes this upload's: nothing
 * else will ever give it one.
 *
 * The standing cover is read whether or not this upload filed one, because the
 * two are unrelated: a run that timed out leaves the node with no poster while
 * the row it resolved to has had one all along.
 *
 * Failing here is not the upload's failure, for the same reason filing a cover
 * is not: the video stands and is shown without a poster. The row is already
 * written by the time this runs, so throwing would report a stored, registered
 * upload as failed.
 * @param video - The row this upload resolved to.
 * @param filed - The cover this upload filed, when it filed one.
 * @param filed.id - Its ledger row.
 * @param filed.url - Where it is readable, which is what the node shows once
 *   the video points at it.
 * @returns The URL the node should show, or null when there is none to show.
 */
async function settleDedupedCover(
  video: StudioAssetEntity,
  filed: { id: string | null; url: string | null },
): Promise<string | null> {
  try {
    const standing = await assetRepo.findCoverOf(video.id);
    if (standing !== null) return standing.fileUrl;
    if (filed.id === null) return null;
    await assetRepo.setCoverAsset(video.id, filed.id);
    return filed.url;
  } catch {
    return null;
  }
}

/**
 * Apply one report from the ingest Worker.
 * @param report - What happened to this upload.
 * @returns What was decided, for the route to answer with.
 * @throws {NotFoundError} When the key names no grant we ever issued.
 */
export async function applyIngestReport(
  report: IngestReport,
): Promise<IngestReportOutcome> {
  const grant = await findGrantByKey(report.storageKey);
  if (grant === null) throw new NotFoundError(t("server.error.not_found"));

  // What the report says happened is the first question, because a failure
  // never settles anything as done. A key that is already registered got that
  // way through an earlier delivery of this same upload, and what it wrote
  // stands: this report carries no hash to find the registered row by, so
  // anything it announced would name a URL built from the key — and dedup
  // means the registered URL can name an object under an entirely different
  // one.
  if (report.outcome === "aborted") {
    if (grant.consumedAt !== null) return { status: "stale" };
    await voidGrant(grant.storageKey);
    const countsPublishFailed = await announceFailure(grant, "aborted");
    return { status: "voided", ...(countsPublishFailed && { countsPublishFailed }) };
  }

  const adapter = await getStorageAdapter();
  const contentType = report.contentType;

  // A retry: the browser did not hear the answer to its finish request, so it
  // sent the same upload again. Publishing again is the point — collab applies
  // these last-write-wins, so a duplicate costs nothing while a lost one
  // leaves the node spinning.
  if (grant.consumedAt !== null) {
    const existing = await assetRepo.findByStudioAndHash(
      grant.studioId,
      report.sha256,
    );
    // A studio that no longer holds a row for this content has no canonical
    // url to answer with, and the key on the grant is not one: within a studio
    // the same content dedups to a single row, so this key may be the loser
    // the reclaim job is about to remove (storage rule ②).
    if (existing === null) return { status: "stale" };
    const fileUrl = existing.fileUrl;
    const settledKind = existing.kind;
    // Everything the node is told comes off the row that already stands, never
    // off this report: within a studio the same content is one row however
    // many uploads reached it, and this key may be the loser the reclaim job
    // is about to remove.
    const existingCover =
      settledKind === "video" ? await assetRepo.findCoverOf(existing.id) : null;
    const countsPublishFailed = await announceSuccess(grant, {
      fileUrl,
      coverUrl: existingCover?.fileUrl ?? null,
      width: existing.width,
      height: existing.height,
      durationSeconds: existing.durationSeconds,
    });
    return {
      status: "already_registered",
      assetId: existing.id,
      fileUrl,
      kind: settledKind,
      coverUrl: existingCover?.fileUrl ?? null,
      width: existing.width,
      height: existing.height,
      durationSeconds: existing.durationSeconds,
      ...(countsPublishFailed && { countsPublishFailed }),
    };
  }

  // The declared size got the ticket issued; this is the first time anyone has
  // measured what actually arrived. The object is already in storage, so this
  // refusal leaves it there and lets the voided grant name it as an orphan.
  const { upload } = getStorageConfig();
  const sizeBytes = report.sizeBytes;
  if (sizeBytes > upload.max_upload_bytes) {
    await voidGrant(grant.storageKey);
    const countsPublishFailed = await announceFailure(grant, "over_cap");
    return {
      status: "rejected",
      reason: "over_cap",
      ...(countsPublishFailed && { countsPublishFailed }),
    };
  }

  // Nothing arrived. A provider that answers 200 with no body, or a transport
  // that hands back an empty buffer, produces a completed report of zero bytes
  // — and registering that would put an empty object on the node and let the
  // generation reach its charge. Every one of these comes from a lane the
  // backend opened for bytes it expected to exist: a browser delivery is
  // stopped a step earlier, where the Worker refuses a final part carrying no
  // bytes (`packages/ingest/src/part-layout.ts`), and that refusal reaches the
  // node the ordinary way.
  if (sizeBytes === 0) {
    // No node is told: the lanes that can produce this open their grants
    // without one, and the worker settles its own task row off the refusal.
    await voidGrant(grant.storageKey);
    return { status: "rejected", reason: "empty" };
  }

  const kind = assetService.detectAssetKind(contentType);

  // Filed first, so the video row below is inserted already pointing at it.
  // The frame was cut in the media container while this request waited, so
  // there is nothing to wait for — and a video row that is readable before its
  // cover is linked is the window a dedup hit fell into (#187).
  const cover = await fileCover(report, grant);

  // The hash the Worker computed is the one the ledger keys on. The browser's
  // claim answered "have we got this already?" before a byte moved; only this
  // one names what is actually stored.
  const { asset, deduped, reclaimQueueFailed } = await assetService.register({
    ...(cover.id !== null && { coverAssetId: cover.id }),
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
    width: report.width ?? null,
    height: report.height ?? null,
    durationSeconds: report.durationSeconds ?? null,
    // Off the grant, because what this is was decided where the upload was
    // opened. The worker opens its own now (#181), and calling everything that
    // arrives here an upload would file a generation's output under the wrong
    // source and break the link between an asset and what it cost.
    source: grant.assetSource ?? "upload",
    ...(grant.generationTaskId !== null && {
      generationTaskId: grant.generationTaskId,
    }),
  });

  // The object this upload wrote is a duplicate of one the studio already
  // holds, and the row that would have had it collected could not be written.
  // Nothing else records that, so without this the extra object is simply lost
  // to whoever has to reclaim it.
  const reclaimUnrecorded = reclaimQueueFailed === true || cover.reclaimQueueFailed;

  // A row that already stood keeps the cover it already had; one that stood
  // without a cover takes this upload's, which is the only way a row
  // registered before there was a container to cut one ever gets a poster.
  // The frame this upload cut is registered either way, so the object is on
  // the reclaim job's list rather than lost (storage rule ①).
  const coverUrl = deduped ? await settleDedupedCover(asset, cover) : cover.url;

  // Whether the node history row is new. It gates the feed write below, which
  // has no key of its own. A retry does reach here — the grant is consumed at
  // the very end — and so does the video job, which writes the same two
  // downstreams; reading the flag keeps one rule instead of two.
  let historyIsNew = true;
  /** The history row this pass wrote or found, which the task row points at. */
  let historyEntryId: string | undefined;
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
      // The panel reads a video's preview off this row and nothing else, and
      // restoring an entry writes what it holds back onto the node — so an
      // entry with no thumbnail takes the node's cover away when restored.
      ...(coverUrl !== null && { thumbnailUrl: coverUrl }),
    });
    historyIsNew = recorded.inserted;
    historyEntryId = recorded.entry.id;
  }

  // The project feed. A byproduct — today a focus crop — is in the ledger for
  // attribution and dedup, and is not an event anyone watching the project
  // wants announced.
  let activityAppendFailed = false;
  if (historyIsNew && grant.projectId !== null && grant.derived !== true) {
    const appended = await appendProjectActivity({
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
    activityAppendFailed = !appended.ok;
  }

  const countsPublishFailed = await announceSuccess(
    grant,
    {
      fileUrl: asset.fileUrl,
      coverUrl,
      width: asset.width,
      height: asset.height,
      durationSeconds: asset.durationSeconds,
    },
    historyEntryId,
  );

  // Last, because the grant is what tells a repeat report from a first one: an
  // interruption anywhere above leaves it unconsumed, and the retry runs the
  // whole stretch again. Every step in it is safe to repeat — the ledger row
  // dedups onto itself, the history row is keyed, the feed row is gated on
  // that key, and the event is applied last-write-wins.
  // The answer is a CAS: false means another delivery of this same report got
  // there first, and both did the same work against one registered asset — so
  // the loser has nothing to undo and nothing to say.
  await consumeGrant({ storageKey: grant.storageKey, userId: grant.userId });
  return {
    status: "registered",
    assetId: asset.id,
    fileUrl: asset.fileUrl,
    kind: asset.kind,
    coverUrl,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    ...(countsPublishFailed && { countsPublishFailed }),
    ...(reclaimUnrecorded && { reclaimQueueFailed: reclaimUnrecorded }),
    ...(activityAppendFailed && { activityAppendFailed }),
    ...(cover.failed && { coverRegisterFailed: true }),
  };
}
