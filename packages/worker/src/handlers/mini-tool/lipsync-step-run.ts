// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One lip-sync step on the frozen plan (multi-person lip-sync DD §7.2): prepare, a person's track, faces, clip, stem and
 * gen, then the shared composite and stitch. The runner (`run-lip-sync.ts`) calls it each pickup; a finished step answers
 * `done` again without being redone.
 */
import type { MiniToolExecutionRegistered } from "@breatic/shared/mini-tools";

/** A lip-sync step kind in stage order. */
export type LipSyncStepKind = "prepare" | "track" | "faces" | "clip" | "stem" | "gen" | "composite" | "stitch";
/** One step: a person's (personId set) or a shared one (null). */
export interface LipSyncStep { kind: LipSyncStepKind; personId: string | null }
/** What a step reached; the stitch's `done` carries the registered output. */
export type LipSyncStepOutcome =
  | { state: "done"; result?: MiniToolExecutionRegistered }
  | { state: "running" }
  /** A failed step names the step its line is written under: a faces job that found no tracked foreground names track (§97 D21-5). */
  | { state: "failed"; step: LipSyncStepKind; category: "no_face" | "model_rejected" | "timeout" | "failed" };

/**
 * Advance one step.
 * @param execution - The frozen run.
 * @param step - The step.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The step's outcome.
 * @throws {Error} Always, until the step bodies land: lip-sync admission refuses every run before this is reached.
 */
export async function runLipSyncStep(execution: unknown, step: LipSyncStep, userId: string, deadlineAt: number): Promise<LipSyncStepOutcome> {
  // ponytail: the seam only; the step bodies (SAM3 track, container faces/clip/stem/composite/stitch, model gen) come
  // with the lip-sync container recipes, and admission keeps refusing lip-sync until they do.
  void execution; void userId; void deadlineAt;
  throw new Error(`The lip-sync ${step.kind} step is not available yet`);
}
