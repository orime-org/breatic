// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Read a stored source ledger companion and hand it back only when every byte
 * is the one its receipt measured (inner#1306).
 *
 * A ready receipt says a small object was stored; it is not a usable frame
 * table. The table is usable once the whole body has arrived under the
 * caller's one read deadline, its size and SHA-256 equal the receipt's, and
 * the strict parser accepts it against the receipt and the current read
 * policy. Anything less is a refusal and no part of the arrays is returned.
 *
 * The receipt is only data here: which receipt belongs to which registered
 * source, and who may read it, is the caller's to have settled first.
 */

import { z } from 'zod';

import { MAX_TIMER_MS } from '@shared/http/constants.js';
import { assertBeforeDeadline, untilDeadline } from '@shared/http/deadline.js';
import { readBytesWithin } from '@shared/http/read-within.js';
import { httpRequest } from '@shared/http/request.js';
import { reduceMediaType } from '@shared/upload/media-type.js';
import { parseVideoSourceLedger, videoSourceLedgerReceiptSchema } from '@shared/upload/video-source-ledger.js';
import type { VideoSourceLedgerCompanion, VideoSourceLedgerReceipt } from '@shared/upload/video-source-ledger-types.js';

/** Why a stored companion was not handed back. */
export class VideoSourceLedgerReadRefused extends Error {
  /** Which check refused it. */
  readonly reason: 'receipt' | 'limits' | 'over_limit' | 'status' | 'content_type' | 'size' | 'digest' | 'content';

  /**
   * Build one.
   * @param reason - Which check refused it.
   */
  constructor(reason: VideoSourceLedgerReadRefused['reason']) {
    super(`source ledger read refused: ${reason}`);
    this.name = 'VideoSourceLedgerReadRefused';
    this.reason = reason;
  }
}

/** The current read policy: the stored object's byte ceiling and the parser's two count ceilings. */
export interface VideoSourceLedgerReadLimits { maxBytes: number; maxPhysicalFrames: number; maxOccurrences: number }

const ceiling = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** The read policy as the presentation response carries it. */
export const videoSourceLedgerReadLimitsSchema: z.ZodType<VideoSourceLedgerReadLimits> = z.strictObject({
  maxBytes: ceiling, maxPhysicalFrames: ceiling, maxOccurrences: ceiling,
});

/**
 * Lowercase SHA-256 of the bytes exactly as they arrived.
 * @param bytes - The received body.
 * @returns The hex digest.
 * @throws {DOMException} When the platform cannot compute SHA-256.
 */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Stop the unread body of a response being refused, so its connection is let go.
 * @param res - The response.
 * @returns Once the body has been cancelled.
 */
async function drop(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * Read a source ledger companion against its receipt.
 * @param receipt - The ready receipt the caller has already bound to the current source.
 * @param limits - The current read policy, captured once for this read.
 * @param options - The one absolute read deadline and the caller's signal.
 * @param options.deadlineAt - When this read must be done, in epoch ms; never the receipt's own producer deadline.
 * @param options.signal - The caller's signal.
 * @returns The whole validated companion.
 * @throws {VideoSourceLedgerReadRefused} When the receipt, policy, response or bytes are not the stored companion.
 * @throws {DeadlinePassed} When the read deadline comes before the companion is validated.
 * @throws {BodyTooLarge} When more bytes arrive than the receipt measured.
 * @throws {EmptyBody} When the response carries no body.
 * @throws {Error} The transport's own failure, or the caller's abort reason.
 */
export async function readVideoSourceLedger(
  receipt: VideoSourceLedgerReceipt,
  limits: VideoSourceLedgerReadLimits,
  options: { deadlineAt: number; signal?: AbortSignal },
): Promise<VideoSourceLedgerCompanion> {
  const { deadlineAt, signal } = options;
  const policy = videoSourceLedgerReadLimitsSchema.safeParse(limits);
  if (!policy.success) throw new VideoSourceLedgerReadRefused('limits');
  const stored = videoSourceLedgerReceiptSchema.safeParse(receipt);
  if (!stored.success) throw new VideoSourceLedgerReadRefused('receipt');
  const measured = stored.data;
  if (measured.size > policy.data.maxBytes || measured.physicalFrameCount > policy.data.maxPhysicalFrames ||
    measured.occurrenceCount > policy.data.maxOccurrences) throw new VideoSourceLedgerReadRefused('over_limit');

  const value = await readMeasuredVideoJson(measured, { deadlineAt, ...(signal === undefined ? {} : { signal }) });
  const companion = parseVideoSourceLedger(value, measured, policy.data);
  if (companion === null) throw new VideoSourceLedgerReadRefused('content');
  return companion;
}

/**
 * Read exact measured JSON bytes under one absolute deadline.
 * @param measured - Already validated storage measurements.
 * @param measured.url - The immutable stored object address.
 * @param measured.size - Its measured byte length.
 * @param measured.sha256 - Its measured lowercase SHA-256 digest.
 * @param measured.contentType - Its measured media type.
 * @param options - The caller's deadline and cancellation lifetime.
 * @param options.deadlineAt - The absolute read deadline in epoch milliseconds.
 * @param options.signal - The caller's cancellation lifetime.
 * @returns Complete decoded JSON, never a partial body.
 * @throws {VideoSourceLedgerReadRefused} When response measurements or JSON differ.
 * @throws {DeadlinePassed} When the absolute deadline expires.
 * @throws {BodyTooLarge} When the body exceeds the measured size.
 * @throws {EmptyBody} When no body exists.
 * @throws {Error} When transport fails or the caller cancels.
 */
export async function readMeasuredVideoJson(
  measured: { url: string; size: number; sha256: string; contentType: string },
  options: { deadlineAt: number; signal?: AbortSignal },
): Promise<unknown> {
  const { deadlineAt, signal } = options;
  signal?.throwIfAborted();
  const until = untilDeadline(deadlineAt);
  const bound = signal === undefined ? until.signal : AbortSignal.any([until.signal, signal]);
  const res = await httpRequest(measured.url, { method: 'GET' }, { replaySafe: true, timeoutMs: until.timeoutMs, signal: bound });
  if (!res.ok) {
    await drop(res);
    throw new VideoSourceLedgerReadRefused('status');
  }
  // The headers spent part of the one deadline; the body gets what is left,
  // never a fresh budget.
  try {
    signal?.throwIfAborted();
    assertBeforeDeadline(deadlineAt);
  } catch (err) {
    await drop(res);
    throw err;
  }
  if (reduceMediaType(res.headers.get('content-type')) !== measured.contentType) {
    await drop(res);
    throw new VideoSourceLedgerReadRefused('content_type');
  }

  // The receipt's size already passed the policy, so it is the tighter cap.
  // Content-Length is not consulted: only the bytes that arrive count.
  const bytes = await readBytesWithin(res, Math.min(deadlineAt - Date.now(), MAX_TIMER_MS), measured.size, bound);
  if (bytes.byteLength !== measured.size) throw new VideoSourceLedgerReadRefused('size');
  const digest = await digestOf(bytes);
  signal?.throwIfAborted();
  assertBeforeDeadline(deadlineAt);
  if (digest !== measured.sha256) throw new VideoSourceLedgerReadRefused('digest');

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new VideoSourceLedgerReadRefused('content');
  }
  signal?.throwIfAborted();
  assertBeforeDeadline(deadlineAt);
  return value;
}
