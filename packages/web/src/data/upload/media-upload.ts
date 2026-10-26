// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  isAlreadyStored,
  isOpenFailed,
  isRefused,
  type BatchTicketAnswer,
  type BatchTicketRequest,
  type UploadContext,
  type UploadTicket,
  type UploadTicketRequest,
  type UploadTicketResponse,
} from '@web/data/upload/ingest-upload';
import type { UploadClientConfig, UploadStatusResult } from '@breatic/shared';
import {
  errorStatus,
  retryTransient,
  STORAGE_FULL_STATUS,
  UNSUPPORTED_TYPE_STATUS,
} from '@web/data/upload/upload-retry';
import { assetsApi } from '@web/data/api/assets';
import {
  BytesNotDelivered,
  sendFileAndFinish,
  type QueuedFinish,
} from '@web/data/upload/finish-upload';
import { hashFile } from '@web/data/upload/hash';
import { waitForUploadEnding, type UploadEnding } from '@web/data/upload/upload-status';

/**
 * The media upload orchestrator: ask for a ticket, send the bytes to the ingest
 * Worker, and report the outcome through injected callbacks (kept
 * dependency-injected so the async flow is unit-tested without the network).
 * Every browser upload goes through it — a canvas node, a chat attachment, a
 * project cover, a studio avatar — so it lives with the rest of the upload
 * transport rather than with any one of them.
 */

/**
 * What the server filed a finished upload as: its address, the ledger row a
 * cover or an avatar is then pointed at, the kind it read off the stored bytes
 * and their pixel size.
 */
export type StoredUpload = UploadStatusResult;

/**
 * Why an upload ended in `onFailure` — the caller picks the message from this.
 *
 * Whichever one it is, the person who tried hears it in their own language.
 * Which of them it is decides whether a File is worth keeping for a retry, and
 * whether anything on the server is going to end this upload's task row — see
 * {@link UploadFailure}.
 *
 * `hash` — the browser could not fingerprint the file (worker / WASM / read
 * failure), which no retry of the SAME page fixes: the fix is a reload.
 * `storage` — the studio's account is out of room (#89), which no retry fixes
 * either, for the opposite reason: nothing is broken, there is simply nowhere
 * to put the bytes until the admin acts.
 * `rateLimited` — the reader went over a per-user limit on the upload routes
 * (tickets, or finishing uploads) in its window. A retry once the window has passed goes through.
 * `unsupportedType` — the edge read the stored bytes and turned them down.
 * The bytes are what they are, so re-sending them meets the same refusal.
 * `transfer` — the transfer half ended without our server hearing anything:
 * the bytes never got out, or the edge turned them down (#237). Either way the
 * finish was never asked for, which makes this the one failure whose task row,
 * when the upload has one, nobody else will end.
 * `upload` — anything else along the way: the knobs, the ticket request, or a
 * finish that failed. A retry can fix it, and the server settles the row
 * itself whenever it answered.
 */
export const UPLOAD_FAILURE_REASONS = [
  'hash',
  'storage',
  'rateLimited',
  'unsupportedType',
  'transfer',
  'upload',
] as const;

export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

/**
 * Whether a string the pipeline tagged is a reason this side knows.
 *
 * The crop lane carries a verdict out of the pipeline rather than reaching it
 * again, and it has one string to go on. Asking the list is what keeps that
 * lane current when the pipeline learns a new reason.
 * @param value - What was tagged.
 * @returns True when it is one of the reasons above.
 */
export function isUploadFailureReason(
  value: string,
): value is UploadFailureReason {
  return (UPLOAD_FAILURE_REASONS as readonly string[]).includes(value);
}

/**
 * How an upload ended badly, and whether the server knows about it (#186
 * §3.7.3).
 *
 * `taskId` is present exactly when the ticket opened a task row, which only an
 * upload with a node behind it does: the server then holds the row, carrying
 * the budget it will be judged against, so the browser leaves the outcome to
 * that row and only keeps the File for a retry, keyed by it. Absent — the
 * ticket was refused, or the upload has no node (a focus crop, a chat
 * attachment, a cover, an avatar) — no row exists, nobody on the server is
 * going to give it an ending, and the browser says so locally.
 */
export interface UploadFailure {
  reason: UploadFailureReason;
  taskId?: string;
}

/** Too Many Requests (RFC 6585 §4): a per-user limit on the upload routes. */
const RATE_LIMITED_STATUS = 429;

