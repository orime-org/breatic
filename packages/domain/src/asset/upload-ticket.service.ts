// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Signing the ticket that lets one upload reach the ingest Worker.
 *
 * The layout is the load-bearing part: how many parts there will be and how
 * long each one is travel under the HMAC, and the Worker judges every part
 * against them without asking anything. Two callers open uploads — the ticket
 * endpoint for the browser, and the backend lanes for what a generation
 * produced — and a layout computed one way in one of them and another way in
 * the other would have the Worker refusing parts from whichever side drifted.
 * So the rule lives here once.
 */

import { env, getStorageConfig } from "@breatic/core";
import {
  INGEST_NO_ANSWER,
  openUploadAtIngest,
  signUploadTicket,
  type IngestTarget,
  type OpenedIngestTarget,
} from "@breatic/shared";
import { applyIngestReport } from "@domain/asset/ingest-report.service.js";
import { ingestFailureReason } from "@domain/asset/ingest-failure-reason.js";
import { UploadOpenFailed } from "@domain/asset/upload-open-failure.js";

/** What an upload has to declare before a ticket can be signed for it. */
export interface UploadTicketRequest {
  /** The key this upload writes to. */
  storageKey: string;
  /** The studio the bytes will be charged to. */
  studioId: string;
  /** Who is uploading. */
  userId: string;
  /**
   * The byte size when it is known; the ceiling the upload may reach when it
   * is not, which is what a lane pulling from a URL has to give instead.
   */
  declaredSize: number;
  /** What the object is served as. */
  contentType: string;
  /**
   * Have the Worker take the type off the source's own answer instead.
   *
   * Only the lane handed an address sets it: nobody there has seen a byte of
   * what is behind that address, so `contentType` above is a placeholder and
   * the source's answer is the only truthful value.
   */
  typeFromSource?: boolean;
  /** When the ticket stops being accepted, as epoch milliseconds. */
  expiresAt: number;
  /**
   * When the task this upload belongs to runs out, as epoch milliseconds
   * (inner#1367). Every session token the Worker issues for it expires then.
   */
  deadlineAt: number;
}

/**
 * Sign a ticket and say where to send the parts.
 * @param request - What this upload is.
 * @returns The ticket, the Worker's address, and the layout both sides hold to.
 */
export async function signTicketFor(
  request: UploadTicketRequest,
): Promise<IngestTarget> {
  const { ingest } = getStorageConfig();
  // A single-part upload is exempt from R2's 5 MiB floor, so a small file
  // travels as one part rather than being padded up to the configured size.
  const totalParts = Math.max(
    1,
    Math.ceil(request.declaredSize / ingest.part_size_bytes),
  );
  return {
    ticket: await signUploadTicket(
      {
        storageKey: request.storageKey,
        studioId: request.studioId,
        userId: request.userId,
        totalParts,
        partSize: ingest.part_size_bytes,
        contentType: request.contentType,
        ...(request.typeFromSource === true && { typeFromSource: true }),
        expiresAt: request.expiresAt,
        deadlineAt: request.deadlineAt,
      },
      env.INGEST_SHARED_SECRET,
    ),
    uploadUrl: env.INGEST_BASE_URL,
    partSize: ingest.part_size_bytes,
    totalParts,
  };
}

/**
 * Sign a ticket and open its upload at the ingest Worker with the shared
 * secret, once (inner#1595).
 *
 * The ticket never leaves this call: whoever sends the bytes gets the upload
 * id and the first token. The grant and the task row exist before this runs,
 * so any failure here settles them as aborted before it is thrown; a resend
 * could open a second upload for the same key, so nothing is retried.
 * @param request - What this upload is.
 * @param bound - The caller's deadline and stop signal, or a timeout alone.
 * @returns The opened upload and the layout its parts follow.
 * @throws {UploadOpenFailed} When signing or opening failed; it carries what
 *   settling decided, or the error settling threw.
 */
export async function openSignedUpload(
  request: UploadTicketRequest,
  bound: Parameters<typeof openUploadAtIngest>[2],
): Promise<OpenedIngestTarget> {
  try {
    const target = await signTicketFor(request);
    const { uploadId, token } = await openUploadAtIngest(
      target,
      env.INGEST_SHARED_SECRET,
      bound,
    );
    return {
      uploadUrl: target.uploadUrl,
      uploadId,
      token,
      partSize: target.partSize,
      totalParts: target.totalParts,
    };
  } catch (cause) {
    // No answer from the Worker is between our server and it, not the user's.
    const reason = ingestFailureReason(cause, INGEST_NO_ANSWER);
    const { storageKey } = request;
    let settled;
    try {
      settled = await applyIngestReport({ storageKey, outcome: "aborted", reason });
    } catch (settleError) {
      throw new UploadOpenFailed({ storageKey, reason, settleError, cause });
    }
    throw new UploadOpenFailed({ storageKey, reason, settled, cause });
  }
}
