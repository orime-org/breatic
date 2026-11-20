// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The lip-sync facts a fresh admission checks and freezes (inner#1306 execution design §9.2, §9.3; multi-person lip-sync DD
 * §7.1; frames-split §7.11 fresh row): the selected model, the run caps, the referenced people analysis, the registered
 * audio durations, the timeline and the used source range. Each refusal is a 400 whose message tells the user why.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, ValidationError, getStorageAdapter, type MiniToolsConfig } from "@breatic/core";
import { t, type VideoPresentationDisplay } from "@breatic/shared";
import {
  lipsyncClipCropFrames, lipsyncPictureBytes, lipsyncSourceSpan, lipsyncTimeline, lipsyncUsedSourceRange, type TrackingClips, miniToolAnalysisRecordSchema,
  type LipsyncTimeline, type MiniToolPlannedRequest, type VideoExecutionDialogue,
} from "@breatic/shared/mini-tools";
import { miniToolFrozenAnalysisSchema } from "@domain/mini-tool/analysis.service.js";
import * as assetRepo from "@domain/asset/asset.repo.js";
import { modelSecondsRange } from "@domain/mini-tool/model-call-admission.js";
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
  /** The people analysis's anchor, a grid frame. */
  anchor: { frameIndex: number };
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
 * The timeline and the used source range, each checked against its model's duration range (§9.3), on the grid: the video
 * lasts its real video slots V ÷ fps, the anchor frame k starts at k ÷ fps and its slot ends at (k + 1) ÷ fps.
 * @param request - The request.
 * @param display - The selected version's display grid.
 * @param dialogues - The rows with registered durations.
 * @param settings - The configured lip-sync execution.
 * @param model - The selected model.
 * @returns The timeline and the used range.
 * @throws {AppError} When either lies outside its model's range.
 * @throws {ValidationError} When the rows or the anchor do not fit the video.
 */
export function lipSyncTimeline(request: LipSyncRequest, display: VideoPresentationDisplay, dialogues: VideoExecutionDialogue[], settings: LipSyncSettings,
  model: LipSyncSettings["models"][number]): { timeline: LipsyncTimeline; usedRange: { start: 0; end: number } } {
  let timeline: LipsyncTimeline;
  const { fps } = display;
  const anchor = request.draft.params.anchor.frameIndex;
  const frameSeconds = fps.denominator / fps.numerator;
  try {
    if (anchor >= display.frameCount) throw new RangeError("The anchor lies outside the grid");
    timeline = lipsyncTimeline({ videoDuration: display.realFrameCount * frameSeconds, dialogues, syncMode: request.draft.params.syncMode });
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
  const usedRange = lipsyncUsedSourceRange(timeline, [{ time: anchor * frameSeconds, windowEnd: (anchor + 1) * frameSeconds }]);
  // The tracker's seconds are its vendor's, from its provider rejects (execution design §11.5).
  const tracker = modelSecondsRange(settings.tracking.model);
  if (tracker.maxSeconds === null) throw new AppError(503, t("server.mini_tool.unavailable"));
  if (!within(usedRange.end - usedRange.start, { min_duration_seconds: tracker.minSeconds, max_duration_seconds: tracker.maxSeconds })) {
    throw new AppError(400, t("server.mini_tool.lipSyncTrackingOutOfRange", { min: tracker.minSeconds, max: tracker.maxSeconds }));
  }
  return { timeline, usedRange };
}

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
 * The crop file a person's clip writes (execution design paragraph before §9.4): one crop for each source frame the result
 * uses after the clip's forward decode has passed it.
 * @param sources - The source frame of each result frame.
 * @param cropSize - The crop side.
 * @returns The bytes.
 * @throws {never} Never.
 */
export function lipsyncClipCropBytes(sources: readonly number[], cropSize: number): number {
  return lipsyncClipCropFrames(sources).length * lipsyncPictureBytes(cropSize, cropSize, false);
}

/** Half-open result frames. */
type ResultWindow = { start: number; end: number };

/**
 * Split a window evenly into parts.
 * @param window - The window.
 * @param parts - The part count, at most its length.
 * @returns The parts in order.
 * @throws {never} Never.
 */
function evenParts(window: ResultWindow, parts: number): ResultWindow[] {
  const length = window.end - window.start;
  return Array.from({ length: parts }, (_unused, at) => ({ start: window.start + Math.floor((at * length) / parts), end: window.start + Math.floor(((at + 1) * length) / parts) }));
}

/**
 * The composite chunks (frames-split §5.4; execution design paragraph before §9.4): the result split evenly into the fewest
 * chunks each within the chunk share, across loop and bounce segment boundaries; a chunk whose source frames go back decodes
 * its union source window to a raw file, so one whose window is over the disk budget is cut at its segment boundaries and
 * each piece that still goes back is split evenly until its window fits.
 * @param input - The result's source frames, its monotonic segments, a window's job seconds, the share, a source window's
 * raw bytes and the disk budget.
 * @param input.sources - The source frame of each result frame.
 * @param input.segments - The monotonic segments in result order.
 * @param input.seconds - One chunk's job seconds, its start included.
 * @param input.shareSeconds - The chunk share.
 * @param input.rawBytes - The raw bytes of a decoded source window.
 * @param input.diskBytes - The raw disk budget.
 * @returns Half-open result-frame windows tiling the result.
 * @throws {RangeError} When the result is empty or one result frame alone is over the share.
 */
export function lipsyncCompositeChunks(input: { sources: readonly number[]; segments: readonly { resultStart: number; resultEnd: number }[];
  seconds: (window: ResultWindow) => number; shareSeconds: number; rawBytes: (span: ResultWindow) => number; diskBytes: number }): ResultWindow[] {
  const { sources, segments, seconds, shareSeconds, rawBytes, diskBytes } = input;
  const whole = { start: 0, end: sources.length };
  if (whole.end === 0) throw new RangeError("Expected a result frame");
  // Splitting never lowers the total work, so the whole's seconds over the share is the least chunk count.
  let timed: ResultWindow[] | null = null;
  for (let parts = Math.min(whole.end, Math.max(1, Math.ceil(seconds(whole) / shareSeconds))); timed === null && parts <= whole.end; parts += 1) {
    const windows = evenParts(whole, parts);
    if (windows.every((window) => seconds(window) <= shareSeconds)) timed = windows;
  }
  if (timed === null) throw new RangeError("One lip-sync result frame alone is over the chunk share");
  /**
   * Whether a window streams its source or its raw source window fits the disk.
   * @param window - The window.
   * @returns True when it fits.
   * @throws {never} Never.
   */
  const fits = (window: ResultWindow): boolean => { const span = lipsyncSourceSpan(sources, window); return !span.goesBack || rawBytes(span) <= diskBytes; };
  // ponytail: an oversized chunk is cut at every segment boundary; merge neighbouring pieces if the chunk count matters.
  return timed.flatMap((chunk) => fits(chunk) ? [chunk] : segments
    .map((segment) => ({ start: Math.max(segment.resultStart, chunk.start), end: Math.min(segment.resultEnd, chunk.end) }))
    .filter((piece) => piece.end > piece.start)
    .flatMap((piece) => {
      // A single result frame never goes back, so this ends.
      for (let parts = 1; ; parts += 1) {
        const windows = evenParts(piece, parts);
        if (windows.every(fits)) return windows;
      }
    }));
}
