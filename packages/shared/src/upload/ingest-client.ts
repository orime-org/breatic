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

import { z } from "zod";
import { agentPictureReadSchema, type AgentPictureRead, type AgentPictureSpec } from "@shared/upload/agent-picture.js";
import { MAX_TIMER_MS } from "@shared/http/constants.js";
import { untilDeadline, type UntilDeadline } from "@shared/http/deadline.js";
import { httpRequest } from "@shared/http/request.js";
import type { UprightCopy } from "@shared/upload/upright.js";
import {
  INGEST_FAILURE_HEADER,
  readIngestFailureCode,
  type IngestFailureCode,
} from "@shared/upload/ingest-failure.js";

/** The upload knobs served by `GET /assets/upload-config` (camelCase wire). */
export interface UploadClientConfig {
  /** Hard upload cap in bytes (pre-checked on selection; server 413s). */
  maxUploadBytes: number;
  /** Ticket attempts including the first; a part's count lives in the transport. */
  clientMaxAttempts: number;
  /** Base backoff (ms) between ticket attempts; full jitter on base * 2^attemptIndex. */
  clientRetryBaseDelayMs: number;
  /**
   * How long one part may go without a byte moving before it is cut and sent
   * again (inner#1367): an idle window, so a slow part that keeps moving is
   * never cut.
   */
  uploadIdleTimeoutMs: number;
}

/** An HTTP failure from the ingest Worker, carrying what it refused with. */
export class UploadHttpError extends Error {
  /** The HTTP response status. */
  readonly status: number;

  /**
   * Which refusal this was, when the Worker named one.
   *
   * The status does not carry it: four separate failures answer 502, and a
   * caller that writes the reason where a person reads it would otherwise be
   * naming the source as unreachable when our own storage was what broke.
   * Null for an answer that named nothing, which every status but those
   * does.
   */
  readonly code: IngestFailureCode | null;

  /**
   * Build the error from what the Worker answered.
   * @param status - The non-2xx HTTP status it responded with.
   * @param code - The refusal it named, if it named one.
   */
  constructor(status: number, code: IngestFailureCode | null = null) {
    super(`Asset upload failed (HTTP ${status})`);
    this.name = "UploadHttpError";
    this.status = status;
    this.code = code;
  }
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
  /**
   * What Node sends the parts through, timing the socket for a part whose
   * bytes stopped moving (core's `idleSocketDispatcher`). A page leaves it
   * out and the transport judges the same from upload progress.
   */
  dispatcher?: unknown;
}

/**
 * What the Worker turns a picture upright under (inner#1367). It reads no
 * configuration of its own, so these travel on every finish and fetch.
 */
export interface MediaLimits {
  /** JPEG and lossy WebP quality for the upright copy, 1-100. */
  uprightJpegQuality: number;
  /** The most the upright copy may weigh, in bytes. */
  uprightMaxBytes: number;
}

/** What finishing or fetching an upload is told, beyond the bytes. */
export interface IngestRun {
  /** Where to write a cut frame, named on every finish and fetch. */
  coverKey: string;
  /**
   * When the task this upload belongs to runs out, in epoch ms (inner#1367).
   * The Worker holds the media container to it and to nothing of its own.
   */
  deadlineAt: number;
  /** What a picture with an EXIF orientation is turned upright under. */
  limits: MediaLimits;
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
  /**
   * What the stored bytes read as, under the one spelling the lists use, and
   * corrected by the probe where a container holding only sound reads as
   * video. This is what the ledger records; the object's own header stays as
   * the ticket signed it.
   */
  contentType: string;
  /**
   * What the media container read off the object (#209). Absent for anything
   * it could not answer for — a medium with no such number, and equally a
   * container that timed out. Reading them is best-effort and never decides
   * whether the upload succeeded, so the two cases need not be told apart.
   */
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  /**
   * The frame the container cut, already stored at the key the caller minted
   * and hashed at the edge. Present only when a cover was asked for and there
   * was a frame to lift — so absent for everything that is not a video, and
   * for a video ffmpeg could not read.
   */
  cover?: {
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    contentType: string;
    /**
     * The frame's own pixel size, read off the bytes. It is not the video's:
     * the cut is capped on both edges on the way out of ffmpeg, so anything
     * shot larger comes back smaller, and this row states what it actually is.
     */
    width?: number | null;
    height?: number | null;
  } | null;
  /**
   * The upright copy of a picture with an EXIF orientation, written beside
   * the bytes as received (inner#1367). The asset is this copy; `sha256` and
   * the type stay the received bytes'.
   */
  upright?: UprightCopy | null;
}

