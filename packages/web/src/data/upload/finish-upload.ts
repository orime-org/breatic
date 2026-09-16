// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending a file to the ingest Worker and having our server finish it (#206,
 * design §3.5).
 *
 * The parts go straight to the Worker, which is what keeps the bytes off our
 * servers. Finishing does not: the Worker asks for a shared secret, and a page
 * cannot hold one — so what this side collects on the way (the upload id, the
 * token every part answered with, and R2's receipt for each part) is handed to
 * our server, which finishes on the browser's behalf and registers what
 * landed.
 */

import {
  sendBytesToIngest,
  type IngestOutcome,
  type UploadClientConfig,
} from '@breatic/shared';
import { apiPost } from '@web/data/api/request';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { retryTransient } from '@web/data/upload/upload-retry';

/**
 * How long this side waits for one finish to answer.
 *
 * The wait is the Worker assembling the object and reading it back to hash it,
 * plus our own registration — none of which the browser's upload figures say
 * anything about, and a 25 MiB file already spends about a minute in it. So
 * this states its own deadline rather than taking the API client's, which is
 * sized for requests that answer immediately.
 *
 * Asking again is safe and is the whole recovery for an answer that never
 * arrived: the retry carries the same upload id, which the ledger grants the
 * key to a second time, and R2 refuses a second assembly — which the Worker
 * answers out of the object already standing on that key.
 */
const FINISH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A transfer that ended without our server hearing anything (#237).
 *
 * It covers both ways that half can end: the bytes never got out, and the edge
 * turned them down. What the two share is the part that matters here — the
 * finish needs an upload id and a token only a completed transfer hands back,
 * so it was never asked for, and the edge answers the browser rather than us.
 * Nobody but the browser can end this upload's task row.
 */
export class BytesNotDelivered extends Error {
  /**
   * Wrap what the transfer threw, keeping it reachable as `cause`.
   * @param cause - What the transfer threw.
   */
  constructor(cause: unknown) {
    super('the transfer ended without our server hearing anything', { cause });
    this.name = 'BytesNotDelivered';
  }
}

/**
 * Send one file's bytes to the Worker, then have our server finish it.
 * @param file - What the person picked.
 * @param ticket - What the ticket endpoint issued for it.
 * @param cfg - The upload knobs, which size the per-part deadlines.
 * @returns The registered row, as our server filed it.
 * @throws {Error} When any part is refused, or the finish fails every attempt.
 */
export async function sendFileAndFinish(
  file: File,
  ticket: UploadTicket,
  cfg: UploadClientConfig,
): Promise<IngestOutcome> {
  const held = await sendBytesToIngest(file, ticket, cfg).catch(
    (err: unknown) => {
      throw new BytesNotDelivered(err);
    },
  );

  // The same budget and the same reading of "transient" the ticket request
  // gets. Both halves matter here: the interval is what lets a connection that
  // dropped for a second come back, and a refusal the server states as a fact
  // (the grant is gone, the bytes were over the cap) ends the delivery there
  // rather than asking twice more for an answer that cannot change.
  return retryTransient(
    () =>
      apiPost<IngestOutcome>(
        `/assets/uploads/${held.uploadId}/complete`,
        { parts: held.parts },
        {
          headers: { 'x-upload-token': held.token },
          timeout: FINISH_TIMEOUT_MS,
        },
      ),
    {
      attempts: cfg.clientMaxAttempts,
      baseDelayMs: cfg.clientRetryBaseDelayMs,
    },
  );
}
