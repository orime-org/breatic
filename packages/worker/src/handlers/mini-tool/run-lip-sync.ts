// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The lip-sync runner on the frozen plan (execution design §9.3, §9.4; multi-person lip-sync DD §7.2). Each pickup walks
 * the stages in order (prepare, track, faces, clip and stem, gen, composite, stitch); a finished step answers `done`
 * again, so the walk resumes where the run is. A `no_face` or `model_rejected` stops every other person's unsubmitted
 * paid step; the one output then fails with the §9.4 reason as its error.
 */
import type { MiniToolExecutionOutput } from "@breatic/shared/mini-tools";
import { lipsyncFailureReason, lipsyncStoppedLines, type LipsyncPersonState, type LipsyncSharedLine } from "@worker/handlers/mini-tool/lipsync-steps.js";
import { runLipSyncStep, type LipSyncStepKind } from "@worker/handlers/mini-tool/lipsync-step-run.js";

/** The parts of a frozen lip-sync run the runner reads. */
export interface LipSyncExecution { taskId: string; persons: readonly { personId: string; detectionNumber: number }[] }
/** What one pickup observed of the one output. */
export interface LipSyncPickup { results: Map<number, NonNullable<MiniToolExecutionOutput["result"]>>; waiting: boolean }

/** The per-person stages in order; clip and stem run in one stage. */
const PERSON_STAGES: readonly (readonly LipSyncStepKind[])[] = [["track"], ["faces"], ["clip", "stem"], ["gen"]];

/**
 * Run one pickup of a lip-sync execution.
 * @param execution - The frozen run.
 * @param userId - The run's user.
 * @param deadlineAt - The task deadline.
 * @returns The output's result once it ended, and whether a step still runs.
 * @throws {Error} When a step throws, or the stitch ends without a registered output.
 */
export async function runMiniToolLipSync(execution: LipSyncExecution, userId: string, deadlineAt: number): Promise<LipSyncPickup> {
  const pickup: LipSyncPickup = { results: new Map(), waiting: false };
  const people: (LipsyncPersonState & { succeeded: boolean })[] = execution.persons.map((p) => ({
    personId: p.personId, detectionNumber: p.detectionNumber, track: "unsubmitted", gen: "unsubmitted", failure: null, succeeded: false,
  }));
  /**
   * End the output with the §9.4 reason.
   * @param shared - The failed shared step, or null.
   * @returns The pickup.
   * @throws {never} Never.
   */
  const fail = (shared: LipsyncSharedLine | null): LipSyncPickup => {
    pickup.results.set(0, { status: "failed", error: { ...lipsyncFailureReason(people, shared) } });
    return pickup;
  };
  /**
   * Run a shared step.
   * @param kind - The step.
   * @returns False when it still runs or failed (the pickup is then settled).
   * @throws {Error} When the step throws.
   */
  const shared = async (kind: "prepare" | "composite" | "stitch"): Promise<boolean> => {
    const outcome = await runLipSyncStep(execution, { kind, personId: null }, userId, deadlineAt);
    if (outcome.state === "running") { pickup.waiting = true; return false; }
    if (outcome.state === "failed") { fail({ step: kind, category: outcome.category === "timeout" ? "timeout" : "failed" }); return false; }
    if (kind === "stitch") {
      if (outcome.result === undefined) throw new Error("The lip-sync stitch ended without a registered output");
      pickup.results.set(0, outcome.result);
    }
    return true;
  };

  if (!await shared("prepare")) return pickup;
  for (const stage of PERSON_STAGES) {
    for (const person of people) {
      if (person.failure !== null) continue;
      for (const kind of stage) {
        if (person.failure !== null) break;
        const outcome = await runLipSyncStep(execution, { kind, personId: person.personId }, userId, deadlineAt);
        if (outcome.state === "running") {
          pickup.waiting = true;
          if (kind === "track" || kind === "gen") person[kind] = "submitted";
        } else if (outcome.state === "failed") {
          person.failure = { step: kind as "track" | "faces" | "clip" | "stem" | "gen", category: outcome.category };
        } else if (kind === "track" || kind === "gen") person[kind] = "done";
      }
    }
    for (const line of lipsyncStoppedLines(people)) {
      const stopped = people.find((p) => p.personId === line.personId)!;
      stopped.failure = { step: line.step, category: "stopped" };
    }
    if (people.some((p) => p.failure?.category === "no_face" || p.failure?.category === "model_rejected")) {
      // A submitted paid step settles before the output ends.
      if (pickup.waiting) return pickup;
      return fail(null);
    }
    if (pickup.waiting) return pickup;
  }
  for (const person of people) person.succeeded = person.failure === null;
  if (people.some((p) => !p.succeeded)) return fail(null);
  if (!await shared("composite")) return pickup;
  await shared("stitch");
  return pickup;
}
