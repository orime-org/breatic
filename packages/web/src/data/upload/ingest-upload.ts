// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Sending a file's bytes to the ingest Worker (#173, design §4.2).
 *
 * Three steps: open the upload with the ticket our server signed, PUT each
 * part, then ask to complete. The Worker hands back a fresh session token with
 * every part, so a leaked one can only write the next part of this one upload.
 *
 * Every step is replay-safe by construction rather than by hope: the Durable
 * Object holding this upload answers a repeated open with the upload already
 * open, records a part under its own number, and completes once. That is what
 * lets the shared transport deliver any of them again.
 */

import { httpRequest } from '@breatic/shared';
import {
  UploadHttpError,
  computePutTimeoutMs,
  type UploadClientConfig,
} from '@web/data/upload/upload-retry';

/**
 * A failure that arrived before the upload was open.
 *
 * The Durable Object that reports an upload's outcome is created by the open
 * request, which is one step past the ticket. A failure there leaves nothing
 * anywhere holding this attempt, and that is what decides who writes the
 * node's failure — so the step it happened at travels with the error.
 */
export class UploadNotOpenedError extends Error {
  /**
   * Wrap what the open request rejected with.
   * @param cause - What the open request rejected with.
   */
  constructor(override readonly cause: unknown) {
    super('the upload was never opened');
  }
}

/** What the ticket endpoint hands back when bytes have to move. */
export interface UploadTicket {
  /** The signed permission slip the Worker verifies. */
  ticket: string;
  /** The key the bytes land under — the server minted it. */
  storageKey: string;
  /** The ingest Worker's base address. */
  uploadUrl: string;
  /** The asset kind the server filed this under. */
  kind: string;
  /** How long every part but the last must be. */
  partSize: number;
  /** How many parts the file was cut into. */
  totalParts: number;
}

/**
 * The ticket endpoint's other answer: this studio already holds this content,
 * so nothing moves and the existing URL is reused.
 */
export interface UploadAlreadyStored {
  alreadyExists: true;
  fileUrl: string;
  kind: string;
}

/** Either answer the ticket endpoint can give. */
export type UploadTicketResponse = UploadTicket | UploadAlreadyStored;

/**
 * Tell the two ticket answers apart.
 * @param res - What the ticket endpoint answered.
 * @returns True when nothing needs uploading.
 */
export function isAlreadyStored(
  res: UploadTicketResponse,
): res is UploadAlreadyStored {
  return 'alreadyExists' in res && res.alreadyExists;
}

/**
 * What completing an upload told us.
 *
 * The upload behind a node hears its outcome through Yjs and ignores this. An
 * upload with no node — a focus crop — has no other channel, so this is what
 * it reads (design §9). Both fields are optional because the Worker hands on
 * whatever the server filed rather than reshaping it.
 */
export interface IngestOutcome {
  /** Where the stored object is readable. */
  fileUrl?: string;
  /** The kind the server filed it under. */
  kind?: string;
}

/** What opening an upload answers with. */
interface OpenedUpload {
  uploadId: string;
  token: string;
}

