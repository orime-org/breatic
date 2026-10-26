// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolPlanJobReport, MiniToolPlanJobRequest, MiniToolPlanPixelRect, StudioAssetEntity } from "@breatic/shared";
import type { MiniToolAnalysisRecord, MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

/** The owned people result preserves the accepted identity and canonical thumbnails. */
export type MiniToolPeopleAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "people" }>;

/** Display candidates retain their detector indices and saved integer pixel regions. */
export interface MiniToolDisplayPeople {
  schemaVersion: 1;
  kind: "people";
  coordinateSpace: "display";
  anchor: MiniToolPeopleAnalysisResult["anchor"];
  width: number;
  height: number;
  candidates: { detectionIndex: number; faceBox: MiniToolPeopleAnalysisResult["people"][number]["faceBox"]; pixelCrop: MiniToolPlanPixelRect }[];
}

/** A task-owned original plan, actual report and canonical registered output rows. */
export interface MiniToolRegisteredAnalysisJob {
  request: MiniToolPlanJobRequest;
  report: MiniToolPlanJobReport;
  assets: { outputIndex: number; asset: StudioAssetEntity }[];
}

/**
 * Read display candidates bound to the accepted original people anchor.
 * @param _accepted - The original SQL accepted analysis.
 * @param _observations - Its registered display detector JSON.
 * @throws {Error} When content, geometry, candidate identities or the anchor is invalid.
 */
export function readMiniToolDisplayPeople(_accepted: MiniToolAnalysisRecord, _observations: unknown): MiniToolDisplayPeople {
  throw new Error("Display people reader is not implemented");
}

/**
 * Assemble canonical thumbnails from the original task-owned job collection.
 * @param _accepted - The original SQL accepted analysis.
 * @param _sourceKey - The SQL frozen source key mapped by the original source alias.
 * @param _observations - The original registered display candidates.
 * @param _jobs - Original thumbnail plans, reports and registered rows from the owning task.
 * @throws {Error} When candidates, original recipes, reports or registered rows differ.
 */
export function assembleMiniToolPeopleAnalysis(
  _accepted: MiniToolAnalysisRecord, _sourceKey: string, _observations: unknown, _jobs: readonly MiniToolRegisteredAnalysisJob[],
): MiniToolPeopleAnalysisResult {
  throw new Error("People analysis assembly is not implemented");
}
