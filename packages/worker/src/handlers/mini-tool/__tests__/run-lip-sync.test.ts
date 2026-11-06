// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 D17-7 (c) (execution design §9.4; multi-person lip-sync DD §7.2, §7.3; frames-split §5.4 上限 row
 * stage order): the lip-sync runner `runMiniToolLipSync(execution, userId, deadlineAt)` in
 * `packages/worker/src/handlers/mini-tool/run-lip-sync.ts` runs the frozen plan stage by stage (prepare, track, faces, clip
 * and stem, gen, composite, stitch) and answers a pickup like the frames and split runner: one output, whose failed result
 * carries the one §9.4 reason `{ kind: "lipsync", persons, shared }` as its `error` (TR05 records the reason there).
 *
 * The step functions are mocked at one module seam chosen here, `@worker/handlers/mini-tool/lipsync-step-run.ts`
 * `runLipSyncStep(execution, step, userId, deadlineAt)`, where `step` is `{ kind, personId }` (personId null for shared
 * steps) and the outcome is `{ state: "done" }`, `{ state: "running" }` or `{ state: "failed", category }`. The frozen
 * execution below holds what DD §7.1 freezes for the runner; each person also carries its `detectionNumber` (§9.4: the
 * reason's "Person N" comes from the people result order, and the runner has no other source of it).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as miniTools from "@breatic/shared/mini-tools";

type StepKind = "prepare" | "track" | "faces" | "clip" | "stem" | "gen" | "composite" | "stitch";
interface Step { kind: StepKind; personId: string | null }
type Outcome = { state: "done" } | { state: "running" } | { state: "failed"; category: "no_face" | "model_rejected" | "timeout" | "failed" };
interface Pickup { results: Map<number, unknown>; waiting: boolean }

const h = vi.hoisted(() => ({ step: vi.fn() }));
vi.mock("@worker/handlers/mini-tool/lipsync-step-run.js", () => ({ runLipSyncStep: h.step }));

const RUNNER = "@worker/handlers/mini-tool/run-lip-sync.js";
/**
 * The runner, loaded by name so this file compiles before it exists.
 * @returns Its entry.
 */
const runner = async (): Promise<(execution: unknown, userId: string, deadlineAt: number) => Promise<Pickup>> =>
  ((await import(/* @vite-ignore */ RUNNER)) as { runMiniToolLipSync: (execution: unknown, userId: string, deadlineAt: number) => Promise<Pickup> }).runMiniToolLipSync;
const reasonSchema = (miniTools as unknown as { lipsyncFailureReasonSchema: { safeParse: (value: unknown) => { success: boolean } } }).lipsyncFailureReasonSchema;

const TASK = "50000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001";
const DEADLINE = Date.now() + 3_600_000;
const EXECUTION = {
  schemaVersion: 1, tool: "video.lip-sync", taskId: TASK, planFingerprint: "d".repeat(64),
  outputs: [{ outputIndex: 0, nodeId: "40000000-0000-4000-8000-000000000001", recipe: { kind: "lip-sync" } }],
  generator: { backend: "wavespeed-crop", modelId: "sync-lipsync-3", schemaFingerprint: "1".repeat(64), providerSyncMode: "cut_off" },
  timeline: { duration: 4, videoDuration: 5, syncMode: "cut_off" },
  persons: [
    { personId: "person-a", detectionNumber: 1, anchor: { frameIndex: 0, pts: 0 }, anchorFaceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
    { personId: "person-b", detectionNumber: 3, anchor: { frameIndex: 0, pts: 0 }, anchorFaceBox: { x: 0.6, y: 0.1, width: 0.2, height: 0.2 } },
  ],
};

/**
 * Drive pickups until the one output has a result.
 * @param script - The outcome of each step.
 * @returns The output's result.
 */
async function run(script: (step: Step) => Outcome): Promise<unknown> {
  h.step.mockImplementation(async (_execution: unknown, step: Step) => script(step));
  const lipSync = await runner();
  for (let pickup = 0; pickup < 20; pickup += 1) {
    try {
      const answer = await lipSync(structuredClone(EXECUTION), USER, DEADLINE);
      if (answer.results.has(0)) return answer.results.get(0);
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "StillRunning") throw error;
    }
  }
  throw new Error("The runner never ended its output");
}

/**
 * The steps the runner asked for.
 * @returns Them, in order.
 */
const asked = (): Step[] => h.step.mock.calls.map((call) => call[1] as Step);

beforeEach(() => { h.step.mockReset(); });

describe("the lip-sync runner's one failure reason (§97 D17-7; execution design §9.4)", () => {
  it("LR01 a person with no face fails the output with that person's line and stops the other's unsubmitted gen", async () => {
    const result = await run((step) => (step.kind === "faces" && step.personId === "person-a" ? { state: "failed", category: "no_face" } : { state: "done" }));
    const error = { kind: "lipsync", shared: null, persons: [
      { personId: "person-a", detectionNumber: 1, step: "faces", category: "no_face" },
      { personId: "person-b", detectionNumber: 3, step: "gen", category: "stopped" },
    ] };
    expect(result).toEqual({ status: "failed", error });
    expect(reasonSchema.safeParse(error).success).toBe(true);
    expect(asked().filter((step) => step.kind === "gen")).toEqual([]);
  });

  it("LR02 a failed shared step with every person done gives one shared line and no person lines", async () => {
    const result = await run((step) => (step.kind === "stitch" ? { state: "failed", category: "failed" } : { state: "done" }));
    expect(result).toEqual({ status: "failed", error: { kind: "lipsync", persons: [], shared: { step: "stitch", category: "failed" } } });
  });

  it("LR03 a timed-out generation fails only that person's line; the other person's steps all ran", async () => {
    const result = await run((step) => (step.kind === "gen" && step.personId === "person-b" ? { state: "failed", category: "timeout" } : { state: "done" }));
    expect(result).toEqual({ status: "failed", error: { kind: "lipsync", shared: null, persons: [{ personId: "person-b", detectionNumber: 3, step: "gen", category: "timeout" }] } });
    expect(asked()).toEqual(expect.arrayContaining([{ kind: "gen", personId: "person-a" }, { kind: "gen", personId: "person-b" }]));
  });
});
