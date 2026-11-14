// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { FrameWindow, VideoPresentationTable } from "@breatic/shared/mini-tools";

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
 * The presented frame covering an exact time: the last frame starting at or before it.
 * @param table - The presentation table.
 * @param at - The time in seconds as a numerator and a positive denominator.
 * @returns The frame's presentation index.
 * @throws {RangeError} When no presented frame covers the time.
 */
export function presentationFrameCovering(table: VideoPresentationTable, at: readonly [bigint, bigint]): number {
  const [numerator, denominator] = at;
  // Frame start `s` ticks is at or before the time when s · denominator ≤ numerator · timescale.
  const time = numerator * BigInt(table.timescale);
  let offset = 0;
  let found: { index: number; end: bigint } | null = null;
  for (const run of table.runs) {
    const start = BigInt(run.start);
    if (start * denominator > time) break;
    const step = BigInt(run.step);
    const last = BigInt(run.count - 1);
    const reached = step === 0n ? last : (time - start * denominator) / (step * denominator);
    const k = reached < last ? reached : last;
    found = { index: offset + Number(k), end: start + k * step + BigInt(run.duration) };
    offset += run.count;
  }
  if (found === null || found.end * denominator <= time) throw new RangeError("No presented frame covers the time");
  return found.index;
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
