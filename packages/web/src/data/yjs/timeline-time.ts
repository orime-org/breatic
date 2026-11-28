// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import {
  assertTimelineRate as assertRate, timelineSourceRoom,
  type TimelineClip, type TimelineFraction as Fraction, type TimelineRate, type TimelineSourceExtent,
} from '@breatic/shared';

export { timelineSourceRoom, type TimelineSourceExtent } from '@breatic/shared';

/**
 * Whether a clip is a still with no in-point: a picture, a text or a picture placeholder (inner#1709).
 * @param clip - The clip.
 * @returns True when its in-point stays 0.
 * @throws {never} Never.
 */
function isStill(clip: TimelineClip): boolean {
  return clip.kind === 'image' || clip.kind === 'text' || (clip.kind === 'upload' && clip.upload.kind === 'image');
}

/**
 * Whether a clip's frame bounds are a stored clip's: safe integers, a non-negative start and in-point, a positive
 * duration and a safe end.
 * @param clip - The placement bounds.
 * @returns Whether the interval is valid.
 * @throws {never} Never.
 */
export function timelineClipIntervalValid(clip: Pick<TimelineClip, 'startFrame' | 'sourceInFrame' | 'durationFrames'>): boolean {
  return Number.isSafeInteger(clip.startFrame) && clip.startFrame >= 0
    && Number.isSafeInteger(clip.sourceInFrame) && clip.sourceInFrame >= 0
    && Number.isSafeInteger(clip.durationFrames) && clip.durationFrames >= 1
    && Number.isSafeInteger(clip.startFrame + clip.durationFrames);
}

/**
 * A frame count typed by the user: digits only, so an empty field or any other notation is invalid.
 * @param text - The field text.
 * @returns The number, or NaN.
 * @throws {never} Never.
 */
export function parseTimelineFrame(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN;
}

/**
 * Check the integer placement bounds before doing any frame arithmetic.
 * @param clip - The current placement to check.
 * @throws {RangeError} When a bound or speed is invalid.
 */
function assertClip(clip: TimelineClip): void {
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
function sampleFraction(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate, frame: number): Fraction {
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
export function timelineSourceSeconds(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate, frame: number): number {
  if (!validateTimelineRange(clip, source, fps) || !Number.isSafeInteger(frame)
    || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) {
    throw new RangeError('Timeline frame is outside the usable clip interval');
  }
  const sample = sampleFraction(clip, source, fps, frame);
  return Number(sample.num) / Number(sample.den);
}

/**
 * The source frames `frames` Timeline frames of a clip advance.
 * @param clip - The clip whose speed applies.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @param frames - Timeline frames.
 * @returns The source frame offset, or null when it is not a whole source frame; 0 for a still, which has no in-point.
 * @throws {never} Never.
 */
export function timelineSourceOffset(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate, frames: number): number | null {
  if (isStill(clip)) return 0;
  const num = BigInt(frames) * BigInt(fps.den) * BigInt(clip.rate.num) * BigInt(source.timebase.num);
  const den = BigInt(fps.num) * BigInt(clip.rate.den) * BigInt(source.timebase.den);
  return num % den === 0n ? Number(num / den) : null;
}

/**
 * How many Timeline frames a clip's head can extend before its in-point reaches the source start.
 * @param clip - The clip with its in-point and speed.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @returns The whole Timeline frames available before the head; unlimited for a still.
 * @throws {never} Never.
 */
export function timelineHeadRoom(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate): number {
  if (isStill(clip)) return Number.MAX_SAFE_INTEGER;
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
export function timelineTrimHead(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate, shift: number): number | null {
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
export function validateTimelineRange(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate): boolean {
  try {
    assertClip(clip);
    assertRate(fps);
    return timelineSourceRoom(clip, source, fps) >= clip.durationFrames;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

/**
 * Count of clip frames whose source sample falls outside the source.
 * @param clip - The clip.
 * @param source - Its source.
 * @param fps - The Timeline frame rate.
 * @returns The out-of-source frames.
 * @throws {RangeError} When a rate or the source duration is invalid.
 */
export function timelineSourceOverflow(clip: TimelineClip, source: TimelineSourceExtent, fps: TimelineRate): number {
  return clip.durationFrames - Math.min(clip.durationFrames, timelineSourceRoom(clip, source, fps));
}
