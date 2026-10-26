// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending what the backend produced to R2 (#181, lanes ② and ③).
 *
 * A generation leaves its output in one of two places: in our own process, as
 * a buffer a synchronous transport answered with or ffmpeg wrote, or behind a
 * temporary link the provider handed back. Both end up in R2 the same way the
 * browser's files do — through the ingest Worker, which hashes what actually
 * landed — because the hash is what the ledger keys on and a second way of
 * computing it is a second answer to the same question.
 *
 * Neither lane pre-checks for a duplicate. The browser computes a hash before
 * it uploads because doing so can save the upload entirely; here the bytes are
 * already at hand or already remote, so a local hash would buy nothing and
 * dedup happens where it always does — when the asset is registered, with the
 * loser's key queued for offline reclaim.
 *
 * The grant is what carries everything the report handler will need. Neither
 * lane names a node: the worker settles its own task row and writes its own
 * history, and a grant naming a node would have the report handler do both a
 * second time.
 */

import { budgetDeadlineFrom, env, getStorageConfig, idleSocketDispatcher } from "@breatic/core";
import {
  fetchUrlToIngest,
  finishUploadAtIngest,
  INGEST_NO_ANSWER,
  INGEST_TYPE_NOT_REPORTED,
  sendBytesToIngest,
  assertBeforeDeadline,
  type StudioAssetEntity,
} from "@breatic/shared";
import { issueUploadGrant } from "@domain/asset/upload-grant.service.js";
import { ingestRunFor } from "@domain/asset/asset.service.js";
import {
  openSignedUpload,
  signTicketFor,
  type UploadTicketRequest,
} from "@domain/asset/upload-ticket.service.js";
import { extFromUrl } from "@domain/asset/source-url.js";
import { ingestFailureReason } from "@domain/asset/ingest-failure-reason.js";
import { storedTypeOf, TYPE_UNKNOWN } from "@domain/asset/reader-source.js";
import {
  applyIngestReport,
  INGEST_SIDE_EFFECT_EVENTS,
  type IngestReportOutcome,
  type IngestSideEffects,
} from "@domain/asset/ingest-report.service.js";

/**
 * A backend upload that reached the ledger.
 *
 * A backend lane has no node listening: whatever it stored is what a node
 * will point at, so an answer without a url is the upload having failed.
 */
export type StoredAsset = {
  /** The ledger row these bytes landed on. */
  assetId: string;
  /** Where the stored object is readable. */
  fileUrl: string;
  /** The kind the server filed it under. */
  kind: string;
  /**
   * The cover filed against this row, for a video. A backend lane has no node
   * to hear it through, so this is where it reads one.
   */
  coverUrl: string | null;
  /**
   * What the media container measured. A backend lane has no node listening,
   * so this is where whatever it puts on one reads them.
   */
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  /**
   * What the ledger judged this file to be, and counted its bytes at. The
   * canvas gates Understand on both, so a node a backend lane puts content on
   * needs them for the same reason it needs the numbers above.
   */
  mimeType: string | null;
  sizeBytes: number | null;
} & IngestSideEffects;

/**
 * Read a registration as a stored asset, or fail the upload.
 *
 * Only the two outcomes that name a row can be one. Everything else — a
 * refusal, a void, a report that lost its race — leaves a backend lane with
 * nothing to put on a node, which is the upload having failed.
 * @param outcome - What registering these bytes decided.
 * @param what - Names the upload in the error.
 * @returns The stored row, and whatever the caller has to write down.
 * @throws {Error} When nothing was registered.
 */
function landed(outcome: IngestReportOutcome, what: string): StoredAsset {
  if (
    outcome.status !== "registered" &&
    outcome.status !== "already_registered"
  ) {
    throw new Error(`${what} came back with no url`);
  }
  return {
    assetId: outcome.assetId,
    fileUrl: outcome.fileUrl,
    kind: outcome.kind,
    coverUrl: outcome.coverUrl,
    width: outcome.width,
    height: outcome.height,
    durationSeconds: outcome.durationSeconds,
    mimeType: outcome.mimeType,
    sizeBytes: outcome.sizeBytes,
    ...sideEffectsOf(outcome),
  };
}

