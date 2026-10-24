// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from "zod";
import {
  videoToolDialogueRowSchema,
  videoToolExpansionFrameSchema,
  videoToolSyncModeSchema,
  videoToolTimelineClipSchema,
  type VideoToolExpansionFrame,
  type VideoToolSyncMode,
  type VideoToolTimelineClip,
} from "@shared/mini-tools/video-draft.js";

export interface VideoSourceFrame { frameIndex: number; pts: number }
export interface VideoFrameTable { frames: readonly VideoSourceFrame[]; videoEnd: number }
export interface VideoFrameRequest { mode: "first" | "last" | "current" | "interval"; currentTime?: number; interval?: number }
export interface VideoFrameOutput extends VideoSourceFrame { outputIndex: number }
export interface VideoSplitOutput { outputIndex: number; start: number; end: number }
export interface VideoExpandPlan { width: number; height: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number }

const frameTableSchema = z.strictObject({
  frames: z.array(z.strictObject({ frameIndex: z.number().int().nonnegative(), pts: z.number() })).min(1),
  videoEnd: z.number().positive(),
}).superRefine((source, ctx) => {
  if (source.frames.some((frame, index) => frame.frameIndex !== index || frame.pts >= source.videoEnd || (index > 0 && frame.pts < source.frames[index - 1]!.pts))) ctx.addIssue({ code: "custom", path: ["frames"], message: "Expected complete presentation-ordered source frames before videoEnd" });
});
const frameRequestSchema = z.strictObject({
  mode: z.enum(["first", "last", "current", "interval"]),
  currentTime: z.number().nonnegative().optional(),
  interval: z.number().positive().optional(),
}).superRefine((request, ctx) => {
  if (request.mode === "current" && request.currentTime === undefined) ctx.addIssue({ code: "custom", path: ["currentTime"], message: "Current frame selection requires its displayed time" });
  if (request.mode === "interval" && request.interval === undefined) ctx.addIssue({ code: "custom", path: ["interval"], message: "Interval frame selection requires a positive period" });
});

/**
 * Finds the displayed frame covering a source-clock instant.
 * @param frames - Validated frames in presentation order.
 * @param time - The requested source time.
 * @returns The covering frame, bounded by the first and last displayed frames.
 * @throws {never} Never.
 */
function coveringFrame(frames: readonly VideoSourceFrame[], time: number): VideoSourceFrame {
  let left = 0;
  let right = frames.length - 1;
  while (left < right) {
    const middle = Math.ceil((left + right) / 2);
    if (frames[middle]!.pts <= time) left = middle;
    else right = middle - 1;
  }
  return frames[left]!;
}

/**
 * Builds every selected displayed-frame output, in source order.
 * @param source - The decoded source frame table and video end.
 * @param request - The selected frame mode and source-clock parameters.
 * @returns Complete deduplicated frame outputs with stable indices.
 * @throws {z.ZodError} When frame metadata or selection parameters are invalid.
 */
export function planVideoFrames(source: VideoFrameTable, request: VideoFrameRequest): VideoFrameOutput[] {
  const table = frameTableSchema.parse(source);
  const selection = frameRequestSchema.parse(request);
  let selected: VideoSourceFrame[];
  switch (selection.mode) {
    case "first": selected = [table.frames[0]!]; break;
    case "last": selected = [table.frames[table.frames.length - 1]!]; break;
    case "current": selected = [coveringFrame(table.frames, selection.currentTime!)]; break;
    case "interval": {
      const interval = selection.interval!;
      // Frame windows keep dense sampling bounded by the actual displayed-frame set.
      selected = table.frames.filter((frame, index) => {
        const start = Math.max(0, frame.pts);
        const end = table.frames[index + 1]?.pts ?? table.videoEnd;
        const candidate = Math.floor(start / interval);
        const sampleTime = candidate * interval >= start ? candidate * interval : (candidate + 1) * interval;
        return end > start && (end - start >= interval || sampleTime < end);
      });
      break;
    }
  }
  return selected.map((frame, outputIndex) => ({ outputIndex, ...frame }));
}

/**
 * Normalizes cuts to the shared displayed-frame boundaries and returns all segments.
 * @param source - The decoded source frame table and video end.
 * @param cuts - Editable source-clock cut positions.
 * @returns N plus one ranges for N distinct internal frame boundaries.
 * @throws {z.ZodError} When source metadata or a cut is invalid.
 * @throws {RangeError} When a cut lies beyond the source video.
 */
export function planVideoSplit(source: VideoFrameTable, cuts: readonly number[]): VideoSplitOutput[] {
  const table = frameTableSchema.parse(source);
  const requested = z.array(z.number().nonnegative()).parse(cuts);
  if (requested.some((cut) => cut > table.videoEnd)) throw new RangeError("Split cut lies beyond videoEnd");
  const normalized = [...new Set(requested.filter((cut) => cut > 0 && cut < table.videoEnd).map((cut) => coveringFrame(table.frames, cut).pts).filter((pts) => pts > 0 && pts < table.videoEnd))].sort((a, b) => a - b);
  const boundaries = [0, ...normalized, table.videoEnd];
  return boundaries.slice(0, -1).map((start, outputIndex) => ({ outputIndex, start, end: boundaries[outputIndex + 1]! }));
}

