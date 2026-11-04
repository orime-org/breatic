// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The extract-frames and split runners (inner#1306 test plan §93 D5-1..D5-5; frames-split design §5.4 用户运行的两层编码 and
 * 作业身份, §7.11 逐项结果, §7.15, §7.17 「唯一写点：worker的配方构造」, §10.8 作业 and 失败与提交).
 *
 * A planned extract-frames or split pickup enters through `runMiniToolExecutionTask` (as the removal does) and runs the
 * frozen plan: it reads the full ledger of the frozen `ledgerReceipts.source` (served here at its receipt URL with the
 * cfr96 bytes), uses the frozen `layout` as it is (D5-1), writes each output's job recipe with `frameRecipeOf` /
 * `segmentRecipesOf` and the frozen `container.encode` (D5-2), and submits each batch as a `run-batch` job through
 * `advanceRegisteredMiniToolPlanJob` (D5-4, D5-5). A failed batch attempt's next attempt carries only the outputs not yet
 * done, up to the frozen `chunkRetries`; exhausted outputs fail one by one and the others are delivered (D5-3, §7.11).
 *
 * The job boundary (`advanceRegisteredMiniToolPlanJob`), grants, steps, the SQL lifecycle and the completion owner are
 * mocked; the recipe builders and the ledger read stay real. Every frame and span starts on a cfr96 keyframe (0 or 48).
 * The chunk-and-stitch path of an oversized segment waits for §93 D5-10 and is not here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion, MiniToolExecutionJob, OpenMiniToolPlanJobInput } from "@breatic/domain";
import type { MiniToolPlanJobRequest, StudioAssetEntity, VideoPresentationLedger } from "@breatic/shared";
import { videoContainerJobId } from "@breatic/shared/mini-tools";
import type { RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { frameRecipeOf, segmentRecipesOf } from "@worker/handlers/video-presentation-recipes.js";
import { StillRunning } from "@worker/providers/still-running.js";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({
  start: vi.fn(), plan: vi.fn(), list: vi.fn(), ensure: vi.fn(), inline: vi.fn(), grants: vi.fn(), findById: vi.fn(), findCoverOf: vi.fn(),
  advance: vi.fn(), finish: vi.fn(), deadline: vi.fn(), removal: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/core", async (original) => {
  const actual = await original<typeof coreModule>();
  return { ...actual, logger: h.logger as unknown as typeof actual.logger, getStreamRedis: () => ({}),
    getMiniToolsConfig: (): ReturnType<typeof actual.getMiniToolsConfig> => ({ ...actual.getMiniToolsConfig(), poll_interval_ms: 5000 }) };
});
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, readMiniToolExecutionPlan: h.plan, openContainerOutputs: h.grants,
    assetRepo: { ...actual.assetRepo, findById: h.findById, findCoverOf: h.findCoverOf },
    miniToolExecutionService: { ...actual.miniToolExecutionService, startMiniToolExecution: h.start },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, ensureSteps: h.ensure, recordInline: h.inline } };
});
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", () => ({ advanceRegisteredMiniToolPlanJob: h.advance }));
vi.mock("@worker/handlers/mini-tool/execution-completion.js", () => ({ finishMiniToolExecutionAndNotify: h.finish }));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/run-remove-background.js", () => ({ runMiniToolRemoveBackground: h.removal }));
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
const CFR96 = readFileSync(new URL("../../__tests__/fixtures/presentation/cfr96.ledger.json", import.meta.url));
const LEDGER = JSON.parse(CFR96.toString("utf8")) as VideoPresentationLedger;
const LEDGER_URL = "https://assets.example.test/video/source.mp4.video-source-ledger.cfr96.json";
let ledgerBytes: Buffer = CFR96;
let ledgerFault: "reset" | null = null;

type Tool = "video.extract-frames" | "video.split";
type Steps = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>;
type StepPlan = Parameters<typeof domainModule.upstreamStepRepo.ensureSteps>[1];
type GrantInput = Parameters<typeof domainModule.openContainerOutputs>[0];
let steps: Steps;
let grantSequence: number;
// Scripted batch outcomes by job id: which declared outputs the attempt wrote, and whether it failed or still runs.
let scripted: Map<string, { written: number[]; state: "done" | "failed" } | "running">;

// Two outputs per tool, each on a keyframe: frames 0 and 48; segments [0, 1.92) and [1.92, 3.84) (frames 0–47 and 48–95).
const RECIPES: Record<Tool, ({ kind: "frame"; frameIndex: number; pts: number } | { kind: "segment"; range: { start: number; end: number } })[]> = {
  "video.extract-frames": [{ kind: "frame", frameIndex: 0, pts: 0 }, { kind: "frame", frameIndex: 48, pts: 1.92 }],
  "video.split": [{ kind: "segment", range: { start: 0, end: 1.92 } }, { kind: "segment", range: { start: 1.92, end: 3.84 } }],
};

