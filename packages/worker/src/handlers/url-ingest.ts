// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Fetching an address somebody handed the backend (task #207, design §7.6).
 *
 * The route did everything that can be decided without moving bytes: it
 * checked who was asking, opened the grant, opened the task row on the node
 * when it named one, and queued this. What is left is one long call to the ingest Worker and the
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
import { getStorageConfig, logger } from "@breatic/core";
import {
  backendUploadService,
  TYPE_UNKNOWN,
  uploadDeadlineByKey,
  uploadTicketService,
  urlIngestFailureLevel,
} from "@breatic/domain";
import { abortIngest } from "@worker/handlers/abort-ingest.js";
import { noteSideEffects } from "@worker/handlers/side-effects.js";
import { INGEST_NOT_STARTED } from "@breatic/shared";

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
  /** The project the result lands in. */
  projectId: string;
  /** The space the result lands on. */
  spaceId: string;
  /** The node the result goes to; absent for a document body's block. */
  nodeId?: string;
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
  // The end of the row the route opened on the node (inner#1367).
  const deadlineAt = await uploadDeadlineByKey(storageKey);

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
      deadlineAt,
    });
  } catch (err) {
    // Nothing was fetched, so neither the address nor its source is what to
    // report. This queue has no reclaim of its own: a job that throws here
    // leaves the row running until a harvest calls it expired.
    logger.error(
      { err, key: storageKey, projectId, nodeId },
      "url_ingest_ticket_failed",
    );
    await abortIngest(storageKey, INGEST_NOT_STARTED);
    return;
  }

  const pulled = await backendUploadService.pullReaderLink(storageKey, target, url, deadlineAt);
  if (pulled.status === "failed") {
    if (pulled.reported === undefined) {
      logger[urlIngestFailureLevel(pulled.reason)](
        { err: pulled.err, key: storageKey, projectId, nodeId, reason: pulled.reason },
        "url_ingest_failed",
      );
    } else {
      logger.error(
        { key: storageKey, projectId, nodeId, reported: pulled.reported },
        "url_ingest_type_not_reported",
      );
    }
    noteSideEffects(pulled.settled, { key: storageKey });
    return;
  }

  const { outcome } = pulled;
  if (outcome.status === "rejected") {
    logger.info(
      { key: storageKey, projectId, nodeId, reason: outcome.reason },
      `url_ingest_${outcome.reason}`,
    );
  }
  noteSideEffects(outcome, { key: storageKey, projectId, nodeId });
}
