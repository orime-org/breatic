// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/** A positive rational rate owned by the Timeline format. */
export interface TimelineRate { num: number; den: number }

/** A fraction used only while computing exact sample boundaries. */
export interface TimelineFraction { num: bigint; den: bigint }

/**
 * Check the positive safe-integer components of a rational timebase.
 * @param rate - The timebase or speed to check.
 * @throws {RangeError} When a component is not a positive safe integer.
 */
export function assertTimelineRate(rate: TimelineRate): void {
  if (!Number.isSafeInteger(rate.num) || rate.num < 1 || !Number.isSafeInteger(rate.den) || rate.den < 1) {
    throw new RangeError("Timeline rates require positive safe integers");
  }
}

/**
 * Read decimal seconds exactly, including Number's scientific notation.
 * @param duration - Measured seconds or their decimal representation.
 * @returns A positive decimal fraction without binary floating-point rounding.
 * @throws {RangeError} When the duration is not a positive finite decimal.
 */
export function timelineDurationFraction(duration: string | number): TimelineFraction {
  const text = String(duration);
  const value = Number(text);
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || !Number.isFinite(value) || value <= 0) throw new RangeError("Invalid Timeline source duration");
  const whole = match[1] ?? "0";
  const decimal = match[2] ?? "";
  const power = Number(match[3] ?? 0) - decimal.length;
  const digits = BigInt(whole + decimal);
  return power >= 0
    ? { num: digits * 10n ** BigInt(power), den: 1n }
    : { num: digits, den: 10n ** BigInt(-power) };
}

/**
 * Conform a positive duration to frames whose sample instant is before its end.
 * @param duration - The positive measured source duration.
 * @param fps - The fixed logical source frame rate.
 * @returns The number of visible sample frames.
 * @throws {RangeError} When the inputs or resulting frame count are invalid.
 */
export function durationToFrames(duration: string | number, fps: TimelineRate): number {
  assertTimelineRate(fps);
  const seconds = timelineDurationFraction(duration);
  const num = seconds.num * BigInt(fps.num);
  const den = seconds.den * BigInt(fps.den);
  const frames = (num + den - 1n) / den;
  if (frames < 1n || frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Timeline source extent is not a safe integer");
  return Number(frames);
}

/**
 * What frame arithmetic reads from a clip's source: a registered video or sound, whose measured `durationSeconds` may
 * end between frames, or a source counted in whole frames at its timebase (a web animation, or a still that has no end).
 */
export interface TimelineSourceExtent { timebase: TimelineRate; extentFrames: number; durationSeconds?: string }

/** The clip fields the source arithmetic reads. */
type TimelineSampledClip = { sourceInFrame: number; rate: TimelineRate };

/**
 * A source's length in seconds as an exact fraction.
 * @param source - The source.
 * @returns Its measured duration, or its whole frames at its timebase when it has none.
 * @throws {RangeError} When a measured duration is invalid.
 */
function sourceDuration(source: TimelineSourceExtent): TimelineFraction {
  if (source.durationSeconds !== undefined) return timelineDurationFraction(source.durationSeconds);
  return { num: BigInt(source.extentFrames) * BigInt(source.timebase.den), den: BigInt(source.timebase.num) };
}

/**
 * How many clip frames, counted from its in-point, sample inside the source.
 * @param clip - The placement with its in-point and speed.
 * @param source - Its source descriptor.
 * @param fps - The Timeline frame rate.
 * @returns The frame count, capped at Number.MAX_SAFE_INTEGER.
 * @throws {RangeError} When a rate or the source duration is invalid.
 */
export function timelineSourceRoom(clip: TimelineSampledClip, source: TimelineSourceExtent, fps: TimelineRate): number {
  assertTimelineRate(fps);
  assertTimelineRate(source.timebase);
  assertTimelineRate(clip.rate);
  // Frame j samples in·tb.den/tb.num + j·step seconds, step = fps.den·rate.num / (fps.num·rate.den);
  // it is inside while that stays below the duration, so the count is ceil of the bound on j.
  const duration = sourceDuration(source);
  const tbNum = BigInt(source.timebase.num);
  const stepDen = BigInt(fps.num) * BigInt(clip.rate.den);
  const bound = (duration.num * tbNum - BigInt(clip.sourceInFrame) * BigInt(source.timebase.den) * duration.den) * stepDen;
  const per = BigInt(fps.den) * BigInt(clip.rate.num) * tbNum * duration.den;
  if (bound <= 0n) return 0;
  const room = (bound + per - 1n) / per;
  return room > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(room);
}

/**
 * The extent an upload placeholder is measured against: a video or sound file the browser read, conformed like a
 * registered one; a picture has no end (inner#1709).
 * @param fps - The document frame rate.
 * @param clip - The placeholder.
 * @param clip.upload - Its upload fields.
 * @param clip.upload.durationSeconds - The length the browser read, null for a picture.
 * @returns The extent, or undefined when the duration is too long to count in frames.
 * @throws {never} Never.
 */
export function timelineUploadExtent(fps: TimelineRate, clip: { upload: { durationSeconds: number | null } }): TimelineSourceExtent | undefined {
  const { durationSeconds } = clip.upload;
  if (durationSeconds === null) return { timebase: fps, extentFrames: Number.MAX_SAFE_INTEGER };
  try {
    return { timebase: fps, extentFrames: durationToFrames(durationSeconds, fps), durationSeconds: String(durationSeconds) };
  } catch {
    // A duration whose frame count is not a safe integer cannot be measured, like a missing source.
    return undefined;
  }
}
