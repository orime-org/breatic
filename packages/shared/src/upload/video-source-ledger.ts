// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import type { ExactPresentationTime, VideoSourceLedgerCompanion, VideoSourceLedgerParseLimits, VideoSourceLedgerReceipt, VideoSourceLedgerState } from '@shared/upload/video-source-ledger-types.js';

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

/** Independent capability state, carrying no frame arrays or native claims. */
export const videoSourceLedgerStateSchema: z.ZodType<VideoSourceLedgerState> = z.union([
  z.null(),
  z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('pending'), ...identity }),
    z.strictObject({ state: z.literal('ready'), receipt: videoSourceLedgerReceiptSchema }),
    z.strictObject({ state: z.literal('failed'), ...identity, errorCode: z.string().regex(/^[a-z][a-z0-9_]*$/) }),
  ]),
]);

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
