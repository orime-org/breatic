// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import {
  assertTimelineRate as assertRate, durationToFrames, timelineDurationFraction as durationFraction,
  type TimelineFraction as Fraction, type TimelineRate, type TimelineVideoClip, type TimelineVideoSource,
} from '@breatic/shared';

/** The source-range validation result at an editing boundary. */
export type TimelineRangeValidation = { valid: true } | { valid: false; reason: 'invalid_range' };

/**
 * Whether a clip's frame bounds are a stored clip's: safe integers, a non-negative start and in-point, a positive
 * duration and a safe end.
 * @param clip - The placement bounds.
 * @returns Whether the interval is valid.
 * @throws {never} Never.
 */
export function timelineClipIntervalValid(clip: Pick<TimelineVideoClip, 'startFrame' | 'sourceInFrame' | 'durationFrames'>): boolean {
  return Number.isSafeInteger(clip.startFrame) && clip.startFrame >= 0
    && Number.isSafeInteger(clip.sourceInFrame) && clip.sourceInFrame >= 0
    && Number.isSafeInteger(clip.durationFrames) && clip.durationFrames >= 1
    && Number.isSafeInteger(clip.startFrame + clip.durationFrames);
}

/**
 * Check the integer placement bounds before doing any frame arithmetic.
 * @param clip - The current placement to check.
 * @throws {RangeError} When a bound or speed is invalid.
 */
function assertClip(clip: TimelineVideoClip): void {
  if (!timelineClipIntervalValid(clip)) throw new RangeError('Invalid Timeline clip interval');
  assertRate(clip.rate);
}

/**
 * Evaluate one sample with integer cross multiplication.
 * @param clip - The placement with its fixed in-point and speed.
 * @param source - Its immutable logical source descriptor.
 * @param fps - The Timeline frame rate.
 * @param frame - The visible global frame to sample.
 * @returns The source time as an exact fraction of seconds.
 * @throws {RangeError} When a caller has supplied an invalid rational rate.
 */
function sampleFraction(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate, frame: number): Fraction {
  assertRate(fps);
  assertRate(source.timebase);
  const sourceDen = BigInt(source.timebase.num);
  const inNum = BigInt(clip.sourceInFrame) * BigInt(source.timebase.den);
  const deltaDen = BigInt(fps.num) * BigInt(clip.rate.den);
  const deltaNum = BigInt(frame - clip.startFrame) * BigInt(fps.den) * BigInt(clip.rate.num);
  return { num: inNum * deltaDen + deltaNum * sourceDen, den: sourceDen * deltaDen };
}

/**
 * Convert a visible Timeline frame to its source sampling instant.
 * @param clip - The current placement.
 * @param source - Its immutable logical source descriptor.
 * @param fps - The Timeline frame rate.
 * @param frame - The global integer frame to sample.
 * @returns The source instant in seconds.
 * @throws {RangeError} When the clip, source or requested frame is unusable.
 */
export function timelineSourceSeconds(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate, frame: number): number {
  if (!validateTimelineRange(clip, source, fps).valid || !Number.isSafeInteger(frame)
    || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) {
    throw new RangeError('Timeline frame is outside the usable clip interval');
  }
  const sample = sampleFraction(clip, source, fps, frame);
  return Number(sample.num) / Number(sample.den);
}

/**
 * How many clip frames, counted from its in-point, sample inside the source.
 * @param clip - The placement with its in-point and speed.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @returns The frame count, capped at Number.MAX_SAFE_INTEGER.
 * @throws {RangeError} When a rate or the source duration is invalid.
 */
export function timelineSourceRoom(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate): number {
  assertRate(fps);
  assertRate(source.timebase);
  assertRate(clip.rate);
  // Frame j samples in·tb.den/tb.num + j·step seconds, step = fps.den·rate.num / (fps.num·rate.den);
  // it is inside while that stays below the duration, so the count is ceil of the bound on j.
  const duration = durationFraction(source.durationSeconds);
  const tbNum = BigInt(source.timebase.num);
  const stepDen = BigInt(fps.num) * BigInt(clip.rate.den);
  const bound = (duration.num * tbNum - BigInt(clip.sourceInFrame) * BigInt(source.timebase.den) * duration.den) * stepDen;
  const per = BigInt(fps.den) * BigInt(clip.rate.num) * tbNum * duration.den;
  if (bound <= 0n) return 0;
  const room = (bound + per - 1n) / per;
  return room > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(room);
}

/**
 * The source frames `frames` Timeline frames of a clip advance.
 * @param clip - The clip whose speed applies.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @param frames - Timeline frames.
 * @returns The source frame offset, or null when it is not a whole source frame.
 * @throws {never} Never.
 */
export function timelineSourceOffset(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate, frames: number): number | null {
  const num = BigInt(frames) * BigInt(fps.den) * BigInt(clip.rate.num) * BigInt(source.timebase.num);
  const den = BigInt(fps.num) * BigInt(clip.rate.den) * BigInt(source.timebase.den);
  return num % den === 0n ? Number(num / den) : null;
}

/**
 * How many Timeline frames a clip's head can extend before its in-point reaches the source start.
 * @param clip - The clip with its in-point and speed.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @returns The whole Timeline frames available before the head.
 * @throws {never} Never.
 */
export function timelineHeadRoom(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate): number {
  const num = BigInt(clip.sourceInFrame) * BigInt(source.timebase.den) * BigInt(fps.num) * BigInt(clip.rate.den);
  const den = BigInt(source.timebase.num) * BigInt(fps.den) * BigInt(clip.rate.num);
  return Number(num / den);
}

/**
 * The source in-point after moving a clip's head by `shift` Timeline frames.
 * @param clip - The clip with its in-point and speed.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @param shift - Timeline frames the head moves; negative extends it.
 * @returns The new in-point, or null when it is not a whole source frame or falls before the source start.
 * @throws {never} Never.
 */
export function timelineTrimHead(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate, shift: number): number | null {
  const offset = timelineSourceOffset(clip, source, fps, shift);
  return offset === null || clip.sourceInFrame + offset < 0 ? null : clip.sourceInFrame + offset;
}

/**
 * Validate every visible sample against the fixed source duration.
 * @param clip - The current placement and range.
 * @param source - Its immutable logical source descriptor.
 * @param fps - The Timeline frame rate.
 * @returns Whether the source range is usable.
 * @throws {Error} When an unexpected arithmetic error occurs.
 */
export function validateTimelineRange(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate): TimelineRangeValidation {
  try {
    assertClip(clip);
    assertRate(fps);
    if (clip.sourceId !== source.id || durationToFrames(source.durationSeconds, source.timebase) !== source.extentFrames) {
      return { valid: false, reason: 'invalid_range' };
    }
    return timelineSourceRoom(clip, source, fps) >= clip.durationFrames
      ? { valid: true }
      : { valid: false, reason: 'invalid_range' };
  } catch (err) {
    if (err instanceof RangeError) return { valid: false, reason: 'invalid_range' };
    throw err;
  }
}
