// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

// Kept free of zod: the media container maps result frames to source frames with these, and its process loads only our own code.

import { presentationCoveringFrame, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";

/** The lip-sync duration modes (execution design §9.2). */
export const VIDEO_TOOL_SYNC_MODES = ["cut_off", "silence", "loop", "bounce", "remap"] as const;

/** The frozen lip-sync timeline: the result duration, the video's presentation duration V and the duration mode. */
export interface LipsyncTimeline { duration: number; videoDuration: number; syncMode: (typeof VIDEO_TOOL_SYNC_MODES)[number] }

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
 * The presentation frames a composite chunk shows (execution design paragraph before §9.4): result frames
 * [window.start, window.end) at k · step / timescale of the table's first run map to source frames, and the chunk decodes
 * only [lowest, highest + 1) of them. The worker writes the chunk's entries over it and the container indexes its decoded
 * frames from its start, so both read this one function.
 * @param timeline - The frozen timeline.
 * @param table - The source's presentation table.
 * @param window - The chunk's half-open result frames.
 * @param window.start - The first.
 * @param window.end - The end.
 * @returns The half-open source presentation frames.
 * @throws {RangeError} When the table has no frame or the window is empty.
 */
export function lipsyncChunkSourceWindow(timeline: LipsyncTimeline, table: VideoPresentationTable, window: { start: number; end: number }): { start: number; end: number } {
  const step = table.runs[0]?.step;
  if (step === undefined) throw new RangeError("Expected a presented frame");
  if (window.end <= window.start) throw new RangeError("Expected a result frame");
  let [low, high] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let k = window.start; k < window.end; k += 1) {
    const frame = lipsyncSourceFrameAt(timeline, table, (k * step) / table.timescale);
    low = Math.min(low, frame);
    high = Math.max(high, frame);
  }
  return { start: low, end: high + 1 };
}
