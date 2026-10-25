// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { OpenMiniToolPlanJobInput } from "@breatic/domain";
import type { StudioAssetEntity, MiniToolPlanJobRequest } from "@breatic/shared";
import type { EndedMiniToolPlanJob } from "@worker/handlers/mini-tool/advance-plan-job.js";

/** Actual registered rows retain their original global output indices. */
export interface RegisteredMiniToolPlanJob {
  request: MiniToolPlanJobRequest;
  report: EndedMiniToolPlanJob;
  assets: { outputIndex: number; asset: StudioAssetEntity }[];
}

/**
 * Advance the original job and register its actual written output set.
 * @param input - The task-owned candidate plan and original expense policy.
 * @returns The persisted report and canonical assets, including a failed job's subset.
 * @throws {Error} When original-plan validation, progress, persistence or registration fails.
 */
export async function advanceRegisteredMiniToolPlanJob(input: OpenMiniToolPlanJobInput): Promise<RegisteredMiniToolPlanJob> {
  void input;
  throw new Error("Registered planned job assembly awaits independent RED");
}
