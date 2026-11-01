// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import { assertBeforeDeadline } from '@shared/http/deadline.js';
import { presentationFrameCount, presentationTableSchema, type VideoPresentationTable } from '@shared/mini-tools/video-presentation-table.js';
import { readMeasuredVideoJson, VideoSourceLedgerReadRefused } from '@shared/upload/read-video-source-ledger.js';
import { videoPresentationTableReceiptSchema } from '@shared/upload/video-source-ledger.js';
import type { VideoSourceLedgerReceiptV2 } from '@shared/upload/video-source-ledger-types.js';
import { videoPresentationCompactSchema, videoPresentationLedgerReceiptSchema } from '@shared/upload/video-presentation-version.js';

/** The byte budget for a compact presentation table; frame counts are not capped. */
export interface VideoPresentationTableReadLimits { maxBytes: number }
/** Strict public read policy, independent from the legacy full-ledger policy. */
export const videoPresentationTableReadLimitsSchema: z.ZodType<VideoPresentationTableReadLimits> = z.strictObject({
  maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/**
 * Read and validate the compact table measured by a v2 receipt.
 * @param receipt - The compact object's measurements, already bound to the source by the caller.
 * @param limits - The current byte policy.
 * @param options - One absolute deadline and optional caller cancellation.
 * @param options.deadlineAt - The absolute read deadline in epoch milliseconds.
 * @param options.signal - The caller's cancellation lifetime.
 * @returns The complete validated run table without expanding frames.
 * @throws {VideoSourceLedgerReadRefused} When receipt, policy, response or table validation fails.
 * @throws {DeadlinePassed} When the absolute deadline expires.
 * @throws {BodyTooLarge} When more bytes arrive than the receipt measured.
 * @throws {EmptyBody} When the response has no body.
 * @throws {Error} When transport fails or the caller cancels.
 */
export async function readVideoPresentationTable(
  receipt: VideoSourceLedgerReceiptV2['table'],
  limits: VideoPresentationTableReadLimits,
  options: { deadlineAt: number; signal?: AbortSignal },
): Promise<VideoPresentationTable> {
  const policy = videoPresentationTableReadLimitsSchema.safeParse(limits);
  if (!policy.success) throw new VideoSourceLedgerReadRefused('limits');
  const stored = videoPresentationTableReceiptSchema.safeParse(receipt);
  if (!stored.success) throw new VideoSourceLedgerReadRefused('receipt');
  if (stored.data.size > policy.data.maxBytes) throw new VideoSourceLedgerReadRefused('over_limit');
  const value = await readMeasuredVideoJson({ ...stored.data, contentType: 'application/json' }, options);
  const parsed = presentationTableSchema.safeParse(value);
  options.signal?.throwIfAborted();
  assertBeforeDeadline(options.deadlineAt);
  if (!parsed.success || presentationFrameCount(parsed.data) !== stored.data.frameCount) throw new VideoSourceLedgerReadRefused('content');
  return parsed.data;
}

/**
 * Read the compact object measured by a full-ledger receipt and hand back its S1 table once the whole envelope matches the receipt.
 * @param receipt - The complete receipt, already bound to the source by the caller.
 * @param limits - The current byte policy.
 * @param options - One absolute deadline and optional caller cancellation.
 * @param options.deadlineAt - The absolute read deadline in epoch milliseconds.
 * @param options.signal - The caller's cancellation lifetime.
 * @returns The validated inner table without expanding frames.
 * @throws {VideoSourceLedgerReadRefused} When receipt, policy, response or envelope validation fails.
 * @throws {DeadlinePassed} When the absolute deadline expires.
 * @throws {BodyTooLarge} When more bytes arrive than the receipt measured.
 * @throws {EmptyBody} When the response has no body.
 * @throws {Error} When transport fails or the caller cancels.
 */
export async function readVideoPresentationCompact(
  receipt: unknown,
  limits: VideoPresentationTableReadLimits,
  options: { deadlineAt: number; signal?: AbortSignal },
): Promise<VideoPresentationTable> {
  const policy = videoPresentationTableReadLimitsSchema.safeParse(limits);
  if (!policy.success) throw new VideoSourceLedgerReadRefused('limits');
  const stored = videoPresentationLedgerReceiptSchema.safeParse(receipt);
  if (!stored.success) throw new VideoSourceLedgerReadRefused('receipt');
  const { table } = stored.data;
  if (table.size > policy.data.maxBytes) throw new VideoSourceLedgerReadRefused('over_limit');
  const value = await readMeasuredVideoJson(table, options);
  const parsed = videoPresentationCompactSchema.safeParse(value);
  options.signal?.throwIfAborted();
  assertBeforeDeadline(options.deadlineAt);
  if (!parsed.success || parsed.data.sourceFingerprint !== stored.data.sourceFingerprint || parsed.data.toolInputId !== stored.data.toolInputId ||
    parsed.data.planSha256 !== stored.data.planSha256 || presentationFrameCount(parsed.data.presentation) !== table.frameCount) {
    throw new VideoSourceLedgerReadRefused('content');
  }
  return parsed.data.presentation;
}
