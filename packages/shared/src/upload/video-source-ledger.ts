// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import { presentationTableSchema } from '@shared/mini-tools/video-presentation-table.js';
import type {
  ExactPresentationTime, VideoEditSpan, VideoSourceLedgerCompanion, VideoSourceLedgerFailureClass, VideoSourceLedgerParseLimits, VideoSourceLedgerReceipt,
  VideoSourceLedgerReceiptV2, VideoSourceLedgerState, VideoSourceLedgerV2, VideoSourceRun,
} from '@shared/upload/video-source-ledger-types.js';

const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const uint32 = ordinal.max(0xffffffff);
const signedDecimal = z.string().regex(/^-?\d+$/);
const unsignedDecimal = z.string().regex(/^\d+$/);
const positiveDecimal = z.string().refine(value => /^\d+$/.test(value) && BigInt(value) > 0n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const attempt = z.strictObject({ jobId: z.string().min(1), deadlineAt: positiveCount });
const strategy = z.enum(['iso_explicit_rate_one', 'iso_unedited_rate_one', 'matroska_rate_one']);
const identity = { schemaVersion: z.literal(1), sourceFingerprint: hash, producerVersion: z.literal(1), attempt };

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
function compare(left: ExactPresentationTime, right: ExactPresentationTime): bigint {
  return BigInt(left.numerator) * BigInt(right.denominator) - BigInt(right.numerator) * BigInt(left.denominator);
}

// Transforms run only after their complete input schema succeeds. Invalid
// integer strings never reach BigInt or the cross-reference checks.
const exactTime = z.strictObject({
  numerator: z.string().regex(/^(?:0|[1-9]\d*|-[1-9]\d*)$/), denominator: z.string().regex(/^[1-9]\d*$/),
}).transform((value, ctx) => {
  if (!reduced(value)) { ctx.addIssue({ code: 'custom', message: 'Expected a reduced exact fraction' }); return z.NEVER; }
  return value;
});
const editInterval = z.strictObject({ editOccurrence: ordinal, empty: z.boolean(), start: exactTime, end: exactTime }).transform((value, ctx) => {
  if (compare(value.start, value.end) > 0n) { ctx.addIssue({ code: 'custom', message: 'Edit interval is reversed' }); return z.NEVER; }
  return value;
});
const occurrence = z.strictObject({
  presentationOrdinal: ordinal, editOccurrence: ordinal, rawDecodeOrdinal: ordinal, sourcePtsTicks: signedDecimal,
  mappedPts: exactTime, displayStart: exactTime, displayEnd: exactTime,
}).transform((value, ctx) => {
  if (compare(value.displayStart, value.displayEnd) >= 0n) { ctx.addIssue({ code: 'custom', message: 'Display interval requires positive width' }); return z.NEVER; }
  return value;
});
const presentation = z.strictObject({ edits: z.array(editInterval), frames: z.array(occurrence) });
const sourceClock = z.strictObject({ numerator: positiveDecimal, denominator: positiveDecimal });
const physicalFrame = z.strictObject({ rawDecodeOrdinal: ordinal, ptsTicks: signedDecimal });
const isoEdit = z.strictObject({ segmentDurationMovieTicks: unsignedDecimal, mediaTimeTrackTicks: signedDecimal, mediaRateFixed16_16: signedDecimal });
const sampleTiming = z.strictObject({
  decodeRuns: z.array(z.strictObject({ sampleCount: uint32, deltaTicks: unsignedDecimal })),
  cttsVersion: z.union([z.literal(0), z.literal(1), z.null()]),
  compositionRuns: z.array(z.strictObject({ sampleCount: uint32, offsetTicks: signedDecimal })).nullable(),
  compositionShift: z.strictObject({
    version: z.union([z.literal(0), z.literal(1)]), compositionToDtsShift: signedDecimal, leastDecodeToDisplayDelta: signedDecimal,
    greatestDecodeToDisplayDelta: signedDecimal, compositionStartTime: signedDecimal, compositionEndTime: signedDecimal,
  }).nullable(),
}).transform((value, ctx) => {
  if ((value.cttsVersion === null) !== (value.compositionRuns === null) ||
    (value.cttsVersion === 0 && value.compositionRuns?.some(run => BigInt(run.offsetTicks) < 0n))) {
    ctx.addIssue({ code: 'custom', message: 'Composition timing differs from its versioned metadata' }); return z.NEVER;
  }
  return value;
});
const isoTrack = z.strictObject({
  trackId: uint32.positive(), trackFlags: uint32, durationMovieTicks: unsignedDecimal, mediaTimescale: positiveDecimal,
  mediaDurationTicks: unsignedDecimal, edits: z.array(isoEdit).nullable(), sampleTiming: sampleTiming.optional(),
});
const isoCompanion = z.strictObject({
  ...identity, strategy: z.enum(['iso_explicit_rate_one', 'iso_unedited_rate_one']), presentation,
  physical: z.strictObject({ streamIndex: ordinal, trackId: uint32.positive(), sourceTimeBase: sourceClock, frames: z.array(physicalFrame).min(1) }),
  container: z.strictObject({ kind: z.literal('iso_bmff'), movieTimescale: positiveDecimal, movieDurationTicks: unsignedDecimal, track: isoTrack }),
});
const matroskaTrack = z.strictObject({
  trackNumber: positiveDecimal, trackUid: positiveDecimal, trackType: z.literal('1'), codecId: z.string().min(1), enabled: z.boolean(),
  defaultDurationNs: unsignedDecimal.nullable(), trackTimestampScale: sourceClock, codecDelayNs: unsignedDecimal,
});
const matroskaBlock = z.strictObject({
  blockOrdinal: ordinal, kind: z.enum(['simple', 'group']), elementOffset: unsignedDecimal, dataOffset: unsignedDecimal, dataBytes: unsignedDecimal,
  trackNumber: positiveDecimal, clusterTimestampTicks: unsignedDecimal, relativeTimestampTicks: signedDecimal, invisible: z.boolean(),
  lacing: z.enum(['none', 'xiph', 'fixed', 'ebml']), frameCount: positiveCount.max(256), blockDurationTicks: unsignedDecimal.nullable(), discardPaddingNs: signedDecimal.nullable(),
});
const matroskaCompanion = z.strictObject({
  ...identity, strategy: z.literal('matroska_rate_one'), presentation,
  physical: z.strictObject({
    streamIndex: ordinal, trackNumber: positiveDecimal, trackUid: positiveDecimal, sourceTimeBase: sourceClock,
    frames: z.array(physicalFrame.extend({ blockOrdinal: ordinal })).min(1),
  }),
  container: z.strictObject({ kind: z.literal('matroska'), timestampScaleNs: positiveDecimal, track: matroskaTrack, blocks: z.array(matroskaBlock).min(1) }),
});

/**
 * Check complete identities without repeating producer time mapping.
 * @param value - A structurally validated complete companion.
 * @returns Whether original track, array identities and references agree.
 * @throws {never} Structural schemas validate every integer used here.
 */
function referencesMatch(value: VideoSourceLedgerCompanion): boolean {
  if (value.physical.frames.some((frame, index) => frame.rawDecodeOrdinal !== index) ||
    value.presentation.edits.some((edit, index) => edit.editOccurrence !== index)) return false;
  for (const [index, frame] of value.presentation.frames.entries()) {
    if (frame.presentationOrdinal !== index || value.physical.frames[frame.rawDecodeOrdinal]?.ptsTicks !== frame.sourcePtsTicks) return false;
    if (value.strategy === 'iso_explicit_rate_one') {
      const edit = value.presentation.edits[frame.editOccurrence];
      if (edit === undefined || edit.empty) return false;
    } else if (frame.editOccurrence !== 0) return false;
  }
  if (value.strategy === 'matroska_rate_one') {
    const { track, blocks } = value.container;
    if (value.presentation.edits.length !== 0 || value.physical.trackNumber !== track.trackNumber || value.physical.trackUid !== track.trackUid) return false;
    const ordinals = new Set<number>();
    for (const [index, block] of blocks.entries()) {
      if (block.trackNumber !== track.trackNumber || (index > 0 && blocks[index - 1]!.blockOrdinal >= block.blockOrdinal) ||
        BigInt(block.dataOffset) <= BigInt(block.elementOffset)) return false;
      ordinals.add(block.blockOrdinal);
    }
    if (ordinals.size !== value.physical.frames.length) return false;
    for (const frame of value.physical.frames) if (!ordinals.delete(frame.blockOrdinal)) return false;
    return ordinals.size === 0;
  }
  const track = value.container.track;
  if (value.physical.trackId !== track.trackId) return false;
  if (value.strategy === 'iso_explicit_rate_one') {
    return track.edits !== null && track.edits.length === value.presentation.edits.length &&
      track.edits.every((edit, index) => value.presentation.edits[index]!.empty === (BigInt(edit.mediaTimeTrackTicks) === -1n));
  }
  if (track.edits !== null || value.presentation.edits.length !== 0 || track.sampleTiming === undefined) return false;
  const count = track.sampleTiming.decodeRuns.reduce((total, run) => total + BigInt(run.sampleCount), 0n);
  return count === BigInt(value.physical.frames.length) && (track.sampleTiming.compositionRuns === null ||
    track.sampleTiming.compositionRuns.reduce((total, run) => total + BigInt(run.sampleCount), 0n) === count);
}

/** Strict complete facts; producer algorithms retain time-mapping ownership. */
export const videoSourceLedgerCompanionSchema: z.ZodType<VideoSourceLedgerCompanion> = z.discriminatedUnion('strategy', [isoCompanion, matroskaCompanion]).transform((value, ctx) => {
  if (!referencesMatch(value)) { ctx.addIssue({ code: 'custom', message: 'Source ledger identities or complete references differ' }); return z.NEVER; }
  return value;
});

/** Small measured receipt, independent from a validated usable frame table. */
export const videoSourceLedgerReceiptSchema: z.ZodType<VideoSourceLedgerReceipt> = z.strictObject({
  ...identity, strategy, url: z.url().refine(value => value.startsWith('https://')), etag: z.string().min(1), size: positiveCount,
  sha256: hash, contentType: z.literal('application/json'), physicalFrameCount: positiveCount, occurrenceCount: ordinal,
});

const safeTick = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const httpsUrl = z.url().refine(value => value.startsWith('https://'));
const identityV2 = { schemaVersion: z.literal(2), sourceFingerprint: hash, producerVersion: z.literal(2), attempt };
const editSpan = z.strictObject({ sourceStart: exactTime, sourceEnd: exactTime, presentationStart: exactTime, rate: exactTime });

/**
 * Check that every run steps forward (a single frame steps by 0) and its last tick stays safe.
 * @param runs - Structurally valid source runs.
 * @returns Whether the runs are well formed.
 * @throws {never} Never.
 */
function sourceRunsValid(runs: readonly VideoSourceRun[]): boolean {
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
function spansValid(spans: readonly VideoEditSpan[]): boolean {
  let previousEnd: ExactPresentationTime = { numerator: '0', denominator: '1' };
  for (const span of spans) {
    if (BigInt(span.rate.numerator) <= 0n || compare(span.sourceStart, span.sourceEnd) >= 0n || compare(span.presentationStart, previousEnd) < 0n) return false;
    previousEnd = presentationEnd(span);
  }
  return true;
}

/** Stored source ledger v2: the compact presentation table, source ticks per presented frame and the edit spans. */
export const videoSourceLedgerV2Schema: z.ZodType<VideoSourceLedgerV2> = z.strictObject({
  ...identityV2,
  presentation: presentationTableSchema,
  source: z.strictObject({ timeBase: sourceClock, runs: z.array(z.strictObject({ start: safeTick, count: positiveCount, step: safeTick })).min(1) }),
  videoEdits: z.array(editSpan).min(1).nullable(),
  audioEdits: z.array(editSpan).nullable(),
}).transform((value, ctx) => {
  // A transform runs only after every field parsed, so the checks below see valid integers.
  const presented = value.presentation.runs.reduce((total, run) => total + run.count, 0);
  const sourced = value.source.runs.reduce((total, run) => total + run.count, 0);
  if (sourced !== presented || !sourceRunsValid(value.source.runs) || (value.videoEdits !== null && !spansValid(value.videoEdits)) ||
    (value.audioEdits !== null && !spansValid(value.audioEdits))) {
    ctx.addIssue({ code: 'custom', message: 'Source runs must give one forward tick per presented frame and edit spans must be non-empty, forward and in order' });
    return z.NEVER;
  }
  return value;
});

/** Stored receipt v2: the full ledger and the compact presentation table written with it. */
export const videoSourceLedgerReceiptV2Schema: z.ZodType<VideoSourceLedgerReceiptV2> = z.strictObject({
  ...identityV2, url: httpsUrl, etag: z.string().min(1), size: positiveCount, sha256: hash, contentType: z.literal('application/json'),
  table: z.strictObject({ url: httpsUrl, sha256: hash, size: positiveCount, frameCount: positiveCount }),
}).refine(value => value.table.url !== value.url, { message: 'The compact table and the full ledger are different objects' });

const errorCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
/** Independent capability state, carrying no frame arrays or native claims; version 1 states stay accepted until their readers move to version 2. */
export const videoSourceLedgerStateSchema: z.ZodType<VideoSourceLedgerState> = z.union([
  z.null(),
  z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('pending'), ...identityV2 }),
    z.strictObject({ state: z.literal('ready'), receipt: videoSourceLedgerReceiptV2Schema }),
    z.strictObject({ state: z.literal('failed'), ...identityV2, errorCode }),
  ]),
  z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('pending'), ...identity }),
    z.strictObject({ state: z.literal('ready'), receipt: videoSourceLedgerReceiptSchema }),
    z.strictObject({ state: z.literal('failed'), ...identity, errorCode }),
  ]),
]);

