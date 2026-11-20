// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The extract-frames, split and video focus crop runners (inner#1306 test plan §67.3 W01–W03, §68 F01; frames-split design
 * §5.4 用户运行的两层编码 and 作业身份, §5.5, §7.11 逐项结果, §7.15, §7.16, §7.17 「唯一写点：worker的配方构造」, §10.8 作业 and 失败与提交).
 *
 * A planned extract-frames, split or focus crop pickup enters through `runMiniToolExecutionTask` and
 * runs the frozen plan: it reads the frozen version's grid, tool source and source keyframe statistics, uses the frozen
 * `layout` as it is (D5-1), writes each output's job recipe with `frameRecipeOf` / `segmentRecipesOf` and the frozen
 * `container.encode` (D5-2), and submits each batch as a `run-batch` job through `advanceRegisteredMiniToolPlanJob` with
 * the frozen payer (D5-4, D5-5; W02, W03). A failed batch attempt's next attempt carries only the outputs not yet done, up
 * to the frozen `chunkRetries`; exhausted outputs fail one by one and the others are delivered (D5-3, §7.11).
 *
 * The job boundary (`advanceRegisteredMiniToolPlanJob`), grants, steps, the SQL lifecycle and the completion owner are
 * mocked; the recipe builders stay real and read the plan colour the frozen version carries.
 *
 * §93 D5-10: a segment in `layout.encodes` runs its frozen chunk windows as `run-chunk` jobs on the model-input preparation
 * path (work keys, `openMiniToolPlanJob` + `advanceMiniToolPlanJob`, a failed attempt's output retired with its result,
 * prepare-model-input.ts:110–125), then one `run-stitch` job through `advanceRegisteredMiniToolPlanJob` with the option
 * that retires the consumed chunk keys after the stitch commits. §93 D5-11 (design line 616, 622, 960): every poll commits
 * the newly finished outputs non-terminally (`commitMiniToolExecutionProgress`, mocked here as the domain entry), one
 * terminal commit follows once all outputs have ended, and a caught exception fails only outputs not yet committed.
 */
import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion, MiniToolExecutionJob, OpenMiniToolPlanJobInput } from "@breatic/domain";
import { DeadlinePassed, videoPresentationWorkKeyFor, type MiniToolPlanJobRequest, type StudioAssetEntity } from "@breatic/shared";
import { videoContainerJobId } from "@breatic/shared/mini-tools";
import type { RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { AUDIO_INPUT_ID, chunkInputId, frameRecipeOf, segmentRecipesOf, SOURCE_INPUT_ID, toolInputOf } from "@worker/handlers/video-presentation-recipes.js";
import { frozenVersion, type VersionFields } from "./frozen-presentation.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({
  start: vi.fn(), plan: vi.fn(), list: vi.fn(), ensure: vi.fn(), inline: vi.fn(), grants: vi.fn(), findById: vi.fn(), findCoverOf: vi.fn(),
  advance: vi.fn(), finish: vi.fn(), deadline: vi.fn(), progress: vi.fn(), openPlan: vi.fn(), advancePlan: vi.fn(), record: vi.fn(),
  readDelivery: vi.fn(), deliver: vi.fn(), wake: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}),
    getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, readMiniToolExecutionPlan: h.plan, openContainerOutputs: h.grants, openMiniToolPlanJob: h.openPlan, recordMiniToolStepResult: h.record,
    assetRepo: { ...actual.assetRepo, findById: h.findById, findCoverOf: h.findCoverOf },
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start, commitMiniToolExecutionProgress: h.progress },
    miniToolDeliveryService: { ...actual.miniToolDeliveryService, readMiniToolDelivery: h.readDelivery },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, ensureSteps: h.ensure, recordInline: h.inline } };
});
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", () => ({ advanceRegisteredMiniToolPlanJob: h.advance }));
// Partial, so a progress wrapper added beside the terminal one runs for real over the mocked domain entry.
vi.mock("@worker/handlers/mini-tool/execution-completion.js", async (original) => ({ ...await original<Record<string, unknown>>(), finishMiniToolExecutionAndNotify: h.finish }));
// Partial, so the reporting window end stays the real one.
vi.mock("@worker/handlers/mini-tool/advance-plan-job.js", async (original) => ({ ...await original<Record<string, unknown>>(), advanceMiniToolPlanJob: h.advancePlan }));
// §93 D6 (design §7.11, §10.8): delivery after a progress commit; the delivery workers are mocked, the wrapper is real.
vi.mock("@worker/handlers/mini-tool/delivery-worker.js", () => ({ deliverMiniToolOutput: h.deliver, wakePendingMiniToolDelivery: h.wake }));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/dispatch.js", () => ({ isTerminalAttempt: () => false, verifyJobLockOwnership: async () => true }));

const TASK = "50000000-0000-4000-8000-000000000001";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const SPACE = "20000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001";
const SOURCE_ID = "80000000-0000-4000-8000-000000000001";
const SOURCE_KEY = "video/source.mp4";
const NODES = ["40000000-0000-4000-8000-000000000001", "40000000-0000-4000-8000-000000000002"];
const DEADLINE = Date.now() + 3_600_000;
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
// The frozen encode differs from today's configuration (crf 18, medium), so a recipe carrying it proves which one was used.
const ENCODE = { crf: 23, preset: "fast" } as const;
// The frozen version: 320x180, 25 fps, 96 grid frames, read from its original; a case may freeze another.
let version = frozenVersion();

type Tool = "video.extract-frames" | "video.split" | "video.focus-crop";
type Steps = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>;
type StepPlan = Parameters<typeof domainModule.upstreamStepRepo.ensureSteps>[1];
type GrantInput = Parameters<typeof domainModule.openContainerOutputs>[0];
let steps: Steps;
let grantSequence: number;
// Scripted batch outcomes by job id: which declared outputs the attempt wrote, and whether it failed or still runs.
let scripted: Map<string, { written: number[]; state: "done" | "failed"; reason?: "expired" } | "running" | "throws">;
// The public record the SQL lifecycle holds; the progress and terminal mocks advance it as the domain owner would.
let staleProgress = 0;
let current: Record<string, unknown> & { resultVersion: number; status: string; outputs: { result: unknown }[] };