/**
 * Every side-effect flag registration raised, read off the list that names
 * them all, so a flag added there reaches the backend callers that log it.
 * @param outcome - What registration answered.
 * @returns The flags that are set.
 */
function sideEffectsOf(outcome: IngestSideEffects): IngestSideEffects {
  const raised: IngestSideEffects = {};
  for (const flag of Object.keys(INGEST_SIDE_EFFECT_EVENTS) as (keyof IngestSideEffects)[]) {
    if (outcome[flag] === true) raised[flag] = true;
  }
  return raised;
}

/** What every backend upload has to say about itself. */
export interface BackendUploadContext {
  /** Project the output belongs to; it decides the owner studio. */
  projectId: string;
  /** Who this is attributed to. */
  actingUserId: string;
  /** What the resulting asset is: a generation's output, a video's cover, or a link the agent saved. */
  assetSource: Extract<StudioAssetEntity["source"], "ai" | "cover" | "agent">;
  /** The generation that produced these bytes, when one did. */
  generationTaskId?: string;
  /** The key's task segment, which also decides its extension. */
  taskType: string;
  /** The dotted extension the object is stored under. */
  ext: string;
  /** What the object is served as. */
  contentType: string;
  /**
   * When the task these bytes belong to runs out, in epoch ms (inner#1367).
   * Every call of the upload is bounded by it and by nothing of its own.
   */
  deadlineAt: number;
}

/**
 * Issue the grant for something the backend produced, and say what its ticket
 * is signed from.
 *
 * `derived` is set on the grant so the report handler writes no activity row:
 * the worker announces the generation itself, and a second row would report
 * one act twice.
 * @param ctx - What this upload is and who it belongs to.
 * @param declaredSize - The byte size, when it is known; the ceiling on the
 *   number of parts otherwise.
 * @param typeFromSource - Whether the Worker takes the type off the source
 *   rather than storing what the ticket signs; set for a link nobody here has
 *   seen into.
 * @returns The key this upload writes to and what its ticket is signed from.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 */
async function grantBackendUpload(
  ctx: BackendUploadContext,
  declaredSize: number,
  typeFromSource = false,
): Promise<{ storageKey: string; request: UploadTicketRequest }> {
  const { ingest } = getStorageConfig();
  const expiresAt = Date.now() + ingest.ticket_expires_seconds * 1000;
  const { key, studioId } = await issueUploadGrant({
    projectId: ctx.projectId,
    actingUserId: ctx.actingUserId,
    declaredSize,
    taskType: ctx.taskType,
    ext: ctx.ext,
    expiresAt: new Date(expiresAt),
    context: {
      assetSource: ctx.assetSource,
      ...(ctx.generationTaskId !== undefined && {
        generationTaskId: ctx.generationTaskId,
      }),
      derived: true,
    },
  });

  return {
    storageKey: key,
    request: {
      storageKey: key,
      studioId,
      userId: ctx.actingUserId,
      declaredSize,
      contentType: ctx.contentType,
      ...(typeFromSource && { typeFromSource: true }),
      expiresAt,
      deadlineAt: ctx.deadlineAt,
    },
  };
}