/**
 * Send one file to the ingest Worker and complete it.
 *
 * Stops at the first step the Worker refuses. A part that never lands leaves
 * the upload incomplete, and the Worker's own alarm is what eventually settles
 * it — so there is nothing useful for this side to do past the refusal.
 * @param file - The file to upload.
 * @param ticket - What the ticket endpoint issued for it.
 * @param cfg - The upload knobs, which size the per-delivery deadlines.
 * @returns What completing the upload said it became.
 * @throws {UploadNotOpenedError} When opening the upload failed, which leaves
 *   no Durable Object to report how it ended.
 * @throws {UploadHttpError} When the Worker refuses a part or the completion.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function sendFileToIngest(
  file: File,
  ticket: UploadTicket,
  cfg: UploadClientConfig,
): Promise<IngestOutcome> {
  const opened = await openUpload(ticket, cfg).catch((err: unknown) => {
    throw new UploadNotOpenedError(err);
  });

  let token = opened.token;
  for (let part = 1; part <= ticket.totalParts; part += 1) {
    const start = (part - 1) * ticket.partSize;
    const bytes = file.slice(start, start + ticket.partSize);
    token = await sendPart(ticket, opened.uploadId, part, bytes, token, cfg);
  }

  return completeUpload(ticket, opened.uploadId, token);
}

/**
 * Send one request to the Worker and read what it answered.
 *
 * The three endpoints differ only in where they point, what they carry and how
 * long one delivery may take; everything else — replaying is safe because the
 * Durable Object answers a repeat with what it already decided, and a non-2xx
 * is the Worker's refusal rather than weather — is the same for all of them.
 * @param url - The endpoint.
 * @param init - Method, headers and body.
 * @param timeoutMs - One delivery's deadline; the transport's default when absent.
 * @returns The parsed answer.
 * @throws {UploadHttpError} When the Worker refuses.
 */
async function askWorker<T>(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<T> {
  const res = await httpRequest(url, init, {
    replaySafe: true,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  if (!res.ok) throw new UploadHttpError(res.status);
  return (await res.json()) as T;
}

/**
 * Open the upload, or reopen one already open.
 * @param ticket - The signed ticket.
 * @param cfg - The upload knobs.
 * @returns The upload's id and its first session token.
 * @throws {UploadHttpError} When the Worker refuses the ticket.
 */
async function openUpload(
  ticket: UploadTicket,
  cfg: UploadClientConfig,
): Promise<OpenedUpload> {
  return askWorker<OpenedUpload>(
    `${ticket.uploadUrl}/uploads`,
    { method: 'POST', headers: { 'x-upload-ticket': ticket.ticket } },
    cfg.clientRequestTimeoutMs,
  );
}

/**
 * Write one part and take the token that lets the next one through.
 * @param ticket - The signed ticket.
 * @param uploadId - The upload these parts belong to.
 * @param part - This part's number, counting from one.
 * @param bytes - This part's bytes.
 * @param token - The token this part is authorised by.
 * @param cfg - The upload knobs.
 * @returns The token for the next part.
 * @throws {UploadHttpError} When the Worker refuses the part.
 */
async function sendPart(
  ticket: UploadTicket,
  uploadId: string,
  part: number,
  bytes: Blob,
  token: string,
  cfg: UploadClientConfig,
): Promise<string> {
  const answer = await askWorker<{ token: string }>(
    `${ticket.uploadUrl}/uploads/${uploadId}/parts/${part}`,
    { method: 'PUT', body: bytes, headers: { 'x-upload-token': token } },
    // The deadline is a stall guard sized to this part, not to the file: a
    // part that is transferring at all must not be cut off, and a part that
    // has stopped should not hold the upload for the whole file's budget.
    computePutTimeoutMs(bytes.size, cfg),
  );
  return answer.token;
}

/**
 * Ask the Worker to finish, and read what it made of the upload.
 * @param ticket - The signed ticket.
 * @param uploadId - The upload to finish.
 * @param token - The most recently issued session token.
 * @returns What the server filed the upload as.
 * @throws {UploadHttpError} When the upload did not become an object.
 */
async function completeUpload(
  ticket: UploadTicket,
  uploadId: string,
  token: string,
): Promise<IngestOutcome> {
  // No deadline of its own. This request carries no bytes, and how long the
  // Worker spends reading the assembled object back to hash it happens inside
  // Cloudflare's network, at a rate the browser's upload figures say nothing
  // about. A deadline reached here loses nothing: the request is replayed, and
  // the alarm reaches the same outcome on its own.
  return askWorker<IngestOutcome>(
    `${ticket.uploadUrl}/uploads/${uploadId}/complete`,
    { method: 'POST', headers: { 'x-upload-token': token } },
  );
}
