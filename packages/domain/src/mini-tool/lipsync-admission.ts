// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync facts a fresh admission checks and freezes (inner#1306 execution design §9.2, §9.3; multi-person lip-sync DD
 * §7.1; frames-split §7.11 fresh row): the selected model, the run caps, the referenced people analysis, the registered
 * audio durations, the timeline and the used source range. Each refusal is a 400 whose message tells the user why.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, ValidationError, getStorageAdapter, type MiniToolsConfig } from "@breatic/core";
import { t } from "@breatic/shared";
import {
  lipsyncChunkSourceWindow, lipsyncTimeline, lipsyncUsedSourceRange, planLipsyncCompositeChunks, type LipsyncMonotonicSegment, type TrackingClips, miniToolAnalysisRecordSchema, presentationFrameAt, presentationVideoEnd,
  type LipsyncTimeline, type MiniToolPlannedRequest, type VideoExecutionDialogue, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";
import { miniToolFrozenAnalysisSchema } from "@domain/mini-tool/analysis.service.js";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** A fresh lip-sync request. */
export type LipSyncRequest = Extract<MiniToolPlannedRequest, { tool: "video.lip-sync" }>;
/** The configured lip-sync execution. */
export type LipSyncSettings = NonNullable<MiniToolsConfig["executions"]["video.lip-sync"]>;
/**
 * A per-person lip-sync step (DD §7.1 steps row): tracking runs on the forward clip, the reversed clip or both, and joins
 * them (execution design §10.2).
 */
export type LipSyncPersonStep = "track:fwd" | "track:rev" | "track_join" | "faces" | "clip" | "stem" | "gen";
/** A shared lip-sync step: a tracking clip's preparation, a composite chunk or the stitch. */
export type LipSyncSharedStep = "prepare:fwd" | "prepare:rev" | `composite:${number}` | "stitch";
/** A referenced person as the plan freezes it (DD §7.1 persons row). */
export interface LipSyncPerson {
  personId: string;
  detectionNumber: number;
  anchor: { frameIndex: number; pts: number };
  anchorFaceBox: { x: number; y: number; width: number; height: number };
  /** The step keys a retry carries from its original run, so the retry reuses the done steps (§97 D21-6). */
  stepKeys?: Partial<Record<LipSyncPersonStep, string>>;
}

/**
 * The DD §7.1 step key: a digest of the plan, the person (none for a shared step) and the step kind; erase and expand key
 * their steps the same way, with no person (execution design §10.7).
 * @param planFingerprint - The frozen plan's fingerprint.
 * @param personId - The person, or null for a shared step.
 * @param kind - The step kind.
 * @returns A 64-hex key.
 * @throws {never} Never.
 */
export function lipsyncStepKey(planFingerprint: string, personId: string | null, kind: string): string {
  return createHash("sha256").update(JSON.stringify({ planFingerprint, personId, kind })).digest("hex");
}

/**
 * The shared steps' keys a fresh plan freezes (DD §7.1 steps row): the tracking clips' preparations the anchor needs (the
 * forward clip of an anchor on the first frame is the run's preparation itself, execution design §10.2), `composite:<k>` per
 * composite chunk and `stitch`.
 * @param planFingerprint - The fingerprint of the plan the keys are frozen into, before its keys.
 * @param compositeChunks - The frozen composite chunk count.
 * @param clips - The tracking clips over the prepared frames.
 * @returns The keys by step.
 * @throws {never} Never.
 */
export function lipsyncSharedStepKeys(planFingerprint: string, compositeChunks: number, clips: TrackingClips): Record<string, string> {
  const preparations: LipSyncSharedStep[] = [...(clips.forward !== null && clips.reverse !== null ? ["prepare:fwd" as const] : []), ...(clips.reverse !== null ? ["prepare:rev" as const] : [])];
  const steps = [...preparations, ...Array.from({ length: compositeChunks }, (_, k) => `composite:${k}` as const), "stitch" as const];
  return Object.fromEntries(steps.map((step) => [step, lipsyncStepKey(planFingerprint, null, step)]));
}

/**
 * A person's step keys: those the plan froze, else the digests over the plan's fingerprint, one per tracking clip the anchor
 * needs (execution design §10.2) and the join, faces, clip, stem and gen.
 * @param planFingerprint - The run's plan fingerprint.
 * @param person - The frozen person.
 * @param clips - The tracking clips over the prepared frames.
 * @returns The person's step keys.
 * @throws {never} Never.
 */
export function lipsyncPersonStepKeys(planFingerprint: string, person: LipSyncPerson, clips: TrackingClips): Partial<Record<LipSyncPersonStep, string>> {
  if (person.stepKeys !== undefined) return person.stepKeys;
  const kinds: LipSyncPersonStep[] = [...(clips.forward !== null ? ["track:fwd" as const] : []), ...(clips.reverse !== null ? ["track:rev" as const] : []),
    "track_join", "faces", "clip", "stem", "gen"];
  return Object.fromEntries(kinds.map((kind) => [kind, lipsyncStepKey(planFingerprint, person.personId, kind)]));
}
/** The selected model as the plan freezes it (§9.3). */
export interface LipSyncGenerator { backend: "wavespeed-crop"; modelId: string; schemaFingerprint: string; providerSyncMode: "cut_off" | null }

/**
 * The selected model and the run caps, checked before anything is read.
 * @param request - The request.
 * @param settings - The configured lip-sync execution, absent where the deployment offers none.
 * @returns The configuration and the selected model.
 * @throws {AppError} When the model is not selectable or the rows exceed a cap.
 */
export function lipSyncModel(request: LipSyncRequest, settings: LipSyncSettings | undefined): { settings: LipSyncSettings; model: LipSyncSettings["models"][number] } {
  const modelId = request.draft.params.modelId ?? settings?.models[0]?.name;
  const model = settings?.models.find((candidate) => candidate.name === modelId);
  if (settings === undefined || model === undefined) throw new AppError(400, t("server.mini_tool.lipSyncModelUnavailable"));
  const { dialogues } = request.draft.params;
  if (dialogues.length > settings.max_dialogues) throw new AppError(400, t("server.mini_tool.lipSyncTooManyDialogues", { max: settings.max_dialogues }));
  if (new Set(dialogues.map((row) => row.personId)).size > settings.max_people) throw new AppError(400, t("server.mini_tool.lipSyncTooManyPeople", { max: settings.max_people }));
  return { settings, model };
}

/**
 * The referenced people analysis's people the rows name, in result order with their detection numbers (§97 D17-2, D18-2).
 * @param request - The request.
 * @param projectId - The run's project.
 * @returns The referenced people.
 * @throws {AppError} When the analysis still runs, or no longer matches this video and these rows.
 * @throws {Error} When the stored analysis is malformed.
 */
export async function lipSyncPeople(request: LipSyncRequest, projectId: string): Promise<LipSyncPerson[]> {
  const stale = new AppError(400, t("server.mini_tool.lipSyncPeopleStale"));
  const ref = request.analysis_refs.find((candidate) => candidate.kind === "people");
  const task = ref === undefined ? null : await taskRepo.getAnalysisTask(ref.analysisRunId);
  if (ref === undefined || task === null || task.taskType !== "mini_tool_analysis" || task.projectId !== projectId) throw stale;
  if (task.status === "pending" || task.status === "running") throw new AppError(400, t("server.mini_tool.lipSyncPeopleRunning"));
  const frozen = miniToolFrozenAnalysisSchema.safeParse(task.params.analysis);
  const stored = miniToolAnalysisRecordSchema.safeParse((task.result as { analysis?: unknown } | null)?.analysis);
  const result = stored.success ? stored.data.result : null;
  if (task.status !== "completed" || !frozen.success || frozen.data.kind !== "people" || result?.kind !== "people"
    || frozen.data.inputFingerprint !== ref.inputFingerprint
    || frozen.data.presentationRef.source.toolInputId !== request.presentation_ref.source.toolInputId) throw stale;
  const rows = request.draft.params.dialogues;
  if (rows.some((row) => row.analysisRunId !== ref.analysisRunId || !result.people.some((person) => person.personId === row.personId))) throw stale;
  const named = new Set(rows.map((row) => row.personId));
  return result.people.flatMap((person, index) => named.has(person.personId)
    ? [{ personId: person.personId, detectionNumber: index + 1, anchor: result.anchor, anchorFaceBox: person.faceBox }] : []);
}

/**
 * Each row with its audio's registered duration; the client's media claims never set a duration.
 * @param request - The request.
 * @returns The execution dialogues.
 * @throws {ValidationError} When a row's audio is not a live registered audio.
 */
export async function lipSyncDialogues(request: LipSyncRequest): Promise<VideoExecutionDialogue[]> {
  const storage = await getStorageAdapter();
  const inputs = new Map(request.draft.inputs.map((input) => [input.inputId, input]));
  return Promise.all(request.draft.params.dialogues.map(async (row) => {
    const { personId, audioInputId } = row;
    const input = audioInputId === null ? undefined : inputs.get(audioInputId);
    const key = input === undefined ? null : storage.keyFromUrl(input.url);
    const asset = key === null ? null : await assetRepo.findLiveByStorageKey(key);
    if (personId === null || audioInputId === null || asset === null || asset.kind !== "audio" || asset.durationSeconds === null || !(asset.durationSeconds > 0)) throw new ValidationError(t("server.mini_tool.foreignSource"));
    return { dialogueId: row.dialogueId, personId, audioInputId, startTime: row.startTime, duration: asset.durationSeconds };
  }));
}

/**
 * The timeline and the used source range, each checked against its model's duration range (§9.3).
 * @param request - The request.
 * @param table - The selected tool input's compact table.
 * @param dialogues - The rows with registered durations.
 * @param settings - The configured lip-sync execution.
 * @param model - The selected model.
 * @returns The timeline and the used range.
 * @throws {AppError} When either lies outside its model's range.
 * @throws {ValidationError} When the rows or the anchor do not fit the video.
 */
export function lipSyncTimeline(request: LipSyncRequest, table: VideoPresentationTable, dialogues: VideoExecutionDialogue[], settings: LipSyncSettings,
  model: LipSyncSettings["models"][number]): { timeline: LipsyncTimeline; usedRange: { start: 0; end: number } } {
  let timeline: LipsyncTimeline;
  let windowEnd: number;
  try {
    timeline = lipsyncTimeline({ videoDuration: presentationVideoEnd(table), dialogues, syncMode: request.draft.params.syncMode });
    windowEnd = presentationFrameAt(table, request.draft.params.anchor.frameIndex).displayEnd;
  } catch (error) {
    if (!(error instanceof RangeError || error instanceof z.ZodError)) throw error;
    throw new ValidationError(t("server.mini_tool.foreignSource"));
  }
  /**
   * Whether a length lies in a configured duration range, both ends included.
   * @param value - The length in seconds.
   * @param range - The range.
   * @param range.min_duration_seconds - Its shortest length.
   * @param range.max_duration_seconds - Its longest length.
   * @returns True when inside.
   * @throws {never} Never.
   */
  const within = (value: number, range: { min_duration_seconds: number; max_duration_seconds: number }): boolean =>
    value >= range.min_duration_seconds && value <= range.max_duration_seconds;
  if (!within(timeline.duration, model)) {
    throw new AppError(400, t("server.mini_tool.lipSyncDurationOutOfRange", { min: model.min_duration_seconds, max: model.max_duration_seconds }));
  }
  const usedRange = lipsyncUsedSourceRange(timeline, [{ time: request.draft.params.anchor.pts, windowEnd }]);
  if (!within(usedRange.end - usedRange.start, settings.tracking)) {
    throw new AppError(400, t("server.mini_tool.lipSyncTrackingOutOfRange", { min: settings.tracking.min_duration_seconds, max: settings.tracking.max_duration_seconds }));
  }
  return { timeline, usedRange };
}

/** The raw pictures a lip-sync job holds: the picture's size and alpha, the referenced people and their crop side. */
export interface LipsyncRawFrames { width: number; height: number; alpha: boolean; persons: number; cropSize: number }

/**
 * The disk a lip-sync job's raw decoded frames may fill (execution design paragraph before §9.4): the configured share of
 * its instance class's disk, the rest left to its downloaded inputs and its encoded output.
 * @param diskGb - The class's disk in GB (10^9 bytes, as Cloudflare publishes it).
 * @param share - The configured `encoding.raw_disk_share`.
 * @returns The bytes.
 * @throws {never} Never.
 */
export function lipsyncRawDiskBytes(diskGb: number, share: number): number {
  return Math.floor(diskGb * 1_000_000_000 * share);
}

/**
 * The bytes of one raw 8-bit 4:2:0 picture, as the container writes it.
 * @param width - Its width.
 * @param height - Its height.
 * @param alpha - Whether it carries an alpha plane.
 * @returns The bytes.
 * @throws {never} Never.
 */
function pictureBytes(width: number, height: number, alpha: boolean): number {
  return width * height * (alpha ? 2 : 1) + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
}

/**
 * The raw bytes one composite chunk holds on disk: the source frames it shows, its result frames, and each person's result
 * frames over the window, all decoded at once.
 * @param timeline - The frozen timeline.
 * @param table - The source's presentation table.
 * @param window - The chunk's result frames.
 * @param window.start - The first.
 * @param window.end - The end.
 * @param frames - The pictures.
 * @returns The bytes.
 * @throws {RangeError} When the table has no frame or the window is empty.
 */
export function lipsyncCompositeRawBytes(timeline: LipsyncTimeline, table: VideoPresentationTable, window: { start: number; end: number }, frames: LipsyncRawFrames): number {
  const shown = lipsyncChunkSourceWindow(timeline, table, window);
  const length = window.end - window.start;
  return (shown.end - shown.start + length) * pictureBytes(frames.width, frames.height, frames.alpha) + frames.persons * length * pictureBytes(frames.cropSize, frames.cropSize, false);
}

/**
 * The raw bytes a person's clip holds beside one decoded segment: its result's crops and one prepared frame, the least a
 * segment needs.
 * @param resultFrames - The result frames.
 * @param frames - The pictures.
 * @returns The bytes.
 * @throws {never} Never.
 */
export function lipsyncClipRawBytes(resultFrames: number, frames: LipsyncRawFrames): number {
  return resultFrames * pictureBytes(frames.cropSize, frames.cropSize, false) + pictureBytes(frames.width, frames.height, frames.alpha);
}

/**
 * The composite chunks (frames-split §5.4; execution design paragraph before §9.4): cut by the time share inside each
 * monotonic segment, then each split evenly into the fewest parts whose raw frames fit the disk budget.
 * @param input - The timeline, table, segments, a frame's work, the share, the pictures and the disk budget.
 * @param input.timeline - The frozen timeline.
 * @param input.table - The source's presentation table.
 * @param input.segments - The monotonic segments in result order.
 * @param input.frameSeconds - One result frame's work.
 * @param input.targetSeconds - The chunk share in seconds.
 * @param input.frames - The pictures.
 * @param input.diskBytes - The raw disk budget.
 * @returns Half-open result-frame windows tiling the result.
 * @throws {RangeError} When the work or the share is not positive, or one result frame alone is over the budget.
 */
export function lipsyncCompositeChunks(input: { timeline: LipsyncTimeline; table: VideoPresentationTable; segments: readonly Pick<LipsyncMonotonicSegment, "resultStart" | "resultEnd">[];
  frameSeconds: number; targetSeconds: number; frames: LipsyncRawFrames; diskBytes: number }): { start: number; end: number }[] {
  const { timeline, table, frames, diskBytes } = input;
  /**
   * The raw bytes of a window.
   * @param window - The window.
   * @param window.start - Its first result frame.
   * @param window.end - Its end.
   * @returns The bytes.
   * @throws {RangeError} When the window is empty.
   */
  const bytes = (window: { start: number; end: number }): number => lipsyncCompositeRawBytes(timeline, table, window, frames);
  return planLipsyncCompositeChunks(input).flatMap((chunk) => {
    const length = chunk.end - chunk.start;
    for (let parts = Math.min(length, Math.max(1, Math.ceil(bytes(chunk) / diskBytes))); parts <= length; parts += 1) {
      const windows = Array.from({ length: parts }, (_unused, at) => ({
        start: chunk.start + Math.floor((at * length) / parts), end: chunk.start + Math.floor(((at + 1) * length) / parts) }));
      if (windows.every((window) => bytes(window) <= diskBytes)) return windows;
    }
    throw new RangeError("One lip-sync result frame alone is over the raw disk budget");
  });
}