/** The statuses that name their own reason; whether a retry helps is `uploadRetryCanChange`'s call. */
const REASON_BY_STATUS: ReadonlyMap<number, UploadFailureReason> = new Map([
  [STORAGE_FULL_STATUS, 'storage'],
  [UNSUPPORTED_TYPE_STATUS, 'unsupportedType'],
  [RATE_LIMITED_STATUS, 'rateLimited'],
]);

/**
 * Say which failure this one ended in.
 *
 * Read off the status because the sentence beside it is localized on the server
 * and matching on the copy would break the moment anyone edits it or a reader
 * switches language. A status with no reason of its own is the catch-all.
 *
 * Hashing is not read off an error at all — it is refused before anything is
 * sent.
 * @param err - The rejection value.
 * @returns The failure reason to report.
 */
function failureOf(err: unknown): UploadFailureReason {
  // Asked first because it is about which half broke rather than what the
  // answer said. The edge answers the browser rather than our server, so a
  // refusal from it reaches here with a status that says nothing about whether
  // anyone will end the row — and nobody will.
  if (err instanceof BytesNotDelivered) return 'transfer';
  return REASON_BY_STATUS.get(errorStatus(err) ?? -1) ?? 'upload';
}

/**
 * The failure a finish that did not register ended in. The status query names
 * the reason the server recorded; only a format the edge refused has a
 * failure of its own, since re-sending the same bytes meets the same refusal.
 * @param ending - What the status query answered.
 * @returns The failure reason to report.
 */
function failureOfEnding(ending: Exclude<UploadEnding, { state: 'completed' }>): UploadFailureReason {
  return ending.state === 'failed' && ending.reason === 'unsupported_type'
    ? 'unsupportedType'
    : 'upload';
}

