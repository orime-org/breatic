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
 *   - nothing landed at all  → void the grant, and tell the node it failed
 *     (zero bytes)              when the grant names one
 *   - any of those, on a key → replay the committed terminal using the fixed
 *     already terminal          registered asset identity or stored refusal
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
import { failureOutcome } from "@domain/node-task/failure-outcome.js";
import { uploadDeadline } from "@domain/asset/upload-deadline.js";
import { emitNodeTaskCounts } from "@domain/canvas-node/node-state-events.js";
import {
  getStorageAdapter,
  getStorageConfig,
  getStreamRedis,
  NotFoundError,
  reportCollaboratorFirstAction,
} from "@breatic/core";
import { canvasSpaceDocName, NO_CONSENT, t, uprightKeyFor } from "@breatic/shared";
import type { NodeTaskResult, StudioAssetEntity, UprightCopy } from "@breatic/shared";
import { appendProjectActivity } from "@domain/activity/project-activity.service.js";
import { scheduleAudioPeaks } from "@domain/asset/audio-peaks.service.js";
import * as uploadGrantRepo from "@domain/asset/upload-grant.repo.js";
import { referenceUploadAsset, settleUploadTerminal, type UploadTerminal } from "@domain/asset/upload-terminal.service.js";
import type {
  UploadGrant,
  FinalizeClaim,
} from "@domain/asset/upload-grant.repo.js";

const {
  findGrantByKey,
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
        /** The frame's own pixel size, which is not the video's. */
        width?: number | null;
        height?: number | null;
      } | null;
      /**
       * The upright copy of a picture with an EXIF orientation, written beside
       * the bytes as received (inner#1367). Present, it is what is filed;
       * `sha256` and `contentType` stay the received bytes'.
       */
      upright?: UprightCopy | null;
    }
  | {
      storageKey: string;
      outcome: "aborted";
      /**
       * Why, in a token the node's task list shows verbatim.
       *
       * Absent leaves `aborted`, which is what a caller that knows no more
       * than "the transfer did not finish" can truthfully say. Every lane that
       * reaches the Worker knows more than that: the refusal it names comes
       * back on the answer, and a caller dropping it tells a person their
       * transfer was interrupted when the bytes were read and turned down.
       */
      reason?: string;
    };

/**
 * The event name each side effect is written down under.
 *
 * The mapping lives beside the type rather than in each caller, because what
 * must not drift is which line names which failure: a caller that missed one
 * loses the only account of it, silently, with the types still green.
 *
 * Typed against the flags rather than left to infer, so a field added below
 * without a name here is a compile error instead of a failure nobody records.
 */
export const INGEST_SIDE_EFFECT_EVENTS: Record<
  keyof IngestSideEffects,
  string
> = {
  countsPublishFailed: "node_task_counts_publish_failed",
  reclaimQueueFailed: "ingest_report_reclaim_queue_failed",
  activityAppendFailed: "activity_record_failed",
  coverRegisterFailed: "ingest_cover_register_failed",
  peaksQueueFailed: "audio_peaks_queue_failed",
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
  /**
   * An audio row's peaks read could not be queued (inner#1305 §4.4). The audio
   * stands and plays; until the peaks backfill reaches it, its cut band draws
   * the browser's own decode within the waveform ceilings and stays plain past
   * them, and this line is what says so.
   */
  peaksQueueFailed?: boolean;
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
  /** What the ledger judged this file to be, off the bytes that landed. */
  mimeType: string | null;
  /** What the ledger counted the bytes at. */
  sizeBytes: number | null;
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
      /**
       * Whether the row is the one this upload wrote, rather than one the
       * studio already held the same bytes as (#299). Only an upload's own
       * row is read later.
       */
      ownRow: boolean;
    } & RegisteredMedia)
  | ({
      status: "already_registered";
      /** The fixed registered identity stored on this key's consumed grant. */
      assetId: string;
      fileUrl: string;
      kind: string;
      coverUrl: string | null;
      /** As on `registered`: whether the row found is the one this key wrote. */
      ownRow: boolean;
    } & RegisteredMedia)
  | { status: "rejected"; reason: "over_cap" | "empty" }
  | { status: "voided" }
  /** A transfer upload (inner#1006) finished: no row was written for it. */
  | { status: "transferred" }
  /**
   * The consumed grant's original asset is unavailable, or a transfer finish
   * has a grant that was already voided.
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
 * What the node is handed when an upload settles as done, read off the
 * registered row. Every field is spelled out, so a new way of settling has to
 * say what the node shows; the history row keeps the same object (#2184).
 * @param row - The registered row.
 * @param row.fileUrl - Its canonical URL.
 * @param row.width - Intrinsic pixel width, null when the medium has none.
 * @param row.height - Intrinsic pixel height, null when the medium has none.
 * @param row.durationSeconds - Playing time, null when the medium has none.
 * @param row.mimeType - What the ledger judged it to be off the bytes.
 * @param row.sizeBytes - What the ledger counted the bytes at.
 * @param coverUrl - The video's cover, once one is registered against the row.
 * @returns The result as the node and the history row hold it.
 */
