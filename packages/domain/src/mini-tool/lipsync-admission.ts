// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync facts a fresh admission checks and freezes (inner#1306 execution design §9.2, §9.3; multi-person lip-sync DD
 * §7.1; frames-split §7.11 fresh row): the selected model, the run caps, the referenced people analysis, the registered
 * audio durations, the timeline and the used source range. Each refusal is a 400 whose message tells the user why.
 */
import { z } from "zod";
import { AppError, ValidationError, getStorageAdapter, type MiniToolsConfig } from "@breatic/core";
import { t } from "@breatic/shared";
import {
  lipsyncTimeline, lipsyncUsedSourceRange, miniToolAnalysisRecordSchema, presentationFrameAt, presentationVideoEnd,
  type LipsyncTimeline, type MiniToolPlannedRequest, type VideoExecutionDialogue, type VideoPresentationTable,
} from "@breatic/shared/mini-tools";
import { miniToolFrozenAnalysisSchema } from "@domain/mini-tool/analysis.service.js";
import * as assetRepo from "@domain/asset/asset.repo.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** A fresh lip-sync request. */
export type LipSyncRequest = Extract<MiniToolPlannedRequest, { tool: "video.lip-sync" }>;
/** The configured lip-sync execution. */
export type LipSyncSettings = NonNullable<MiniToolsConfig["executions"]["video.lip-sync"]>;
/** A referenced person as the plan freezes it (DD §7.1 persons row). */
export interface LipSyncPerson {
  personId: string;
  detectionNumber: number;
  anchor: { frameIndex: number; pts: number };
  anchorFaceBox: { x: number; y: number; width: number; height: number };
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
