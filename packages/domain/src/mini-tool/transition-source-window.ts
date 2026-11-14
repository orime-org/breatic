// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { presentationSlack, type FrameWindow, type VideoPresentationTable } from "@breatic/shared/mini-tools";

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
 * The presented frame covering an exact time: the last frame starting at or before it. A source stores its frame times rounded
 * to its own clock, so a start at most `slack` (half a source tick) after the time is that rounding and covers it.
 * @param table - The presentation table.
 * @param at - The time in seconds as a numerator and a positive denominator.
 * @param slack - Half a tick of the source's time base, in seconds; none when absent.
 * @returns The frame's presentation index.
 * @throws {RangeError} When no presented frame covers the time.
 */
export function presentationFrameCovering(table: VideoPresentationTable, at: readonly [bigint, bigint], slack: readonly [bigint, bigint] = [0n, 1n]): number {
  const [timeNumerator, timeDenominator] = at;
  const [numerator, denominator] = [timeNumerator * slack[1] + slack[0] * timeDenominator, timeDenominator * slack[1]];
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
 * @param slack - Half a tick of the clip's source time base, in seconds.
 * @returns The source window.
 * @throws {RangeError} When an output frame's time lies outside the clip's presentation.
 */
export function transitionSourceWindow(table: VideoPresentationTable, clip: TransitionClipPlace, output: FrameWindow, fps: TransitionFrameRate, slack?: readonly [bigint, bigint]): FrameWindow {
  return { start: presentationFrameCovering(table, transitionSlotTime(clip, output.start, fps), slack), end: presentationFrameCovering(table, transitionSlotTime(clip, output.end - 1, fps), slack) + 1 };
}

/**
 * The covering slack of a clip's plan: half a source tick when its clock rounded its frame times (`presentationSlack`).
 * @param plan - The clip's plan.
 * @param plan.presentation - Its presentation table.
 * @param plan.originMapping - Its origin mapping.
 * @param plan.originMapping.timeBase - Its source time base.
 * @param plan.originMapping.timeBase.numerator - Its numerator.
 * @param plan.originMapping.timeBase.denominator - Its denominator.
 * @returns The slack in seconds as a numerator and denominator, or undefined.
 * @throws {never} Never.
 */
export function planSlack(plan: { presentation: VideoPresentationTable; originMapping: { timeBase: { numerator: string; denominator: string } } }): [bigint, bigint] | undefined {
  const slack = presentationSlack(plan.presentation, plan.originMapping.timeBase);
  return slack === null ? undefined : [BigInt(slack.numerator), BigInt(slack.denominator)];
}
