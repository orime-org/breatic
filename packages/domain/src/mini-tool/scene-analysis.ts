// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolAnalysisRecord, MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

/** The scene detector's owned result on the complete original source clock. */
export type MiniToolSceneAnalysisResult = Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }>;

/**
 * Assemble registered scene observations against the inspected original ledger.
 * @param accepted - The original accepted analysis identity and frozen range.
 * @param inspection - The registered inspect_video JSON.
 * @param observations - The registered scene_cuts JSON.
 * @returns Cuts on the original source clock with the accepted identity intact.
 * @throws {Error} When content, clock, range or source-frame associations differ.
 */
export function assembleMiniToolSceneAnalysis(accepted: MiniToolAnalysisRecord, inspection: unknown, observations: unknown): MiniToolSceneAnalysisResult {
  void accepted; void inspection; void observations;
  throw new Error("Scene analysis assembly awaits independent RED");
}