/** Injected dependencies for {@link runMediaUpload} (network + result sinks). */
export interface MediaUploadDeps {
  /** Fetch the session-cached upload knobs (`assetsApi.fetchUploadConfig`). */
  getUploadConfig: () => Promise<UploadClientConfig>;
  /**
   * Fingerprint the file (`hashFile`). `null` = the browser could not hash it;
   * the upload is then REFUSED up front (user decision 2026-07-26) — see
   * {@link runMediaUpload}.
   */
  hashFile: (file: File) => Promise<string | null>;
  /** Ask for a ticket, or be told the studio already holds this content. */
  requestTicket: (params: UploadTicketRequest) => Promise<UploadTicketResponse>;
  /** Send the bytes to the ingest Worker and have our server queue the finish. */
  sendToIngest: (
    file: File,
    ticket: UploadTicket,
    cfg: UploadClientConfig,
    onPartLanded?: (bytesLanded: number) => void,
  ) => Promise<QueuedFinish>;
  /**
   * Wait for how a queued finish ended (`waitForUploadEnding` unless a test
   * stands in for it).
   */
  waitForEnding?: (storageKey: string) => Promise<UploadEnding>;
  /** Told the share of the file that has landed, from 0 to 1, after each part. */
  onProgress?: (fraction: number) => void;
  /**
   * The server answered: an opened upload or one it could not open, either of
   * which opened the upload's task row, or a copy the studio already holds.
   * Told once, before any bytes move.
   */
  onAnswered?: () => void;
  /**
   * The bytes are delivered and the server has them.
   *
   * What the server filed the content as. A node ignores
   * it: the server writes the node's content through Yjs, and pinning anything
   * here would be a second writer for the one field that has one (design
   * §6.6). An upload with no node behind it has no other channel and this is
   * what it reads.
   */
  onSuccess: (stored: StoredUpload) => void;
  /**
   * Called when the upload cannot complete. `reason` tells the caller which
   * message to show; see {@link UPLOAD_FAILURE_REASONS} for what each one
   * means. `taskId` says whether the server has a row for this upload; see
   * {@link UploadFailure}.
   */
  onFailure: (outcome: UploadFailure) => void;
  /** Backoff sleep override (tests only — production uses real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Upload a media file (#173 design §4): fetch the knobs → hash the bytes
 * (Web Worker, any size) → ask for a ticket — the studio already holding this
 * content answers instantly and nothing moves — else send the parts to the
 * ingest Worker and complete. The two halves retry under different rules: the
 * ticket request through `retryTransient` on the knobs above, each part inside
 * the shared HTTP transport on its own compiled-in policy. Never throws — both
 * outcomes route through `onSuccess` / `onFailure`.
 *
 * NO HASH, NO UPLOAD (user decision 2026-07-26). The hash the browser computes
 * answers one question — does this studio already hold this content — and the
 * server refuses a request without one, so a file that cannot be fingerprinted
 * is refused here rather than sent and rejected.
 *
 * Finishing runs on the server as a job (inner#1367 §4.2a). An upload with a
 * node behind it is over for the page once that job is queued: the server
 * writes the node through Yjs, and only a finish that did not register comes
 * back here, through `onFailure`, when the status query has its ending. An
 * upload with no node waits for that ending and reads its result from it.
 * @param file - The media file to upload.
 * @param context - Where it lands and what it is for.
 * @param deps - Injected config / hash / network / result callbacks.
 */
export async function runMediaUpload(
  file: File,
  context: UploadContext,
  deps: MediaUploadDeps,
): Promise<void> {
  let cfg: UploadClientConfig;
  let answer: UploadTicketResponse;
  try {
    cfg = await deps.getUploadConfig();
    const hash = await deps.hashFile(file);
    if (hash === null) {
      // Refused up front: nothing asked for, nothing sent, no bandwidth burnt.
      deps.onFailure({ reason: 'hash' });
      return;
    }
    answer = await retryTransient(
      () =>
        deps.requestTicket({
          ...context,
          filename: file.name,
          contentType: file.type,
          size: file.size,
          hash,
        }),
      {
        attempts: cfg.clientMaxAttempts,
        baseDelayMs: cfg.clientRetryBaseDelayMs,
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
  } catch (err) {
    deps.onFailure({ reason: failureOf(err) });
    return;
  }

  await deliverTicket(file, answer, cfg, deps, deps);
}

/** Where one file's outcome goes. */
type UploadSinks = Pick<MediaUploadDeps, 'onProgress' | 'onAnswered' | 'onSuccess' | 'onFailure'>;

/** What the delivery half calls out to. */
type DeliveryDeps = Pick<MediaUploadDeps, 'sendToIngest' | 'waitForEnding'>;

/**
 * The half after the ticket: settle a dedup hit or an open our server could
 * not make, or send the bytes, have the finish queued and, for an upload with
 * no node, wait for its ending.
 * @param file - The file.
 * @param answer - What the ticket request answered for it.
 * @param cfg - The upload knobs.
 * @param sinks - Where its outcome goes.
 * @param deps - The network.
 */
async function deliverTicket(
  file: File,
  answer: UploadTicketResponse,
  cfg: UploadClientConfig,
  sinks: UploadSinks,
  deps: DeliveryDeps,
): Promise<void> {
  sinks.onAnswered?.();
  if (isAlreadyStored(answer)) {
    // Nothing moves. When a node is behind this upload, the server has already
    // written its history and published what ends its handling; an upload with
    // no node reads what the answer names.
    sinks.onSuccess({
      fileUrl: answer.fileUrl,
      assetId: answer.assetId,
      kind: answer.kind,
      width: answer.width,
      height: answer.height,
    });
    return;
  }

  const { taskId } = answer;
  if (isOpenFailed(answer)) {
    // Our server could not open the upload at the Worker and has settled the
    // row itself; to the page it is the same as bytes that never got out, so
    // the File is kept for a retry.
    sinks.onFailure({ reason: 'transfer', ...(taskId !== undefined && { taskId }) });
    return;
  }

  let queued: QueuedFinish;
  try {
    const { onProgress } = sinks;
    queued =
      onProgress === undefined
        ? await deps.sendToIngest(file, answer, cfg)
        : await deps.sendToIngest(file, answer, cfg, (landed) => {
          onProgress(landed / file.size);
        });
  } catch (err) {
    sinks.onFailure({
      reason: failureOf(err),
      ...(taskId !== undefined && { taskId }),
    });
    return;
  }

  const ending = (deps.waitForEnding ?? waitForUploadEnding)(queued.storageKey);
  if (taskId !== undefined) {
    void ending.then((end) => {
      if (end.state !== 'completed') sinks.onFailure({ reason: failureOfEnding(end), taskId });
    });
    return;
  }
  const end = await ending;
  if (end.state !== 'completed') {
    sinks.onFailure({ reason: failureOfEnding(end) });
    return;
  }
  sinks.onSuccess(end.result);
}

/** One file of a batch, the node it lands on, and where its outcome goes. */
export interface BatchUploadEntry extends UploadSinks {
  file: File;
  nodeId: string;
}

/** Injected dependencies for {@link runMediaUploadBatch}. */
export interface BatchUploadDeps
  extends Pick<MediaUploadDeps, 'getUploadConfig' | 'hashFile' | 'sendToIngest' | 'waitForEnding' | 'sleep'> {
  /** Ask for every file's ticket in one request. */
  requestTicketBatch: (request: BatchTicketRequest) => Promise<BatchTicketAnswer[]>;
}

/**
 * Upload one browser tool's export of many files (inner#1303 §7): hash them
 * all, ask for every ticket in one request, then send each file the server
 * did not already hold. Each file's outcome goes to its own entry, by the same
 * rules as {@link runMediaUpload}; a file the server refused before any bytes
 * moved fails as `storage` when its account is full and `upload` otherwise.
 * Never throws.
 * @param entries - The files, each on its own node.
 * @param context - Where they land and which tool made them.
 * @param deps - Injected config / hash / network.
 */
export async function runMediaUploadBatch(
  entries: readonly BatchUploadEntry[],
  context: Omit<BatchTicketRequest, 'items'>,
  deps: BatchUploadDeps,
): Promise<void> {
  let cfg: UploadClientConfig;
  let hashes: (string | null)[];
  try {
    cfg = await deps.getUploadConfig();
    hashes = await Promise.all(entries.map((entry) => deps.hashFile(entry.file)));
  } catch (err) {
    for (const entry of entries) entry.onFailure({ reason: failureOf(err) });
    return;
  }
  const asked = entries.flatMap((entry, index) => {
    const hash = hashes[index];
    if (hash === null || hash === undefined) {
      entry.onFailure({ reason: 'hash' });
      return [];
    }
    return [{ entry, hash }];
  });
  if (asked.length === 0) return;

  let answers: BatchTicketAnswer[];
  try {
    answers = await retryTransient(
      () =>
        deps.requestTicketBatch({
          ...context,
          items: asked.map(({ entry, hash }) => ({
            filename: entry.file.name,
            contentType: entry.file.type,
            size: entry.file.size,
            hash,
            nodeId: entry.nodeId,
          })),
        }),
      {
        attempts: cfg.clientMaxAttempts,
        baseDelayMs: cfg.clientRetryBaseDelayMs,
        ...(deps.sleep !== undefined && { sleep: deps.sleep }),
      },
    );
  } catch (err) {
    const reason = failureOf(err);
    for (const { entry } of asked) entry.onFailure({ reason });
    return;
  }

  await Promise.all(
    asked.map(({ entry }, index) => {
      const answer = answers[index];
      if (answer === undefined) {
        entry.onFailure({ reason: 'upload' });
        return Promise.resolve();
      }
      if (isRefused(answer)) {
        entry.onFailure({ reason: answer.refused.reason === 'storage' ? 'storage' : 'upload' });
        return Promise.resolve();
      }
      return deliverTicket(entry.file, answer, cfg, entry, deps);
    }),
  );
}

/** Why an upload did not complete; the caller picks the message from it. */
export class UploadFailedError extends Error {
  /**
   * Name the reason the upload did not complete.
   * @param reason - The pipeline's verdict, also the message.
   */
  constructor(readonly reason: UploadFailureReason) {
    super(reason);
    this.name = 'UploadFailedError';
  }
}

/**
 * Run the pipeline against the real network, for an upload with no node
 * behind it — it reads its result here rather than from Yjs.
 * @param file - The file to upload.
 * @param context - Where it lands and what it is for.
 * @param onProgress - Told the share of the file that has landed, after each part.
 * @returns What the server filed the upload under.
 * @throws {UploadFailedError} When the upload does not complete.
 */
export function uploadMedia(
  file: File,
  context: UploadContext,
  onProgress?: (fraction: number) => void,
): Promise<StoredUpload> {
  return new Promise((resolve, reject) => {
    void runMediaUpload(file, context, {
      getUploadConfig: assetsApi.fetchUploadConfig,
      hashFile,
      requestTicket: assetsApi.requestUploadTicket,
      sendToIngest: sendFileAndFinish,
      ...(onProgress !== undefined && { onProgress }),
      onSuccess: resolve,
      onFailure: (outcome) => reject(new UploadFailedError(outcome.reason)),
    });
  });
}
