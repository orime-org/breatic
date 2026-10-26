// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { miniToolAnalysisService } from "@breatic/domain";
import type { MiniToolAnalysisResult } from "@breatic/shared/mini-tools";

/**
 * Advance the accepted people or scene analysis through its original container steps.
 * @param _execution - The original SQL-owned execution identity, source and context.
 * @param _deadlineAt - The task's unchanged computation deadline.
 * @throws {Error} When an original step, artifact or analysis cannot be completed.
 */
export async function runMiniToolContainerAnalysis(
  _execution: miniToolAnalysisService.MiniToolAnalysisExecution, _deadlineAt: number,
): Promise<Extract<MiniToolAnalysisResult, { kind: "people" | "scene_cuts" }>> {
  throw new Error("Container analysis orchestration is not implemented");
}