function resultOf(
  row: Pick<StudioAssetEntity, "fileUrl" | "width" | "height" | "durationSeconds" | "mimeType" | "sizeBytes">,
  coverUrl: string | null,
): NodeTaskResult {
  return {
    content: row.fileUrl,
    coverUrl,
    width: row.width,
    height: row.height,
    duration: row.durationSeconds,
    mimeType: row.mimeType,
    size: row.sizeBytes,
  };
}

/**
 * Tell the node this upload succeeded, and hand it what to draw.
 * @param grant - The grant, which carries where the node lives.
 * @param result - What the node is handed.
 * @param nodeHistoryId - The history row holding the result, when one was
 *   written on this pass.
 * @returns Whether publishing the node's numbers failed.
 */
async function announceSuccess(
  grant: UploadGrant,
  result: NodeTaskResult,
  nodeHistoryId?: string,
): Promise<boolean> {
  if (!hasNode(grant)) return false;
  return settleUploadTask(grant, {
    outcome: "done",
    ...(nodeHistoryId !== undefined && { nodeHistoryId }),
    result,
  });
}

/**
 * Tell the node this upload failed.
 * @param grant - The grant, which carries where the node lives.
 * @param message - What the node shows.
 * @returns Whether publishing the node's numbers failed.
 */
async function announceFailure(grant: UploadGrant, message: string): Promise<boolean> {
  if (!hasNode(grant)) return false;
  return settleUploadTask(grant, { outcome: "failed", errorMessage: message });
}

/**
 * Whether a ledger row's key is one this upload wrote: the ticket's own, or
 * the upright copy beside it (inner#1367).
 * @param key - The row's key.
 * @param grant - The upload's grant.
 * @returns True for this upload's own row.
 */
function isOwnKey(key: string, grant: UploadGrant): boolean {
  return key === grant.storageKey || key === uprightKeyFor(grant.storageKey);
}

/**
 * What a completed upload is filed as: its upright copy when the Worker wrote
 * one, the bytes as received otherwise.
 * @param report - The completed report.
 * @param grant - The upload's grant.
 * @returns The key, size and pixel size to file.
 */