/**
 * Send bytes we are holding to R2 through the ingest Worker (lane ②).
 *
 * A `Blob` rather than a buffer, so a caller whose bytes are on disk can hand
 * over a file-backed one and have each part read as it is sent; callers already
 * holding the bytes wrap them at their own call site, where that copy was
 * going to happen anyway.
 * @param bytes - What to store.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset, as the report handler filed it.
 * @throws {DeadlinePassed} When the task's deadline has already come.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadOpenFailed} When the upload could not be opened; the grant is
 *   already settled as aborted.
 * @throws {UploadHttpError} When the Worker refuses a part or the finish.
 * @throws {Error} When the report filed nothing.
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function uploadBytesToStorage(
  bytes: Blob,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  assertBeforeDeadline(ctx.deadlineAt);
  // A part is cut once its bytes stop moving for the idle window, which Node
  // reads off the socket.
  const uploadIdleTimeoutMs = getStorageConfig().upload.upload_idle_timeout_seconds * 1000;
  const { storageKey, request } = await grantBackendUpload(ctx, bytes.size);
  const opened = await openSignedUpload(request);
  const held = await sendBytesToIngest(
    bytes,
    { ...opened, dispatcher: idleSocketDispatcher(uploadIdleTimeoutMs) },
    { uploadIdleTimeoutMs },
    undefined,
    ctx.deadlineAt,
  );
  const measured = await finishUploadAtIngest(
    opened.uploadUrl,
    held,
    env.INGEST_SHARED_SECRET,
    ingestRunFor(storageKey, ctx.deadlineAt),
  );
  return landed(
    await applyIngestReport({
      storageKey,
      outcome: "completed",
      ...measured,
    }),
    `the upload for project ${ctx.projectId}`,
  );
}

/**
 * Have the Worker pull a provider's URL into R2 (lane ③).
 *
 * The bytes never reach this process. What is declared as the size is the cap
 * an upload is allowed to reach, since a link says nothing about its length,
 * and it becomes the part ceiling the Worker holds the transfer to.
 * @param sourceUrl - The provider's temporary link.
 * @param ctx - What this upload is and who it belongs to.
 * @returns The registered asset, as the report handler filed it.
 * @throws {DeadlinePassed} When the task's deadline has already come.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {UploadHttpError} When the Worker could not store the source.
 * @throws {Error} When the report filed nothing.
 * @throws {unknown} The transport's own failure when nothing answered.
 */
export async function transferUrlToStorage(
  sourceUrl: string,
  ctx: BackendUploadContext,
): Promise<StoredAsset> {
  assertBeforeDeadline(ctx.deadlineAt);
  const { upload } = getStorageConfig();
  const granted = await grantBackendUpload(ctx, upload.max_upload_bytes);
  const measured = await fetchUrlToIngest(
    sourceUrl,
    await signTicketFor(granted.request),
    env.INGEST_SHARED_SECRET,
    ingestRunFor(granted.storageKey, ctx.deadlineAt),
  );
  return landed(
    await applyIngestReport({
      storageKey: granted.storageKey,
      outcome: "completed",
      ...measured,
    }),
    `the transfer of ${sourceUrl}`,
  );
}

/** Why a reader's link did not land: the reason the grant was settled with. */
export class ReaderUrlTransferError extends Error {
  /**
   * A refusal carrying the reason its grant was settled with.
   * @param reason - The failure reason the grant was settled with, one the
   *   Worker named or one of the ingest failure sentinels.
   * @param reported - The type the Worker reported, when that is what was refused.
   * @throws {never} Never.
   */
  constructor(
    readonly reason: string,
    readonly reported?: string,
  ) {
    super(`the link did not land: ${reason}`);
    this.name = "ReaderUrlTransferError";
  }
}

/**
 * Have the Worker pull a link somebody other than a provider handed over into
 * R2, and wait for it (inner#1315: the agent's save).
 *
 * The canvas paste takes the same link through a queue because a node waits
 * on it; the agent asks for the answer inside its turn, so this runs in the
 * request. Nobody here knows what the link holds, so the ticket lets the
 * Worker take the type off the source, and what is registered is the type it
 * judged. A transfer that does not land settles its grant before it is
 * reported, the way the queued lane settles its task.
 * @param sourceUrl - The link, already checked against `readerUrlSchema`.
 * @param who - The project the bytes are charged to, and who asked.
 * @param who.projectId - The project; it decides the owner studio.
 * @param who.actingUserId - Who the asset is attributed to.
 * @param signal - Raised when nobody wants the answer any more.
 * @returns The registered asset, as the report handler filed it, with the key
 *   it was stored under for the caller's log lines.
 * @throws {NotFoundError} When the project does not exist or is soft-deleted.
 * @throws {ReaderUrlTransferError} When the link did not land, with the reason
 *   its grant was settled with.
 * @throws {Error} When the report filed nothing.
 */
