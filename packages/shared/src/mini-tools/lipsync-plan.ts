// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lip-sync plan both sides compute (inner#1306; execution design §9.2–§9.4, multi-person lip-sync DD): the frozen
 * timeline, the result-to-source time mapping per duration mode, the source range a run uses, and the failure reason
 * with its one retryability rule.
 */

import { z } from "zod";
import { modelRunRetryable } from "@shared/mini-tools/model-run-retryable.js";
import { planVideoDialogues, type VideoDialoguePlanInput } from "@shared/mini-tools/video-plan.js";
import { lipsyncResultFrameCount, lipsyncSourceFrameAt, lipsyncSourceTickAt, type LipsyncGrid, type LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";
export {
  lipsyncChunkSourceWindow, lipsyncClipCropFrames, lipsyncPictureBytes, lipsyncResultFrameCount, lipsyncResultSourceFrames, lipsyncSourceSpan, lipsyncSourceTickAt,
  lipsyncSourceFrameAt, type LipsyncGrid, type LipsyncTimeline,
} from "@shared/mini-tools/lipsync-timeline.js";

/**
 * The frozen timeline of a lip-sync plan: the dialogue planner's result duration with the video duration and mode (§9.2).
 * @param input - The video duration, the dialogue rows and the mode.
 * @returns The timeline.
 * @throws {z.ZodError} When a source, row or timing value is invalid.
 */
export function lipsyncTimeline(input: VideoDialoguePlanInput): LipsyncTimeline {
  const { duration } = planVideoDialogues(input);
  return { duration, videoDuration: input.videoDuration, syncMode: input.syncMode };
}

/**
 * The source range a run uses (§9.3): from 0 to the result duration for cut_off or the video duration otherwise, reaching
 * the window end of any referenced person's anchor frame at or after that end.
 * @param timeline - The frozen timeline.
 * @param anchors - Each referenced person's anchor frame time and its presentation window end.
 * @returns The range.
 * @throws {never} Never.
 */
export function lipsyncUsedSourceRange(timeline: LipsyncTimeline, anchors: readonly { time: number; windowEnd: number }[]): { start: 0; end: number } {
  const base = timeline.syncMode === "cut_off" ? timeline.duration : timeline.videoDuration;
  return { start: 0, end: anchors.reduce((end, anchor) => (anchor.time >= base ? Math.max(end, anchor.windowEnd) : end), base) };
}

const category = z.enum(["no_face", "model_rejected", "timeout", "failed", "stopped"]);
/** One lip-sync failure (§9.4): a line per person that did not succeed and the step outside every person. */
export const lipsyncFailureReasonSchema = z.strictObject({
  kind: z.literal("lipsync"),
  persons: z.array(z.strictObject({
    personId: z.string().min(1), detectionNumber: z.number().int().positive(),
    step: z.enum(["track", "faces", "clip", "stem", "gen"]), category,
  })),
  shared: z.strictObject({ step: z.enum(["prepare", "composite", "stitch", "expired"]), category }).nullable(),
});
/** A parsed lip-sync failure reason. */
export type LipsyncFailureReason = z.infer<typeof lipsyncFailureReasonSchema>;

/**
 * Whether a lip-sync failure can be retried (§9.4), by shared `modelRunRetryable`: stopped people follow what stopped them,
 * and every other person line and the shared step must be timeout or failed.
 * @param reason - The failure reason.
 * @returns True when retrying the failed items can succeed.
 * @throws {z.ZodError} When the reason is malformed.
 */
export function lipsyncFailureRetryable(reason: unknown): boolean {
  const parsed = lipsyncFailureReasonSchema.parse(reason);
  return modelRunRetryable({ items: parsed.persons, shared: parsed.shared });
}

/** A run of result frames whose source frames move one way (frames-split §5.4, the row on measured decode work); frames, ranges half-open. */
export interface LipsyncMonotonicSegment {
  resultStart: number;
  resultEnd: number;
  /** The source frames the segment's decode passes: every frame of [0, V) for remap, else the frames it shows. */
  sourceStart: number;
  sourceEnd: number;
  direction: "forward" | "reverse";
  /** Frames decoded before `sourceStart`: the job's pre-roll (§5.4), never more than the frames before it. */
  prerollFrames: number;
}

/**
 * Split the result grid the container writes (frame k at k / fps of the source grid) into forward and reverse segments of
 * the source mapping: loop starts a forward segment at each wrap, bounce is forward while u = t mod 2V lies in [0, V] and
 * reverse after, every other mode is one forward segment. A reverse segment is decoded GOP by GOP forward once and
 * emitted reversed, so its decode work is the same as a forward pass over its interval.
 * @param timeline - The frozen timeline.
 * @param grid - The source's frame grid.
 * @param prerollFrames - The tool source's decode pre-roll (`decodePrerollFrames`, §5.4).
 * @returns The segments in result order.
 * @throws {RangeError} When the grid has no frame or the result has none.
 */
export function lipsyncMonotonicSegments(timeline: LipsyncTimeline, grid: LipsyncGrid, prerollFrames: number): LipsyncMonotonicSegment[] {
  if (grid.frameCount <= 0) throw new RangeError("Expected a presented frame");
  const count = lipsyncResultFrameCount(timeline, grid);
  if (count <= 0) throw new RangeError("Expected a result frame");
  const segments: LipsyncMonotonicSegment[] = [];
  let open: { start: number; reverse: boolean; low: number; high: number } | null = null;
  let previous = 0;
  /**
   * Close the open segment at a result frame.
   * @param end - The result frame it ends before.
   * @throws {never} Never.
   */
  const close = (end: number): void => {
    if (open === null) return;
    const [sourceStart, sourceEnd] = timeline.syncMode === "remap" ? [0, grid.frameCount] : [open.low, open.high + 1];
    segments.push({ resultStart: open.start, resultEnd: end, sourceStart, sourceEnd, direction: open.reverse ? "reverse" : "forward", prerollFrames: Math.min(prerollFrames, sourceStart) });
  };
  for (let k = 0; k < count; k += 1) {
    const { tick, reverse } = lipsyncSourceTickAt(timeline, grid.fps.numerator, k * grid.fps.denominator);
    const frame = lipsyncSourceFrameAt(timeline, grid, k);
    // A forward source tick falls back only where a loop wraps; a reverse one falls throughout.
    if (open === null || open.reverse !== reverse || (!reverse && tick < previous)) {
      close(k);
      open = { start: k, reverse, low: frame, high: frame };
    } else {
      open.low = Math.min(open.low, frame);
      open.high = Math.max(open.high, frame);
    }
    previous = tick;
  }
  close(count);
  return segments;
}
