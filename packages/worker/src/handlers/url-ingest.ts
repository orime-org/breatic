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
import { env, getStorageConfig, logger } from "@breatic/core";
import {
  assetService,
  ingestReportService,
  uploadTicketService,
} from "@breatic/domain";
import {
  fetchUrlToIngest,
  reduceMediaType,
  isUploadableMediaType,
  UploadHttpError,
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
 * What is signed into the ticket, for want of anything measured.
 *
 * Nobody here has seen a byte of what is behind the address, so this stands in
 * the type's place until the Worker reads the source's own answer. It is never
 * what gets stored: the ticket also carries the flag that makes the Worker
 * take the type off the source and refuse anything that is not uploadable.
 */
const TYPE_UNKNOWN = "application/octet-stream";

/**
 * Why the node's task row failed, for a call that brought back no answer.
 *
 * Our deadline is set under what the platform allows, so a transfer that ran
 * out of time ends here rather than in a platform refusal. An ingest Worker
 * that cannot be reached at all lands here too — that one is an outage rather
 * than a case to design for, and the log below carries what really happened.
 */
const NO_ANSWER = "source_too_slow";

/** The Worker read no type of its own, so what it reported means nothing. */
const TYPE_NOT_REPORTED = "type_not_reported";

/**
 * Judge what came back before any of it is written down.
 *
 * The ticket asked the Worker to take the type off the source. An answer
 * carrying the placeholder back means it did not, and registering that would
 * put a type on the node that nothing ever measured; anything outside the
 * three uploadable kinds means it read one and let it through.
 * @param contentType - What the Worker reported.
 * @returns Whether this answer can be registered.
 */
function typeWasRead(contentType: string): boolean {
  const reduced = reduceMediaType(contentType);
  return reduced !== TYPE_UNKNOWN && isUploadableMediaType(reduced);
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
  if (outcome.countsPublishFailed === true) {
    logger.error({ key: storageKey }, "node_task_counts_publish_failed");
  }
}

/**
 * Have the ingest Worker pull the address this job names into R2.
 *
 * Never throws for a transfer that failed: the grant and the task row are this
 * job's to settle, and a thrown job settles neither.
 * @param job - The queued submission.
 * @throws {Error} When settling the outcome itself fails, which leaves the row
 *   running for a harvest rather than silently wrong.
 */
export async function runUrlIngest(job: Job<UrlIngestJobData>): Promise<void> {
  const { storageKey, studioId, url, userId, projectId, nodeId } = job.data;
  const { upload, ingest } = getStorageConfig();

  const target = await uploadTicketService.signTicketFor({
    storageKey,
    studioId,
    userId,
    // A link says nothing about its length, so what is declared is the ceiling
    // the transfer may reach. The Worker holds it to that and answers 413.
    declaredSize: upload.max_upload_bytes,
    contentType: TYPE_UNKNOWN,
    typeFromSource: true,
    expiresAt: Date.now() + ingest.ticket_expires_seconds * 1000,
  });

  let measured;
  try {
    measured = await fetchUrlToIngest(
      url,
      target,
      env.INGEST_SHARED_SECRET,
      // No cover is asked for. Which media have a frame to lift is decided
      // from the type, and down this lane nobody knows the type until the
      // transfer has already happened (#238).
      undefined,
      assetService.mediaLimits(),
      ingest.url_fetch_deadline_ms,
    );
  } catch (err) {
    const reason =
      err instanceof UploadHttpError ? (err.code ?? NO_ANSWER) : NO_ANSWER;
    logger.error({ err, key: storageKey, projectId, nodeId, reason }, "url_ingest_failed");
    await fail(storageKey, reason);
    return;
  }

  if (!typeWasRead(measured.contentType)) {
    logger.error(
      { key: storageKey, projectId, nodeId, reported: measured.contentType },
      "url_ingest_type_not_reported",
    );
    await fail(storageKey, TYPE_NOT_REPORTED);
    return;
  }

  const outcome = await ingestReportService.applyIngestReport({
    storageKey,
    outcome: "completed",
    ...measured,
  });
  if (outcome.status === "rejected") {
    logger.info(
      { key: storageKey, projectId, nodeId, reason: outcome.reason },
      `url_ingest_${outcome.reason}`,
    );
  }
  if (outcome.countsPublishFailed === true) {
    logger.error({ key: storageKey }, "node_task_counts_publish_failed");
  }
  if (outcome.reclaimQueueFailed === true) {
    logger.error({ key: storageKey }, "ingest_report_reclaim_queue_failed");
  }
  if (outcome.activityAppendFailed === true) {
    logger.error({ key: storageKey }, "activity_record_failed");
  }
}
