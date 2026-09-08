// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Talking to the ingest Worker (#173 design §4.2, #181 lanes ② and ③).
 *
 * Whoever holds the bytes sends them: the browser for a file a person picked,
 * and our own backend for what it produced itself (a transport's audio, a
 * frame ffmpeg lifted out of a video). Both go through the same three steps —
 * open with the ticket, PUT each part, ask to complete — so both go through
 * this, and the Worker needs no idea which one it is talking to.
 *
 * A URL is the third way, and it moves no bytes through the caller at all: the
 * Worker fetches it where R2 already is. Lifting all of them here is what makes
 * "every asset reaches R2 through the ingest Worker" one implementation rather
 * than a rule each caller is trusted to follow.
 *
 * The Worker keeps nothing between requests, so what one upload has to
 * remember travels with it: the upload id and every part's receipt are held
 * here and handed back to finish. A repeated part is written under its own
 * number, and a repeated finish is refused by R2 rather than written twice —
 * which is what lets the shared transport deliver any of these again.
 */

import { httpRequest } from "@shared/http/request.js";
import { partDeadlineMs } from "@shared/upload/windows.js";

/** The upload knobs served by `GET /assets/upload-config` (camelCase wire). */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Ticket attempts including the first; a part's count lives in the transport. */
  clientMaxAttempts: number;
  /** Base backoff (ms) between ticket attempts; full jitter on base * 2^attemptIndex. */
  clientRetryBaseDelayMs: number;
  /** Floor for the part stall guard. It times no API request — the ticket goes through the axios client. */
  clientRequestTimeoutMs: number;
  /** PUT stall guard rate: timeout = max(floor, size / rate). */
  clientPutMinBytesPerSec: number;
}

/** An HTTP failure from the storage PUT, carrying the response status. */
export class UploadHttpError extends Error {
  /** The HTTP response status. */
  readonly status: number;

  /**
   * Build the error from the PUT response status.
   * @param status - The non-2xx HTTP status the PUT target responded with.
   */
  constructor(status: number) {
    super(`Asset upload failed (HTTP ${status})`);
    this.name = "UploadHttpError";
    this.status = status;
  }
}

/**
 * Per-attempt PUT timeout: a stall guard, not a UX deadline. Scales with
 * file size at the minimum acceptable transfer rate so a legitimately
 * slow big upload never trips it, floored at the value below, whose name says API request but times none.
 * @param sizeBytes - The file size about to be PUT.
 * @param cfg - The upload knobs.
 * @returns The per-attempt timeout in milliseconds.
 */
export function computePutTimeoutMs(
  sizeBytes: number,
  cfg: UploadClientConfig,
): number {
  // The same arithmetic the config's own window check reads. A second copy
  // here would let the browser's deadline and that check disagree.
  return partDeadlineMs(sizeBytes, {
    requestTimeoutMs: cfg.clientRequestTimeoutMs,
    minBytesPerSec: cfg.clientPutMinBytesPerSec,
  });
}

/** What sending bytes to the Worker needs off a ticket. */
export interface IngestTarget {
  /** The signed permission slip the Worker verifies. */
  ticket: string;
  /** The ingest Worker's base address. */
  uploadUrl: string;
  /** How long every part but the last must be. */
  partSize: number;
  /** How many parts the bytes were cut into. */
  totalParts: number;
}

/**
 * What completing an upload told us.
 *
 * An upload behind a node hears its outcome through Yjs and ignores this. One
 * with no node — a focus crop, or anything the backend uploaded for itself —
 * has no other channel, so this is what it reads. The fields are optional
 * because the caller hands on whatever it filed rather than reshaping it.
 */
export interface IngestOutcome {
  /** The ledger row these bytes landed on. */
  assetId?: string | null;
  /** Where the stored object is readable. */
  fileUrl?: string;
  /** The kind the server filed it under. */
  kind?: string;
}

/** What one part's write left behind: R2's receipt for it. */
export interface PartReceipt {
  partNumber: number;
  etag: string;
}

/** What opening an upload answers with. */
interface OpenedUpload {
  uploadId: string;
  token: string;
}