export async function transferReaderUrlToStorage(
  sourceUrl: string,
  who: { projectId: string; actingUserId: string },
  signal?: AbortSignal,
): Promise<StoredAsset & { storageKey: string }> {
  const { upload } = getStorageConfig();
  // The grant this opens runs out where any upload's does: two hours on.
  const deadlineAt = budgetDeadlineFrom(Date.now());
  const granted = await grantBackendUpload(
    {
      ...who,
      assetSource: "agent",
      taskType: "url",
      ext: extFromUrl(sourceUrl),
      contentType: TYPE_UNKNOWN,
      deadlineAt,
    },
    upload.max_upload_bytes,
    true,
  );

  const target = await signTicketFor(granted.request);
  const pulled = await pullReaderLink(granted.storageKey, target, sourceUrl, deadlineAt, signal);
  if (pulled.status === "failed") throw new ReaderUrlTransferError(pulled.reason, pulled.reported);
  // A rejected report turned down what the link sent (nothing, or too much):
  // the same link gets the same answer again.
  if (pulled.outcome.status === "rejected") throw new ReaderUrlTransferError(pulled.outcome.reason);
  const stored = landed(pulled.outcome, `the transfer of ${sourceUrl}`);
  return { ...stored, storageKey: granted.storageKey };
}

/**
 * Settle a grant whose transfer did not land, keeping why it did not land
 * when settling fails too.
 * @param storageKey - The key the grant was opened on.
 * @param reason - Why the transfer did not land.
 * @param cause - What the transfer threw, or what it was refused over.
 * @returns What settling decided.
 * @throws {AggregateError} When settling fails, carrying the transfer's cause and the settling error.
 */
async function settleAborted(storageKey: string, reason: string, cause: unknown): Promise<IngestReportOutcome> {
  try {
    return await applyIngestReport({ storageKey, outcome: "aborted", reason });
  } catch (settleErr) {
    throw new AggregateError([cause, settleErr], `settling the grant for ${storageKey} failed after the link did not land: ${reason}`);
  }
}

/** How pulling a reader's link ended: settled before any bytes were judged, or reported. */
export type ReaderLinkPull =
  | {
      status: "failed";
      /** The reason the grant was settled with. */
      reason: string;
      /** What settling it decided. */
      settled: IngestReportOutcome;
      /** What the transfer threw, when it threw. */
      err?: unknown;
      /** The type the Worker reported, when that is what was refused. */
      reported?: string;
    }
  | { status: "reported"; outcome: IngestReportOutcome };

/**
 * Have the Worker pull a reader's link into the object a ticket names, and
 * file what came of it: the one flow both lanes for a reader's link run (the
 * canvas paste through the worker's queue, the agent's save in its request).
 * Either way the grant ends settled; what each lane says about it is its own.
 * @param storageKey - The key the grant was opened on.
 * @param target - The signed ticket.
 * @param url - The link.
 * @param deadlineAt - When the upload's task runs out; the transfer and the
 *   wait for it end there.
 * @param signal - Raised when nobody wants the answer any more.
 * @returns How it ended.
 * @throws {AggregateError} When settling a grant whose transfer did not land
 *   fails, carrying why it did not land and the settling error.
 * @throws {Error} When filing a landed outcome fails.
 */
export async function pullReaderLink(
  storageKey: string,
  target: Parameters<typeof fetchUrlToIngest>[1],
  url: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<ReaderLinkPull> {
  let measured;
  try {
    measured = await fetchUrlToIngest(
      url,
      target,
      env.INGEST_SHARED_SECRET,
      ingestRunFor(storageKey, deadlineAt),
      signal,
    );
  } catch (err) {
    // No answer is ours, not the link's: the Worker or the line to it going
    // away, or the caller stopping the transfer (a cut at the deadline
    // settles as expired).
    const reason = ingestFailureReason(err, INGEST_NO_ANSWER);
    const settled = await settleAborted(storageKey, reason, err);
    return { status: "failed", reason, settled, err };
  }

  const storedType = storedTypeOf(measured.contentType);
  if (storedType === null) {
    const settled = await settleAborted(storageKey, INGEST_TYPE_NOT_REPORTED, `the Worker reported ${measured.contentType}`);
    return { status: "failed", reason: INGEST_TYPE_NOT_REPORTED, settled, reported: measured.contentType };
  }

  const outcome = await applyIngestReport({ storageKey, outcome: "completed", ...measured, contentType: storedType });
  return { status: "reported", outcome };
}
