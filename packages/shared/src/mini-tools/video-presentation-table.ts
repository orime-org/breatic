// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";

/** Run-length encoded presented frames (as MP4 `stts`); frame k of a run shows during [start + k·step, start + k·step + duration) ticks. */
export interface VideoPresentationRun { start: number; count: number; step: number; duration: number }
/** The compact presentation table every video tool plans against; all times are integer ticks on `timescale`. */
export interface VideoPresentationTable { schemaVersion: 1; timescale: number; runs: VideoPresentationRun[] }
/** An exact rational in decimal integer strings. */
export interface PresentationRational { numerator: string; denominator: string }
/** One presented frame's display interval in seconds, as exact rationals. */
export interface PresentedVideoFrame { displayStart: PresentationRational; displayEnd: PresentationRational }
/** One frame read from the table, in seconds. */
export interface PresentationFrame { frameIndex: number; pts: number; displayEnd: number }

const tick = z.number().int();
const runSchema = z.strictObject({ start: tick.nonnegative(), count: tick.positive(), step: tick.positive(), duration: tick.positive() });

/**
 * The last tick of a run's final frame, computed in safe float arithmetic.
 * @param run - The run.
 * @returns The end tick of the run's last frame.
 * @throws {never} Never.
 */
function runEnd(run: VideoPresentationRun): number {
  return run.start + (run.count - 1) * run.step + run.duration;
}

export const presentationTableSchema = z.strictObject({
  schemaVersion: z.literal(1),
  timescale: tick.positive(),
  runs: z.array(runSchema).min(1),
}).superRefine((table, ctx) => {
  table.runs.forEach((run, index) => {
    if (run.duration > run.step) ctx.addIssue({ code: "custom", path: ["runs", index, "duration"], message: "A frame cannot outlast its step" });
    if (run.count === 1 && run.step !== run.duration) ctx.addIssue({ code: "custom", path: ["runs", index, "step"], message: "A single-frame run steps by its duration" });
    // Any true value beyond the safe range rounds to at least 2^53, so this check is sound in floats.
    if (!Number.isSafeInteger(runEnd(run))) ctx.addIssue({ code: "custom", path: ["runs", index], message: "Run ticks exceed the safe integer range" });
    const previous = table.runs[index - 1];
    if (previous !== undefined && run.start < runEnd(previous)) ctx.addIssue({ code: "custom", path: ["runs", index, "start"], message: "A run starts before the previous run ends" });
  });
});

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

// Tables are read-only once validated, so each table's run offsets are computed once.
const offsetCache = new WeakMap<VideoPresentationTable, number[]>();

/**
 * The first frame index of every run, followed by the total frame count.
 * @param table - A table accepted by presentationTableSchema.
 * @returns Cumulative run offsets.
 * @throws {never} Never.
 */
function runOffsets(table: VideoPresentationTable): number[] {
  let offsets = offsetCache.get(table);
  if (offsets === undefined) {
    offsets = [0];
    for (const run of table.runs) offsets.push(offsets.at(-1)! + run.count);
    offsetCache.set(table, offsets);
  }
  return offsets;
}

/**
 * Counts the table's frames without expanding them.
 * @param table - A table accepted by presentationTableSchema.
 * @returns The number of presented frames.
 * @throws {never} Never.
 */
export function presentationFrameCount(table: VideoPresentationTable): number {
  return runOffsets(table).at(-1)!;
}

/**
 * Reads one frame's display interval by binary search over runs.
 * @param table - A table accepted by presentationTableSchema.
 * @param index - The frame's presentation index.
 * @returns The frame's index, start and end in seconds.
 * @throws {RangeError} When the index is not a frame of the table.
 */
export function presentationFrameAt(table: VideoPresentationTable, index: number): PresentationFrame {
  const offsets = runOffsets(table);
  if (!Number.isInteger(index) || index < 0 || index >= offsets.at(-1)!) throw new RangeError("Frame index lies outside the presentation table");
  let low = 0;
  let high = table.runs.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  const run = table.runs[low]!;
  const start = run.start + (index - offsets[low]!) * run.step;
  return { frameIndex: index, pts: start / table.timescale, displayEnd: (start + run.duration) / table.timescale };
}

/**
 * The end of the last presented frame.
 * @param table - A table accepted by presentationTableSchema.
 * @returns The video end in seconds.
 * @throws {never} Never.
 */
export function presentationVideoEnd(table: VideoPresentationTable): number {
  return runEnd(table.runs.at(-1)!) / table.timescale;
}

/**
 * Finds the frame covering an instant: the last frame starting at or before it, else the first.
 * @param table - A table accepted by presentationTableSchema.
 * @param time - A finite time in seconds.
 * @returns The covering frame's presentation index.
 * @throws {never} Never.
 */
export function presentationCoveringFrame(table: VideoPresentationTable, time: number): number {
  /**
   * Whether a frame starting at this tick has started by the requested time, compared in seconds.
   * @param start - The frame's start tick.
   * @returns True when the frame starts at or before the time.
   * @throws {never} Never.
   */
  const started = (start: number): boolean => start / table.timescale <= time;
  if (!started(table.runs[0]!.start)) return 0;
  let low = 0;
  let high = table.runs.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (started(table.runs[middle]!.start)) low = middle;
    else high = middle - 1;
  }
  const run = table.runs[low]!;
  // The float estimate is off by at most a few frames; the exact comparison settles it.
  let k = Math.min(run.count - 1, Math.max(0, Math.floor((time * table.timescale - run.start) / run.step)));
  while (k + 1 < run.count && started(run.start + (k + 1) * run.step)) k += 1;
  while (k > 0 && !started(run.start + k * run.step)) k -= 1;
  return runOffsets(table)[low]! + k;
}
