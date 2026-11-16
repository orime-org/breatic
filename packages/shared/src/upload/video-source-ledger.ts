// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from 'zod';
import type {
  ExactPresentationTime, VideoEditSpan, VideoSourceLedgerFailureClass, VideoSourceRun,
} from '@shared/upload/video-source-ledger-types.js';

export const positiveCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const positiveDecimal = z.string().refine(value => /^\d+$/.test(value) && BigInt(value) > 0n);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const attempt = z.strictObject({ jobId: z.string().min(1), deadlineAt: positiveCount });

/**
 * Check reduction after canonical decimal syntax has passed.
 * @param value - Valid integer components with a positive denominator.
 * @returns Whether the fraction is reduced, including zero as 0/1.
 * @throws {never} The preceding schema validates integer syntax.
 */
function reduced(value: ExactPresentationTime): boolean {
  let numerator = BigInt(value.numerator);
  let denominator = BigInt(value.denominator);
  if (numerator < 0n) numerator = -numerator;
  while (denominator !== 0n) { const remainder = numerator % denominator; numerator = denominator; denominator = remainder; }
  return numerator === 1n;
}

/**
 * Compare validated exact times without changing their representation.
 * @param left - A validated exact time.
 * @param right - A validated exact time.
 * @returns The signed cross-product difference.
 * @throws {never} Both fractions have validated integer components.
 */
export function compare(left: ExactPresentationTime, right: ExactPresentationTime): bigint {
  return BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
}

// Transforms run only after their complete input schema succeeds. Invalid
// integer strings never reach BigInt or the cross-reference checks.
export const exactTime = z.strictObject({
  numerator: z.string().regex(/^(?:0|[1-9]\d*|-[1-9]\d*)$/), denominator: z.string().regex(/^[1-9]\d*$/),
}).transform((value, ctx) => {
  if (!reduced(value)) { ctx.addIssue({ code: 'custom', message: 'Expected a reduced exact fraction' }); return z.NEVER; }
  return value;
});
export const sourceClock = z.strictObject({ numerator: positiveDecimal, denominator: positiveDecimal });
export const safeTick = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const httpsUrl = z.url().refine(value => value.startsWith('https://'));
export const editSpan = z.strictObject({ sourceStart: exactTime, sourceEnd: exactTime, presentationStart: exactTime, rate: exactTime });

/**
 * Check that every run steps forward (a single frame steps by 0) and its last tick stays safe.
 * @param runs - Structurally valid source runs.
 * @returns Whether the runs are well formed.
 * @throws {never} Never.
 */
export function sourceRunsValid(runs: readonly VideoSourceRun[]): boolean {
  return runs.every(run => (run.count === 1 ? run.step === 0 : run.step > 0) &&
    BigInt(run.start) + BigInt(run.count - 1) * BigInt(run.step) <= BigInt(Number.MAX_SAFE_INTEGER));
}

/**
 * Where a span ends in presentation time: its start plus its source length divided by its rate.
 * @param span - A structurally valid span with a positive rate.
 * @returns The end as an exact time.
 * @throws {never} Never.
 */
function presentationEnd(span: VideoEditSpan): ExactPresentationTime {
  const [start, sourceStart, sourceEnd, rate] = [span.presentationStart, span.sourceStart, span.sourceEnd, span.rate].map(value => [BigInt(value.numerator), BigInt(value.denominator)] as const);
  const length = sourceEnd![0] * sourceStart![1] - sourceStart![0] * sourceEnd![1];
  const lengthDenominator = sourceEnd![1] * sourceStart![1] * rate![0];
  return { numerator: String(start![0] * lengthDenominator + length * rate![1] * start![1]), denominator: String(start![1] * lengthDenominator) };
}

/**
 * Check that spans are non-empty, play forward, start at or after zero and follow each other without overlap.
 * @param spans - Structurally valid spans in presentation order.
 * @returns Whether the spans are well formed.
 * @throws {never} Never.
 */
export function spansValid(spans: readonly VideoEditSpan[]): boolean {
  let previousEnd: ExactPresentationTime = { numerator: '0', denominator: '1' };
  for (const span of spans) {
    if (BigInt(span.rate.numerator) <= 0n || compare(span.sourceStart, span.sourceEnd) >= 0n || compare(span.presentationStart, previousEnd) < 0n) return false;
    previousEnd = presentationEnd(span);
  }
  return true;
}

/** The compact object's exact measurements, shared by receipts and their bounded reader. */
export const videoPresentationTableReceiptSchema = z.strictObject({ url: httpsUrl, sha256: hash, size: positiveCount, frameCount: positiveCount });

// Codes the source bytes and the frozen policy decide: producing again fails the same way. Limits frozen at admission
// (`resource_limit`, `source_ledger_over_cap`) are content; real exhaustion is the transient `resource_exhausted`.
// The presentation candidate codes on the last line share the rule and are never written into ledger state.
const CONTENT_FAILURES: ReadonlySet<string> = new Set([
  'source_ledger_format_unknown', 'source_ledger_selection_unknown', 'unsupported_rate', 'invalid_edit', 'invalid_clock', 'invalid_ledger',
  'classification_unknown', 'clock_unknown', 'metadata_unknown', 'audio_clock_unknown', 'probe_invalid', 'source_over_cap', 'no_presented_frames',
  'resource_limit', 'source_ledger_over_cap',
  'too_long', 'packed_over_cap', 'packed_clock_mismatch',
  // A re-probe under the same frozen facts that plans another toolInputId fails the same way every time (§91 D2-3).
  'source_ledger_plan_mismatch',
]);

/**
 * Classify a source ledger or presentation candidate failure code; every code outside the content list is transient.
 * @param errorCode - The producer's or the store's failure code.
 * @returns `content` when the source bytes decide the failure, otherwise `transient`.
 * @throws {never} Never.
 */
export function classifyVideoSourceLedgerFailure(errorCode: string): VideoSourceLedgerFailureClass {
  return CONTENT_FAILURES.has(errorCode) ? 'content' : 'transient';
}

export { videoSourceLedgerKeyFor, videoSourceLedgerTableKeyFor } from '@shared/upload/video-presentation-keys.js';
