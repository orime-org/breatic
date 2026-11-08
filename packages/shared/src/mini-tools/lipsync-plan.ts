// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync plan both sides compute (inner#1306; execution design §9.2–§9.4, multi-person lip-sync DD): the frozen
 * timeline, the result-to-source time mapping per duration mode, the source range a run uses, and the failure reason
 * with its one retryability rule.
 */

import { z } from "zod";
import { modelRunRetryable } from "@shared/mini-tools/model-run-retryable.js";
import { planVideoDialogues, type VideoDialoguePlanInput } from "@shared/mini-tools/video-plan.js";
import { lipsyncSourceFrameAt, type LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";
import { presentationFrameCount } from "@shared/mini-tools/video-presentation-table.js";
import type { VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
export { lipsyncChunkSourceWindow, lipsyncSourceTimeAt, lipsyncSourceFrameAt, type LipsyncTimeline } from "@shared/mini-tools/lipsync-timeline.js";

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
  /** Frames decoded before `sourceStart` from the keyframe at or before it; a reverse segment's later GOPs start on their own keyframe. */
  prerollFrames: number;
}

/**
 * Split the result grid the container writes (frame k at k · step / timescale of the table's first run) into forward and
 * reverse segments of the source mapping: loop starts a forward segment at each wrap, bounce is forward while
 * u = t mod 2V lies in [0, V] and reverse after, every other mode is one forward segment. A reverse segment is decoded GOP by
 * GOP forward once and emitted reversed, so its decode work is the same as a forward pass over its interval.
 * @param timeline - The frozen timeline.
 * @param table - The source's presentation table.
 * @param keyframes - The per-presentation-frame keyframe flags.
 * @returns The segments in result order.
 * @throws {RangeError} When the table has no frame or the result has none.
 */
export function lipsyncMonotonicSegments(timeline: LipsyncTimeline, table: VideoPresentationTable, keyframes: readonly boolean[]): LipsyncMonotonicSegment[] {
  const run = table.runs[0];
  if (run === undefined) throw new RangeError("Expected a presented frame");
  const count = Math.ceil(Math.round(timeline.duration * table.timescale) / run.step);
  if (count <= 0) throw new RangeError("Expected a result frame");
  const v = timeline.videoDuration;
  /**
   * Where a result time is in its cycle and which way it moves.
   * @param t - The result time.
   * @returns The position and whether it moves back.
   * @throws {never} Never.
   */
  const phase = (t: number): { at: number; reverse: boolean } => {
    if (timeline.syncMode === "loop") return { at: t % v, reverse: false };
    if (timeline.syncMode === "bounce") { const u = t % (2 * v); return { at: u, reverse: u > v }; }
    return { at: t, reverse: false };
  };
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
    const [sourceStart, sourceEnd] = timeline.syncMode === "remap" ? [0, presentationFrameCount(table)] : [open.low, open.high + 1];
    let key = sourceStart;
    while (key > 0 && keyframes[key] !== true) key -= 1;
    segments.push({ resultStart: open.start, resultEnd: end, sourceStart, sourceEnd, direction: open.reverse ? "reverse" : "forward", prerollFrames: sourceStart - key });
  };
  for (let k = 0; k < count; k += 1) {
    const t = (k * run.step) / table.timescale;
    const { at, reverse } = phase(t);
    const frame = lipsyncSourceFrameAt(timeline, table, t);
    if (open === null || open.reverse !== reverse || at < previous) {
      close(k);
      open = { start: k, reverse, low: frame, high: frame };
    } else {
      open.low = Math.min(open.low, frame);
      open.high = Math.max(open.high, frame);
    }
    previous = at;
  }
  close(count);
  return segments;
}

/**
 * Cut composite chunks on the result axis: never across a monotonic segment, each within the chunk share, the fewest per
 * segment, split evenly.
 * @param input - The segments, each result frame's work in seconds and the chunk share in seconds.
 * @param input.segments - The segments in result order.
 * @param input.frameSeconds - One result frame's work.
 * @param input.targetSeconds - The chunk share.
 * @returns Half-open result-frame windows tiling the result.
 * @throws {RangeError} When the work or the share is not positive.
 */
export function planLipsyncCompositeChunks(input: { segments: readonly Pick<LipsyncMonotonicSegment, "resultStart" | "resultEnd">[]; frameSeconds: number; targetSeconds: number }):
  { start: number; end: number }[] {
  const { segments, frameSeconds, targetSeconds } = input;
  if (!(frameSeconds > 0) || !(targetSeconds > 0)) throw new RangeError("Expected positive work and share");
  // A frame over the whole share still makes a chunk of one frame; admission refuses a job over its share.
  const perChunk = Math.max(1, Math.floor(targetSeconds / frameSeconds + 1e-9));
  return segments.flatMap((segment) => {
    const length = segment.resultEnd - segment.resultStart;
    const parts = Math.ceil(length / perChunk);
    return Array.from({ length: parts }, (_, at) => ({
      start: segment.resultStart + Math.floor((at * length) / parts), end: segment.resultStart + Math.floor(((at + 1) * length) / parts) }));
  });
}
