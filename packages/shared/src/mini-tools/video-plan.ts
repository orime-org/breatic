// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { z } from "zod";
import {
  presentationCoveringFrame,
  presentationFrameAt,
  presentationFrameCount,
  presentationTableSchema,
  presentationVideoEnd,
  type VideoPresentationTable,
} from "@shared/mini-tools/video-presentation-table.js";
import {
  videoToolDialogueRowSchema,
  videoToolSyncModeSchema,
  videoToolTimelineClipSchema,
  type VideoToolSyncMode,
  type VideoToolTimelineClip,
} from "@shared/mini-tools/video-draft.js";

export interface VideoFrameRequest { mode: "first" | "last" | "current"; currentTime?: number }
export interface VideoFrameOutput { outputIndex: number; frameIndex: number; pts: number }
export interface VideoSplitOutput { outputIndex: number; start: number; end: number }

// The first, last or current frame (frames-split §10.6: the interval mode is removed).
const frameRequestSchema = z.strictObject({
  mode: z.enum(["first", "last", "current"]),
  currentTime: z.number().nonnegative().optional(),
}).superRefine((request, ctx) => {
  if (request.mode === "current" && request.currentTime === undefined) ctx.addIssue({ code: "custom", path: ["currentTime"], message: "Current frame selection requires its displayed time" });
});

/**
 * Builds the selected displayed-frame output: the first, last or current frame, one output.
 * @param source - The compact presentation table.
 * @param request - The selected frame mode and source-clock parameters.
 * @param maxOutputs - Optional caller-configured admission ceiling, validated; one output always fits it.
 * @returns The frame output with its stable index.
 * @throws {z.ZodError} When the table, selection parameters or ceiling are invalid.
 */
export function planVideoFrames(source: VideoPresentationTable, request: VideoFrameRequest, maxOutputs?: number): VideoFrameOutput[] {
  if (maxOutputs !== undefined) z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(maxOutputs);
  const table = presentationTableSchema.parse(source);
  const selection = frameRequestSchema.parse(request);
  let picked: number[];
  switch (selection.mode) {
    case "first": picked = [0]; break;
    case "last": picked = [presentationFrameCount(table) - 1]; break;
    case "current": picked = [presentationCoveringFrame(table, selection.currentTime!)]; break;
  }
  return picked.map((frameIndex, outputIndex) => ({ outputIndex, frameIndex, pts: presentationFrameAt(table, frameIndex).pts }));
}

/**
 * Snaps cuts to covering frame starts and returns all segments from the first frame to the video end.
 * @param source - The compact presentation table.
 * @param cuts - Editable source-clock cut positions.
 * @returns N plus one ranges for N distinct internal frame boundaries.
 * @throws {z.ZodError} When the table or a cut is invalid.
 * @throws {RangeError} When a cut lies beyond the source video.
 */
