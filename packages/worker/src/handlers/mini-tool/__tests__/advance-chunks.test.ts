// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shared chunk list of the model runs (`advanceChunks`, model-run-steps.ts; frames-split design §5.4 parallel stage), the
 * one rule the erase and expand composites, the lip-sync composite and the chunked model-input preparation advance through:
 *
 * - every chunk advances in each pickup, and a pickup in which any chunk still runs settles nothing (StillRunning), so a
 *   running chunk's object is recorded and pinned with the run before the list ends;
 * - once a chunk has failed for good, no chunk opens a new attempt: only the attempts already opened are advanced, whatever
 *   the chunk order;
 * - the list then answers every chunk's key, or the failure of the first chunk in order that failed for good.
 *
 * The step rows, the job opening, the result record and the job boundary are mocked; `advanceMiniToolPlanJob` throws
 * StillRunning while a job runs and answers only a terminal report, as the real one does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { OpenMiniToolPlanJobInput } from "@breatic/domain";
import type { MiniToolPlanJobRequest } from "@breatic/shared";
import { advanceChunks, advanceRegistered, type ContainerStep, type ModelStepRun } from "@worker/handlers/mini-tool/model-run-steps.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { DeadlinePassed } from "@breatic/shared";

const h = vi.hoisted(() => ({ list: vi.fn(), ensure: vi.fn(), open: vi.fn(), record: vi.fn(), advance: vi.fn(), registered: vi.fn(), grants: vi.fn() }));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, openMiniToolPlanJob: h.open, recordMiniToolStepResult: h.record, openContainerOutputs: h.grants,
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, ensureSteps: h.ensure } };
});
// Partial, so the reporting window end stays the real one.
vi.mock("@worker/handlers/mini-tool/advance-plan-job.js", async (original) => ({ ...await original<Record<string, unknown>>(), advanceMiniToolPlanJob: h.advance }));
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", () => ({ advanceRegisteredMiniToolPlanJob: h.registered }));

const TASK = "50000000-0000-4000-8000-000000000001";
const INPUT = "00000000-0000-4000-8000-000000000001";
const DEADLINE = Date.now() + 3_600_000;
const RUN: ModelStepRun = { taskId: TASK, projectId: "10000000-0000-4000-8000-000000000001", sourceKey: "video/source.mp4", log: "test",
  container: { containerClass: "MiniToolContainerStd4", limits: { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 }, chunkRetries: 1 } };

type Steps = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>;
type StepPlan = Parameters<typeof domainModule.upstreamStepRepo.ensureSteps>[1];
let steps: Steps;
// What each job answers this pickup by its id; a job not named is done; "expired" is ingest ending it at its deadline.
let jobs: Map<string, "running" | "failed" | "expired">;
// The jobs ingest holds; as the real boundary, a job not yet submitted is never submitted after its deadline.
let submitted: Set<string>;

/**
 * A chunk step of the list.
 * @param k - The chunk.
 * @returns The step.
 */
function chunk(k: number): ContainerStep {
  return { stepKey: `composite:${k}`, contentType: "video/mp4", failed: (reason) => ({ failed: `chunk ${k}: ${reason}` }),
    build: () => Promise.resolve({ recipe: { kind: "rle_join", inputs: [{ inputId: INPUT, order: "forward", frameCount: 10 }], width: 320, height: 180 },
      inputs: [{ inputId: INPUT, storageKey: `track/${k}.json` }] }) };
}

/**
 * The job id of a chunk attempt.
 * @param k - The chunk.
 * @param attempt - The attempt.
 * @returns The id.
 */
const jobOf = (k: number, attempt: number): string => `${TASK}:composite:${k}:a${attempt}`;

/**
 * One pickup of the list over three chunks.
 * @returns What it answered, or the StillRunning it threw.
 */
async function pickup(): Promise<Awaited<ReturnType<typeof advanceChunks>> | StillRunning> {
  try { return await advanceChunks(RUN, [0, 1, 2].map(chunk), DEADLINE); } catch (error) {
    if (error instanceof StillRunning) return error;
    throw error;
  }
}

/**
 * The job ids opened, in order.
 * @returns Each open call's job id.
 */
function opened(): string[] {
  return h.open.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId);
}

