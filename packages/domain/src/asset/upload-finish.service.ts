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

import { coverKeyFor, env } from "@breatic/core";
import {
  finishUploadAtIngest,
  INGEST_REFUSED_UNNAMED,
  UploadHttpError,
  type PartReceipt,
  type StudioAssetEntity,
} from "@breatic/shared";
import * as ingestReportService from "@domain/asset/ingest-report.service.js";
import type { IngestReportOutcome } from "@domain/asset/ingest-report.service.js";
import { mediaLimits } from "@domain/asset/asset.service.js";
import * as mediaReadService from "@domain/asset/media-read.service.js";
import { uploadDeadlineByKey } from "@domain/asset/upload-deadline.js";

/** The queue finishing jobs run on. */
export const UPLOAD_FINISH_QUEUE = "upload-finish";

/** What the route queues for one upload, all of it read off the signed token. */
export interface UploadFinishJob {
  storageKey: string;
  uploadId: string;
  /** The session token, which the Worker checks again before it assembles. */
  token: string;
  parts: PartReceipt[];
  /** What the grant says the asset is, from the permission to finish. */
  assetSource: StudioAssetEntity["source"] | null;
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
 * @returns The result naming the refusal.
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
  return { outcome, refused: { reason, ...extra } };
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
  const { storageKey } = job;
  const deadlineAt = await uploadDeadlineByKey(storageKey);

  let answered;
  try {
    answered = await finishUploadAtIngest(
      env.INGEST_BASE_URL,
      { uploadId: job.uploadId, token: job.token, parts: job.parts },
      env.INGEST_SHARED_SECRET,
      {
        // Named unconditionally: which media have a frame to lift is decided
        // from the type, and the type is the edge's to read off the bytes. The
        // key is derived from the object's own, so a repeat names the same
        // place.
        coverKey: coverKeyFor(storageKey),
        deadlineAt,
        limits: mediaLimits(),
        deferMediaRead: !mediaReadService.readsMediaAtFinish(job.assetSource),
      },
    );
  } catch (err) {
    // An UploadHttpError exists only because an answer arrived, so a missing
    // name on it is the Worker refusing without saying why. Nothing arriving
    // at all reads "interrupted": the bytes came off a disk the person picked
    // from, so the reasons that speak of a source and its address would
    // describe something this upload never had.
    const reason =
      err instanceof UploadHttpError ? (err.code ?? INGEST_REFUSED_UNNAMED) : "aborted";
    return refuse(storageKey, reason, { cause: err });
  }

  // The ticket named a picture; this is what the bytes that landed are. A
  // cover or an avatar that turns out to be anything else is refused the way
  // a format we do not take is, before a row is written for it.
  if (!mediaReadService.storedTypeAccepted(job.assetSource, answered.contentType)) {
    return refuse(storageKey, "unsupported_type", { contentType: answered.contentType });
  }

  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "completed",
    ...answered,
  });

  // The row stands either way; a read that could not be queued leaves it
  // without numbers, which is how a read that failed leaves it too.
  try {
    await mediaReadService.scheduleMediaRead(outcome, job.assetSource);
  } catch (err) {
    return { outcome, mediaReadNotQueued: err };
  }
  return { outcome };
}
