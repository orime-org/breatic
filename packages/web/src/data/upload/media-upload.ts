// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  isAlreadyStored,
  type UploadTargetParams,
  type UploadTicket,
  type UploadTicketResponse,
} from '@web/data/upload/ingest-upload';
import type { IngestOutcome, UploadClientConfig } from '@breatic/shared';
import {
  errorStatus,
  retryTransient,
  STORAGE_FULL_STATUS,
  UNSUPPORTED_TYPE_STATUS,
} from '@web/data/upload/upload-retry';
import { BytesNotDelivered } from '@web/data/upload/finish-upload';

/**
 * The media upload orchestrator: ask for a ticket, send the bytes to the ingest
 * Worker, and report the outcome through injected callbacks (kept
 * dependency-injected so the async flow is unit-tested without the network).
 * Every browser upload goes through it — a canvas node, a chat attachment, a
 * project cover, a studio avatar — so it lives with the rest of the upload
 * transport rather than with any one of them.
 */

/**
 * Where an upload lands and what it is for.
 *
 * All of it is checked against this user's access when the ticket is issued
 * and then stored on the grant, so what the Worker reports back is read
 * against context we hold rather than context a client could restate.
 */
export type UploadContext = UploadTargetParams & {
  /** The node the bytes land on, when this upload has one. */
  nodeId?: string;
  /** The space that node lives in. */
  spaceId?: string;
  /** `mini_tool` for a mini-tool product. */
  source?: 'mini_tool';
  /** The mini-tool's name when `source` says so. */
  toolName?: string;
  /** True for a byproduct, registered without an activity-feed row of its own. */
  derived?: true;
};

/**
 * What the server filed a finished upload under, when it said: the address,
 * and the ledger row a cover or an avatar is then pointed at.
 */
export interface StoredUpload {
  fileUrl: string | undefined;
  assetId: string | undefined;
}

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
 * `unsupportedType` — the edge read the stored bytes and turned them down.
 * The bytes are what they are, so re-sending them meets the same refusal.
 * `transfer` — the transfer half ended without our server hearing anything:
 * the bytes never got out, or the edge turned them down (#237). Either way the
 * finish was never asked for, which makes this the one failure whose task row
 * nobody else will end.
 * `upload` — anything else along the way: the knobs, the ticket request, or a
 * finish that failed. A retry can fix it, and the server settles the row
 * itself whenever it answered.
 */
export const UPLOAD_FAILURE_REASONS = [
  'hash',
  'storage',
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
 * `taskId` is present exactly when the ticket was granted: past that point the
 * server holds a task row for this upload, carrying the budget it will be
 * judged against, so the browser leaves the outcome to that row and only keeps
 * the File for a retry, keyed by it. Absent, nothing on the server ever heard
 * of this upload — no row, no grant — so nobody is going to give it an ending
 * and the browser says so locally.
 */
export interface UploadFailure {
  reason: UploadFailureReason;
  taskId?: string;
}

/** The statuses that say something other than "try again". */
const FINAL_BY_STATUS: ReadonlyMap<number, UploadFailureReason> = new Map([
  [STORAGE_FULL_STATUS, 'storage'],
  [UNSUPPORTED_TYPE_STATUS, 'unsupportedType'],
]);

/**
 * Say which failure this one ended in.
 *
 * Read off the status because the sentence beside it is localized on the server
 * and matching on the copy would break the moment anyone edits it or a reader
 * switches language. Two statuses say something a retry cannot change: the
 * account is full, and the stored bytes are not a format we keep. Everything
 * else is about this attempt.
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
  return FINAL_BY_STATUS.get(errorStatus(err) ?? -1) ?? 'upload';
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
  requestTicket: (params: UploadTargetParams & {
    filename: string;
    contentType: string;
    size: number;
    /** Mandatory — a hashless upload is refused before it reaches here. */
    hash: string;
    nodeId?: string;
    spaceId?: string;
    source?: 'mini_tool';
    toolName?: string;
    derived?: true;
  }) => Promise<UploadTicketResponse>;
  /** Send the bytes to the ingest Worker and finish the upload. */
  sendToIngest: (
    file: File,
    ticket: UploadTicket,
    cfg: UploadClientConfig,
  ) => Promise<IngestOutcome>;
  /**
   * The bytes are delivered and the server has them.
   *
   * What the server filed the content under, when it said. A node ignores
   * it: the server writes the node's content through Yjs, and pinning anything
   * here would be a second writer for the one field that has one (design
   * §6.6). An upload with no node behind it has no other channel and this is
   * what it reads.
   */
  onSuccess: (stored: StoredUpload) => void;
  /**
   * Called when the upload cannot complete. `reason` tells the caller which
   * message to show: `hash` (we could not fingerprint the file — reload) vs
   * `upload` (config / ticket / parts failed — retry). `taskId` says whether
   * the server has a row for this upload; see {@link UploadFailure}.
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
 * What happens after the bytes land is not this function's to report. The
 * Worker tells the server, the server writes the node through Yjs, and the
 * node comes out of handling that way (design §5). This returning is only the
 * browser's half being over.
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
          filename: file.name,
          contentType: file.type,
          ...(context.projectId !== undefined
            ? {
              projectId: context.projectId,
              ...(context.purpose !== undefined && { purpose: context.purpose }),
            }
            : { studioId: context.studioId, purpose: context.purpose }),
          size: file.size,
          hash,
          ...(context.nodeId !== undefined && { nodeId: context.nodeId }),
          ...(context.spaceId !== undefined && { spaceId: context.spaceId }),
          ...(context.source !== undefined && { source: context.source }),
          ...(context.toolName !== undefined && { toolName: context.toolName }),
          ...(context.derived !== undefined && { derived: context.derived }),
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

  if (isAlreadyStored(answer)) {
    // Nothing moves. The server has already written the node's history and
    // published what ends its handling.
    deps.onSuccess({ fileUrl: answer.fileUrl, assetId: answer.assetId });
    return;
  }

  try {
    const outcome = await deps.sendToIngest(file, answer, cfg);
    deps.onSuccess({
      fileUrl: outcome.fileUrl,
      assetId: outcome.assetId ?? undefined,
    });
  } catch (err) {
    deps.onFailure({
      reason: failureOf(err),
      ...(answer.taskId !== undefined && { taskId: answer.taskId }),
    });
  }
}