/** Hexadecimal, as `hashStoredObject` writes it. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The first duration `studio_assets.duration_seconds` refuses.
 *
 * The column is `numeric(12,3)`, and its rule is about the value AFTER
 * rounding to three places: measured against the database, 999999999.9995
 * overflows and 999999999.99949 is stored as 999999999.999. ffprobe answers
 * whatever the container declares, and a file whose declared duration is 31
 * years is a 300-byte edit away from an ordinary one — filing one the column
 * refuses would turn an upload whose bytes are stored and hashed into a
 * failed one.
 */
const DURATION_CEILING = 999_999_999.9995;

/** The first dimension `studio_assets.width` refuses, the column being int4. */
const DIMENSION_CEILING = 2_147_483_648;

/**
 * One reading of a number the container may not have.
 *
 * A medium with no such number and a field the answer never carried are the
 * same fact, so they come out as the same value and every reader downstream
 * has one case to handle.
 * @param read - What survived the schema.
 * @returns The value, or null when there was none.
 */
function absentAsNone<T>(read: T | null | undefined): T | null {
  return read ?? null;
}

/**
 * What the Worker answered, read before it is believed.
 *
 * The split is what the three lanes all need: the first three decide whether
 * the upload succeeded, so an answer missing one of them is unusable and this
 * throws. The rest decide whether a node shows a resolution and a poster, so
 * anything this side cannot file comes back as no such number — which is what
 * it is, and which keeps an odd container answer from unmaking a stored
 * object.
 *
 * It sits here rather than at each caller because all three lanes reach the
 * Worker through this file. A copy at one of them protects one lane.
 */
/**
 * One pixel dimension as the Worker reports it.
 *
 * Anything outside what `studio_assets` holds reads as no such number rather
 * than failing the whole answer: the numbers are best-effort and never decide
 * whether the upload succeeded, so one the ledger cannot hold is filed the way
 * a medium with no such number is.
 */
const pixels = z.coerce
  .number()
  .int()
  .positive()
  .lt(DIMENSION_CEILING)
  .nullish()
  .catch(null)
  .transform(absentAsNone);

/** A running time, read under the same rule and against its own column. */
const seconds = z.coerce
  .number()
  .positive()
  .lt(DURATION_CEILING)
  .nullish()
  .catch(null)
  .transform(absentAsNone);

export const ingestMeasurements = z.object({
  sha256: z.string().regex(SHA256_HEX),
  sizeBytes: z.coerce.number().int().nonnegative(),
  contentType: z.string().min(1).max(100),
  width: pixels,
  height: pixels,
  durationSeconds: seconds,
  cover: z
    .object({
      storageKey: z.string().min(1).max(500),
      sha256: z.string().regex(SHA256_HEX),
      sizeBytes: z.coerce.number().int().positive(),
      contentType: z.string().min(1).max(100),
      width: pixels,
      height: pixels,
    })
    .nullish()
    .catch(null)
    .transform(absentAsNone),
  // No `.catch`: filing the received bytes in place of an upright copy that
  // cannot be read would put a sideways picture on the node.
  upright: z
    .object({
      storageKey: z.string().min(1).max(500),
      sizeBytes: z.coerce.number().int().positive(),
      width: pixels,
      height: pixels,
    })
    .nullish()
    .transform(absentAsNone),
});

/** What the Worker answered with, when it could not be read at all. */
export class IngestAnswerError extends Error {
  /**
   * Build the error from the answer that could not be read.
   * @param answered - What came back, for the log the caller writes.
   */
  constructor(readonly answered: unknown) {
    super("The ingest Worker answered something this side cannot read");
    this.name = "IngestAnswerError";
  }
}

/**
 * Read one finish answer.
 * @param answered - What the Worker sent.
 * @returns The measurements, each unusable number read as none.
 * @throws {IngestAnswerError} When the hash, the size or the type is missing.
 */
function readMeasurements(answered: unknown): IngestMeasurements {
  const read = ingestMeasurements.safeParse(answered);
  if (!read.success) throw new IngestAnswerError(answered);
  return read.data;
}

/**
 * What bounds one upload's requests: the task's deadline (signal and time
 * left), the caller's stop signal alone, or both joined.
 */
