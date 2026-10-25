// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolPlanRecipe } from "@shared/upload/mini-tool-plan-types.js";
import type { VideoFrameProbe } from "@ingest/container/video-frame-probe.js";
import type { MediaOfOutput } from "@ingest/jobs/container-report.js";

/** Caller-frozen IO bounds, with no local operational fallback. */
export interface PlanLimits { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number }
/** Complete raw facts of one downloaded immutable input. */
export interface PlanSource { source: VideoFrameProbe; raw: Record<string, unknown> }
/** One recipe's owned local files, raw facts and original lifetime. */
export interface PlanRecipeRequest {
  recipe: MiniToolPlanRecipe;
  input: string;
  output: string;
  directory: string;
  facts: PlanSource;
  signal: AbortSignal;
  limits: PlanLimits;
}
/**
 * Read complete primary-video frame and all-stream metadata facts.
 * @param _input - The downloaded immutable source.
 * @param _signal - The original job lifetime.
 * @param _limits - Frozen process IO bounds.
 * @returns Raw facts without presentation-clock edits.
 * @throws {Error} Until the complete probe is implemented.
 */
export async function inspectPlanInput(_input: string, _signal: AbortSignal, _limits: PlanLimits): Promise<PlanSource> {
  throw new Error("Planned source inspection is not implemented");
}
/**
 * Execute one repository-owned recipe against its frozen source clock.
 * @param _request - Its input, exact recipe, output and original lifetime.
 * @returns The produced object's actual metadata.
 * @throws {Error} Until the planned recipe is implemented.
 */
export async function executePlanRecipe(_request: PlanRecipeRequest): Promise<MediaOfOutput> {
  throw new Error("Planned recipe execution is not implemented");
}