/**
 * Everything an upload needs remembered to be finished.
 *
 * The Worker keeps nothing between requests, so this is the whole of it, and
 * it travels: the browser hands it to our server, which finishes on its
 * behalf.
 */
export interface HeldUpload {
  /** R2's id for the multipart upload. */
  uploadId: string;
  /** The token the last part answered with. */
  token: string;
  /** R2's receipt for every part that landed. */
  parts: PartReceipt[];
}

/** What the Worker measured over the object that landed. */
export interface IngestMeasurements {
  /** Of the stored bytes, which is what the ledger keys on. */
  sha256: string;
  /** What actually landed, which is what it charges for. */
  sizeBytes: number;
  /** What a reader will be served, as the ticket signed it. */
  contentType: string;
}

/**
 * Send one blob of bytes to the ingest Worker, part by part.
 *
 * The receipts are collected on the way: the Worker keeps nothing between
 * requests, so what it needs to assemble the object is the list this side
 * built up (design §6.1). They are handed back rather than used here, because
 * finishing takes the shared secret and a browser does not hold one — it sends
 * what this answers to our server, which finishes on its behalf.
 *
 * Stops at the first step the Worker refuses. A part that never lands leaves
 * the upload incomplete, and nothing here can finish it — the task's own
 * budget is what settles that, when somebody opens the node's task list.
 * @param bytes - What to upload. A browser's `File` is one of these.
 * @param target - What the ticket endpoint issued for it.
 * @param cfg - The upload knobs, which size the per-delivery deadlines.
 * @returns Everything finishing this upload will need.
 * @throws {UploadHttpError} When the Worker refuses either step.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function sendBytesToIngest(
  bytes: Blob,
  target: IngestTarget,
  cfg: UploadClientConfig,
): Promise<HeldUpload> {
  const opened = await openUpload(target, cfg);

  let token = opened.token;
  const parts: PartReceipt[] = [];
  for (let part = 1; part <= target.totalParts; part += 1) {
    const start = (part - 1) * target.partSize;
    const slice = bytes.slice(start, start + target.partSize);
    const landed = await sendPart(
      target,
      opened.uploadId,
      part,
      slice,
      token,
      cfg,
    );
    token = landed.token;
    parts.push({ partNumber: landed.partNumber, etag: landed.etag });
  }

  return { uploadId: opened.uploadId, token, parts };
}

/**
 * Ask the Worker to assemble the object and measure it.
 *
 * No deadline of its own. This request carries no bytes, and how long the
 * Worker spends reading the assembled object back to hash it happens inside
 * Cloudflare's network, at a rate the caller's own upload figures say nothing
 * about. A deadline reached here costs only this delivery: the retry brings
 * the same upload id, for which R2 refuses a second complete rather than
 * writing anything.
 *
 * The secret goes with it because a session token travels to the browser —
 * every part's answer hands it one — while finishing is the step whose
 * permission lives in our ledger. Whoever calls this has already taken it.
 * @param uploadUrl - The ingest Worker's base address.
 * @param held - The upload id, newest token and part receipts.
 * @param secret - The secret the Worker also holds.
 * @returns What the Worker measured over the stored object.
 * @throws {UploadHttpError} When the upload did not become an object.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function finishUploadAtIngest(
  uploadUrl: string,
  held: HeldUpload,
  secret: string,
): Promise<IngestMeasurements> {
  return askWorker<IngestMeasurements>(
    `${uploadUrl}/uploads/${held.uploadId}/complete`,
    {
      method: "POST",
      headers: {
        "x-upload-token": held.token,
        "x-ingest-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ parts: held.parts }),
    },
    // The request names the upload it finishes, and a finished one is refused
    // by R2 rather than written twice.
    { replaySafe: true },
  );
}

/**
 * Have the Worker fetch a URL into the key this ticket names (lane ③).
 *
 * The bytes never reach the caller. A provider's link expires and the file may
 * be gigabytes; pulling it at the edge keeps it inside Cloudflare's network,
 * where the wait costs no CPU time and the egress is free.
 *
 * The shared secret goes with it because this is the one Worker endpoint that
 * fetches an address its caller names, and a ticket alone is something every
 * browser holds.
 * @param sourceUrl - Where the bytes are now.
 * @param target - What the ticket endpoint issued for them.
 * @param secret - The secret the Worker also holds.
 * @returns What the Worker measured over the object it pulled.
 * @throws {UploadHttpError} When the Worker could not store the source.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function fetchUrlToIngest(
  sourceUrl: string,
  target: IngestTarget,
  secret: string,
): Promise<IngestMeasurements> {
  return askWorker<IngestMeasurements>(
    `${target.uploadUrl}/fetch`,
    {
      method: "POST",
      headers: {
        "x-upload-ticket": target.ticket,
        "x-ingest-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: sourceUrl }),
    },
    // Sending this again is a second full transfer: the Worker opens its own
    // multipart upload each time it runs, so a repeat re-fetches the source,
    // writes R2 a second time, and brings an upload id the permission to
    // finish this key was not granted to.
    { replaySafe: false },
  );
}

/**
 * Send one request to the Worker and read what it answered.
 *
 * The endpoints differ in where they point, what they carry, how long one
 * delivery may take, and whether sending it again costs anything; a non-2xx
 * being the Worker's refusal rather than weather is the same for all of them.
 * They all answer flat, so what comes back is read directly.
 * @param url - The endpoint.
 * @param init - Method, headers and body.
 * @param options - What only the caller knows about this delivery.
 * @param options.timeoutMs - One delivery's deadline; the transport's default when absent.
 * @param options.replaySafe - Whether sending this again produces no second
 *   side effect. The test is whether the request names the upload it writes
 *   into: a part and a completion do, and opening one does not.
 * @returns The parsed answer.
 * @throws {UploadHttpError} When the Worker refuses.
 */