type PartBound = UntilDeadline | { signal: AbortSignal };

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
 * @param cfg - The idle window a part is cut after.
 * @param onPartLanded - Told how many bytes have landed so far, after each
 *   part the Worker accepts.
 * @param deadlineAt - When the upload's task runs out, in epoch ms, for a
 *   backend caller; a page holds none, and the Worker refuses a part past it.
 * @param signal - Raised when the caller no longer wants the upload: checked
 *   between parts and handed to each request.
 * @returns Everything finishing this upload will need.
 * @throws {UploadHttpError} When the Worker refuses either step.
 * @throws {DeadlinePassed} When the deadline has already come.
 * @throws {DOMException} `AbortError` once `signal` is raised.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function sendBytesToIngest(
  bytes: Blob,
  target: IngestTarget,
  cfg: Pick<UploadClientConfig, "uploadIdleTimeoutMs">,
  onPartLanded?: (bytesLanded: number) => void,
  deadlineAt?: number,
  signal?: AbortSignal,
): Promise<HeldUpload> {
  const deadline = deadlineAt === undefined ? undefined : untilDeadline(deadlineAt);
  const bound: PartBound | undefined =
    signal === undefined
      ? deadline
      : deadline === undefined
        ? { signal }
        : { ...deadline, signal: AbortSignal.any([deadline.signal, signal]) };
  signal?.throwIfAborted();
  const opened = await openUpload(target, bound);

  let token = opened.token;
  const parts: PartReceipt[] = [];
  for (let part = 1; part <= target.totalParts; part += 1) {
    signal?.throwIfAborted();
    const start = (part - 1) * target.partSize;
    const slice = bytes.slice(start, start + target.partSize);
    const landed = await sendPart(
      target,
      opened.uploadId,
      part,
      slice,
      token,
      cfg,
      bound,
    );
    token = landed.token;
    parts.push({ partNumber: landed.partNumber, etag: landed.etag });
    onPartLanded?.(start + slice.size);
  }

  return { uploadId: opened.uploadId, token, parts };
}

/**
 * Ask the Worker to assemble the object and measure it.
 *
 * Bounded by the upload's task deadline and nothing else (inner#1367): the
 * Worker holds its container to `deadlineAt`, and the wait ends at the same
 * instant. A resend brings the same upload id, for which
 * R2 refuses a second complete rather than writing anything.
 *
 * The secret goes with it because a session token travels to the browser —
 * every part's answer hands it one — while finishing is the step whose
 * permission lives in our ledger. Whoever calls this has already taken it.
 * @param uploadUrl - The ingest Worker's base address.
 * @param held - The upload id, newest token and part receipts.
 * @param secret - The secret the Worker also holds.
 * @param run - The cover key, the deadline, and whether the media numbers are
 *   read after this upload returns rather than now (#299: covers and
 *   avatars).
 * @returns What the Worker measured over the stored object.
 * @throws {UploadHttpError} When the upload did not become an object.
 * @throws {DeadlinePassed} When the deadline has already come.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function finishUploadAtIngest(
  uploadUrl: string,
  held: HeldUpload,
  secret: string,
  run: IngestRun & { deferMediaRead?: boolean },
): Promise<IngestMeasurements> {
  const answered = await askWorker<unknown>(
    `${uploadUrl}/uploads/${held.uploadId}/complete`,
    {
      method: "POST",
      headers: {
        "x-upload-token": held.token,
        "x-ingest-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parts: held.parts,
        coverKey: run.coverKey,
        deadlineAt: run.deadlineAt,
        limits: run.limits,
        ...(run.deferMediaRead === true && { deferMediaRead: true }),
      }),
    },
    // The request names the upload it finishes, and a finished one is refused
    // by R2 rather than written twice, so a repeat answers out of the object
    // already standing on that key.
    { replaySafe: true, bound: untilDeadline(run.deadlineAt) },
  );
  return readMeasurements(answered);
}

/** What the media container measured over a stored object. */
export interface MediaNumbers {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
}

const mediaNumbers = z.object({
  width: pixels,
  height: pixels,
  durationSeconds: seconds,
});

/**
 * What became of a preview a read asked for (inner#1320). The Worker answers
 * one of these, and this list is the only place they are written.
 *
 * `failed` is kept apart from `none`: a picture with a frame that came back
 * without a stored preview (no container answer, vips failed or ran out of
 * time, or the write failed) is worth running again; one with no frame to cut
 * is not.
 */
export const PREVIEW_OUTCOMES = ["generated", "existing", "none", "failed"] as const;

/** One of {@link PREVIEW_OUTCOMES}. */
export type PreviewOutcome = (typeof PREVIEW_OUTCOMES)[number];

