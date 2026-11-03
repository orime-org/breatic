// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Read stored ledger JSON and hand it back only when every byte is the one
 * its receipt measured (inner#1306). Which receipt belongs to which source,
 * and who may read it, is the caller's to have settled first.
 */

import { MAX_TIMER_MS } from '@shared/http/constants.js';
import { assertBeforeDeadline, untilDeadline } from '@shared/http/deadline.js';
import { readBytesWithin } from '@shared/http/read-within.js';
import { httpRequest } from '@shared/http/request.js';
import { reduceMediaType } from '@shared/upload/media-type.js';

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
