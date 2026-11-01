// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineRate } from "@shared/timeline/schema.js";

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