async function askWorker<T>(
  url: string,
  init: RequestInit,
  { timeoutMs, replaySafe }: { timeoutMs?: number; replaySafe: boolean },
): Promise<T> {
  const res = await httpRequest(url, init, {
    replaySafe,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  if (!res.ok) throw new UploadHttpError(res.status);
  return (await res.json()) as T;
}

/**
 * Open a multipart upload for this ticket's key.
 * @param target - The signed ticket and where to send it.
 * @param cfg - The upload knobs.
 * @returns The upload's id and its first session token.
 * @throws {UploadHttpError} When the Worker refuses the ticket.
 */
async function openUpload(
  target: IngestTarget,
  cfg: UploadClientConfig,
): Promise<OpenedUpload> {
  return askWorker<OpenedUpload>(
    `${target.uploadUrl}/uploads`,
    { method: "POST", headers: { "x-upload-ticket": target.ticket } },
    // This request carries no upload id: it mints one, and the Worker opens a
    // fresh multipart upload on every delivery. A replay leaves the first one
    // abandoned, holding parts R2 charges for.
    { timeoutMs: cfg.clientRequestTimeoutMs, replaySafe: false },
  );
}

/**
 * Write one part and take the token that lets the next one through.
 * @param target - The signed ticket and where to send it.
 * @param uploadId - The upload these parts belong to.
 * @param part - This part's number, counting from one.
 * @param bytes - This part's bytes.
 * @param token - The token this part is authorised by.
 * @param cfg - The upload knobs.
 * @returns This part's receipt and the token for the next part.
 * @throws {UploadHttpError} When the Worker refuses the part.
 */
async function sendPart(
  target: IngestTarget,
  uploadId: string,
  part: number,
  bytes: Blob,
  token: string,
  cfg: UploadClientConfig,
): Promise<PartReceipt & { token: string }> {
  return askWorker<PartReceipt & { token: string }>(
    `${target.uploadUrl}/uploads/${uploadId}/parts/${part}`,
    { method: "PUT", body: bytes, headers: { "x-upload-token": token } },
    // The deadline is a stall guard sized to this part, not to the file: a
    // part that is transferring at all must not be cut off, and a part that
    // has stopped should not hold the upload for the whole file's budget.
    // The part number is in the path, so a repeat writes the same part under
    // the same number; R2 keeps the later write of a part, never both.
    { timeoutMs: computePutTimeoutMs(bytes.size, cfg), replaySafe: true },
  );
}