// Two outputs per tool: grid frames 0 and 48; segments over grid frames [0, 48) and [48, 96); a focus crop has one.
type Recipe = { kind: "frame"; frameIndex: number; crop?: { x: number; y: number; width: number; height: number } } | { kind: "segment"; range: { start: number; end: number } };
const RECIPES: Record<Tool, Recipe[]> = {
  "video.extract-frames": [{ kind: "frame", frameIndex: 0 }, { kind: "frame", frameIndex: 48 }],
  "video.split": [{ kind: "segment", range: { start: 0, end: 48 } }, { kind: "segment", range: { start: 48, end: 96 } }],
  "video.focus-crop": [{ kind: "frame", frameIndex: 30, crop: { x: 10, y: 20, width: 100, height: 50 } }],
};
// The payer admission freezes from the platform-funded set (frames-split §5.5 configuration row).
const PAYER: Record<Tool, "platform" | "user"> = { "video.extract-frames": "platform", "video.split": "user", "video.focus-crop": "platform" };

/**
 * A frozen extract-frames, split or focus crop plan on the frozen version (shape of `execution-plan.service.ts` storedPlanSchema).
 * @param tool - The tool.
 * @param layout - The frozen layout.
 * @param chunkRetries - The frozen retry cap.
 * @param recipes - The outputs' recipes.
 * @returns The plan.
 */
function plan(tool: Tool, layout: { batches: number[][]; encodes: { outputIndex: number; chunks: { start: number; end: number }[] }[] } = { batches: [RECIPES[tool].map((_recipe, at) => at)], encodes: [] },
  chunkRetries = 2, recipes = RECIPES[tool]): Record<string, unknown> {
  const frozen = { sourceFingerprint: version.sourceFingerprint, toolInputId: version.toolInputId, planSha256: version.planSha256 };
  return {
    schemaVersion: 1, tool, taskId: TASK, projectId: PROJECT, spaceId: SPACE, targetNodeIds: NODES.slice(0, recipes.length),
    binding: { assetId: SOURCE_ID, contentHash: frozen.sourceFingerprint, canonicalURL: "https://assets.example.test/video/source.mp4", kind: "video",
      mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
    sourceKey: SOURCE_KEY, draft: {}, analysisRefs: [],
    outputs: recipes.map((recipe, outputIndex) => ({ outputIndex, nodeId: NODES[outputIndex]!, recipe })),
    model: tool, credits: 1, requestFingerprint: "c".repeat(64), planFingerprint: "d".repeat(64), chargeTo: PAYER[tool],
    presentationRef: { source: { toolInputId: frozen.toolInputId, planSha256: frozen.planSha256 } },
    presentations: { source: version }, versionIds: { source: version.versionId },
    layout, outputSeconds: recipes.map(() => 1),
    container: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 },
      prices: { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 }, limits: LIMITS, startSeconds: 3,
      encode: ENCODE, chunkRetries },
  };
}

/**
 * Route one frozen plan through the mocked SQL lifecycle.
 * @param execution - The frozen plan.
 */
function serve(execution: Record<string, unknown>): void {
  const task = { id: TASK, userId: USER, projectId: PROJECT, spaceId: SPACE, createdAt: new Date(), status: "running", source: "mini_tool", mode: "append" };
  const outputs = (execution.outputs as { outputIndex: number; nodeId: string; recipe: unknown }[]).map((output) => ({ ...output, result: null, late: false }));
  current = { schemaVersion: 1, runId: TASK, status: "running", planFingerprint: execution.planFingerprint, resultVersion: 0,
    sourceBindings: [execution.binding], outputs, usage: [], billingState: "idle", error: null };
  h.start.mockImplementation(async () => ({ task, execution, record: structuredClone(current) }));
  h.plan.mockResolvedValue({ task, execution });
}

/**
 * A registered canonical row for a written output.
 * @param key - The written storage key.
 * @param video - Whether the tool writes video.
 * @returns The row.
 */
function asset(key: string, video: boolean): StudioAssetEntity {
  const id = createHash("sha256").update(key).digest("hex");
  return { id: `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`, studioId: "b0000000-0000-4000-8000-000000000001",
    contentHash: id, storageKey: key, fileUrl: `https://assets.example.test/${key}`, sizeBytes: 100, mimeType: video ? (key.endsWith(".webm") ? "video/webm" : "video/mp4") : "image/png",
    kind: video ? "video" : "image", source: "ai", producedByUserId: USER, generationTaskId: TASK, width: 320, height: 180,
    durationSeconds: video ? 1.92 : null, createdAt: new Date("2026-11-04T00:00:00Z"), deletedAt: null };
}

/**
 * The job boundary: an attempt writes its scripted outputs (all declared ones by default), and a repeated call for the
 * same step answers its stored terminal report, as `advanceRegisteredMiniToolPlanJob` does.
 * @param input - The open-job input.
 * @returns The registered job.
 */
async function advance(input: OpenMiniToolPlanJobInput): Promise<RegisteredMiniToolPlanJob> {
  const step = steps.find((item) => item.id === input.stepId);
  if (step === undefined) throw new Error("Fixture advance lost its step");
  const request = (step.output.miniToolPlanJob as MiniToolPlanJobRequest | undefined) ?? input.request;
  step.output = { ...step.output, miniToolPlanJob: structuredClone(request) };
  const script = scripted.get(request.jobId);
  if (script === "running") throw new StillRunning(Date.now() + 5000);
  if (script === "throws") throw new ContainerJobFailed("tool_failed");
  const declared = request.outputs.map((output) => output.outputIndex);
  const written = script?.written ?? declared;
  const state = script?.state ?? "done";
  const video = request.outputs.some((output) => output.contentType.startsWith("video/"));
  const outputs = request.outputs.filter((output) => written.includes(output.outputIndex)).map((output) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey,
    sha256: asset(output.storageKey, video).contentHash, sizeBytes: 100, contentType: output.contentType, width: 320, height: 180,
    durationSeconds: video ? 1.92 : null, cover: null, upright: null }));
  const report = state === "done" ? { schemaVersion: 2 as const, state, outputs, usage: { wallMs: 1000, cpuUsec: 2000000 } }
    : { schemaVersion: 2 as const, state, reason: script?.reason ?? "tool_failed" as const, outputs, usage: { wallMs: 1000, cpuUsec: 2000000 } };
  // The stored step result, as recordMiniToolStepResult leaves it.
  step.output = { ...step.output, miniToolStep: { schemaVersion: 1, scope: { taskId: TASK, stepId: step.id, kind: "container_job", endpoint: step.endpoint, itemIndex: step.itemIndex },
    deadlineAt: request.deadlineAt, requestBody: null, requestFingerprint: null, chargeTo: input.chargeTo, creditMultiplier: 1, attempts: [],
    result: { outcome: state, result: report, error: state === "failed" ? { code: "tool_failed" } : null }, error: null, conflicts: [] } };
  return { request, report, assets: outputs.map((output) => ({ outputIndex: output.outputIndex, asset: asset(output.storageKey, video) })) };
}

/**
 * The preparation-path job boundary of a chunk: `openMiniToolPlanJob` keeps the first request on its step.
 * @param input - The open-job input.
 * @returns The stored request and its consumption identity.
 */