export function planVideoSplit(source: VideoPresentationTable, cuts: readonly number[]): VideoSplitOutput[] {
  const table = presentationTableSchema.parse(source);
  const requested = z.array(z.number().nonnegative()).parse(cuts);
  const first = presentationFrameAt(table, 0).pts;
  const videoEnd = presentationVideoEnd(table);
  if (requested.some((cut) => cut > videoEnd)) throw new RangeError("Split cut lies beyond videoEnd");
  const inner = [...new Set(requested.filter((cut) => cut > first && cut < videoEnd).map((cut) => presentationFrameAt(table, presentationCoveringFrame(table, cut)).pts))]
    .filter((start) => start > first).sort((a, b) => a - b);
  const boundaries = [first, ...inner, videoEnd];
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
 * Derives a seconds composition clock from trimmed clips and outgoing transitions, for the editor's preview of any number of
 * clips; the execution plans on the output frame grid with {@link planVideoTimeline}.
 * @param clips - The complete ordered clip sequence.
 * @returns The source mappings and composition duration.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When overlaps exceed the available adjacent source ranges.
 */
export function planVideoTimelineSeconds(clips: readonly VideoToolTimelineClip[]): VideoTimelinePlan {
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

/** An exact rational frame rate, as the presentation plan writes it. */
export interface VideoFrameRate { numerator: string; denominator: string }
/** One clip of the frame-grid timeline: where it starts and how many output frames it lasts, and its trimmed source frames. */
export interface VideoFramePlannedClip { clipId: string; inputId: string; startFrame: number; frameCount: number; inFrame: number; outFrame: number }
/** The overlap window of a non-Cut transition, in output frames. */
export interface VideoFrameTransitionWindow { startFrame: number; frameCount: number; kind: "fade" | "wipeLeft" | "wipeRight" }
/** The two-clip transition timeline on the output frame grid (§97 D15-3): every number a whole count of output frames. */
export interface VideoFrameTimeline { fps: VideoFrameRate; frameCount: number; clips: VideoFramePlannedClip[]; window: VideoFrameTransitionWindow | null }

/**
 * The frame rate as frames per second.
 * @param fps - The exact rate.
 * @returns Its value.
 * @throws {RangeError} When it is not a positive rational.
 */
function framesPerSecond(fps: VideoFrameRate): number {
  const value = Number(fps.numerator) / Number(fps.denominator);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("A frame rate is a positive rational");
  return value;
}

/**
 * The nearest whole output frame of a time, a tie going down (§97 D15-3).
 * @param seconds - The time.
 * @param perSecond - The frame rate.
 * @returns The frame.
 * @throws {RangeError} When the frame is not a safe integer.
 */
function nearestFrame(seconds: number, perSecond: number): number {
  // `+ 0` turns the -0 that ceil gives for (-0.5, 0] into 0.
  const frame = Math.ceil(seconds * perSecond - 0.5) + 0;
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("A timeline time lies beyond whole output frames");
  return frame;
}

/**
 * Whether a trimmed clip snaps to no output frame (§97 D15-3: in and out snap to the nearest frame, a tie going down), which
 * {@link planVideoTimeline} refuses; the panel checks it before any node is made.
 * @param clip - The trimmed clip.
 * @param fps - The output frame rate.
 * @returns True when the clip has no output frame.
 * @throws {RangeError} When the frame rate is not positive.
 */
export function timelineClipLacksOutputFrame(clip: Pick<VideoToolTimelineClip, "in" | "out">, fps: VideoFrameRate): boolean {
  const perSecond = framesPerSecond(fps);
  return nearestFrame(clip.out, perSecond) <= nearestFrame(clip.in, perSecond);
}

/**
 * Plans the two-clip transition timeline on the output frame grid (§97 D15-3; frames-split §7.17): each clip's in and
 * out and the transition duration snap to the nearest output frame (a tie going down), a transition lasts at least one
 * frame, its window starts where the first clip ends less the window, and the second clip starts with the window; a Cut
 * has no window and the second clip starts where the first ends.
 * @param clips - The two ordered clips; the first one's transition joins them.
 * @param fps - The output frame rate.
 * @returns The frame-grid timeline.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When there are not two clips, a clip has no frame, or the window exceeds a clip.
 */
export function planVideoTimeline(clips: readonly VideoToolTimelineClip[], fps: VideoFrameRate): VideoFrameTimeline {
  const sequence = z.array(videoToolTimelineClipSchema).refine((items) => new Set(items.map((clip) => clip.clipId)).size === items.length).parse(clips);
  if (sequence.length !== 2) throw new RangeError("A transition timeline has two clips");
  const perSecond = framesPerSecond(fps);
  const [first, second] = sequence.map((clip) => {
    if (timelineClipLacksOutputFrame(clip, fps)) throw new RangeError("A timeline clip lasts at least one output frame");
    const inFrame = nearestFrame(clip.in, perSecond);
    const outFrame = nearestFrame(clip.out, perSecond);
    return { clipId: clip.clipId, inputId: clip.inputId, startFrame: 0, frameCount: outFrame - inFrame, inFrame, outFrame };
  }) as [VideoFramePlannedClip, VideoFramePlannedClip];
  const transition = sequence[0]!.transition;
  const window = transition.kind === "cut" ? null : {
    startFrame: 0, frameCount: Math.max(1, nearestFrame(transition.duration, perSecond)), kind: transition.kind,
  };
  if (window !== null && (window.frameCount > first.frameCount || window.frameCount > second.frameCount)) throw new RangeError("Timeline overlaps exceed the adjacent clip ranges");
  const secondStart = first.frameCount - (window?.frameCount ?? 0);
  const placed = { ...second, startFrame: secondStart };
  return {
    fps, frameCount: secondStart + placed.frameCount, clips: [first, placed],
    window: window === null ? null : { ...window, startFrame: secondStart },
  };
}

/**
 * The duration range of a non-Cut transition (canvas design §4 transitions row, frames-split §7.17): from one output frame
 * to half the shorter trimmed clip on the output frame grid, in seconds.
 * @param clips - The two ordered clips.
 * @param fps - The output frame rate.
 * @returns The smallest and largest duration, or null when half the shorter clip is under one frame.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When the frame rate is not positive.
 */
export function transitionDurationBounds(clips: readonly VideoToolTimelineClip[], fps: VideoFrameRate): { min: number; max: number } | null {
  const sequence = z.array(videoToolTimelineClipSchema).min(1).parse(clips);
  const perSecond = framesPerSecond(fps);
  // Half the shorter clip, counted on the output grid the timeline snaps to.
  const frames = Math.min(...sequence.map((clip) => nearestFrame(clip.out, perSecond) - nearestFrame(clip.in, perSecond)));
  const min = Number(fps.denominator) / Number(fps.numerator);
  const max = (frames / 2) * Number(fps.denominator) / Number(fps.numerator);
  return max < min ? null : { min, max };
}

/**
 * The clips with every transition that no longer fits turned into a Cut (frames-split §5.4: the front end and admission
 * share one check): a junction keeps its type and duration while the duration lies within `transitionDurationBounds` of
 * the two clips it joins, on the output grid, or within half the shorter of them while the grid is unknown; the last clip
 * carries no transition.
 * @param clips - The ordered clips.
 * @param fps - The output frame rate, or null while it is unknown.
 * @returns The clips, each junction kept or made a Cut.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When the frame rate is not positive.
 */
export function fitTransitions(clips: readonly VideoToolTimelineClip[], fps: VideoFrameRate | null): VideoToolTimelineClip[] {
  return junctions(clips, fps, (clip, bounds) => {
    const { duration } = clip.transition;
    return bounds !== null && duration >= bounds.min - ON_MICROSECOND_GRID && duration <= bounds.max + ON_MICROSECOND_GRID ? clip.transition : CUT;
  });
}

/**
 * How far a stored length may sit outside its bounds: the Dialog writes lengths to the nearest whole microsecond, and a
 * bound such as 1001/30000 s is no whole number of them; the frame plan rounds to whole frames either way.
 */
const ON_MICROSECOND_GRID = 5e-7 + 1e-9;

/**
 * The clips after an edit inside the timeline Dialog (canvas design §4 transitions row): each junction keeps its type with its duration
 * held within `transitionDurationBounds` of the two clips it joins, or within half the shorter of them while the grid is
 * unknown; a junction no transition fits becomes a Cut, and the last clip carries no transition.
 * @param clips - The ordered clips.
 * @param fps - The output frame rate, or null while it is unknown.
 * @returns The clips, each junction held or made a Cut.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When the frame rate is not positive.
 */
export function clampTransitions(clips: readonly VideoToolTimelineClip[], fps: VideoFrameRate | null): VideoToolTimelineClip[] {
  return junctions(clips, fps, (clip, bounds) => bounds === null || bounds.max <= 0 ? CUT
    : { kind: clip.transition.kind, duration: Math.min(bounds.max, Math.max(bounds.min, clip.transition.duration)) });
}

const CUT: VideoToolTimelineClip["transition"] = { kind: "cut", duration: 0 };

/**
 * Decide every junction from its duration bounds, the last clip and every Cut carrying a Cut.
 * @param clips - The ordered clips.
 * @param fps - The output frame rate, or null while it is unknown (half the shorter clip then bounds it).
 * @param decide - The junction's next transition from its bounds.
 * @returns The clips with the decided transitions.
 * @throws {z.ZodError} When clip data is invalid.
 * @throws {RangeError} When the frame rate is not positive.
 */
function junctions(clips: readonly VideoToolTimelineClip[], fps: VideoFrameRate | null,
  decide: (clip: VideoToolTimelineClip, bounds: { min: number; max: number } | null) => VideoToolTimelineClip["transition"]): VideoToolTimelineClip[] {
  return clips.map((clip, index) => {
    const next = clips[index + 1];
    if (clip.transition.kind === "cut" || next === undefined) return { ...clip, transition: CUT };
    const pair = [clip, next];
    const bounds = fps === null ? { min: 0, max: Math.min(...pair.map((item) => item.out - item.in)) / 2 } : transitionDurationBounds(pair, fps);
    const transition = decide(clip, bounds);
    return transition === clip.transition ? clip : { ...clip, transition };
  });
}