// Codes the source bytes decide: producing again from the same bytes fails the same way.
const CONTENT_FAILURES: ReadonlySet<string> = new Set([
  'source_ledger_format_unknown', 'source_ledger_selection_unknown', 'unsupported_rate', 'invalid_edit', 'invalid_clock', 'invalid_ledger',
  'classification_unknown', 'clock_unknown', 'metadata_unknown', 'audio_clock_unknown', 'probe_invalid', 'source_over_cap', 'no_presented_frames',
]);

/**
 * Classify a source ledger failure code; every code outside the content list is transient.
 * @param errorCode - The producer's or the store's failure code.
 * @returns `content` when the source bytes decide the failure, otherwise `transient`.
 * @throws {never} Never.
 */
export function classifyVideoSourceLedgerFailure(errorCode: string): VideoSourceLedgerFailureClass {
  return CONTENT_FAILURES.has(errorCode) ? 'content' : 'transient';
}

/**
 * Validate full source JSON against its measured receipt and mandatory caller limits.
 * @param value - Complete untrusted companion JSON supplied after a bounded body read.
 * @param receipt - Original measured stored companion identity and counts.
 * @param limits - Mandatory frozen physical-frame and occurrence ceilings.
 * @returns The complete matching companion, or null without altering the input.
 * @throws {never} Invalid or mismatched facts resolve to null.
 */