async function openPlan(input: OpenMiniToolPlanJobInput): Promise<{ request: MiniToolPlanJobRequest; consumption: { identity: Record<string, unknown> } }> {
  const step = steps.find((item) => item.id === input.stepId);
  if (step === undefined) throw new Error("Fixture open lost its step");
  if (step.output.miniToolPlanJob === undefined) step.output = { ...step.output, miniToolPlanJob: structuredClone(input.request) };
  const request = step.output.miniToolPlanJob as MiniToolPlanJobRequest;
  return { request, consumption: { identity: { kind: "container", containerClass: request.containerClass, jobId: request.jobId, chunkIndex: input.chunkIndex } } };
}

/**
 * A chunk job's report: done with its one work output unless scripted to fail; a running job throws StillRunning, as
 * `advanceMiniToolPlanJob` does.
 * @param request - The chunk request.
 * @returns The report.
 */
async function advancePlan(request: MiniToolPlanJobRequest): Promise<Record<string, unknown>> {
  const script = scripted.get(request.jobId);
  if (script === "running") throw new StillRunning(Date.now() + 5000);
  const output = request.outputs[0]!;
  const written = [{ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }];
  return script !== undefined && script !== "throws" && script.state === "failed"
    ? { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } }
    : { schemaVersion: 2, state: "done", outputs: written, usage: { wallMs: 1000, cpuUsec: 2000000 } };
}

/**
 * `recordMiniToolStepResult`: the step keeps its result as the domain owner leaves it.
 * @param value - The recorded result.
 * @param value.stepId - The step.
 * @param value.outcome - Done or failed.
 * @param value.result - The report.
 * @returns The step.
 */
async function record(value: { stepId: string; outcome: "done" | "failed"; result: unknown }): Promise<Steps[number]> {
  const step = steps.find((item) => item.id === value.stepId)!;
  step.output = { ...step.output, miniToolStep: { schemaVersion: 1, scope: { taskId: TASK, stepId: step.id, kind: "container_job", endpoint: step.endpoint, itemIndex: step.itemIndex },
    deadlineAt: DEADLINE, requestBody: null, requestFingerprint: null, chargeTo: "user", creditMultiplier: 1, attempts: [],
    result: { outcome: value.outcome, result: value.result, error: value.outcome === "failed" ? { code: "tool_failed" } : null }, error: null, conflicts: [] } };
  step.status = value.outcome;
  return step;
}

/**
 * The domain progress commit: resultVersion arbitration, committed results kept, the version moves only on a change.
 * @param _taskId - The run.
 * @param input - The commit.
 * @param input.expectedVersion - The version it read.
 * @param input.outputs - The complete indexed outputs.
 * @returns The new record.
 * @throws {Error} When the version is stale or a committed result would change.
 */
async function progress(_taskId: string, input: { expectedVersion: number; outputs: { result: unknown }[] }): Promise<{ record: typeof current }> {
  if (input.expectedVersion !== current.resultVersion) { staleProgress += 1; throw new Error("Fixture progress commit is stale"); }
  let changed = false;
  const outputs = current.outputs.map((held, index) => {
    const next = input.outputs[index]!.result;
    if (held.result !== null) {
      if (next !== null && JSON.stringify(next) !== JSON.stringify(held.result)) throw new Error("Fixture progress would rewrite a committed result");
      return held;
    }
    if (next === null) return held;
    changed = true;
    return { ...held, result: next };
  });
  if (changed) current = { ...current, outputs, resultVersion: current.resultVersion + 1 };
  return { record: structuredClone(current) };
}

/**
 * The progress commits in order: each output's result status, null while pending.
 * @returns Their statuses.
 */
function progressed(): (string | null)[][] {
  return h.progress.mock.calls.map((call) => (call[1] as { outputs: { result: { status: string } | null }[] }).outputs.map((output) => output.result?.status ?? null));
}

/**
 * Run pickups until the completion owner is called (a StillRunning pickup is redelivered), at most eight.
 * @returns The completion it was given, or null when none was.
 */
