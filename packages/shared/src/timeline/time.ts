// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineRate, TimelineVideoClip, TimelineVideoSource } from "@shared/timeline/schema.js";

/** A fraction used only while computing exact sample boundaries. */
interface Fraction { num: bigint; den: bigint }

/** The source-range validation result at an editing boundary. */
export type TimelineRangeValidation = { valid: true } | { valid: false; reason: "invalid_range" };

/**
 * Check the positive safe-integer components of a rational timebase.
 * @param rate - The timebase or speed to check.
 * @throws {RangeError} When a component is not a positive safe integer.
 */
function assertRate(rate: TimelineRate): void {
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
function durationFraction(duration: string | number): Fraction {
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
  assertRate(fps);
  const seconds = durationFraction(duration);
  const num = seconds.num * BigInt(fps.num);
  const den = seconds.den * BigInt(fps.den);
  const frames = (num + den - 1n) / den;
  if (frames < 1n || frames > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Timeline source extent is not a safe integer");
  return Number(frames);
}

/**
 * Check the integer placement bounds before doing any frame arithmetic.
 * @param clip - The current placement to check.
 * @throws {RangeError} When a bound or speed is invalid.
 */
function assertClip(clip: TimelineVideoClip): void {
  if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0
    || !Number.isSafeInteger(clip.sourceInFrame) || clip.sourceInFrame < 0
    || !Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1
    || !Number.isSafeInteger(clip.startFrame + clip.durationFrames)) {
    throw new RangeError("Invalid Timeline clip interval");
  }
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
    throw new RangeError("Timeline frame is outside the usable clip interval");
  }
  const sample = sampleFraction(clip, source, fps, frame);
  return Number(sample.num) / Number(sample.den);
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
      return { valid: false, reason: "invalid_range" };
    }
    const duration = durationFraction(source.durationSeconds);
    const last = sampleFraction(clip, source, fps, clip.startFrame + clip.durationFrames - 1);
    return last.num >= 0n && last.num * duration.den < duration.num * last.den
      ? { valid: true }
      : { valid: false, reason: "invalid_range" };
  } catch (err) {
    if (err instanceof RangeError) return { valid: false, reason: "invalid_range" };
    throw err;
  }
}
