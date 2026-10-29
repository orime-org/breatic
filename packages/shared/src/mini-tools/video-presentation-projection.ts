// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Kept free of zod: the media container bundles this projection and its process loads only our own code.

/** Run-length encoded presented frames (as MP4 `stts`); frame k of a run shows during [start + k·step, start + k·step + duration) ticks. */
export interface VideoPresentationRun { start: number; count: number; step: number; duration: number }
/** The compact presentation table every video tool plans against; all times are integer ticks on `timescale`. */
export interface VideoPresentationTable { schemaVersion: 1; timescale: number; runs: VideoPresentationRun[] }
/** An exact rational in decimal integer strings. */
export interface PresentationRational { numerator: string; denominator: string }
/** One presented frame's display interval in seconds, as exact rationals. */
export interface PresentedVideoFrame { displayStart: PresentationRational; displayEnd: PresentationRational }

const INTEGER = /^-?\d+$/;

/**
 * Greatest common divisor of two non-negative integers.
 * @param a - First value.
 * @param b - Second value.
 * @returns Their greatest common divisor.
 * @throws {never} Never.
 */
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * Parses an exact rational into lowest terms with a positive denominator.
 * @param value - The rational.
 * @returns Its numerator and denominator.
 * @throws {RangeError} When either part is not an integer or the denominator is not positive.
 */
function rational(value: PresentationRational): [bigint, bigint] {
  if (!INTEGER.test(value.numerator) || !INTEGER.test(value.denominator)) throw new RangeError("Presentation times must be integer rationals");
  const numerator = BigInt(value.numerator);
  const denominator = BigInt(value.denominator);
  if (denominator <= 0n) throw new RangeError("Presentation time denominators must be positive");
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

/**
 * Projects presented frames into the canonical compact table with exact arithmetic.
 * @param frames - Every presented frame in presentation order.
 * @returns The table on the least common timescale, with maximal runs.
 * @throws {RangeError} When there are no frames, a time is negative, a frame is empty or overlaps the next, or a tick is unsafe.
 */
export function projectPresentationTable(frames: readonly PresentedVideoFrame[]): VideoPresentationTable {
  if (frames.length === 0) throw new RangeError("A presentation table needs at least one frame");
  const parsed = frames.map((frame) => [rational(frame.displayStart), rational(frame.displayEnd)] as const);
  const timescale = parsed.reduce((scale, [[, start], [, end]]) => {
    const withStart = scale / gcd(scale, start) * start;
    return withStart / gcd(withStart, end) * end;
  }, 1n);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (timescale > limit) throw new RangeError("Presentation timescale exceeds the safe integer range");
  const runs: VideoPresentationRun[] = [];
  let previousEnd = 0n;
  for (const [[startNumerator, startDenominator], [endNumerator, endDenominator]] of parsed) {
    const start = startNumerator * (timescale / startDenominator);
    const end = endNumerator * (timescale / endDenominator);
    if (start < previousEnd) throw new RangeError("Presented frames must start at or after zero and after the previous frame ends");
    if (end <= start) throw new RangeError("A presented frame must end after it starts");
    if (end > limit) throw new RangeError("Presentation ticks exceed the safe integer range");
    previousEnd = end;
    const frame = { start: Number(start), duration: Number(end - start) };
    const run = runs.at(-1);
    if (run !== undefined && run.duration === frame.duration && (run.count === 1 || frame.start === run.start + run.count * run.step)) {
      if (run.count === 1) run.step = frame.start - run.start;
      run.count += 1;
    } else runs.push({ start: frame.start, count: 1, step: frame.duration, duration: frame.duration });
  }
  return { schemaVersion: 1, timescale: Number(timescale), runs };
}