function filedObject(
  report: Extract<IngestReport, { outcome: "completed" }>,
  grant: UploadGrant,
): { storageKey: string; sizeBytes: number; width: number | null; height: number | null } {
  if (report.upright !== undefined && report.upright !== null) {
    return {
      storageKey: uprightKeyFor(grant.storageKey),
      sizeBytes: report.upright.sizeBytes,
      width: report.upright.width,
      height: report.upright.height,
    };
  }
  return {
    storageKey: grant.storageKey,
    sizeBytes: report.sizeBytes,
    width: report.width ?? null,
    height: report.height ?? null,
  };
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
  // finish included — the queue runs a finish again when a try failed or its
  // worker went away, and that repeat is the whole recovery for a result that
  // never reached the node. A row that settled some OTHER way leaves the node's content alone:
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
      originStorageKey: grant.storageKey,
      ownerStudioId: grant.studioId,
      actingUserId: grant.userId,
      contentHash: cover.sha256,
      storageKey: cover.storageKey,
      fileUrl: adapter.publicUrl(cover.storageKey),
      sizeBytes: cover.sizeBytes,
      mimeType: cover.contentType,
      kind: assetService.detectAssetKind(cover.contentType),
      source: "cover",
      // The frame's own size, read off the PNG at the edge. It is not the
      // video's: the cut is capped on the way out of ffmpeg, so anything shot
      // larger comes back smaller, and this row is about the frame.
      width: cover.width ?? null,
      height: cover.height ?? null,
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
 * upload as failed — and the caller hears about it through the same flag that
 * already carries a cover that could not be filed.
 * @param video - The row this upload resolved to.
 * @param filed - The cover this upload filed, when it filed one.
 * @param filed.id - Its ledger row.
 * @param filed.url - Where it is readable, which is what the node shows once
 *   the video points at it.
 * @returns The URL the node should show, and whether pointing at it failed.
 */
export async function settleDedupedCover(
  video: StudioAssetEntity,
  filed: { id: string | null; url: string | null },
): Promise<{ url: string | null; failed: boolean }> {
  try {
    const standing = await assetRepo.findCoverOf(video.id);
    if (standing !== null) return { url: standing.fileUrl, failed: false };
    if (filed.id === null) return { url: null, failed: false };
    await assetRepo.setCoverAsset(video.id, filed.id);
    return { url: filed.url, failed: false };
  } catch {
    return { url: null, failed: true };
  }
}

/**
 * Write or recover the keyed history that a registered upload owes its node.
 * @param grant - The immutable upload scope and attribution.
 * @param asset - The canonical registered media.
 * @param coverUrl - The current registered video cover.
 * @param metadata - The original measured file metadata, on first completion.
 * @param metadata.size - The byte size the ingest Worker measured.
 * @param metadata.mimeType - The content type the ingest Worker identified.
 * @returns The stable history identity and whether this call inserted it.
 * @throws {Error} When the history cannot be accepted.
 */
async function recordRegisteredUploadHistory(
  grant: UploadGrant,
  asset: StudioAssetEntity,
  coverUrl: string | null,
  metadata?: { size: number; mimeType: string },
): Promise<{ entryId?: string; inserted: boolean }> {
  if (grant.nodeId === null || grant.projectId === null) return { inserted: true };
  const recorded = await nodeHistoryService.recordUpload({
    projectId: grant.projectId,
    nodeId: grant.nodeId,
    userId: grant.userId,
    content: asset.fileUrl,
    storageKey: grant.storageKey,
    metadata: {
      ...(grant.filename !== null && { filename: grant.filename }),
      ...(asset.sizeBytes !== null && { size: asset.sizeBytes }),
      ...(asset.mimeType !== null && { mimeType: asset.mimeType }),
      ...metadata,
      ...(grant.source === "mini_tool" && grant.toolName !== null && { toolId: grant.toolName }),
    },
    ...(coverUrl !== null && { thumbnailUrl: coverUrl }),
    media: resultOf(asset, coverUrl),
  });
  return { entryId: recorded.entry.id, inserted: recorded.inserted };
}

/**
 * Publish and answer exclusively from the committed upload terminal.
 * @param terminal - The result of serialized database arbitration.
 * @param sideEffects - Best-effort work whose failures the caller must log.
 * @returns The same canonical result for completions and their later replays.
 * @throws {Error} When history recovery or success publication cannot finish.
 */
async function announceUploadTerminal(terminal: UploadTerminal, sideEffects: IngestSideEffects = {}): Promise<IngestReportOutcome> {
  const { grant } = terminal;
  if (terminal.state === "void") {
    const reason = grant.failureReason ?? "aborted";
    const countsPublishFailed = await announceFailure(grant, reason);
    const refusal: IngestReportOutcome = reason === "empty" || reason === "over_cap"
      ? { status: "rejected", reason }
      : { status: "voided" };
    return { ...refusal, ...sideEffects, ...(countsPublishFailed && { countsPublishFailed }) };
  }
  const asset = grant.assetId === null ? null : await assetRepo.findLiveInStudio(grant.studioId, grant.assetId);
  if (asset === null) return { status: "stale", ...sideEffects };
  const cover = asset.kind === "video" ? await assetRepo.findCoverOf(asset.id) : null;
  const coverUrl = cover?.fileUrl ?? null;
  const history = await recordRegisteredUploadHistory(grant, asset, coverUrl);
  const countsPublishFailed = await announceSuccess(grant, resultOf(asset, coverUrl), history.entryId);
  return withPeaksQueued({
    status: terminal.newlyConsumed ? "registered" : "already_registered",
    assetId: asset.id,
    fileUrl: asset.fileUrl,
    kind: asset.kind,
    ownRow: isOwnKey(asset.storageKey, grant),
    coverUrl,
    width: asset.width,
    height: asset.height,
    durationSeconds: asset.durationSeconds,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    ...sideEffects,
    ...(countsPublishFailed && { countsPublishFailed }),
  });
}

/**
 * Apply one report from the ingest Worker.
 * @param report - What happened to this upload.
 * @returns What was decided, for the route to answer with.
 * @throws {NotFoundError} When the key names no grant we ever issued.
 * @throws {Error} When registration, association, terminal commitment or success publication fails.
 */
export async function applyIngestReport(
  report: IngestReport,
): Promise<IngestReportOutcome> {
  const grant = await findGrantByKey(report.storageKey);
  if (grant === null) throw new NotFoundError(t("server.error.not_found"));

  if (grant.consumedAt !== null || grant.voidedAt !== null) {
    return announceUploadTerminal(await settleUploadTerminal(grant.storageKey, { kind: "replay" }));
  }
  if (report.outcome === "aborted") {
    const expired = failureOutcome(await uploadDeadline(grant)) === "expired";
    const reason = expired ? "expired" : (report.reason ?? "aborted");
    return announceUploadTerminal(await settleUploadTerminal(grant.storageKey, { kind: "failed", reason }));
  }

  // A transfer (inner#1006) never becomes a row: its own finish settles it,
  // so a completed report for one has nothing to register.
  if (grant.assetSource === "transfer") return { status: "stale" };

  const adapter = await getStorageAdapter();
  const contentType = report.contentType;

  // The declared size got the ticket issued; this is the first time anyone has
  // measured what actually arrived. The object is already in storage, so this
  // refusal leaves it there and lets the voided grant name it as an orphan.
  const { upload } = getStorageConfig();
  const sizeBytes = report.sizeBytes;
  if (sizeBytes > upload.max_upload_bytes) {
    return announceUploadTerminal(await settleUploadTerminal(grant.storageKey, { kind: "failed", reason: "over_cap" }));
  }

  // Nothing arrived. A provider that answers 200 with no body, or a transport
  // that hands back an empty buffer, produces a completed report of zero bytes
  // — and registering that would put an empty object on the node and let the
  // generation reach its charge. Every one of these is either an address that
  // answered with nothing in it, or a backend upload opened for bytes it
  // expected to exist. A browser delivery is stopped a step
  // earlier, where the Worker refuses a final part carrying no bytes
  // (`packages/ingest/src/part-layout.ts`), and that refusal reaches the node
  // the ordinary way.
  if (sizeBytes === 0) {
    return announceUploadTerminal(await settleUploadTerminal(grant.storageKey, { kind: "failed", reason: "empty" }));
  }

  const kind = assetService.detectAssetKind(contentType);
  // A picture turned upright is filed as its upright copy (inner#1367 §4.5).
  // The key is derived from the ticket's rather than read off the answer, so
  // the copy can only ever be the one this upload wrote.
  const filed = filedObject(report, grant);

  // Filed first, so the video row below is inserted already pointing at it.
  // The frame was cut in the media container while this request waited, so
  // there is nothing to wait for — and a video row that is readable before its
  // cover is linked is the window a dedup hit fell into (#187).
  const cover = await fileCover(report, grant);

  // The hash the Worker computed is the one the ledger keys on. The browser's
  // claim answered "have we got this already?" before a byte moved; only this
  // one names what is actually stored.
  const { asset, deduped, reclaimQueueFailed } = await assetService.register({
      originStorageKey: grant.storageKey,
    ...(cover.id !== null && { coverAssetId: cover.id }),
    ownerStudioId: grant.studioId,
    actingUserId: grant.userId,
    contentHash: report.sha256,
    storageKey: filed.storageKey,
    fileUrl: adapter.publicUrl(filed.storageKey),
    sizeBytes: filed.sizeBytes,
    mimeType: contentType,
    kind,
    width: filed.width,
    height: filed.height,
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
  const settled = deduped ? await settleDedupedCover(asset, cover) : null;
  const coverUrl = settled === null ? cover.url : settled.url;
  await referenceUploadAsset(grant, asset.id);
  const history = await recordRegisteredUploadHistory(grant, asset, coverUrl, {
    size: filed.sizeBytes,
    mimeType: contentType,
  });
  const historyIsNew = history.inserted;

  // The project feed. A byproduct — today a focus crop — is in the ledger for
  // attribution and dedup, and is not an event anyone watching the project
  // wants announced.
  let activityAppendFailed = false;
  if (historyIsNew && grant.projectId !== null && grant.derived !== true) {
    const type = grant.source === "mini_tool" ? "generation:succeeded" : "asset:uploaded";
    const appended = await appendProjectActivity({
      projectId: grant.projectId,
      actorUserId: grant.userId,
      type,
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
    if (appended.ok) {
      await reportCollaboratorFirstAction(
        { projectId: grant.projectId, userId: grant.userId, action: type === "asset:uploaded" ? "asset" : "generation" },
        grant.analyticsConsent ?? NO_CONSENT,
      );
    }
  }

  const terminal = await settleUploadTerminal(grant.storageKey, { kind: "completed", assetId: asset.id });
  return announceUploadTerminal(terminal, {
    ...(reclaimUnrecorded && { reclaimQueueFailed: reclaimUnrecorded }),
    ...(activityAppendFailed && { activityAppendFailed }),
    ...((cover.failed || settled?.failed === true) && { coverRegisterFailed: true }),
  });
}

/**
 * Queue the peaks read of a registered audio row, as the last step of
 * registering it (inner#1305 §4.4).
 *
 * Every lane that registers bytes returns through here, so none of them can
 * leave its audio without a job. The row stands either way; a job that could
 * not be queued is a flag for the caller to write down.
 * @param outcome - What registration answered.
 * @returns The same outcome, flagged when its job could not be queued.
 */
async function withPeaksQueued(outcome: IngestReportOutcome): Promise<IngestReportOutcome> {
  const queued = await scheduleAudioPeaks(outcome).then(
    () => true,
    () => false,
  );
  return queued ? outcome : { ...outcome, peaksQueueFailed: true };
}
