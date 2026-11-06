// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync plan both sides compute (inner#1306; execution design §9.2–§9.4, multi-person lip-sync DD): the frozen
 * timeline, the result-to-source time mapping per duration mode, the source range a run uses, and the failure reason
 * with its one retryability rule.
 */

import { z } from "zod";
import { presentationCoveringFrame, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-table.js";
import { planVideoDialogues, type VideoDialoguePlanInput } from "@shared/mini-tools/video-plan.js";
import type { VideoToolSyncMode } from "@shared/mini-tools/video-draft.js";

/** The frozen lip-sync timeline: the result duration, the video's presentation duration V and the duration mode. */
export interface LipsyncTimeline { duration: number; videoDuration: number; syncMode: VideoToolSyncMode }

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
 * The source presentation time s in [0, V] a result time shows (§9.2, §97 D14-1), s = V being the last presentation frame:
 * cut_off s = t; silence s = min(t, V); loop s = t mod V; bounce u = t mod 2V, s = u when u <= V else 2V - u; remap
 * s = t · V / duration.
 * @param timeline - The frozen timeline.
 * @param t - The result time in seconds.
 * @returns The source presentation time.
 * @throws {never} Never.
 */
export function lipsyncSourceTimeAt(timeline: LipsyncTimeline, t: number): number {
  const v = timeline.videoDuration;
  switch (timeline.syncMode) {
    case "cut_off": return t;
    case "silence": return Math.min(t, v);
    case "loop": return t % v;
    case "bounce": {
      const u = t % (2 * v);
      return u <= v ? u : 2 * v - u;
    }
    case "remap": return (t * v) / timeline.duration;
  }
}

/**
 * The presentation frame a result time shows: the frame covering its source time, s = V giving the last frame.
 * @param timeline - The frozen timeline.
 * @param table - The source's compact presentation table.
 * @param t - The result time in seconds.
 * @returns The presentation frame index.
 * @throws {never} Never.
 */
export function lipsyncSourceFrameAt(timeline: LipsyncTimeline, table: VideoPresentationTable, t: number): number {
  return presentationCoveringFrame(table, lipsyncSourceTimeAt(timeline, t));
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
 * Whether a lip-sync failure can be retried (§9.4): only when every person line and the shared step are timeout or failed.
 * @param reason - The failure reason.
 * @returns True when retrying the failed items can succeed.
 * @throws {z.ZodError} When the reason is malformed.
 */
export function lipsyncFailureRetryable(reason: unknown): boolean {
  const parsed = lipsyncFailureReasonSchema.parse(reason);
  /**
   * Whether a category is temporary.
   * @param value - The category.
   * @returns True for timeout and failed.
   * @throws {never} Never.
   */
  const transient = (value: string): boolean => value === "timeout" || value === "failed";
  return parsed.persons.every((person) => transient(person.category)) && (parsed.shared === null || transient(parsed.shared.category));
}
