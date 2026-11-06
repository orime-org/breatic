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
