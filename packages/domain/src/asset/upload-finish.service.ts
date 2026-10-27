// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing a browser upload (inner#1367 §4.2a).
 *
 * The route takes the permission to finish and queues this; the browser hears
 * 202 and learns the ending from the upload status query. Finishing runs as a
 * job because it lasts as long as the Worker takes to assemble, hash and read
 * the object, which is bounded by the upload's two hours and nothing shorter.
 */

import { env } from "@breatic/core";
import {
  finishUploadAtIngest,
  TRANSFER_MEDIA_TYPE,
  type IngestMeasurements,
  type PartReceipt,
} from "@breatic/shared";
import * as ingestReportService from "@domain/asset/ingest-report.service.js";
import { ingestFailureReason } from "@domain/asset/ingest-failure-reason.js";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";
import { ingestRunFor } from "@domain/asset/asset.service.js";
import * as mediaReadService from "@domain/asset/media-read.service.js";
import { uploadDeadlineByKey } from "@domain/asset/upload-deadline.js";
import {
  completeTransferGrant,
  findGrantByKey,
  type GrantAssetSource,
} from "@domain/asset/upload-grant.repo.js";

/** The queue finishing jobs run on. */
export const UPLOAD_FINISH_QUEUE = "upload-finish";

/** What the route queues for one upload, all of it read off the signed token. */
export interface UploadFinishJob {
  storageKey: string;
  uploadId: string;
  /** The session token, which the Worker checks again before it assembles. */
  token: string;
  parts: PartReceipt[];
  /** What the grant says the upload is, from the permission to finish. */
  assetSource: GrantAssetSource | null;
}

/** How one finish ended, for the job to log. */
export interface UploadFinishResult {
  /** What registration, or the abort that settled the grant, answered. */
  outcome: IngestReportOutcome;
  /** Set when the upload was settled as aborted, with the reason recorded. */
  refused?: {
    reason: string;
    /** The error the Worker call ended in, when it ended in one. */
    cause?: unknown;
    /** The type the bytes turned out to be, when that was the refusal. */
    contentType?: string;
  };
  /** Set when the row stands but its media read could not be queued. */
  mediaReadNotQueued?: unknown;
}

/**
 * Settle the grant and the task row as aborted.
 * @param storageKey - The upload's key.
 * @param reason - What the grant and the row record.
 * @param extra - The cause or the refused type, for the log.
 * @param extra.cause - The error the Worker call ended in.
 * @param extra.contentType - The type the bytes turned out to be.
 * @returns The committed result, naming a refusal only when it did not recover success.
 * @throws {Error} When the committed terminal cannot be recovered or published.
 */
async function refuse(
  storageKey: string,
  reason: string,
  extra: { cause?: unknown; contentType?: string } = {},
): Promise<UploadFinishResult> {
  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "aborted",
    reason,
  });
  if (outcome.status === "registered" || outcome.status === "already_registered") return { outcome };
  return { outcome, refused: { reason, ...extra } };
}

/**
 * Queue media reads for a canonical result, including a recovered completion.
 * @param result - The outcome selected by the committed upload terminal.
 * @param assetSource - The grant's attribution controlling deferred media reads.
 * @returns The result with any media-read queue failure preserved for logging.
 * @throws {never} Never.
 */
async function finishResult(result: UploadFinishResult, assetSource: GrantAssetSource | null): Promise<UploadFinishResult> {
  if (assetSource === "transfer") return result;
  try {
    await mediaReadService.scheduleMediaRead(result.outcome, assetSource);
  } catch (err) {
    return { ...result, mediaReadNotQueued: err };
  }
  return result;
}

/**
 * Settle a transfer upload (inner#1006) once the Worker has stored it: no
 * asset row, no media read, no activity. The grant is marked complete so the
 * request it carries may be referenced once.
 * @param storageKey - The transfer's key.
 * @param answered - What the Worker measured over the stored object.
 * @returns How it ended.
 * @throws {Error} When the ledger cannot be read or written.
 */
async function finishTransfer(
  storageKey: string,
  answered: IngestMeasurements,
): Promise<UploadFinishResult> {
  if (answered.contentType !== TRANSFER_MEDIA_TYPE) {
    return refuse(storageKey, "unsupported_type");
  }
  // The grant cannot be missing here, since finishing claimed it; read as
  // nothing declared, a missing one ends where registration's own check does.
  const declared = (await findGrantByKey(storageKey))?.declaredSize ?? 0;
  if (answered.sizeBytes > declared) return refuse(storageKey, "too_large");
  // False only for a grant voided first, whose ending stands.
  const completed = await completeTransferGrant(storageKey);
  return { outcome: { status: completed ? "transferred" : "stale" } };
}

/**
 * Have the Worker finish the upload, then register what it stored.
 *
 * Safe to run again: the Worker answers a repeat of the same upload id from
 * the object it already assembled, and registration answers a registered
 * grant as `already_registered`.
 * @param job - What the route queued.
 * @returns How it ended.
 * @throws {Error} When the ledger cannot be read or written, so the queue
 *   tries again.
 */
export async function finishUpload(job: UploadFinishJob): Promise<UploadFinishResult> {
  const { storageKey, assetSource } = job;
  const deadlineAt = await uploadDeadlineByKey(storageKey);

  // A transfer has no media to read, so it is never asked whether to.
  const deferMediaRead =
    assetSource === "transfer" ? true : !mediaReadService.readsMediaAtFinish(assetSource);
  let answered: IngestMeasurements;
  try {
    answered = await finishUploadAtIngest(
      env.INGEST_BASE_URL,
      { uploadId: job.uploadId, token: job.token, parts: job.parts },
      env.INGEST_SHARED_SECRET,
      {
        // The cover key is named unconditionally: which media have a frame to
        // lift is decided from the type, and the type is the edge's to read
        // off the bytes. It is derived from the object's own key, so a repeat
        // names the same place.
        ...ingestRunFor(storageKey, deadlineAt),
        deferMediaRead,
      },
    );
  } catch (err) {
    // Nothing arriving at all reads "interrupted": the bytes came off a disk
    // the person picked from, so the reasons that speak of a source and its
    // address would describe something this upload never had.
    const reason = ingestFailureReason(err, "aborted");
    return finishResult(await refuse(storageKey, reason, { cause: err }), job.assetSource);
  }

  if (assetSource === "transfer") return finishTransfer(storageKey, answered);

  // The ticket named a picture; this is what the bytes that landed are. A
  // cover or an avatar that turns out to be anything else is refused the way
  // a format we do not take is, before a row is written for it.
  if (!mediaReadService.storedTypeAccepted(assetSource, answered.contentType)) {
    return finishResult(await refuse(storageKey, "unsupported_type", { contentType: answered.contentType }), assetSource);
  }

  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "completed",
    ...answered,
  });

  return finishResult({ outcome }, assetSource);
}
