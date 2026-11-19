// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The erase and expand facts a fresh admission checks and freezes (inner#1306 execution design §10.4, §10.5): the referenced
 * tracking analysis of an erase, and the expand window geometry in the model's standard frame. Each refusal is a 400 whose
 * message tells the user why.
 */
import { AppError, getStorageAdapter } from "@breatic/core";
import { t } from "@breatic/shared";
import { fingerprintMiniToolAnalysisInput, miniToolAnalysisRecordSchema, projectMiniToolAnalysisInput, type MiniToolPlannedRequest, type VideoExpandLayout } from "@breatic/shared/mini-tools";
import { miniToolFrozenAnalysisSchema } from "@domain/mini-tool/analysis.service.js";
import * as taskRepo from "@domain/task/task.repo.js";

/** A fresh erase request. */
export type EraseRequest = Extract<MiniToolPlannedRequest, { tool: "video.erase" }>;
/** An integer pixel rectangle. */
export interface PixelRect { x: number; y: number; width: number; height: number }
/** The tracking an erase reads: its analysis and the stored RLE's key. */
export interface EraseTracking { analysisRunId: string; rleKey: string }

/**
 * The referenced tracking analysis of an erase (§10.4 request row): completed, live, made for this draft's selection on the
 * same tool input, with its one RLE. The current selection is projected with the analysis's own frozen profile, as the web
 * fingerprints it, so a later change of the configured tracking profile does not make a valid tracking stale.
 * @param request - The request.
 * @param projectId - The run's project.
 * @param sourceURL - The source's canonical URL.
 * @returns The analysis and its RLE key.
 * @throws {AppError} `trackingRunning` while it runs, `trackingStale` when it is missing, failed or made for another selection.
 * @throws {Error} When the stored analysis or the storage adapter cannot be read.
 */
export async function eraseTracking(request: EraseRequest, projectId: string, sourceURL: string): Promise<EraseTracking> {
  const stale = new AppError(400, t("server.mini_tool.trackingStale"));
  const ref = request.analysis_refs[0];
  const task = ref === undefined ? null : await taskRepo.getAnalysisTask(ref.analysisRunId);
  if (ref === undefined || task === null || task.taskType !== "mini_tool_analysis" || task.projectId !== projectId) throw stale;
  if (task.status === "pending" || task.status === "running") throw new AppError(400, t("server.mini_tool.trackingRunning"));
  const frozen = miniToolFrozenAnalysisSchema.safeParse(task.params.analysis);
  const stored = miniToolAnalysisRecordSchema.safeParse((task.result as { analysis?: unknown } | null)?.analysis);
  const result = stored.success ? stored.data.result : null;
  if (task.status !== "completed" || !frozen.success || frozen.data.kind !== "tracked_mask" || result?.kind !== "tracked_mask" || !stored.success || stored.data.artifactUnavailable
    || frozen.data.inputFingerprint !== ref.inputFingerprint) throw stale;
  const current = await fingerprintMiniToolAnalysisInput(projectMiniToolAnalysisInput({ kind: "tracked_mask", source: { canonicalURL: sourceURL },
    profile: frozen.data.analysisInput.profile, params: request.draft.params }));
  if (current !== ref.inputFingerprint
    || frozen.data.presentationRef.source.toolInputId !== request.presentation_ref.source.toolInputId) throw stale;
  const rle = result.artifactRefs[0];
  const rleKey = rle === undefined ? null : (await getStorageAdapter()).keyFromUrl(rle.canonicalURL);
  if (rleKey === null) throw stale;
  return { analysisRunId: ref.analysisRunId, rleKey };
}

/** An expand window's frame: the model's standard frame, where the target and the source sit in it. */
export interface ExpandBox { frame: { width: number; height: number }; size: "832*480" | "480*832"; targetRoi: PixelRect; sourceRoi: PixelRect }

/**
 * The expand model's standard frame and the two rectangles a plan freezes in it (§10.5 standard frame row): a landscape or
 * square target is placed in 832x480, a portrait one in 480x832, scaled to fit and centred; `targetRoi` is the target's
 * rectangle (the composite crops it), `sourceRoi` the source's (the model input and mask place it), with even sides and kept inside `targetRoi`.
 * @param layout - The even video expand layout.
 * @param source - The source's display size.
 * @param source.width - Its width.
 * @param source.height - Its height.
 * @returns The frame and its rectangles.
 * @throws {never} Never.
 */
export function expandBox(layout: VideoExpandLayout, source: { width: number; height: number }): ExpandBox {
  const landscape = layout.width >= layout.height;
  const frame = landscape ? { width: 832, height: 480 } : { width: 480, height: 832 };
  const scale = Math.min(frame.width / layout.width, frame.height / layout.height);
  const width = Math.round(layout.width * scale);
  const height = Math.round(layout.height * scale);
  const targetRoi = { x: Math.round((frame.width - width) / 2), y: Math.round((frame.height - height) / 2), width, height };
  // The source layer is encoded as H.264, so its sides are even; the source is laid back over the result at its own
  // rectangle, which hides the at most one pixel this takes off.
  /**
   * A side rounded down to even, at least 2.
   * @param side - The side.
   * @returns The even side.
   * @throws {never} Never.
   */
  const even = (side: number): number => Math.max(2, 2 * Math.floor(side / 2));
  const sourceWidth = even(Math.round(source.width * scale));
  const sourceHeight = even(Math.round(source.height * scale));
  // Rounding the offset and the side can each add half a pixel, so the source is shifted back inside the target.
  const sourceRoi = {
    x: Math.max(targetRoi.x, Math.min(targetRoi.x + Math.round(layout.sourceX * scale), targetRoi.x + targetRoi.width - sourceWidth)),
    y: Math.max(targetRoi.y, Math.min(targetRoi.y + Math.round(layout.sourceY * scale), targetRoi.y + targetRoi.height - sourceHeight)),
    width: sourceWidth, height: sourceHeight };
  return { frame, size: landscape ? "832*480" : "480*832", targetRoi, sourceRoi };
}