export function parseVideoSourceLedger(value: unknown, receipt: VideoSourceLedgerReceipt, limits: VideoSourceLedgerParseLimits): VideoSourceLedgerCompanion | null {
  if (!Number.isSafeInteger(limits?.maxPhysicalFrames) || limits.maxPhysicalFrames <= 0 ||
    !Number.isSafeInteger(limits?.maxOccurrences) || limits.maxOccurrences <= 0) return null;
  const measured = videoSourceLedgerReceiptSchema.safeParse(receipt);
  if (!measured.success || measured.data.physicalFrameCount > limits.maxPhysicalFrames || measured.data.occurrenceCount > limits.maxOccurrences) return null;
  const candidate = value as { physical?: { frames?: unknown }; presentation?: { frames?: unknown } } | null | undefined;
  // Check the complete counts before the strict schema copies either array.
  if (!Array.isArray(candidate?.physical?.frames) || !Array.isArray(candidate?.presentation?.frames) ||
    candidate.physical.frames.length !== measured.data.physicalFrameCount || candidate.presentation.frames.length !== measured.data.occurrenceCount) return null;
  const parsed = videoSourceLedgerCompanionSchema.safeParse(value);
  if (!parsed.success) return null;
  const companion = parsed.data;
  const original = measured.data;
  return companion.sourceFingerprint === original.sourceFingerprint && companion.producerVersion === original.producerVersion &&
    companion.strategy === original.strategy && companion.attempt.jobId === original.attempt.jobId && companion.attempt.deadlineAt === original.attempt.deadlineAt &&
    companion.physical.frames.length === original.physicalFrameCount && companion.presentation.frames.length === original.occurrenceCount ? companion : null;
}

/**
 * Derive the source companion key from the registered canonical storage key.
 * @param key - Original registered canonical storage key.
 * @returns The deterministic versioned source companion key.
 * @throws {never} Never.
 */
export function videoSourceLedgerKeyFor(key: string): string {
  return `${key}.video-source-ledger.v1.json`;
}

/**
 * Derive the compact presentation table key, stored beside the source ledger, from the registered canonical storage key.
 * @param key - Original registered canonical storage key.
 * @returns The deterministic versioned table key.
 * @throws {never} Never.
 */
export function videoSourceLedgerTableKeyFor(key: string): string {
  return `${key}.video-presentation-table.v1.json`;
}
