// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import type { PlanLimits } from "@ingest/container/plan-recipes.js";

/** The internal, attempt-bound run sent by the validated job object. */
export interface PlanRunBody {
  schemaVersion: 2;
  attemptId: string;
  deadlineAt: number;
  limits: PlanLimits;
  inputs: { inputId: string; url: string }[];
  outputs: { outputIndex: number; key: string; url: string; contentType: string; coverUrl?: string; recipe: MiniToolPlanRecipe }[];
  reportUrl: string;
}

/**
 * Execute an immutable local plan and report only the completed indexed subset.
 * @param _job - The attempt, exact capabilities and original deadline.
 * @returns Nothing; the owned report travels through the outbound handler.
 * @throws {Error} Until the planned run owner is implemented.
 */
export async function runPlanJob(_job: PlanRunBody): Promise<void> {
  throw new Error("Planned job execution is not implemented");
}