/**
 * A frozen extract-frames or split plan on the cfr96 ledger (shape of `execution-plan.service.ts` storedPlanSchema).
 * @param tool - The tool.
 * @param layout - The frozen layout.
 * @param chunkRetries - The frozen retry cap.
 * @returns The plan.
 */
function plan(tool: Tool, layout: { batches: number[][]; encodes: { outputIndex: number; chunks: { start: number; end: number }[] }[] } = { batches: [[0, 1]], encodes: [] },
  chunkRetries = 2): Record<string, unknown> {
  const ledger = LEDGER as unknown as { sourceFingerprint: string; toolInputId: string; planSha256: string };
  return {
    schemaVersion: 1, tool, taskId: TASK, projectId: PROJECT, spaceId: SPACE, targetNodeIds: NODES,
    binding: { assetId: SOURCE_ID, contentHash: ledger.sourceFingerprint, canonicalURL: "https://assets.example.test/video/source.mp4", kind: "video",
      mediaInfo: { width: 320, height: 180, duration: 3.84, mimeType: "video/mp4" } },
    sourceKey: SOURCE_KEY, draft: {}, analysisRefs: [],
    outputs: RECIPES[tool].map((recipe, outputIndex) => ({ outputIndex, nodeId: NODES[outputIndex]!, recipe })),
    model: tool, credits: 1, requestFingerprint: "c".repeat(64), planFingerprint: "d".repeat(64),
    presentationRef: { source: { toolInputId: ledger.toolInputId, planSha256: ledger.planSha256 } },
    ledgerReceipts: { source: { schemaVersion: 2, sourceFingerprint: ledger.sourceFingerprint, toolInputId: ledger.toolInputId, planSha256: ledger.planSha256, producerVersion: 2,
      attempt: { jobId: "video-presentation:fixture", deadlineAt: 1900000000000 }, url: LEDGER_URL, etag: "full-etag", size: CFR96.byteLength,
      sha256: createHash("sha256").update(CFR96).digest("hex"), contentType: "application/json",
      table: { url: "https://assets.example.test/video/source.mp4.video-presentation-table.cfr96.json", sha256: "e".repeat(64), size: 81, contentType: "application/json", frameCount: 96 } } },
    versionIds: { source: "f".repeat(64) },
    layout, outputSeconds: [1, 1],
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
  const record = { schemaVersion: 1, runId: TASK, status: "running", planFingerprint: execution.planFingerprint, resultVersion: 0,
    sourceBindings: [execution.binding], outputs, usage: [], billingState: "idle", error: null };
  h.start.mockResolvedValue({ task, execution, record });
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
    contentHash: id, storageKey: key, fileUrl: `https://assets.example.test/${key}`, sizeBytes: 100, mimeType: video ? "video/mp4" : "image/png",
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
  const declared = request.outputs.map((output) => output.outputIndex);
  const written = script?.written ?? declared;
  const state = script?.state ?? "done";
  const video = request.outputs.some((output) => output.contentType.startsWith("video/"));
  const outputs = request.outputs.filter((output) => written.includes(output.outputIndex)).map((output) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey,
    sha256: asset(output.storageKey, video).contentHash, sizeBytes: 100, contentType: output.contentType, width: 320, height: 180,
    durationSeconds: video ? 1.92 : null, cover: null, upright: null }));
  const report = state === "done" ? { schemaVersion: 2 as const, state, outputs, usage: { wallMs: 1000, cpuUsec: 2000000 } }
    : { schemaVersion: 2 as const, state, reason: "tool_failed" as const, outputs, usage: { wallMs: 1000, cpuUsec: 2000000 } };
  // The stored step result, as recordMiniToolStepResult leaves it.
  step.output = { ...step.output, miniToolStep: { schemaVersion: 1, scope: { taskId: TASK, stepId: step.id, kind: "container_job", endpoint: step.endpoint, itemIndex: step.itemIndex },
    deadlineAt: request.deadlineAt, requestBody: null, requestFingerprint: null, chargeTo: input.chargeTo, creditMultiplier: 1, attempts: [],
    result: { outcome: state, result: report, error: state === "failed" ? { code: "tool_failed" } : null }, error: null, conflicts: [] } };
  return { request, report, assets: outputs.map((output) => ({ outputIndex: output.outputIndex, asset: asset(output.storageKey, video) })) };
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
  steps = []; grantSequence = 0; scripted = new Map(); ledgerBytes = CFR96; ledgerFault = null;
  h.deadline.mockResolvedValue(DEADLINE);
  h.removal.mockRejectedValue(new Error("A frames or split run must not take the removal runner"));
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
    return input.outputs.map((output, index) => output.modality === "video"
      ? { storageKey: `derived/grant-${sequence}/${index}.mp4`, contentType: "video/mp4", coverKey: `derived/grant-${sequence}/${index}.cover.jpg` }
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
  h.finish.mockImplementation(async (_taskId: string, completion: MiniToolExecutionCompletion) => ({ record: { status: completion.error === null ? "completed" : "failed" } }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    if (url !== LEDGER_URL) return new Response("unexpected", { status: 500 });
    if (ledgerFault === "reset") throw new TypeError("fetch failed: connection reset");
    return new Response(ledgerBytes, { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("extract-frames and split run the frozen plan (§93 D5-1, D5-2, D5-4, D5-5; design §7.17, §5.4)", () => {
  it("VT01 extract-frames: one run-batch job of the frozen batch, each frame recipe from the frozen ledger, every output delivered", async () => {
    serve(plan("video.extract-frames"));
    const completion = await drive();
    expect(h.removal).not.toHaveBeenCalled();
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1)]);
    const [request] = submitted();
    expect(request).toMatchObject({ containerClass: "MiniToolContainerStd4", deadlineAt: DEADLINE, limits: LIMITS });
    expect(request!.inputs).toEqual([expect.objectContaining({ storageKey: SOURCE_KEY })]);
    const inputId = request!.inputs[0]!.inputId;
    // §7.17 「唯一写点：worker的配方构造」: the execution-level { frameIndex, pts } becomes the D4-3 frame recipe.
    expect(request!.outputs.map(({ outputIndex, contentType, recipe }) => ({ outputIndex, contentType, recipe }))).toEqual([
      { outputIndex: 0, contentType: "image/png", recipe: frameRecipeOf(LEDGER, { frameIndex: 0, pts: 0 }, inputId) },
      { outputIndex: 1, contentType: "image/png", recipe: frameRecipeOf(LEDGER, { frameIndex: 48, pts: 1.92 }, inputId) },
    ]);
    expect(h.advance.mock.calls.every((call) => (call[0] as OpenMiniToolPlanJobInput).chargeTo === "user")).toBe(true);
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
    const inputId = request!.inputs[0]!.inputId;
    expect(request!.outputs.map(({ outputIndex, recipe }) => ({ outputIndex, recipe }))).toEqual([
      { outputIndex: 0, recipe: segmentRecipesOf(LEDGER, { range: { start: 0, end: 1.92 } }, inputId, ENCODE, [{ start: 0, end: 48 }])[0] },
      { outputIndex: 1, recipe: segmentRecipesOf(LEDGER, { range: { start: 1.92, end: 3.84 } }, inputId, ENCODE, [{ start: 48, end: 96 }])[0] },
    ]);
    expect(request!.outputs.every((output) => output.contentType.startsWith("video/"))).toBe(true);
    expect(statuses(completion)).toEqual(["registered", "registered"]);
  });

  it("VT04 a batch pickup that is still running does not hold back the other batch's submission (§5.4 batches run in parallel)", async () => {
    serve(plan("video.extract-frames", { batches: [[0], [1]], encodes: [] }));
    scripted.set(batchId(0, 1), "running");
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(submitted().map((request) => request.jobId)).toEqual([batchId(0, 1), batchId(1, 1)]);
    expect(h.finish).not.toHaveBeenCalled();
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

// D4-7 / §91 D3b-9: the run froze its receipt, so a ledger that fails it never recovers in this run. A transport failure
// is not a content mismatch and keeps the normal retry.
describe("the frozen full ledger of a run (§92 D4-7)", () => {
  it.each(["video.extract-frames", "video.split"] as const)("VT08 %s: frozen ledger bytes that fail the receipt fail every output as source_ledger_invalid, nothing submitted", async (tool) => {
    serve(plan(tool));
    ledgerBytes = Buffer.concat([CFR96, Buffer.from(" ")]);
    const completion = await drive();
    expect(h.advance).not.toHaveBeenCalled(); expect(h.grants).not.toHaveBeenCalled();
    expect(statuses(completion)).toEqual(["failed", "failed"]);
    expect(JSON.stringify(completion!.error)).toContain("source_ledger_invalid");
    expect(h.logger.error).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ taskId: TASK,
      toolInputId: (LEDGER as unknown as { toolInputId: string }).toolInputId }) }), expect.any(String));
  });

  it("VT09 a ledger read that fails in transport submits nothing and leaves the run to the queue retry", async () => {
    serve(plan("video.extract-frames"));
    ledgerFault = "reset";
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toThrow();
    expect(h.removal).not.toHaveBeenCalled();
    expect(h.advance).not.toHaveBeenCalled(); expect(h.finish).not.toHaveBeenCalled();
  });
});
