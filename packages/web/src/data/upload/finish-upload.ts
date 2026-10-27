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
 * our server, which queues the finish on the browser's behalf and answers 202
 * (inner#1367 §4.2a). How it ended comes from the upload status query.
 */

import { sendBytesToIngest, type UploadClientConfig } from '@breatic/shared';
import { apiPost } from '@web/data/api/request';
import type { UploadTicket } from '@web/data/upload/ingest-upload';
import { retryTransient } from '@web/data/upload/upload-retry';

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

/** What our server answers a finish with: it queued it, under this key. */
export interface QueuedFinish {
  storageKey: string;
}

/**
 * Send one file's bytes to the Worker, then have our server queue its finish.
 *
 * Asking again is safe and is the whole recovery for an answer that never
 * arrived: the key is the finish job's id, so a repeat queues nothing more.
 * @param file - What the person picked, or the bytes a page wrote.
 * @param ticket - The upload our server opened for it; the parts start from
 *   its token, and no upload is opened here.
 * @param cfg - The upload knobs, which set the idle window on each part.
 * @param onPartLanded - Told how many bytes have landed, after each part.
 * @param signal - Raised when the caller no longer wants the upload: handed
 *   to every part and to the finish, and checked between the two.
 * @returns The key the queued finish runs under.
 * @throws {Error} When any part is refused, or queueing fails every attempt.
 * @throws {DOMException} `AbortError` when `signal` is raised during the parts
 *   or before the finish; a stop during the finish request rejects with the
 *   `ApiException` the cancelled request becomes.
 */
export async function sendFileAndFinish(
  file: Blob,
  ticket: UploadTicket,
  cfg: UploadClientConfig,
  onPartLanded?: (bytesLanded: number) => void,
  signal?: AbortSignal,
): Promise<QueuedFinish> {
  const held = await sendBytesToIngest(file, ticket, cfg, onPartLanded, undefined, signal).catch(
    (err: unknown) => {
      // A stop is the caller's own doing, not a delivery that failed.
      if (signal?.aborted === true) throw err;
      throw new BytesNotDelivered(err);
    },
  );
  signal?.throwIfAborted();

  // The same budget and the same reading of "transient" the ticket request
  // gets. Both halves matter here: the interval is what lets a connection that
  // dropped for a second come back, and a refusal the server states as a fact
  // (the grant is gone, the bytes were over the cap) ends the delivery there
  // rather than asking twice more for an answer that cannot change.
  return retryTransient(
    () =>
      apiPost<QueuedFinish>(
        `/assets/uploads/${held.uploadId}/complete`,
        { parts: held.parts },
        {
          headers: { 'x-upload-token': held.token },
          ...(signal !== undefined && { signal }),
        },
      ),
    {
      attempts: cfg.clientMaxAttempts,
      baseDelayMs: cfg.clientRetryBaseDelayMs,
    },
  );
}