/** What a read of a stored object answers. */
export interface StoredMediaRead extends MediaNumbers {
  /** Present when a preview was asked for and the answer named a known one. */
  preview?: PreviewOutcome;
  /** Present when peaks were asked for; they take the same outcomes as a preview. */
  peaks?: PreviewOutcome;
  /** Measured facts of the static JPEG prepared for a model request. */
  agentPicture?: AgentPictureRead;
}

const previewOutcome = z
  .enum(PREVIEW_OUTCOMES)
  .optional()
  .catch(undefined);

/**
 * Ask the Worker what an object already in storage measures (#299).
 *
 * The read a cover or an avatar skipped when it was finished, asked for by our
 * worker once the upload has returned, the audio peaks job, and the backfills
 * of previews and peaks, and the Agent's versioned JPEG preparation. It may
 * write a preview, an audio object's peaks or a requested Agent JPEG, each at
 * a key derived from the object's own. Existing outputs are left alone, so a
 * repeat costs at most one more container
 * run and nothing else. Bounded by the caller's deadline: the Worker holds its
 * container to `deadlineAt`, and the wait ends at the same instant.
 * @param uploadUrl - The ingest Worker's base address.
 * @param secret - The secret the Worker also holds.
 * @param about - The object to read.
 * @param about.storageKey - Its key.
 * @param about.contentType - What the ledger recorded the bytes as, which says
 *   whether there is anything for the container to read.
 * @param about.deadlineAt - When the job asking runs out, in epoch ms.
 * @param about.wantPreview - Whether to cut a preview when none stands.
 * @param about.wantPeaks - Whether to read the peaks of an audio object when none stand.
 * @param about.agentPicture - Optional versioned JPEG encoding specification.
 * @param signal - Stops this caller's wait while preserving the media deadline.
 * @returns The three numbers, each unusable one as none, and the outcomes of
 *   the requested preview, peaks and Agent JPEG.
 * @throws {UploadHttpError} When the Worker refuses.
 * @throws {DeadlinePassed} When the deadline has already come.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function readStoredMediaAtIngest(
  uploadUrl: string,
  secret: string,
  about: {
    storageKey: string;
    contentType: string;
    deadlineAt: number;
    wantPreview?: boolean;
    wantPeaks?: boolean;
    agentPicture?: AgentPictureSpec;
  },
  signal?: AbortSignal,
): Promise<StoredMediaRead> {
  const deadline = untilDeadline(about.deadlineAt);
  const bound = signal === undefined ? deadline : { ...deadline, signal: AbortSignal.any([deadline.signal, signal]) };
  const answered = await askWorker<unknown>(
    `${uploadUrl}/media`,
    {
      method: "POST",
      headers: {
        "x-ingest-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify(about),
    },
    { replaySafe: true, bound },
  );
  const numbers = mediaNumbers.parse(answered ?? {});
  const outcomes = answered as { preview?: unknown; peaks?: unknown; agentPicture?: unknown } | null;
  const preview = previewOutcome.parse(outcomes?.preview);
  const peaks = previewOutcome.parse(outcomes?.peaks);
  const picture = outcomes?.agentPicture === undefined
    ? undefined
    : agentPictureReadSchema.safeParse(outcomes.agentPicture);
  return {
    ...numbers,
    ...(preview !== undefined && { preview }),
    ...(peaks !== undefined && { peaks }),
    ...(picture !== undefined && { agentPicture: picture.success ? picture.data : { outcome: "failed" as const } }),
  };
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
 * @param run - The cover key, and the task deadline the Worker holds the
 *   transfer and the container to, and the wait ends at.
 * @param signal - Raised when the caller no longer wants the transfer, which
 *   a caller with a reader waiting on it passes (the agent's save stops when
 *   the reader stops the turn).
 * @returns What the Worker measured over the object it pulled.
 * @throws {UploadHttpError} When the Worker could not store the source.
 * @throws {DeadlinePassed} When the deadline has already come.
 * @throws {unknown} The transport's own failure when no delivery produced a
 *   response.
 */