/**
 * Groups a complete ordered output plan by the caller's per-job capacity.
 * @param outputs - Every planned output, retaining its global identity.
 * @param chunkSize - The existing container's configured capacity.
 * @returns Ordered chunks whose concatenation is the complete output sequence.
 * @throws {z.ZodError} When the per-job capacity is invalid.
 */
export function chunkVideoOutputs<T>(outputs: readonly T[], chunkSize: number): T[][] {
  const capacity = z.number().int().positive().parse(chunkSize);
  return Array.from({ length: Math.ceil(outputs.length / capacity) }, (_, index) => outputs.slice(index * capacity, (index + 1) * capacity));
}

/**
 * Converts the fixed-source target frame into integral output pixel geometry.
 * @param source - The original pixel size.
 * @param source.width - Original pixel width.
 * @param source.height - Original pixel height.
 * @param frame - The target frame in source-normalized coordinates.
 * @returns Complete target dimensions and source placement.
 * @throws {z.ZodError} When source or target geometry is invalid.
 */
export function planVideoExpand(source: { width: number; height: number }, frame: VideoToolExpansionFrame): VideoExpandPlan {
  const size = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(source);
  const target = videoToolExpansionFrameSchema.parse(frame);
  const output = {
    width: Math.round(size.width * target.width), height: Math.round(size.height * target.height),
    sourceX: Math.max(0, Math.round(-size.width * target.x)), sourceY: Math.max(0, Math.round(-size.height * target.y)),
    sourceWidth: size.width, sourceHeight: size.height,
  };
  z.object({ width: z.number().int().positive(), height: z.number().int().positive(), sourceX: z.number().int().nonnegative(), sourceY: z.number().int().nonnegative() }).parse(output);
  return output;
}

const executionDialogueSchema = videoToolDialogueRowSchema.omit({ analysisRunId: true }).extend({
  personId: z.string().min(1), audioInputId: z.string().uuid(), duration: z.number().positive(),
});
export type VideoExecutionDialogue = z.infer<typeof executionDialogueSchema>;
export interface VideoDialoguePlan { duration: number; dialogues: VideoExecutionDialogue[] }
export interface VideoDialoguePlanInput { videoDuration: number; dialogues: readonly VideoExecutionDialogue[]; syncMode: VideoToolSyncMode }

/**
 * Applies one duration mode to every explicitly positioned dialogue row.
 * @param input - The source duration, all dialogue rows and selected mode.
 * @returns The complete voice timeline and final video duration.
 * @throws {z.ZodError} When a source, row or timing value is invalid.
 */
export function planVideoDialogues(input: VideoDialoguePlanInput): VideoDialoguePlan {
  const request = z.strictObject({
    videoDuration: z.number().positive(), syncMode: videoToolSyncModeSchema,
    dialogues: z.array(executionDialogueSchema).min(1).refine((rows) => new Set(rows.map((row) => row.dialogueId)).size === rows.length),
  }).parse(input);
  const audioEnd = z.number().positive().parse(request.dialogues.reduce((end, row) => Math.max(end, row.startTime + row.duration), 0));
  const duration = request.syncMode === "cut_off" ? Math.min(request.videoDuration, audioEnd) : request.syncMode === "silence" ? Math.max(request.videoDuration, audioEnd) : audioEnd;
  return { duration, dialogues: request.dialogues };
}

export interface VideoPlannedClip extends VideoToolTimelineClip { start: number; end: number; overlap: number }
export interface VideoTimelinePlan { duration: number; clips: VideoPlannedClip[] }

/**
 * Derives one composition clock from trimmed clips and outgoing transitions.
 * @param clips - The complete ordered clip sequence.
 * @returns The source mappings and composition duration.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When overlaps exceed the available adjacent source ranges.
 */
export function planVideoTimeline(clips: readonly VideoToolTimelineClip[]): VideoTimelinePlan {
  const sequence = z.array(videoToolTimelineClipSchema).refine((items) => new Set(items.map((clip) => clip.clipId)).size === items.length).parse(clips);
  let cursor = 0;
  let incoming = 0;
  const planned = sequence.map((clip, index): VideoPlannedClip => {
    const length = clip.out - clip.in;
    const next = sequence[index + 1];
    const overlap = next === undefined || clip.transition.kind === "cut" ? 0 : clip.transition.duration;
    if (overlap + incoming > length || (next !== undefined && overlap > next.out - next.in)) throw new RangeError("Timeline overlaps exceed the adjacent clip ranges");
    const start = cursor;
    const end = z.number().positive().parse(start + length);
    cursor = end - overlap;
    incoming = overlap;
    return { ...clip, start, end, overlap };
  });
  return { duration: planned.at(-1)?.end ?? 0, clips: planned };
}
