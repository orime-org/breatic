// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fetching an address somebody handed the backend (task #207, design §7.6).
 *
 * The route did everything that can be decided without moving bytes: it
 * checked who was asking, opened the grant, opened the task row on the node,
 * and queued this. What is left is one long call to the ingest Worker and the
 * two ways it can end.
 *
 * It has its own queue rather than a branch inside `runTask`, because that one
 * runs a generation: after the branch it records a provider result, bills the
 * studio and writes a generation activity row, unconditionally. None of those
 * belong to somebody pasting a link.
 *
 * The failure path is written out rather than left to the job failing, because
 * a thrown job settles nothing: the grant stays open and the node keeps showing
 * a task that is still running until a harvest calls it expired.
 */

import type { Job } from "bullmq";
import { coverKeyFor, env, getStorageConfig, logger } from "@breatic/core";
import {
  assetService,
  ingestReportService,
  storedTypeOf,
  TYPE_UNKNOWN,
  uploadTicketService,
  urlIngestFailureLevel,
} from "@breatic/domain";
import { noteSideEffects } from "@worker/handlers/side-effects.js";
import {
  fetchUrlToIngest,
  UploadHttpError,
  INGEST_REFUSED_UNNAMED,
  INGEST_NO_ANSWER,
  INGEST_NOT_STARTED,
  INGEST_TYPE_NOT_REPORTED,
} from "@breatic/shared";

/** What the route queued for one submitted address. */
export interface UrlIngestJobData {
  /** The key the grant was opened on, which the task row carries too. */
  storageKey: string;
  /** The studio the bytes are charged to. */
  studioId: string;
  /** Where the bytes are now. */
  url: string;
  /** Who submitted it. */
  userId: string;
  /** The project the node lives in. */
  projectId: string;
  /** The space the node lives on. */
  spaceId: string;
  /** The node the result goes to. */
  nodeId: string;
}

/**
 * Settle the grant and the node's task row on a transfer that did not finish.
 * @param storageKey - The key the grant was opened on.
 * @param reason - What the node's task list shows.
 */
async function fail(storageKey: string, reason: string): Promise<void> {
  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "aborted",
    reason,
  });
  noteSideEffects(outcome, { key: storageKey });
}

/**
 * Have the ingest Worker pull the address this job names into R2.
 *
 * Never throws for a transfer that failed, from signing the ticket onward:
 * the grant and the task row are this job's to settle, a thrown job settles
 * neither, and this queue has no reclaim of its own — a job that throws
 * leaves the row running until a harvest calls it expired.
 * @param job - The queued submission.
 * @throws {Error} When settling the outcome itself fails, which leaves the row
 *   running for a harvest rather than silently wrong.
 */
export async function runUrlIngest(job: Job<UrlIngestJobData>): Promise<void> {
  const { storageKey, studioId, url, userId, projectId, nodeId } = job.data;
  const { upload, ingest } = getStorageConfig();

  let target;
  try {
    target = await uploadTicketService.signTicketFor({
      storageKey,
      studioId,
      userId,
      // A link says nothing about its length, so what is declared is the
      // ceiling the transfer may reach. The Worker holds it to that and
      // answers 413.
      declaredSize: upload.max_upload_bytes,
      contentType: TYPE_UNKNOWN,
      typeFromSource: true,
      expiresAt: Date.now() + ingest.ticket_expires_seconds * 1000,
    });
  } catch (err) {
    // Nothing was fetched, so neither the address nor its source is what to
    // report. This queue has no reclaim of its own: a job that throws here
    // leaves the row running until a harvest calls it expired.
    logger.error(
      { err, key: storageKey, projectId, nodeId },
      "url_ingest_ticket_failed",
    );
    await fail(storageKey, INGEST_NOT_STARTED);
    return;
  }

  let measured;
  try {
    measured = await fetchUrlToIngest(
      url,
      target,
      env.INGEST_SHARED_SECRET,
      // Named on every call rather than only for video. Which media have a
      // frame to lift is decided from the type, and nobody on this side knows
      // the type until the transfer has already happened — so the Worker
      // judges it there, against the type it stored the object under.
      coverKeyFor(storageKey),
      assetService.mediaLimits(),
      ingest.url_fetch_deadline_ms,
    );
  } catch (err) {
    // An UploadHttpError exists only because an answer arrived, so a missing
    // name on it is the Worker refusing without saying why. Only the absence
    // of any answer is the source running out of time.
    const reason =
      err instanceof UploadHttpError
        ? (err.code ?? INGEST_REFUSED_UNNAMED)
        : INGEST_NO_ANSWER;
    logger[urlIngestFailureLevel(reason)](
      { err, key: storageKey, projectId, nodeId, reason },
      "url_ingest_failed",
    );
    await fail(storageKey, reason);
    return;
  }

  const storedType = storedTypeOf(measured.contentType);
  if (storedType === null) {
    logger.error(
      { key: storageKey, projectId, nodeId, reported: measured.contentType },
      "url_ingest_type_not_reported",
    );
    await fail(storageKey, INGEST_TYPE_NOT_REPORTED);
    return;
  }

  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "completed",
    ...measured,
    contentType: storedType,
  });
  if (outcome.status === "rejected") {
    logger.info(
      { key: storageKey, projectId, nodeId, reason: outcome.reason },
      `url_ingest_${outcome.reason}`,
    );
  }
  noteSideEffects(outcome, { key: storageKey, projectId, nodeId });
}
