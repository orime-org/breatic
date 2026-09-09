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
import { signUploadTicket, type IngestTarget } from "@breatic/shared";

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
  /** When the ticket stops being accepted, as epoch milliseconds. */
  expiresAt: number;
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
        expiresAt: request.expiresAt,
        sessionTokenTtlSeconds: ingest.session_token_ttl_seconds,
      },
      env.INGEST_SHARED_SECRET,
    ),
    uploadUrl: env.INGEST_BASE_URL,
    partSize: ingest.part_size_bytes,
    totalParts,
  };
}