export async function fetchUrlToIngest(
  sourceUrl: string,
  target: IngestTarget,
  secret: string,
  run: IngestRun,
  signal?: AbortSignal,
): Promise<IngestMeasurements> {
  const deadline = untilDeadline(run.deadlineAt);
  // A caller with a reader waiting also stops the transfer when the reader does.
  const bound =
    signal === undefined ? deadline : { ...deadline, signal: AbortSignal.any([deadline.signal, signal]) };
  const answered = await askWorker<unknown>(
    `${target.uploadUrl}/fetch`,
    {
      method: "POST",
      headers: {
        "x-upload-ticket": target.ticket,
        "x-ingest-secret": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: sourceUrl,
        coverKey: run.coverKey,
        deadlineAt: run.deadlineAt,
        limits: run.limits,
      }),
    },
    // Sending this again is a second full transfer: the Worker opens its own
    // multipart upload each time it runs, so a repeat re-fetches the source,
    // writes R2 a second time, and brings an upload id the permission to
    // finish this key was not granted to.
    { replaySafe: false, bound },
  );
  return readMeasurements(answered);
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
 * @param options.bound - How long the call may run: the task's deadline as a
 *   signal with the time left (joined with the caller's stop signal, when it
 *   has one), or, for a call no deadline reaches, a timeout alone.
 * @param options.idleTimeoutMs - How long a delivery may go without a byte
 *   moving, in a page.
 * @param options.dispatcher - What Node sends through, when the caller times
 *   the socket.
 * @param options.replaySafe - Whether sending this again produces no second
 *   side effect. The test is whether the request names the upload it writes
 *   into: a part and a completion do, and opening one does not.
 * @returns The parsed answer.
 * @throws {UploadHttpError} When the Worker refuses.
 */
export async function askWorker<T>(
  url: string,
  init: RequestInit,
  options: {
    replaySafe: boolean;
    bound?: PartBound | { timeoutMs: number };
    idleTimeoutMs?: number;
    dispatcher?: unknown;
  },
): Promise<T> {
  const { replaySafe, bound, idleTimeoutMs, dispatcher } = options;
  const res = await httpRequest(
    url,
    dispatcher === undefined ? init : ({ ...init, dispatcher } as RequestInit),
    {
      replaySafe,
      ...bound,
      ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
    },
  );
  if (!res.ok) {
    throw new UploadHttpError(
      res.status,
      readIngestFailureCode(res.headers.get(INGEST_FAILURE_HEADER)),
    );
  }
  return (await res.json()) as T;
}

/**
 * Open a multipart upload for this ticket's key.
 * @param target - The signed ticket and where to send it.
 * @param bound - The upload's deadline and the caller's stop signal, when held.
 * @returns The upload's id and its first session token.
 * @throws {UploadHttpError} When the Worker refuses the ticket.
 */
async function openUpload(
  target: IngestTarget,
  bound: PartBound | undefined,
): Promise<OpenedUpload> {
  return askWorker<OpenedUpload>(
    `${target.uploadUrl}/uploads`,
    { method: "POST", headers: { "x-upload-ticket": target.ticket } },
    // This request carries no upload id: it mints one, and the Worker opens a
    // fresh multipart upload on every delivery. A replay leaves the first one
    // abandoned, holding parts R2 charges for.
    { replaySafe: false, ...(bound !== undefined && { bound }) },
  );
}

/**
 * Write one part and take the token that lets the next one through.
 * @param target - The signed ticket and where to send it.
 * @param uploadId - The upload these parts belong to.
 * @param part - This part's number, counting from one.
 * @param bytes - This part's bytes.
 * @param token - The token this part is authorised by.
 * @param cfg - The idle window a part is cut after.
 * @param bound - The upload's deadline and the caller's stop signal, when held.
 * @returns This part's receipt and the token for the next part.
 * @throws {UploadHttpError} When the Worker refuses the part.
 */
async function sendPart(
  target: IngestTarget,
  uploadId: string,
  part: number,
  bytes: Blob,
  token: string,
  cfg: Pick<UploadClientConfig, "uploadIdleTimeoutMs">,
  bound: PartBound | undefined,
): Promise<PartReceipt & { token: string }> {
  return askWorker<PartReceipt & { token: string }>(
    `${target.uploadUrl}/uploads/${uploadId}/parts/${part}`,
    { method: "PUT", body: bytes, headers: { "x-upload-token": token } },
    // Cut only once its bytes stop moving: in a page the transport reads
    // upload progress, in Node the caller's dispatcher times the socket. A
    // page holds no deadline, so it sets no total of its own; the Worker
    // refuses a part once the upload's deadline has come. The part number is
    // in the path, so a repeat writes the same part under the same number; R2
    // keeps the later write of a part, never both.
    {
      replaySafe: true,
      bound: { timeoutMs: MAX_TIMER_MS, ...bound },
      ...(target.dispatcher !== undefined
        ? { dispatcher: target.dispatcher }
        : { idleTimeoutMs: cfg.uploadIdleTimeoutMs }),
    },
  );
}