async function drive(): Promise<MiniToolExecutionCompletion | null> {
  const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
  for (let pickup = 0; pickup < 8 && h.finish.mock.calls.length === 0; pickup += 1) {
    try { await runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  return (h.finish.mock.calls[0]?.[1] as MiniToolExecutionCompletion | undefined) ?? null;
}

/**
 * The submitted requests in order.
 * @returns Each advance call's request.
 */
function submitted(): MiniToolPlanJobRequest[] {
  return h.advance.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request);
}

/**
 * The §5.4 id of a run batch attempt.
 * @param batch - The batch index.
 * @param attempt - The attempt.
 * @returns The id.
 */
function batchId(batch: number, attempt: number): string {
  return videoContainerJobId({ kind: "run-batch", taskId: TASK, batch, attempt });
}

/**
 * The outputs' result statuses in output order.
 * @param completion - The completion.
 * @returns Their statuses.
 */
function statuses(completion: MiniToolExecutionCompletion | null): (string | null)[] {
  return completion?.outputs.map((output) => output.result?.status ?? null) ?? [];
}

beforeEach(() => {
  vi.resetAllMocks();
  steps = []; grantSequence = 0; scripted = new Map(); staleProgress = 0; version = frozenVersion();
  h.deadline.mockResolvedValue(DEADLINE);
  h.list.mockImplementation(async () => steps);
  h.ensure.mockImplementation(async (_taskId: string, planned: StepPlan) => {
    for (const [position, entry] of planned.entries()) {
      if (!steps.some((step) => step.position === position)) steps.push({ ...entry, position,
        id: `c0000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 });
    }
    return steps;
  });
  h.inline.mockImplementation(async (stepId: string, values: Record<string, unknown>) => {
    const step = steps.find((item) => item.id === stepId);
    if (step !== undefined) step.output = { ...step.output, ...structuredClone(values) };
  });
  h.grants.mockImplementation(async (input: GrantInput) => {
    const sequence = grantSequence++;
    // §93 D5-12 (this round's choice): a video output may ask for a WebM container.
    return input.outputs.map((output, index) => output.modality === "video"
      ? (output as { container?: string }).container === "webm"
        ? { storageKey: `derived/grant-${sequence}/${index}.webm`, contentType: "video/webm", coverKey: `derived/grant-${sequence}/${index}.webm.cover.jpg` }
        : { storageKey: `derived/grant-${sequence}/${index}.mp4`, contentType: "video/mp4", coverKey: `derived/grant-${sequence}/${index}.cover.jpg` }
      : { storageKey: `derived/grant-${sequence}/${index}.png`, contentType: "image/png" });
  });
  h.findById.mockImplementation(async (id: string) => {
    for (const call of h.advance.mock.calls) {
      const request = (call[0] as OpenMiniToolPlanJobInput).request;
      for (const output of request.outputs) {
        const row = asset(output.storageKey, output.contentType.startsWith("video/"));
        if (row.id === id) return row;
      }
    }
    return null;
  });
  h.findCoverOf.mockResolvedValue(null);
  h.advance.mockImplementation(advance);
  h.openPlan.mockImplementation(openPlan); h.advancePlan.mockImplementation(advancePlan); h.record.mockImplementation(record); h.progress.mockImplementation(progress);
  // The delivery context: every registered output's slot is pending until delivered.
  h.readDelivery.mockImplementation(async () => ({ task: { id: TASK }, execution: {}, record: structuredClone(current),
    delivery: { schemaVersion: 1, planFingerprint: "d".repeat(64), version: 1, lastErrorCode: null,
      outputs: current.outputs.flatMap((output, outputIndex) => output.result === null ? [] : [{ outputIndex, state: "pending" }]) } }));
  h.deliver.mockImplementation(async (value: unknown) => value);
  h.finish.mockImplementation(async (_taskId: string, completion: MiniToolExecutionCompletion) => ({ record: { status: completion.error === null ? "completed" : "failed" } }));
});
afterEach(() => { vi.useRealTimers(); });

describe("extract-frames and split run the frozen plan (§93 D5-1, D5-2, D5-4, D5-5; design §7.17, §5.4)", () => {
  it("VT01 extract-frames: one run-batch job of the frozen batch, each frame recipe on the frozen grid, every output delivered", async () => {
    serve(plan("video.extract-frames"));
    const completion = await drive();
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1)]);
    const [request] = submitted();
    expect(request).toMatchObject({ containerClass: "MiniToolContainerStd4", deadlineAt: DEADLINE, limits: LIMITS });
    expect(request!.inputs).toEqual([expect.objectContaining({ storageKey: SOURCE_KEY })]);
    // §7.17 「唯一写点：worker的配方构造」: the execution-level grid frame becomes the frame recipe on the frozen tool source (W01).
    const tool = toolInputOf(version, SOURCE_KEY);
    expect(request!.outputs.map(({ outputIndex, contentType, recipe }) => ({ outputIndex, contentType, recipe }))).toEqual([
      { outputIndex: 0, contentType: "image/png", recipe: frameRecipeOf(version, tool, 0).recipe },
      { outputIndex: 1, contentType: "image/png", recipe: frameRecipeOf(version, tool, 48).recipe },
    ]);
    expect(request!.outputs[1]!.recipe).toMatchObject({ grid: tool.grid, source: { kind: "original", keyframes: version.toolSource.keyframes }, frameIndex: 48 });
    // W02: the frozen payer, platform for frame extraction.
    expect(h.advance.mock.calls.every((call) => (call[0] as OpenMiniToolPlanJobInput).chargeTo === "platform")).toBe(true);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
    expect(completion!.outputs.map((output) => output.result)).toEqual(request!.outputs.map((output) => expect.objectContaining({
      status: "registered", assetId: asset(output.storageKey, false).id, kind: "image" })));
    expect(completion!.error).toBeNull();
  });

  it("VT02 the frozen layout is used as it is, never re-planned (D5-1): two batches of one frame each", async () => {
    serve(plan("video.extract-frames", { batches: [[0], [1]], encodes: [] }));
    const completion = await drive();
    expect(submitted().map((request) => ({ jobId: request.jobId, outputs: request.outputs.map((output) => output.outputIndex) })))
      .toEqual([{ jobId: batchId(0, 1), outputs: [0] }, { jobId: batchId(1, 1), outputs: [1] }]);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
  });

  it("VT03 split: each batched segment is one segment recipe over its range with the frozen encode (D5-2)", async () => {
    serve(plan("video.split"));
    const completion = await drive();
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1)]);
    const [request] = submitted();
    expect(request!.outputs.map(({ outputIndex, recipe }) => ({ outputIndex, recipe }))).toEqual([
      { outputIndex: 0, recipe: segmentRecipesOf(version, SOURCE_KEY, { start: 0, end: 48 }, ENCODE, [{ start: 0, end: 48 }]).recipes[0] },
      { outputIndex: 1, recipe: segmentRecipesOf(version, SOURCE_KEY, { start: 48, end: 96 }, ENCODE, [{ start: 48, end: 96 }]).recipes[0] },
    ]);
    // W03: a split stays user-paid.
    expect(h.advance.mock.calls.every((call) => (call[0] as OpenMiniToolPlanJobInput).chargeTo === "user")).toBe(true);
    expect(request!.outputs.every((output) => output.contentType.startsWith("video/"))).toBe(true);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
  });

  // §93 D5-11 (design line 622): a poll commits what finished non-terminally; the terminal commit waits for every output.
  it("VT04 a running batch does not hold back the other: it is submitted, its finished output committed non-terminally, the terminal commit waits", async () => {
    serve(plan("video.extract-frames", { batches: [[0], [1]], encodes: [] }));
    scripted.set(batchId(0, 1), "running");
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1), batchId(1, 1)]);
    expect(h.finish).not.toHaveBeenCalled();
    expect(progressed()).toEqual([[null, "registered"]]);
    // §93 D6: the committed output is delivered and pending delivery woken before this pickup ended with StillRunning.
    expect(h.deliver.mock.calls.map((call) => call[1])).toEqual([1]);
    expect(h.wake).toHaveBeenCalled();
    expect(h.progress.mock.calls[0]![1]).toMatchObject({ planFingerprint: "d".repeat(64), expectedVersion: 0 });
    const committed = structuredClone(current.outputs[1]!.result);
    scripted.delete(batchId(0, 1));
    const completion = await drive();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
    expect(completion!.outputs[1]!.result).toEqual(committed);
    // Every progress commit read the version the previous one left (none was refused as stale).
    expect(staleProgress).toBe(0);
  });
});

describe("per-output retries and delivery (§93 D5-3; design §7.11, §7.1.1)", () => {
  it("VT05 the next run-batch attempt carries only the outputs the failed attempt did not write", async () => {
    serve(plan("video.extract-frames", { batches: [[0, 1]], encodes: [] }, 1));
    scripted.set(batchId(0, 1), { written: [0], state: "failed" });
    const completion = await drive();
    expect(submitted().map((request) => ({ jobId: request.jobId, outputs: request.outputs.map((output) => output.outputIndex) })))
      .toEqual([{ jobId: batchId(0, 1), outputs: [0, 1] }, { jobId: batchId(0, 2), outputs: [1] }]);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
    expect(completion!.error).toBeNull();
  });

  it("VT06 an output whose attempts are exhausted at the frozen chunkRetries fails alone; the other is delivered", async () => {
    serve(plan("video.extract-frames", { batches: [[0, 1]], encodes: [] }, 1));
    scripted.set(batchId(0, 1), { written: [0], state: "failed" });
    scripted.set(batchId(0, 2), { written: [], state: "failed" });
    const completion = await drive();
    // chunkRetries 1: the first attempt and one retry, never a third.
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1), batchId(0, 2)]);
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    const first = submitted()[0]!.outputs[0]!;
    expect(completion!.outputs[0]!.result).toMatchObject({ status: "registered", assetId: asset(first.storageKey, false).id });
  });

  it("VT07 a failed batch fails only its own outputs; another batch's outputs are delivered", async () => {
    serve(plan("video.split", { batches: [[0], [1]], encodes: [] }, 0));
    scripted.set(batchId(1, 1), { written: [], state: "failed" });
    const completion = await drive();
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1), batchId(1, 1)]);
    expect(statuses(completion)).toEqual(["registered", "failed"]);
  });
});

// §7.16: a version with an edit file is read from it; the original is bound beside it for a segment's audio (§4.4).
describe("the frozen tool source of a run (§67.3 W01; design §7.16)", () => {
  it("VT08 a version with an edit file: frames read the edit file alone; segments read it with the original bound for audio", async () => {
    version = frozenVersion({ editKey: "video/source.edit.mp4" });
    serve(plan("video.extract-frames"));
    await drive();
    expect(submitted()[0]!.inputs).toEqual([{ inputId: SOURCE_INPUT_ID, storageKey: "video/source.edit.mp4" }]);
    expect(submitted()[0]!.outputs[0]!.recipe).toMatchObject({ source: { kind: "edit" } });
    vi.clearAllMocks();
    h.advance.mockImplementation(advance); h.list.mockImplementation(async () => steps);
    steps = [];
    serve(plan("video.split"));
    await drive();
    const request = submitted()[0]!;
    expect(request.inputs).toEqual([{ inputId: SOURCE_INPUT_ID, storageKey: "video/source.edit.mp4" }, { inputId: AUDIO_INPUT_ID, storageKey: SOURCE_KEY }]);
    expect(request.outputs[0]!.recipe).toMatchObject({ kind: "segment", source: { kind: "edit" }, audio: true, audioInputId: AUDIO_INPUT_ID });
  });
});

// §68 F01, frames-split §5.5: a video focus crop is the frame recipe of its grid frame with its rectangle in P.display,
// one PNG on the panel node, paid by the platform.
describe("a video focus crop (§68; design §5.5)", () => {
  it("VF01 runs one run-batch job of its frame recipe with the crop, registers a FOCUS image and opens it with the frozen payer", async () => {
    serve(plan("video.focus-crop"));
    const completion = await drive();
    const request = submitted()[0]!;
    expect(request.outputs).toHaveLength(1);
    expect(request.outputs[0]!.recipe).toEqual(frameRecipeOf(version, toolInputOf(version, SOURCE_KEY), 30, { x: 10, y: 20, width: 100, height: 50 }).recipe);
    expect(request.outputs[0]!.recipe).toMatchObject({ crop: { sourceWidth: 320, sourceHeight: 180, rect: { x: 10, y: 20, width: 100, height: 50 } } });
    expect((h.grants.mock.calls[0]![0] as GrantInput).outputs).toEqual([{ modality: "image", namePrefix: "FOCUS" }]);
    expect((h.advance.mock.calls[0]![0] as OpenMiniToolPlanJobInput).chargeTo).toBe("platform");
    expect(statuses(completion)).toEqual(["registered"]);
  });
});

// §93 D5-11 (design line 622 「捕获异常时只把尚未提交的产物标失败」).
describe("progress commits and the caught exception (§93 D5-11)", () => {
  it("VP01 an exception after one output was committed fails only the output not yet committed", async () => {
    serve(plan("video.extract-frames", { batches: [[0], [1]], encodes: [] }));
    scripted.set(batchId(1, 1), "running");
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(progressed()).toEqual([["registered", null]]);
    const committed = structuredClone(current.outputs[0]!.result);
    scripted.set(batchId(1, 1), "throws");
    const completion = await drive();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[0]!.result).toEqual(committed);
  });
});

// §93 D5-10 (design §5.4 用户运行的两层编码, §7.15 块对象「拼接提交后」, §7.17 「产出都是不登记的中间对象」).
describe("an oversized segment: run-chunk jobs and one run-stitch (§93 D5-10)", () => {
  const WHOLE = { kind: "segment" as const, range: { start: 0, end: 96 } };
  const CHUNKS = [{ start: 0, end: 48 }, { start: 48, end: 96 }];
  /**
   * The §5.4 id of a run chunk attempt.
   * @param chunk - The chunk.
   * @param attempt - The attempt.
   * @returns The id.
   */
  const chunkId = (chunk: number, attempt = 1): string => videoContainerJobId({ kind: "run-chunk", taskId: TASK, output: 0, chunk, attempt });
  const stitchId = (attempt = 1): string => videoContainerJobId({ kind: "run-stitch", taskId: TASK, output: 0, attempt });

  it("VC01 each frozen chunk window runs as an unregistered work object; the stitch binds them, registers the output and retires them", async () => {
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 2, [WHOLE]));
    const completion = await drive();
    const opened = h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput));
    expect(opened.map((input) => input.request.jobId)).toEqual([chunkId(0), chunkId(1)]);
    const { recipes } = segmentRecipesOf(version, SOURCE_KEY, WHOLE.range, ENCODE, CHUNKS);
    const keys = [chunkId(0), chunkId(1)].map((id) => videoPresentationWorkKeyFor(SOURCE_KEY, id));
    expect(opened.map((input) => ({ chargeTo: input.chargeTo, key: input.request.outputs[0]!.storageKey, recipe: input.request.outputs[0]!.recipe, containerClass: input.request.containerClass })))
      .toEqual([0, 1].map((k) => ({ chargeTo: "user", key: keys[k], recipe: recipes[k], containerClass: "MiniToolContainerStd4" })));
    // Only the stitch holds a grant: the chunks are intermediate objects, never registered.
    expect(h.grants).toHaveBeenCalledTimes(1);
    expect((h.grants.mock.calls[0]![0] as GrantInput).outputs).toEqual([expect.objectContaining({ modality: "video" })]);
    expect(submitted().map((request) => request.jobId)).toEqual([stitchId()]);
    const stitch = submitted()[0]!;
    expect(stitch.outputs[0]!.recipe).toEqual(recipes[2]);
    expect(stitch.inputs).toEqual(expect.arrayContaining([{ inputId: chunkInputId(0), storageKey: keys[0] }, { inputId: chunkInputId(1), storageKey: keys[1] }]));
    expect(h.advance.mock.calls[0]![1]).toEqual({ retire: keys });
    expect(statuses(completion)).toEqual(["registered"]);
  });

  // inner#1306 test plan §97 (frames-split §5.4 预算 row: 同一阶段派出的作业数不大于冻结的阶段计数; D12-1): the worker sends the
  // frozen layout as it is, so the distinct jobs of each stage (attempts of one job counted once) never exceed the frozen
  // `stageJobs` beside the layout; here every frozen job of each stage is sent, and no more.
  it("VC03 never sends more distinct jobs in a stage than the frozen stageJobs", async () => {
    const stageJobs = [{ stage: "encode", jobs: 3 }, { stage: "stitch", jobs: 1 }];
    serve({ ...plan("video.split", { batches: [[1]], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 2, [WHOLE, RECIPES["video.split"][1]!]), stageJobs });
    await drive();
    const job = (id: string): string => id.replace(/:a\d+$/, "");
    const encode = new Set([...h.openPlan.mock.calls.map((call) => job((call[0] as OpenMiniToolPlanJobInput).request.jobId)), ...submitted().filter((request) => request.jobId.includes(":batch:")).map((request) => job(request.jobId))]);
    const stitch = new Set(submitted().filter((request) => request.jobId.includes(":stitch:")).map((request) => job(request.jobId)));
    expect(encode.size).toBe(3);
    expect(stitch.size).toBe(1);
  });

  it("VC02 a chunk whose attempts are exhausted fails only its own segment; another segment is delivered and no stitch runs", async () => {
    // Output 1 [48, 96) overlaps output 0; the runner does not care.
    serve(plan("video.split", { batches: [[1]], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 0, [WHOLE, RECIPES["video.split"][1]!]));
    scripted.set(chunkId(1), { written: [], state: "failed" });
    const completion = await drive();
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1)]);
    expect(statuses(completion)).toEqual(["failed", "registered"]);
    // The failed attempt's own output is retired with its result, as on the preparation path.
    const failedChunk = h.record.mock.calls.map((call) => call[0] as { outcome: string; presentation?: { retire?: string[] } }).find((value) => value.outcome === "failed");
    expect(failedChunk?.presentation?.retire).toEqual([videoPresentationWorkKeyFor(SOURCE_KEY, chunkId(1))]);
  });

  // Design §5.4: the chunks of a stage run in parallel up to the frozen stage count, so a running chunk holds back neither
  // the next chunk nor another segment's chunks.
  it("VC05 a running chunk does not hold back the next chunk or another segment's chunks: all are submitted in one pickup", async () => {
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }, { outputIndex: 1, chunks: [{ start: 48, end: 96 }] }] }, 0,
      [WHOLE, RECIPES["video.split"][1]!]));
    scripted.set(chunkId(0), "running");
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    const opened = h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId);
    expect(opened).toEqual(expect.arrayContaining([chunkId(0), chunkId(1), videoContainerJobId({ kind: "run-chunk", taskId: TASK, output: 1, chunk: 0, attempt: 1 })]));
  });

  it("VC06 a segment with a chunk failed for good waits for its running chunk, then fails with that chunk's object pinned", async () => {
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 0, [WHOLE]));
    // Both chunks are opened while they run; then chunk 0 fails for good while chunk 1 still runs.
    scripted.set(chunkId(0), "running");
    scripted.set(chunkId(1), "running");
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    scripted.set(chunkId(0), { written: [], state: "failed" });
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(h.finish).not.toHaveBeenCalled();
    scripted.delete(chunkId(1));
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed"]);
    const recorded = h.record.mock.calls.map((call) => call[0] as { outcome: string; presentation?: { pin?: string[] } });
    expect(recorded.find((value) => value.outcome === "done")?.presentation).toEqual({ pin: [videoPresentationWorkKeyFor(SOURCE_KEY, chunkId(1))] });
    expect(submitted()).toEqual([]);
  });

  // Once a chunk of the segment failed for good its stitch never runs, so a sibling's next attempt would be charged and never used.
  it("VC07 once a chunk failed for good, an earlier chunk whose attempt then fails opens no next attempt", async () => {
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 1, [WHOLE]));
    scripted.set(chunkId(0), "running");
    scripted.set(chunkId(1), { written: [], state: "failed" }); scripted.set(chunkId(1, 2), { written: [], state: "failed" });
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(h.finish).not.toHaveBeenCalled();
    scripted.set(chunkId(0), { written: [], state: "failed" });
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed"]);
    expect(h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId)).not.toContain(chunkId(0, 2));
  });

  // The stitch of a segment that is not output 0 declares and registers its own output index; a stitch whose attempts are
  // exhausted fails only its segment with the last attempt's reason, and the batched output is delivered.
  it("VC08 a stitch keeps its segment's output index and, once its attempts are exhausted, fails only that segment with its reason", async () => {
    serve(plan("video.split", { batches: [[0]], encodes: [{ outputIndex: 1, chunks: CHUNKS }] }, 1, [RECIPES["video.split"][0]!, WHOLE]));
    const stitchOf = (attempt: number): string => videoContainerJobId({ kind: "run-stitch", taskId: TASK, output: 1, attempt });
    scripted.set(stitchOf(1), { written: [], state: "failed" }); scripted.set(stitchOf(2), { written: [], state: "failed" });
    const completion = await drive();
    const stitches = submitted().filter((request) => request.jobId.includes(":stitch:"));
    expect(stitches.map((request) => request.jobId)).toEqual([stitchOf(1), stitchOf(2)]);
    expect(stitches.map((request) => request.outputs.map((output) => output.outputIndex))).toEqual([[1], [1]]);
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "mini_tool_failed", message: "tool_failed" } });
  });

  // A done chunk is pinned with the run (the model-step rule, model-run-steps.ts advanceContainer), so the stitch's retire
  // leaves it to the run's pin release and a segment that fails after it still hands it to reclaim at the terminal release.
  it("VC04 every done chunk is pinned with the run when its result is recorded", async () => {
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 0, [WHOLE]));
    scripted.set(chunkId(1), { written: [], state: "failed" });
    await drive();
    const recorded = h.record.mock.calls.map((call) => call[0] as { outcome: string; presentation?: { pin?: string[]; retire?: string[] } });
    expect(recorded.find((value) => value.outcome === "done")?.presentation).toEqual({ pin: [videoPresentationWorkKeyFor(SOURCE_KEY, chunkId(0))] });
  });
});

// §93 D5-12 (frames-split design §7.17 segment row 「透明源输出VP9+透明+Opus的WebM并保留奇数尺寸」, §4.3): a transparent source's
// split output is a VP9 WebM with alpha, so its grant, declared content type and registration are WebM; an opaque one stays
// MP4. This round's choice of the grant input (may be vetoed): `{ modality: "video", namePrefix, container: "webm" }`.
describe("the container of a split output follows the plan's alpha (§93 D5-12)", () => {
  it("VW01 a transparent source's segments are granted, declared and registered as WebM", async () => {
    version = frozenVersion({ transparent: true });
    serve(plan("video.split"));
    const completion = await drive();
    expect((h.grants.mock.calls[0]![0] as GrantInput).outputs).toEqual([0, 1].map(() => expect.objectContaining({ modality: "video", container: "webm" })));
    const [request] = submitted();
    expect(request!.outputs.map((output) => ({ key: output.storageKey.endsWith(".webm"), contentType: output.contentType, format: (output.recipe as { target: { format: string } }).target.format })))
      .toEqual([0, 1].map(() => ({ key: true, contentType: "video/webm", format: "webm-vp9" })));
    expect(completion!.outputs.map((output) => (output.result as { mimeType?: string } | null)?.mimeType)).toEqual(["video/webm", "video/webm"]);
  });

  it("VW02 an opaque source's segments stay MP4", async () => {
    serve(plan("video.split"));
    const completion = await drive();
    expect((h.grants.mock.calls[0]![0] as GrantInput).outputs.every((output) => (output as { container?: string }).container !== "webm")).toBe(true);
    expect(submitted()[0]!.outputs.map((output) => ({ key: output.storageKey.endsWith(".mp4"), contentType: output.contentType })))
      .toEqual([0, 1].map(() => ({ key: true, contentType: "video/mp4" })));
    expect(completion!.outputs.map((output) => (output.result as { mimeType?: string } | null)?.mimeType)).toEqual(["video/mp4", "video/mp4"]);
  });
});

// §93 D5-12 (frames-split design §7.17 segment row 「超过一个块份额时按§5.4分块，chunk_encode用同样的条目写法」): the chunks of an
// oversized segment are encoded for the same output, so a transparent source's chunk work objects are declared WebM too.
describe("the container of an oversized segment's chunks follows the plan's alpha (§93 D5-12)", () => {
  const WHOLE = { kind: "segment" as const, range: { start: 0, end: 96 } };
  const CHUNKS = [{ start: 0, end: 48 }, { start: 48, end: 96 }];

  it.each([["transparent", "video/webm", "webm-vp9"], ["opaque", "video/mp4", "mp4-h264"]] as const)("VW03 a %s source's run-chunk work objects are declared %s", async (alpha, contentType, format) => {
    if (alpha === "transparent") version = frozenVersion({ transparent: true } satisfies VersionFields);
    serve(plan("video.split", { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }] }, 2, [WHOLE]));
    await drive();
    const chunks = h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.outputs[0]!);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((output) => ({ contentType: output.contentType, format: (output.recipe as { target: { format: string } }).target.format })))
      .toEqual([0, 1].map(() => ({ contentType, format })));
    expect(submitted().map((request) => request.outputs[0]!.contentType)).toEqual([contentType]);
  });
});

// An attempt due after the run's deadline ends its step as expired instead of throwing for the whole pickup, so the other
// outputs of the same pickup settle; and an output registered in a pickup that then throws stays registered.
describe("an attempt due after the deadline and an output registered before a throw", () => {
  const WHOLE = { kind: "segment" as const, range: { start: 0, end: 96 } };
  const CHUNKS = [{ start: 0, end: 48 }, { start: 48, end: 96 }];
  const LAYOUT = { batches: [], encodes: [{ outputIndex: 0, chunks: CHUNKS }, { outputIndex: 1, chunks: [{ start: 48, end: 96 }] }] };
  const RECIPES2 = [WHOLE, RECIPES["video.split"][1]!];
  const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
  /**
   * A run-chunk attempt's id.
   * @param output - The output.
   * @param chunk - The chunk.
   * @param attempt - The attempt.
   * @returns The id.
   */
  const chunkOf = (output: number, chunk: number, attempt = 1): string => videoContainerJobId({ kind: "run-chunk", taskId: TASK, output, chunk, attempt });
  /**
   * A run-stitch attempt's id.
   * @param output - The output.
   * @param attempt - The attempt.
   * @returns The id.
   */
  const stitchOf = (output: number, attempt = 1): string => videoContainerJobId({ kind: "run-stitch", taskId: TASK, output, attempt });
  // The jobs ingest holds; as the real boundary, a job not yet submitted is never submitted after its deadline.
  let held: Set<string>;
  // Jobs whose answer moves the clock past the deadline: a chunk's report; a registered job named here reports failed.
  let atDeadline: Map<string, Record<string, unknown>>;
  // Ingest ends a job it expires at its deadline as failed with reason expired (transition.ts "expired" event).
  const failedReport = { schemaVersion: 2, state: "failed", reason: "expired", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } };
  /**
   * As the real boundary: a held job still running once its reporting window (two polls past the deadline) has closed throws
   * DeadlinePassed instead of waiting.
   * @param request - The job.
   * @throws {DeadlinePassed} When it still runs at the window's end.
   */
  const closedWindow = (request: MiniToolPlanJobRequest): void => {
    if (scripted.get(request.jobId) === "running" && Date.now() >= request.deadlineAt + 2 * 5000) throw new DeadlinePassed();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(DEADLINE - 60_000);
    held = new Set(); atDeadline = new Map();
    h.advancePlan.mockImplementation(async (request: MiniToolPlanJobRequest) => {
      if (!held.has(request.jobId) && Date.now() >= request.deadlineAt) throw new DeadlinePassed();
      held.add(request.jobId);
      closedWindow(request);
      const answer = atDeadline.get(request.jobId);
      if (answer === undefined) return advancePlan(request);
      vi.setSystemTime(DEADLINE + 1);
      return answer;
    });
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const stored = steps.find((item) => item.id === input.stepId)?.output.miniToolPlanJob as MiniToolPlanJobRequest | undefined;
      const request = stored ?? input.request;
      if (!held.has(request.jobId) && Date.now() >= request.deadlineAt) throw new DeadlinePassed();
      held.add(request.jobId);
      closedWindow(request);
      if (atDeadline.has(request.jobId)) {
        vi.setSystemTime(DEADLINE + 1);
        scripted.set(request.jobId, { written: [], state: "failed" });
      }
      return advance(input);
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * What was opened once the clock passed the deadline: steps appended, grants, chunk jobs and registered jobs.
   * @param before - The counts when the clock passed it.
   * @param before.ensure - Steps appended.
   * @param before.grants - Grants opened.
   * @param before.open - Chunk jobs opened.
   * @param before.advance - Registered jobs advanced.
   * @returns The calls since.
   */
  function since(before: { ensure: number; grants: number; open: number }): { ensure: number; grants: number; open: string[] } {
    return { ensure: h.ensure.mock.calls.length - before.ensure, grants: h.grants.mock.calls.length - before.grants,
      open: h.openPlan.mock.calls.slice(before.open).map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId) };
  }

  it("DL01 a chunk due a new attempt after the deadline expires its segment while the other segment's stitch registered in the same pickup", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(stitchOf(0), "running"); scripted.set(chunkOf(1, 0), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    // Output 0's stitch reports done; output 1's chunk was killed at the deadline, so its next attempt is due after it.
    scripted.delete(stitchOf(0)); scripted.delete(chunkOf(1, 0));
    atDeadline.set(chunkOf(1, 0), failedReport);
    const counts = { ensure: h.ensure.mock.calls.length, grants: h.grants.mock.calls.length, open: h.openPlan.mock.calls.length };
    const completion = await drive();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
    expect(since(counts)).toEqual({ ensure: 0, grants: 0, open: [chunkOf(1, 0)] });
  });

  it("DL02 a stitch due a new attempt after the deadline expires its segment and opens no grant, step or job", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(stitchOf(1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    scripted.delete(stitchOf(1));
    atDeadline.set(stitchOf(1), failedReport);
    const counts = { ensure: h.ensure.mock.calls.length, grants: h.grants.mock.calls.length, open: h.openPlan.mock.calls.length };
    const completion = await drive();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
    expect(since(counts)).toMatchObject({ ensure: 0, grants: 0 });
    expect(submitted().map((request) => request.jobId)).not.toContain(stitchOf(1, 2));
  });

  it("DL03 a batch due a new attempt after the deadline expires its outputs and opens no grant, step or job", async () => {
    serve(plan("video.split", { batches: [[0], [1]], encodes: [] }, 1));
    scripted.set(batchId(1, 1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    scripted.delete(batchId(1, 1));
    atDeadline.set(batchId(1, 1), failedReport);
    const counts = { ensure: h.ensure.mock.calls.length, grants: h.grants.mock.calls.length, open: h.openPlan.mock.calls.length };
    const completion = await drive();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
    expect(since(counts)).toMatchObject({ ensure: 0, grants: 0 });
    expect(submitted().map((request) => request.jobId)).not.toContain(batchId(1, 2));
  });

  it("DL08 a batch attempt ingest expired at the deadline expires its unwritten outputs and opens no next attempt", async () => {
    serve(plan("video.split", { batches: [[0, 1]], encodes: [] }, 1));
    scripted.set(batchId(0, 1), { written: [0], state: "failed", reason: "expired" });
    const completion = await drive();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1)]);
  });

  // A worker backlog can run the first pickup after the deadline once the reporting window (two polls past it) has closed:
  // what already finished is read and registered, and only what never finished expires.
  it("DL09 a first pickup after the reporting window registers a stitch that reported done while a chunk still running expires", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(chunkOf(0, 0), "running"); scripted.set(stitchOf(1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    scripted.delete(stitchOf(1));
    vi.setSystemTime(DEADLINE + 2 * 5000 + 1);
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed", "registered"]);
    expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "expired" } });
  });

  it("DL10 a first pickup after the reporting window registers a batch that reported done while a batch still running expires", async () => {
    serve(plan("video.split", { batches: [[0], [1]], encodes: [] }, 1));
    scripted.set(batchId(0, 1), "running"); scripted.set(batchId(1, 1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    scripted.delete(batchId(1, 1));
    vi.setSystemTime(DEADLINE + 2 * 5000 + 1);
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed", "registered"]);
    expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "expired" } });
  });

  it("DL04 an output registered in a pickup that then throws stays registered in the terminal commit", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(stitchOf(0), "running"); scripted.set(chunkOf(1, 0), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    // Output 0's stitch registers; output 1's stitch registration then throws past the deadline, out of the runner, so only
    // what the pickup settled before the throw keeps output 0 (no progress commit holds it).
    scripted.delete(stitchOf(0)); scripted.delete(chunkOf(1, 0));
    const boundary = h.advance.getMockImplementation()!;
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      if (input.request.jobId === stitchOf(1)) { vi.setSystemTime(DEADLINE + 1); throw new Error("Fixture stitch registration failed"); }
      return boundary(input);
    });
    const completion = await drive();
    expect(h.progress).not.toHaveBeenCalled();
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[0]!.result).toMatchObject({ status: "registered" });
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
  });

  it("DL05 the first pickup after the deadline registers an output whose stitch reported done before it, while the other output's next attempt expires", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(chunkOf(0, 0), "running"); scripted.set(stitchOf(1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    // Before the deadline output 1's stitch reports done; at it, ingest expires output 0's running chunk.
    scripted.delete(stitchOf(1)); scripted.set(chunkOf(0, 0), { written: [], state: "failed" });
    vi.setSystemTime(DEADLINE + 1);
    const counts = { ensure: h.ensure.mock.calls.length, grants: h.grants.mock.calls.length, open: h.openPlan.mock.calls.length };
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed", "registered"]);
    expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "expired" } });
    expect(completion!.error).toEqual({ code: "expired" });
    expect(since(counts)).toEqual({ ensure: 0, grants: 0, open: [chunkOf(0, 0)] });
  });

  it("DL06 a run nothing was submitted for ends expired on its first pickup after the deadline and opens nothing", async () => {
    serve(plan("video.split", { batches: [[0]], encodes: [{ outputIndex: 1, chunks: [{ start: 48, end: 96 }] }] }, 1));
    vi.setSystemTime(DEADLINE + 1);
    const completion = await drive();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(completion!.outputs.map((output) => output.result)).toEqual([{ status: "failed", error: { code: "expired" } }, { status: "failed", error: { code: "expired" } }]);
    expect({ ensure: h.ensure.mock.calls.length, grants: h.grants.mock.calls.length, open: h.openPlan.mock.calls.length, advance: h.advance.mock.calls.length })
      .toEqual({ ensure: 0, grants: 0, open: 0, advance: 0 });
  });

  it("DL07 a submitted job still running after the deadline is waited for until its reporting window ends, then its output expires", async () => {
    serve(plan("video.split", LAYOUT, 1, RECIPES2));
    scripted.set(stitchOf(1), "running");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    vi.setSystemTime(DEADLINE + 1);
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(h.finish).not.toHaveBeenCalled();
    vi.setSystemTime(DEADLINE + 2 * 5000);
    const completion = await drive();
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(statuses(completion)).toEqual(["registered", "failed"]);
    expect(completion!.outputs[1]!.result).toEqual({ status: "failed", error: { code: "expired" } });
  });
});