beforeEach(() => {
  vi.resetAllMocks();
  steps = []; jobs = new Map(); submitted = new Set();
  // A fresh array per read, as the repository answers.
  h.list.mockImplementation(async () => [...steps]);
  h.ensure.mockImplementation(async (_taskId: string, planned: StepPlan) => {
    for (const [position, entry] of planned.entries()) {
      if (!steps.some((step) => step.position === position)) steps.push({ ...entry, position,
        id: `c0000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 });
    }
    return [...steps];
  });
  h.open.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
    const step = steps.find((item) => item.id === input.stepId)!;
    if (step.output.miniToolPlanJob === undefined) step.output = { ...step.output, miniToolPlanJob: structuredClone(input.request) };
    const request = step.output.miniToolPlanJob as MiniToolPlanJobRequest;
    return { request, consumption: { identity: { kind: "container", containerClass: request.containerClass, jobId: request.jobId, chunkIndex: input.chunkIndex } } };
  });
  h.advance.mockImplementation(async (request: MiniToolPlanJobRequest) => {
    if (!submitted.has(request.jobId) && Date.now() >= request.deadlineAt) throw new DeadlinePassed();
    submitted.add(request.jobId);
    const state = jobs.get(request.jobId);
    if (state === "running") throw new StillRunning(Date.now() + 5000);
    const output = request.outputs[0]!;
    return state === "failed" || state === "expired"
      ? { schemaVersion: 2, state: "failed", reason: state === "expired" ? "expired" : "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } }
      : { schemaVersion: 2, state: "done", outputs: [{ outputIndex: 0, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }],
        usage: { wallMs: 1000, cpuUsec: 2000000 } };
  });
  h.record.mockImplementation(async (value: { stepId: string; outcome: "done" | "failed"; result: unknown }) => {
    const step = steps.find((item) => item.id === value.stepId)!;
    step.output = { ...step.output, miniToolStep: { schemaVersion: 1, scope: { taskId: TASK, stepId: step.id, kind: "container_job", endpoint: step.endpoint, itemIndex: step.itemIndex },
      deadlineAt: DEADLINE, requestBody: null, requestFingerprint: null, chargeTo: "user", creditMultiplier: 1, attempts: [],
      result: { outcome: value.outcome, result: value.result, error: value.outcome === "failed" ? { code: "tool_failed" } : null }, error: null, conflicts: [] } };
    step.status = value.outcome;
    return step;
  });
});

describe("the shared chunk list (frames-split §5.4 parallel stage; execution design §10.4, §10.5 composite rows)", () => {
  it("CL01 a chunk failed for good waits for its running sibling, whose object is pinned, and no chunk opens a new attempt after it", async () => {
    // Pickup 1: every chunk's first attempt runs.
    for (const k of [0, 1, 2]) jobs.set(jobOf(k, 1), "running");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    // Pickup 2: chunk 0 fails on both of its attempts, chunk 2's first attempt fails, chunk 1 still runs.
    jobs.set(jobOf(0, 1), "failed"); jobs.set(jobOf(0, 2), "failed"); jobs.set(jobOf(2, 1), "failed");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    // Pickup 3: chunk 1 is done; the list ends with chunk 0's failure.
    jobs.delete(jobOf(1, 1));
    expect(await pickup()).toEqual({ failed: "chunk 0: tool_failed" });
    expect(opened()).not.toContain(jobOf(2, 2));
    const done = h.record.mock.calls.map((call) => call[0] as { outcome: string; presentation?: unknown }).filter((value) => value.outcome === "done");
    expect(done.map((value) => value.presentation)).toEqual([{ pin: [steps.map((step) => step.output.miniToolPlanJob as MiniToolPlanJobRequest)
      .find((request) => request.jobId === jobOf(1, 1))!.outputs[0]!.storageKey] }]);
  });

  it("CL02 a later chunk failed for good keeps an earlier chunk from opening its next attempt", async () => {
    // Pickup 1: chunks 0 and 1 run while chunk 2 fails on both of its attempts.
    jobs.set(jobOf(0, 1), "running"); jobs.set(jobOf(1, 1), "running"); jobs.set(jobOf(2, 1), "failed"); jobs.set(jobOf(2, 2), "failed");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    // Pickup 2: chunk 0's first attempt fails; chunk 2, later in order, already failed for good, so chunk 0 opens no second attempt.
    jobs.set(jobOf(0, 1), "failed"); jobs.delete(jobOf(1, 1));
    expect(await pickup()).toEqual({ failed: "chunk 2: tool_failed" });
    expect(opened()).not.toContain(jobOf(0, 2));
  });

  it("CL03 with no failure every chunk is opened in the first pickup and the list answers every key in order", async () => {
    jobs.set(jobOf(0, 1), "running");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    expect(opened()).toEqual([jobOf(0, 1), jobOf(1, 1), jobOf(2, 1)]);
    jobs.clear();
    const ended = await pickup();
    const keys = [0, 1, 2].map((k) => (steps.find((step) => (step.output.miniToolPlanJob as MiniToolPlanJobRequest | undefined)?.jobId === jobOf(k, 1))!.output.miniToolPlanJob as MiniToolPlanJobRequest).outputs[0]!.storageKey);
    expect(ended).toEqual({ keys });
  });

  it("CL04 once the run's deadline has passed no chunk opens a new attempt: a retry due after it is never opened, its chunk expires", async () => {
    for (const k of [0, 1, 2]) jobs.set(jobOf(k, 1), "running");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    jobs.set(jobOf(0, 1), "failed"); jobs.delete(jobOf(1, 1)); jobs.delete(jobOf(2, 1));
    const passed = Date.now() - 1;
    expect(await advanceChunks(RUN, [0, 1, 2].map(chunk), passed)).toEqual({ failed: "chunk 0: expired", expired: true });
    expect(new Set(opened())).toEqual(new Set([jobOf(0, 1), jobOf(1, 1), jobOf(2, 1)]));
  });
});

// The job ingest ends at its deadline reports `expired` (ingest transition.ts): a step whose attempt ended so ends expired,
// as one whose next attempt is due after the deadline does, so its run shows its tool's timeout reason (§9.4, §10.4, §10.5).
describe("a container step ingest ended at its deadline ends expired (execution design §9.4, §10.4, §10.5)", () => {
  it("CL05 a chunk whose last attempt ingest expired ends the list with the expiry mark", async () => {
    jobs.set(jobOf(0, 1), "failed");
    jobs.set(jobOf(0, 2), "running");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    jobs.set(jobOf(0, 2), "expired");
    expect(await pickup()).toEqual({ failed: "chunk 0: expired", expired: true });
  });

  it("CL06 a chunk ingest expired before the worker's clock reaches the deadline opens no next attempt", async () => {
    jobs.set(jobOf(0, 1), "expired");
    expect(await pickup()).toEqual({ failed: "chunk 0: expired", expired: true });
    expect(opened()).not.toContain(jobOf(0, 2));
  });

  it("CL07 a registered stitch whose last attempt ingest expired ends with the expiry mark", async () => {
    h.grants.mockImplementation(async () => [{ storageKey: "derived/out.mp4", contentType: "video/mp4", coverKey: "derived/out.cover.jpg" }]);
    h.registered.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const step = steps.find((item) => item.id === input.stepId)!;
      step.output = { ...step.output, miniToolPlanJob: structuredClone(input.request) };
      const reason = input.request.jobId.endsWith(":a2") ? "expired" : "tool_failed";
      return { request: input.request, report: { schemaVersion: 2, state: "failed", reason, outputs: [], usage: null }, assets: [] };
    });
    const planned = { stepKey: "stitch", namePrefix: "ERASE", container: "mp4" as const, build: chunk(0).build };
    expect(await advanceRegistered(RUN, planned, "60000000-0000-4000-8000-000000000001", DEADLINE)).toEqual({ failed: "expired", expired: true });
  });

  it("CL08 a registered stitch that can no longer be submitted or waited for ends with the expiry mark instead of throwing", async () => {
    h.grants.mockImplementation(async () => [{ storageKey: "derived/out.mp4", contentType: "video/mp4", coverKey: "derived/out.cover.jpg" }]);
    h.registered.mockRejectedValue(new DeadlinePassed());
    const planned = { stepKey: "stitch", namePrefix: "ERASE", container: "mp4" as const, build: chunk(0).build };
    expect(await advanceRegistered(RUN, planned, "60000000-0000-4000-8000-000000000001", DEADLINE)).toEqual({ failed: "expired", expired: true });
  });

  it("CL09 a chunk that can no longer be waited for expires while every other submitted chunk is still read and recorded", async () => {
    for (const k of [0, 1, 2]) jobs.set(jobOf(k, 1), "running");
    expect(await pickup()).toBeInstanceOf(StillRunning);
    // Chunk 0 still runs once its reporting window has closed, which the boundary answers with DeadlinePassed; 1 and 2 are done.
    jobs.delete(jobOf(1, 1)); jobs.delete(jobOf(2, 1));
    const normal = h.advance.getMockImplementation()!;
    h.advance.mockImplementation(async (request: MiniToolPlanJobRequest) => {
      if (request.jobId === jobOf(0, 1)) throw new DeadlinePassed();
      return normal(request);
    });
    expect(await pickup()).toEqual({ failed: "chunk 0: expired", expired: true });
    const done = h.record.mock.calls.map((call) => call[0] as { outcome: string }).filter((value) => value.outcome === "done");
    expect(done).toHaveLength(2);
  });
});
