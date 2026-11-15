// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { presentationConform, type FrameWindow, type VideoPresentationTable } from "@breatic/shared/mini-tools";

/** A clip's place on a transition's output frame grid: its first output frame and its In frame on that grid. */
export interface TransitionClipPlace { startFrame: number; inFrame: number }
/** An output frame rate as the plan writes it. */
export interface TransitionFrameRate { numerator: string; denominator: string }

/**
 * The time in a clip's presentation that output frame `k` shows (frames-split design §7.17 transition output profile row:
 * each clip takes, at output frame k, the source frame covering that moment), exact.
 * @param clip - The clip's place on the grid.
 * @param k - The output frame.
 * @param fps - The output frame rate.
 * @returns The time in seconds as a numerator and denominator.
 * @throws {never} Never.
 */
export function transitionSlotTime(clip: TransitionClipPlace, k: number, fps: TransitionFrameRate): [bigint, bigint] {
  return [BigInt(clip.inFrame + k - clip.startFrame) * BigInt(fps.denominator), BigInt(fps.numerator)];
}

/**
 * The presented frame covering an exact time: the last frame starting at or before it. On a table whose clock rounded a
 * constant rate's frame times, each frame from the second on starts on its exact grid point (`presentationConform`, §7.17
 * rounding clock row): it starts at or before the time when its stored start rounds to a grid point at or before it, that is
 * when it is stored before origin + (floor((t − origin) / period) + 1/2) · period.
 * @param table - The presentation table.
 * @param at - The time in seconds as a numerator and a positive denominator.
 * @returns The frame's presentation index.
 * @throws {RangeError} When no presented frame covers the time.
 */
export function presentationFrameCovering(table: VideoPresentationTable, at: readonly [bigint, bigint]): number {
  const conform = presentationConform(table);
  // The bound a frame start lies at or before (or, on a conform grid, strictly before) to start at or before the time.
  let [numerator, denominator] = at;
  if (conform !== null) {
    const [an, ad] = [BigInt(conform.origin.numerator), BigInt(conform.origin.denominator)];
    const [pn, pd] = [BigInt(conform.period.numerator), BigInt(conform.period.denominator)];
    // m = floor((t − a) / p); the bound is a + (m + 1/2) · p = (2 · an · pd + (2m + 1) · pn · ad) / (2 · ad · pd).
    const top = (numerator * ad - an * denominator) * pd;
    const bottom = denominator * ad * pn;
    const m = top >= 0n ? top / bottom : -((-top + bottom - 1n) / bottom);
    [numerator, denominator] = [2n * an * pd + (2n * m + 1n) * pn * ad, 2n * ad * pd];
  }
  const strict = conform !== null;
  const time = numerator * BigInt(table.timescale);
  let offset = 0;
  let found: { index: number; end: bigint } | null = null;
  let frames = 0;
  for (const run of table.runs) frames += run.count;
  for (const run of table.runs) {
    const start = BigInt(run.start);
    // The first frame keeps the presentation's start, so it covers any time from it on.
    if (offset > 0 && (strict ? start * denominator >= time : start * denominator > time)) break;
    const step = BigInt(run.step);
    const last = BigInt(run.count - 1);
    let reached = last;
    if (step !== 0n) reached = strict ? (time - start * denominator - 1n) / (step * denominator) : (time - start * denominator) / (step * denominator);
    if (reached < 0n) reached = 0n;
    const k = reached < last ? reached : last;
    found = { index: offset + Number(k), end: start + k * step + BigInt(run.duration) };
    offset += run.count;
  }
  const [timeNumerator, timeDenominator] = at;
  const before = found === null || BigInt(table.runs[0]!.start) * timeDenominator > timeNumerator * BigInt(table.timescale);
  // A stored end bounds only the last frame on a conform grid; every other frame ends where the next one starts.
  if (before || found!.end * timeDenominator <= timeNumerator * BigInt(table.timescale) && (!strict || found!.index === frames - 1)) {
    throw new RangeError("No presented frame covers the time");
  }
  return found!.index;
}

/**
 * The source presentation frames a clip shows over output frames `[start, end)`: from the frame covering the first output
 * frame's time to the one covering the last's.
 * @param table - The clip's presentation table.
 * @param clip - The clip's place on the grid.
 * @param output - The output frames.
 * @param fps - The output frame rate.
 * @returns The source window.
 * @throws {RangeError} When an output frame's time lies outside the clip's presentation.
 */
export function transitionSourceWindow(table: VideoPresentationTable, clip: TransitionClipPlace, output: FrameWindow, fps: TransitionFrameRate): FrameWindow {
  return { start: presentationFrameCovering(table, transitionSlotTime(clip, output.start, fps)), end: presentationFrameCovering(table, transitionSlotTime(clip, output.end - 1, fps)) + 1 };
}
