// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The transitions runner (inner#1306 test plan §97 D12-1, D15-3..D15-7, D16-1; frames-split design §5.4 派发, 预算 and 作业身份
 * rows, §7.17 `chunk_encode`, `transition_window` and `stitch` rows and 转场输出档 row).
 *
 * A planned `video.transitions` pickup enters through `runMiniToolExecutionTask`, as the frames and split runs do, and runs
 * the frozen plan as it is: one `chunk_encode` job on the frozen `container` class (standard-4) per frozen `layout.encode`
 * window, one `transition_window` job on the frozen `windowContainer` class (`MiniToolContainerGl`) per frozen
 * `layout.window` window, then exactly one `stitch` on standard-4 that binds every chunk in output-frame order, both clips'
 * audio in timeline order (an audio entry for every clip, §97 D23: the frozen plan holds no has-audio fact, and the
 * container fills silence for a file without an audio track) and the `crossfade` window (null for a Cut). Every
 * job carries the frozen `profile`. A Cut sends no window job. Job ids follow §5.4: `<taskId>:out:0:enc:<k>:a<m>`,
 * `<taskId>:out:0:win:<k>:a<m>`, `<taskId>:out:0:stitch:a<m>`.
 *
 * As in run-video-tool.test.ts, the job boundaries (`openMiniToolPlanJob` + `advanceMiniToolPlanJob` for unregistered work
 * objects, `advanceRegisteredMiniToolPlanJob` for registered ones), grants, steps, the SQL lifecycle and the completion owner
 * are mocked; the ledger reads and the shared planners stay real. Requests are read from both boundaries, so either may
 * carry a chunk. The frozen plan below names each clip by its draft input id (`presentationRef`, `ledgerReceipts`,
 * `versionIds`, and, chosen here, `bindings` and `sourceKeys`); the runner rebuilds the frame-grid timeline from the frozen
 * `draft.params.clips` and `profile.fps` with `planVideoTimeline`, the planner the panel uses.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as coreModule from "@breatic/core";
import type * as domainModule from "@breatic/domain";
import type { MiniToolExecutionCompletion, MiniToolExecutionJob, OpenMiniToolPlanJobInput } from "@breatic/domain";
import type { MiniToolPlanJobRequest, StudioAssetEntity, VideoPresentationLedger } from "@breatic/shared";
import { planTransitionChunks, plannedStageJobs, planVideoTimeline, transitionOutputProfile, type FrameWindow } from "@breatic/shared/mini-tools";
import type { RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { readJobLedger } from "@worker/handlers/video-presentation-recipes.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { runMiniToolExecutionTask } from "../run-execution-task.js";

const h = vi.hoisted(() => ({
  start: vi.fn(), plan: vi.fn(), list: vi.fn(), ensure: vi.fn(), inline: vi.fn(), grants: vi.fn(), findById: vi.fn(), findCoverOf: vi.fn(),
  advance: vi.fn(), finish: vi.fn(), deadline: vi.fn(), removal: vi.fn(), progress: vi.fn(), openPlan: vi.fn(), advancePlan: vi.fn(), record: vi.fn(),
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
vi.mock("@worker/handlers/mini-tool/execution-completion.js", async (original) => ({ ...await original<Record<string, unknown>>(), finishMiniToolExecutionAndNotify: h.finish }));
// Partial, so the reporting window end stays the real one.
vi.mock("@worker/handlers/mini-tool/advance-plan-job.js", async (original) => ({ ...await original<Record<string, unknown>>(), advanceMiniToolPlanJob: h.advancePlan }));
vi.mock("@worker/handlers/mini-tool/delivery-worker.js", () => ({ deliverMiniToolOutput: h.deliver, wakePendingMiniToolDelivery: h.wake }));
vi.mock("@worker/handlers/task-deadline.js", () => ({ taskDeadline: h.deadline }));
vi.mock("@worker/handlers/mini-tool/run-remove-background.js", () => ({ runMiniToolRemoveBackground: h.removal }));
vi.mock("@worker/handlers/dispatch.js", () => ({ isTerminalAttempt: () => false, verifyJobLockOwnership: async () => true }));

const TASK = "50000000-0000-4000-8000-000000000001";
const PROJECT = "10000000-0000-4000-8000-000000000001";
const SPACE = "20000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001";
const HOST = "30000000-0000-4000-8000-000000000001";
const NODE = "40000000-0000-4000-8000-000000000001";
// The draft's input ids: the host node's current video and the picked video.
const CURRENT = "90000000-0000-4000-8000-000000000001";
const PICKED = "90000000-0000-4000-8000-000000000002";
const DEADLINE = Date.now() + 3_600_000;
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
// The frozen encode differs from today's configuration (crf 18, medium), so a profile carrying it proves which one was used.
const ENCODE = { crf: 23, preset: "fast" } as const;
const SIZE = { instance_type: "standard-4", vcpu: 4, memory_gib: 12, disk_gb: 20 };
const PRICES = { vcpu_second_usd: 0.00002, memory_gib_second_usd: 0.0000025, disk_gb_second_usd: 0.00000007 };

/** One served full ledger fixture. */
interface Served { bytes: Buffer; ledger: VideoPresentationLedger; url: string; key: string }
/**
 * Load a presentation ledger fixture and where it is served.
 * @param file - The fixture file.
 * @param key - The source's storage key.
 * @returns The fixture.
 */
function served(file: string, key: string): Served {
  const bytes = readFileSync(new URL(`../../__tests__/fixtures/presentation/${file}`, import.meta.url));
  return { bytes, ledger: JSON.parse(bytes.toString("utf8")) as VideoPresentationLedger, url: `https://assets.example.test/${key}.ledger.json`, key };
}
// 96 frames at 25 fps, 320×180, with audio (PROVENANCE.txt).
const A = served("cfr96.ledger.json", "video/current.mp4");
// The same picture bound to another source fingerprint, with audio.
const B = served("cfr96-source-a.ledger.json", "video/picked.mp4");
// 38 frames over 1.5 s, 160×96, without audio.
const SILENT = served("cut.ledger.json", "video/silent.mp4");

type Steps = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>;
type StepPlan = Parameters<typeof domainModule.upstreamStepRepo.ensureSteps>[1];
type GrantInput = Parameters<typeof domainModule.openContainerOutputs>[0];
type Transition = { kind: "cut" | "fade" | "wipeLeft" | "wipeRight"; duration: number };
type Recipe = Record<string, unknown> & { kind: string };
let steps: Steps;
let grantSequence: number;
let current: Record<string, unknown> & { resultVersion: number; status: string; outputs: { result: unknown }[] };

/**
 * The frozen receipt of a served ledger.
 * @param source - The fixture.
 * @returns The receipt.
 */
function receipt(source: Served): Record<string, unknown> {
  const ledger = source.ledger as unknown as { sourceFingerprint: string; toolInputId: string; planSha256: string; attempt: unknown };
  return { schemaVersion: 2, sourceFingerprint: ledger.sourceFingerprint, toolInputId: ledger.toolInputId, planSha256: ledger.planSha256, producerVersion: 2,
    attempt: ledger.attempt, url: source.url, etag: "full-etag", size: source.bytes.byteLength, sha256: createHash("sha256").update(source.bytes).digest("hex"),
    contentType: "application/json", table: { url: `${source.url}.table`, sha256: "e".repeat(64), size: 81, contentType: "application/json",
      frameCount: source.ledger.plan.presentation.runs.reduce((total, run) => total + run.count, 0) } };
}

/**
 * The registered binding of a served source.
 * @param source - The fixture.
 * @returns The binding.
 */
function binding(source: Served): Record<string, unknown> {
  const { display } = source.ledger.plan;
  return { assetId: createHash("sha256").update(source.key).digest("hex").replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$/, "$1-$2-4$3-8$4-$5"),
    contentHash: (source.ledger as unknown as { sourceFingerprint: string }).sourceFingerprint, canonicalURL: `https://assets.example.test/${source.key}`, kind: "video",
    mediaInfo: { width: display.width, height: display.height, duration: Number(display.duration.numerator) / Number(display.duration.denominator), mimeType: "video/mp4" } };
}

/** The two clips of a run in timeline order, the frame-grid timeline, the frozen layout and profile. */
interface Run { first: Served; second: Served; clips: Record<string, unknown>[]; timeline: ReturnType<typeof planVideoTimeline>; layout: { encode: FrameWindow[]; window: FrameWindow[] }; profile: ReturnType<typeof transitionOutputProfile> }

/**
 * A run: the current video from 0 to 3.84 s, the transition, then the second video from 0 to its own end, its layout
 * frozen with chunks of at most `target` frames.
 * @param transition - The transition.
 * @param second - The second clip's source.
 * @param secondOut - Its out point in seconds.
 * @param target - The frozen chunk size in frames.
 * @returns The run.
 */
function run(transition: Transition, second: Served, secondOut: number, target: number): Run {
  const clips = [
    { clipId: "a0000000-0000-4000-8000-000000000001", inputId: CURRENT, in: 0, out: 3.84, transition },
    { clipId: "a0000000-0000-4000-8000-000000000002", inputId: PICKED, in: 0, out: secondOut, transition: { kind: "cut", duration: 0 } },
  ];
  const profile = transitionOutputProfile(A.ledger.plan, second.ledger.plan, { encode: ENCODE });
  const timeline = planVideoTimeline(clips as Parameters<typeof planVideoTimeline>[0], profile.fps);
  return { first: A, second, clips, timeline, layout: planTransitionChunks(timeline, { targetSeconds: target, frameSeconds: () => 1 }), profile };
}

/**
 * Each clip's stitch audio interval, in seconds, beside the interval its output frames show: [In slot, In slot + frames / fps).
 * @param value - The run.
 * @param clips - The stitch's clips.
 * @returns Both, per clip.
 */
function audioAgainstVideo(value: Run, clips: { audio: unknown }[]): { audio: [number, number]; video: [number, number] }[] {
  const seconds = (exact: { numerator: string; denominator: string }): number => Number(exact.numerator) / Number(exact.denominator);
  const fps = seconds(value.profile.fps);
  return value.timeline.clips.map((clip, at) => {
    const audio = clips[at]!.audio as { start: { numerator: string; denominator: string }; end: { numerator: string; denominator: string } };
    return { audio: [seconds(audio.start), seconds(audio.end)], video: [clip.inFrame / fps, (clip.inFrame + clip.frameCount) / fps] };
  });
}

/**
 * The frozen transitions plan (the admission's projection; field names chosen in §97 for this test).
 * @param value - The run.
 * @returns The plan.
 */
function plan(value: Run): Record<string, unknown> {
  const { first, second } = value;
  const media = (source: Served): unknown => binding(source).mediaInfo;
  const ledgerOf = (source: Served): { toolInputId: string; planSha256: string } => source.ledger;
  return {
    schemaVersion: 1, tool: "video.transitions", taskId: TASK, projectId: PROJECT, spaceId: SPACE, targetNodeIds: [NODE],
    binding: binding(first), sourceKey: first.key,
    bindings: { [CURRENT]: binding(first), [PICKED]: binding(second) }, sourceKeys: { [CURRENT]: first.key, [PICKED]: second.key },
    draft: { version: 1, draftId: "70000000-0000-4000-8000-000000000001", revision: "70000000-0000-4000-8000-000000000002",
      source: { nodeId: HOST, canonicalURL: `https://assets.example.test/${first.key}`, mediaInfo: media(first) },
      inputs: [{ inputId: CURRENT, url: `https://assets.example.test/${first.key}`, mediaInfo: media(first), sourceNodeId: HOST },
        { inputId: PICKED, url: `https://assets.example.test/${second.key}`, mediaInfo: media(second), sourceNodeId: "30000000-0000-4000-8000-000000000002" }],
      params: { clips: value.clips } },
    analysisRefs: [], outputs: [{ outputIndex: 0, nodeId: NODE, recipe: { kind: "transitions" } }],
    model: "video.transitions", credits: 1, requestFingerprint: "c".repeat(64), planFingerprint: "d".repeat(64),
    presentationRef: { [CURRENT]: { toolInputId: ledgerOf(first).toolInputId, planSha256: ledgerOf(first).planSha256 },
      [PICKED]: { toolInputId: ledgerOf(second).toolInputId, planSha256: ledgerOf(second).planSha256 } },
    ledgerReceipts: { [CURRENT]: receipt(first), [PICKED]: receipt(second) }, versionIds: { [CURRENT]: "f".repeat(64), [PICKED]: "e".repeat(64) },
    layout: value.layout, stageJobs: plannedStageJobs(value.layout), profile: value.profile,
    container: { containerClass: "MiniToolContainerStd4", precheckSeconds: 300, size: SIZE, prices: PRICES, limits: LIMITS, startSeconds: 3, encode: ENCODE, chunkRetries: 2 },
    windowContainer: { containerClass: "MiniToolContainerGl", precheckSeconds: 300, size: SIZE, prices: PRICES, limits: LIMITS },
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
 * @returns The row.
 */
function asset(key: string): StudioAssetEntity {
  const id = createHash("sha256").update(key).digest("hex");
  return { id: `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`, studioId: "b0000000-0000-4000-8000-000000000001",
    contentHash: id, storageKey: key, fileUrl: `https://assets.example.test/${key}`, sizeBytes: 100, mimeType: key.endsWith(".webm") ? "video/webm" : "video/mp4",
    kind: "video", source: "ai", producedByUserId: USER, generationTaskId: TASK, width: 320, height: 180,
    durationSeconds: 6.68, createdAt: new Date("2026-11-06T00:00:00Z"), deletedAt: null };
}

/**
 * The registered job boundary: every declared output is written; a repeated call answers the stored request.
 * @param input - The open-job input.
 * @returns The registered job.
 */
async function advance(input: OpenMiniToolPlanJobInput): Promise<RegisteredMiniToolPlanJob> {
  const step = steps.find((item) => item.id === input.stepId);
  if (step === undefined) throw new Error("Fixture advance lost its step");
  const request = (step.output.miniToolPlanJob as MiniToolPlanJobRequest | undefined) ?? input.request;
  step.output = { ...step.output, miniToolPlanJob: structuredClone(request) };
  const outputs = request.outputs.map((output) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: asset(output.storageKey).contentHash, sizeBytes: 100,
    contentType: output.contentType, width: 320, height: 180, durationSeconds: 6.68, cover: null, upright: null }));
  const report = { schemaVersion: 2 as const, state: "done" as const, outputs, usage: { wallMs: 1000, cpuUsec: 2000000 } };
  step.output = { ...step.output, miniToolStep: { schemaVersion: 1, scope: { taskId: TASK, stepId: step.id, kind: "container_job", endpoint: step.endpoint, itemIndex: step.itemIndex },
    deadlineAt: request.deadlineAt, requestBody: null, requestFingerprint: null, chargeTo: input.chargeTo, creditMultiplier: 1, attempts: [],
    result: { outcome: "done", result: report, error: null }, error: null, conflicts: [] } };
  return { request, report, assets: outputs.map((output) => ({ outputIndex: output.outputIndex, asset: asset(output.storageKey) })) };
}

/**
 * The work-object job boundary: `openMiniToolPlanJob` keeps the first request on its step.
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
 * A work-object job's report: done with its one output.
 * @param request - The request.
 * @returns The report.
 */
async function advancePlan(request: MiniToolPlanJobRequest): Promise<Record<string, unknown>> {
  const output = request.outputs[0]!;
  return { schemaVersion: 2, state: "done", outputs: [{ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "9".repeat(64), sizeBytes: 2048, contentType: output.contentType }],
    usage: { wallMs: 1000, cpuUsec: 2000000 } };
}

/**
 * `recordMiniToolStepResult`: the step keeps its result.
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
 * The domain progress commit: committed results kept, the version moves only on a change.
 * @param _taskId - The run.
 * @param input - The commit.
 * @param input.expectedVersion - The version it read.
 * @param input.outputs - The complete indexed outputs.
 * @returns The new record.
 * @throws {Error} When the version is stale.
 */
async function progress(_taskId: string, input: { expectedVersion: number; outputs: { result: unknown }[] }): Promise<{ record: typeof current }> {
  if (input.expectedVersion !== current.resultVersion) throw new Error("Fixture progress commit is stale");
  let changed = false;
  const outputs = current.outputs.map((held, index) => {
    const next = input.outputs[index]!.result;
    if (held.result !== null || next === null) return held;
    changed = true;
    return { ...held, result: next };
  });
  if (changed) current = { ...current, outputs, resultVersion: current.resultVersion + 1 };
  return { record: structuredClone(current) };
}

/**
 * Run pickups until the completion owner is called, at most twelve.
 * @returns The completion it was given, or null when none was.
 */
async function drive(): Promise<MiniToolExecutionCompletion | null> {
  const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
  for (let pickup = 0; pickup < 12 && h.finish.mock.calls.length === 0; pickup += 1) {
    try { await runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>); } catch (error) { if (!(error instanceof StillRunning)) throw error; }
  }
  return (h.finish.mock.calls[0]?.[1] as MiniToolExecutionCompletion | undefined) ?? null;
}

/**
 * Every container request sent through either boundary, first request per job id, in send order.
 * @returns The requests.
 */
function sent(): MiniToolPlanJobRequest[] {
  const all = [...h.openPlan.mock.calls, ...h.advance.mock.calls].map((call) => (call[0] as OpenMiniToolPlanJobInput).request);
  return all.filter((request, index) => all.findIndex((other) => other.jobId === request.jobId) === index);
}

/**
 * The request of a job id.
 * @param jobId - The id.
 * @returns The request.
 * @throws {Error} When no request has it.
 */
function requestOf(jobId: string): MiniToolPlanJobRequest {
  const found = sent().find((request) => request.jobId === jobId);
  if (found === undefined) throw new Error(`No request was sent for ${jobId}; sent: ${sent().map((request) => request.jobId).join(", ")}`);
  return found;
}

/**
 * The storage key a request binds to an input id.
 * @param request - The request.
 * @param inputId - The input id a recipe names.
 * @returns The bound key, or undefined.
 */
function bound(request: MiniToolPlanJobRequest, inputId: unknown): string | undefined {
  return request.inputs.find((input) => input.inputId === inputId)?.storageKey;
}

/**
 * The one output recipe of a request.
 * @param request - The request.
 * @returns The recipe.
 */
function recipeOf(request: MiniToolPlanJobRequest): Recipe {
  expect(request.outputs).toHaveLength(1);
  return request.outputs[0]!.recipe as unknown as Recipe;
}

// §5.4 作业身份: the transition's encode chunks, window chunks and stitch of its one output.
const encId = (k: number): string => `${TASK}:out:0:enc:${k}:a1`;
const winId = (k: number): string => `${TASK}:out:0:win:${k}:a1`;
const STITCH = `${TASK}:out:0:stitch:a1`;

/**
 * The completion's output statuses.
 * @param completion - The completion.
 * @returns Their statuses.
 */
function statuses(completion: MiniToolExecutionCompletion | null): (string | null)[] {
  return completion?.outputs.map((output) => output.result?.status ?? null) ?? [];
}

beforeEach(() => {
  vi.resetAllMocks();
  steps = []; grantSequence = 0;
  h.deadline.mockResolvedValue(DEADLINE);
  h.removal.mockRejectedValue(new Error("A transitions run must not take the removal runner"));
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
    return input.outputs.map((output, index) => (output as { container?: string }).container === "webm"
      ? { storageKey: `derived/grant-${sequence}/${index}.webm`, contentType: "video/webm", coverKey: `derived/grant-${sequence}/${index}.webm.cover.jpg` }
      : { storageKey: `derived/grant-${sequence}/${index}.mp4`, contentType: "video/mp4", coverKey: `derived/grant-${sequence}/${index}.cover.jpg` });
  });
  h.findById.mockImplementation(async (id: string) => {
    for (const request of sent()) for (const output of request.outputs) if (asset(output.storageKey).id === id) return asset(output.storageKey);
    return null;
  });
  h.findCoverOf.mockResolvedValue(null);
  h.advance.mockImplementation(advance);
  h.openPlan.mockImplementation(openPlan); h.advancePlan.mockImplementation(advancePlan); h.record.mockImplementation(record); h.progress.mockImplementation(progress);
  h.readDelivery.mockImplementation(async () => ({ task: { id: TASK }, execution: {}, record: structuredClone(current),
    delivery: { schemaVersion: 1, planFingerprint: "d".repeat(64), version: 1, lastErrorCode: null,
      outputs: current.outputs.flatMap((output, outputIndex) => output.result === null ? [] : [{ outputIndex, state: "pending" }]) } }));
  h.deliver.mockImplementation(async (value: unknown) => value);
  h.finish.mockImplementation(async (_taskId: string, completion: MiniToolExecutionCompletion) => ({ record: { status: completion.error === null ? "completed" : "failed" } }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    const source = [A, B, SILENT].find((item) => item.url === url);
    if (source === undefined) return new Response("unexpected", { status: 500 });
    return new Response(source.bytes, { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a transitions pickup runs its frozen chunks on their container classes, then one stitch (§5.4 派发; §7.17)", () => {
  // A 1 s fade at 25 fps: the window is [71, 96); chunks of at most 24 frames give three encode chunks on each side and
  // two window chunks, so the frozen encode stage holds eight jobs.
  const fade = (): Run => run({ kind: "fade", duration: 1 }, B, 3.84, 24);

  it("TW00 the fixture plans a 25-frame window at frame 71 and freezes 6 encode and 2 window chunks", () => {
    const value = fade();
    expect(value.timeline.window).toEqual({ startFrame: 71, frameCount: 25, kind: "fade" });
    expect(value.layout.encode).toHaveLength(6);
    expect(value.layout.window).toEqual([{ start: 71, end: 83 }, { start: 83, end: 96 }]);
    expect(plannedStageJobs(value.layout)).toEqual([{ stage: "encode", jobs: 8 }, { stage: "stitch", jobs: 1 }]);
  });

  it("TW00b each frozen receipt reads its served full ledger", async () => {
    for (const source of [A, B, SILENT]) {
      expect(await readJobLedger(receipt(source) as unknown as Parameters<typeof readJobLedger>[0], DEADLINE)).toEqual(source.ledger);
    }
  });

  it("TW01 sends one standard-4 chunk_encode per frozen encode window, on the clip it lies in, with the frozen profile", async () => {
    const value = fade();
    serve(plan(value));
    const completion = await drive();
    expect(h.removal).not.toHaveBeenCalled();
    for (const [k, window] of value.layout.encode.entries()) {
      const request = requestOf(encId(k));
      const recipe = recipeOf(request);
      expect({ containerClass: request.containerClass, kind: recipe.kind, profile: recipe.profile, frames: recipe.frames })
        .toEqual({ containerClass: "MiniToolContainerStd4", kind: "chunk_encode", profile: value.profile, frames: { start: window.start, end: window.end } });
      // Encode chunks before the window lie in the first clip, the others in the second.
      expect(bound(request, recipe.inputId)).toBe(window.end <= value.timeline.window!.startFrame ? A.key : B.key);
    }
    expect(statuses(completion)).toEqual(["registered"]);
    expect(completion!.error).toBeNull();
  });

  it("TW02 sends one MiniToolContainerGl transition_window per frozen window chunk, binding both clips in timeline order", async () => {
    const value = fade();
    serve(plan(value));
    await drive();
    expect(h.removal).not.toHaveBeenCalled();
    for (const [k, frames] of value.layout.window.entries()) {
      const request = requestOf(winId(k));
      const recipe = recipeOf(request);
      expect(request.containerClass).toBe("MiniToolContainerGl");
      expect(recipe).toMatchObject({ kind: "transition_window", frames, window: { startFrame: 71, frameCount: 25 }, transition: "fade", profile: value.profile });
      expect((recipe.clips as { inputId: string }[]).map((clip) => bound(request, clip.inputId))).toEqual([A.key, B.key]);
    }
  });

  it("TW03 then exactly one standard-4 stitch binds every chunk in output-frame order, both clips' audio and the crossfade window", async () => {
    const value = fade();
    serve(plan(value));
    const completion = await drive();
    expect(h.removal).not.toHaveBeenCalled();
    expect(sent().filter((request) => request.jobId.includes(":stitch:")).map((request) => request.jobId)).toEqual([STITCH]);
    const request = requestOf(STITCH);
    const recipe = recipeOf(request);
    expect(request.containerClass).toBe("MiniToolContainerStd4");
    expect(recipe).toMatchObject({ kind: "stitch", crossfade: { startFrame: 71, frameCount: 25 }, profile: value.profile });
    const clips = recipe.clips as { inputId: string; audio: unknown }[];
    expect(clips.map((clip) => bound(request, clip.inputId))).toEqual([A.key, B.key]);
    // Both fixtures carry an audio track.
    expect(clips.every((clip) => clip.audio !== null && typeof clip.audio === "object")).toBe(true);
    // The chunks in output-frame order: three encode chunks of the first clip, the two window chunks, three of the second.
    const order = [...value.layout.encode.map((window, k) => ({ start: window.start, id: encId(k) })), ...value.layout.window.map((window, k) => ({ start: window.start, id: winId(k) }))]
      .sort((left, right) => left.start - right.start);
    expect((recipe.chunks as { inputId: string }[]).map((chunk) => bound(request, chunk.inputId))).toEqual(order.map(({ id }) => requestOf(id).outputs[0]!.storageKey));
    expect(statuses(completion)).toEqual(["registered"]);
  });

  it("TW03e a stitch failing on every frozen attempt fails the output with its reason, each attempt retiring the chunks it binds once done", async () => {
    serve(plan(fade()));
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const job = await advance(input);
      return { ...job, report: { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } }, assets: [] };
    });
    const completion = await drive();
    expect(sent().filter((request) => request.jobId.includes(":stitch:")).map((request) => request.jobId)).toEqual([1, 2, 3].map((attempt) => `${TASK}:out:0:stitch:a${attempt}`));
    const keys = requestOf(STITCH).inputs.filter((input) => input.inputId.includes("-8001-")).map((input) => input.storageKey);
    expect(h.advance.mock.calls.map((call) => new Set((call[1] as { retire: string[] }).retire))).toEqual([1, 2, 3].map(() => new Set(keys)));
    expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "mini_tool_failed", message: "tool_failed" } });
  });

  // A done chunk is pinned with the run (the model-step rule, model-run-steps.ts advanceContainer), so a run that fails after
  // it still hands it to reclaim at the terminal release; the stitch's retire leaves it to that release.
  it("TW03b every done encode and window chunk is pinned with the run when its result is recorded", async () => {
    const value = fade();
    serve(plan(value));
    await drive();
    const done = h.record.mock.calls.map((call) => call[0] as { outcome: string; stepId: string; presentation?: unknown }).filter((entry) => entry.outcome === "done");
    const ids = [...value.layout.encode.map((_window, k) => encId(k)), ...value.layout.window.map((_window, k) => winId(k))];
    expect(done.map((entry) => entry.presentation)).toEqual(ids.map((id) => ({ pin: [requestOf(id).outputs[0]!.storageKey] })));
  });

  // Design §5.4: a stage's jobs run in parallel up to its frozen count, so a running chunk holds back no other chunk or window.
  it("TW03c a running encode chunk holds back no other chunk or window: every one is submitted in the same pickup", async () => {
    const value = fade();
    serve(plan(value));
    const running = encId(0);
    h.advancePlan.mockImplementation(async (request: MiniToolPlanJobRequest) => {
      if (request.jobId === running) throw new StillRunning(Date.now() + 5000);
      return advancePlan(request);
    });
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    const opened = h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId);
    expect(opened).toEqual(expect.arrayContaining([...value.layout.encode.map((_window, k) => encId(k)), ...value.layout.window.map((_window, k) => winId(k))]));
  });

  it("TW03d a chunk failed for good waits for a running chunk, whose object is pinned, and no chunk opens a next attempt after it", async () => {
    const value = fade();
    serve(plan(value));
    const at = (id: string, attempt: number): string => id.replace(/:a1$/, `:a${attempt}`);
    const states = new Map<string, "running" | "failed">([[encId(0), "running"], [encId(1), "running"], [winId(0), "running"]]);
    h.advancePlan.mockImplementation(async (request: MiniToolPlanJobRequest) => {
      const state = states.get(request.jobId);
      if (state === "running") throw new StillRunning(Date.now() + 5000);
      if (state === "failed") return { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } };
      return advancePlan(request);
    });
    const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    // Encode chunk 0 fails on every attempt and window chunk 0's first attempt fails, while encode chunk 1 still runs.
    for (const attempt of [1, 2, 3]) states.set(at(encId(0), attempt), "failed");
    states.set(winId(0), "failed");
    await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
    expect(h.finish).not.toHaveBeenCalled();
    states.delete(encId(1));
    const completion = await drive();
    expect(statuses(completion)).toEqual(["failed"]);
    const opened = h.openPlan.mock.calls.map((call) => (call[0] as OpenMiniToolPlanJobInput).request.jobId);
    expect(opened).not.toContain(at(winId(0), 2));
    const done = h.record.mock.calls.map((call) => call[0] as { outcome: string; presentation?: unknown; stepId: string })
      .filter((entry) => entry.outcome === "done" && steps.find((step) => step.id === entry.stepId)?.output.miniToolPlanJob !== undefined
        && (steps.find((step) => step.id === entry.stepId)!.output.miniToolPlanJob as MiniToolPlanJobRequest).jobId === encId(1));
    expect(done.map((entry) => entry.presentation)).toEqual([{ pin: [requestOf(encId(1)).outputs[0]!.storageKey] }]);
    expect(h.advance).not.toHaveBeenCalled();
  });

  // A step whose next attempt is due after the deadline expires the output as the run's own expiry does (code "expired").
  it("TW05 a chunk ingest expired at the deadline, its next attempt due after it, ends the output expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(DEADLINE - 60_000);
      serve(plan(fade()));
      let expired = false;
      h.advancePlan.mockImplementation(async (request: MiniToolPlanJobRequest) => {
        if (request.jobId !== encId(0)) return advancePlan(request);
        if (!expired) throw new StillRunning(Date.now() + 5000);
        // Ingest ends a job it expires at its deadline as failed with reason expired.
        return { schemaVersion: 2, state: "failed", reason: "expired", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } };
      });
      const job = { id: "queue-job", data: { taskId: TASK, source: "mini_tool", executionKind: "planned" }, attemptsMade: 0, stalledCounter: 0, moveToDelayed: vi.fn() };
      await expect(runMiniToolExecutionTask(job as unknown as Job<MiniToolExecutionJob>)).rejects.toBeInstanceOf(StillRunning);
      expired = true;
      vi.setSystemTime(DEADLINE + 1);
      const completion = await drive();
      expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "expired" } });
      expect(completion!.error).toEqual({ code: "expired" });
      expect(sent().map((request) => request.jobId)).not.toContain(encId(0).replace(/:a1$/, ":a2"));
    } finally { vi.useRealTimers(); }
  });

  it("TW06 a stitch whose next attempt is due after the deadline ends the output expired and opens no next stitch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(DEADLINE - 60_000);
      serve(plan(fade()));
      h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
        const job = await advance(input);
        // The stitch's first attempt ends at the deadline.
        vi.setSystemTime(DEADLINE + 1);
        return { ...job, report: { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: [], usage: { wallMs: 1000, cpuUsec: 2000000 } }, assets: [] };
      });
      const completion = await drive();
      expect(completion!.outputs[0]!.result).toEqual({ status: "failed", error: { code: "expired" } });
      expect(h.advance).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("TW04 sends in each stage exactly the frozen stageJobs distinct jobs and no other job", async () => {
    const value = fade();
    serve(plan(value));
    await drive();
    expect(h.removal).not.toHaveBeenCalled();
    const ids = sent().map((request) => request.jobId.replace(/:a\d+$/, ""));
    expect(new Set(ids).size).toBe(ids.length);
    const encode = ids.filter((id) => /:out:0:(enc|win):\d+$/.test(id));
    const stitch = ids.filter((id) => id.endsWith(":out:0:stitch"));
    expect([{ stage: "encode", jobs: encode.length }, { stage: "stitch", jobs: stitch.length }]).toEqual(plannedStageJobs(value.layout));
    expect(ids).toHaveLength(encode.length + stitch.length);
  });
});

// §97 D23-3 (frames-split §5.4 预算 row: 各阶段的块数与块边界在受理事务里算出并冻结进计划，worker按冻结结果派发，不再重新切块): the
// worker may rebuild the timeline from the frozen draft and fps, but every chunk boundary comes from the frozen layout.
describe("the frozen chunk boundaries are dispatched as they are (§97 D23-3)", () => {
  // A valid partition of the fade's [0, 167) that no even split by one target gives: uneven encode chunks on both sides
  // and the window [71, 96) split at frame 90.
  const FROZEN = { encode: [{ start: 0, end: 10 }, { start: 10, end: 71 }, { start: 96, end: 100 }, { start: 100, end: 167 }], window: [{ start: 71, end: 90 }, { start: 90, end: 96 }] };

  it("TB00 the frozen layout partitions the timeline and differs from every single-target plan", () => {
    const value = run({ kind: "fade", duration: 1 }, B, 3.84, 24);
    const all = [...FROZEN.encode, ...FROZEN.window].sort((left, right) => left.start - right.start);
    expect(all.every((window, at) => window.start === (at === 0 ? 0 : all[at - 1]!.end))).toBe(true);
    expect(all.at(-1)!.end).toBe(value.timeline.frameCount);
    for (let target = 1; target <= value.timeline.frameCount; target += 1) expect(planTransitionChunks(value.timeline, { targetSeconds: target, frameSeconds: () => 1 })).not.toEqual(FROZEN);
  });

  it("TB01 every chunk_encode and transition_window covers exactly one frozen window, and the stitch binds them in output order", async () => {
    const value = { ...run({ kind: "fade", duration: 1 }, B, 3.84, 24), layout: FROZEN };
    serve(plan(value));
    const completion = await drive();
    expect(h.removal).not.toHaveBeenCalled();
    const second = value.timeline.clips[1]!;
    for (const [k, window] of FROZEN.encode.entries()) {
      const request = requestOf(encId(k));
      const recipe = recipeOf(request);
      const onFirst = window.end <= value.timeline.window!.startFrame;
      expect(bound(request, recipe.inputId)).toBe(onFirst ? A.key : B.key);
      // Both clips present at the output's 25 fps from their in point 0: output frame k is the first clip's presentation
      // frame k and the second clip's frame k − its start frame.
      const offset = onFirst ? 0 : second.startFrame - second.inFrame;
      expect(recipe.window).toEqual({ start: window.start - offset, end: window.end - offset });
      expect(recipe.frames).toEqual({ start: window.start, end: window.end });
    }
    for (const [k, frames] of FROZEN.window.entries()) {
      expect(recipeOf(requestOf(winId(k)))).toMatchObject({ kind: "transition_window", frames, window: { startFrame: 71, frameCount: 25 } });
    }
    const sentIds = sent().map((request) => request.jobId);
    expect(sentIds.filter((id) => /:out:0:(enc|win):/.test(id)).sort())
      .toEqual([...FROZEN.encode.map((_, k) => encId(k)), ...FROZEN.window.map((_, k) => winId(k))].sort());
    const order = [...FROZEN.encode.map((window, k) => ({ start: window.start, id: encId(k) })), ...FROZEN.window.map((window, k) => ({ start: window.start, id: winId(k) }))]
      .sort((left, right) => left.start - right.start);
    const stitch = requestOf(STITCH);
    expect((recipeOf(stitch).chunks as { inputId: string }[]).map((chunk) => bound(stitch, chunk.inputId))).toEqual(order.map(({ id }) => requestOf(id).outputs[0]!.storageKey));
    expect(statuses(completion)).toEqual(["registered"]);
  });
});

// frames-split §7.17 transition output profile row (每段从输出帧k取覆盖该时刻的源呈现帧) and §5.4 chunking row: a chunk's frames are the output
// slots k0..k1-1, so its picture starts at slot k0's time in the clip, which can fall inside a source frame.
describe("a chunk starts at its first output slot's time in the clip (§7.17 transition output profile row; §5.4 chunking row)", () => {
  // The cut fixture presents frame i (i ≥ 1) over [0.04i − 0.02, 0.04i + 0.02) s, so every 25 fps output slot of it falls
  // in the middle of a source frame. The second clip starts at output frame 96 and is split at 110.
  const FROZEN = { encode: [{ start: 0, end: 96 }, { start: 96, end: 110 }, { start: 110, end: 133 }], window: [] };

  it("TS01 each chunk of the second clip opens on the frame covering its first slot's time, shown from that time", async () => {
    const value = { ...run({ kind: "cut", duration: 0 }, SILENT, 1.48, 48), layout: FROZEN };
    serve(plan(value));
    await drive();
    const second = value.timeline.clips[1]!;
    const seconds = (time: { numerator: string; denominator: string }): number => Number(time.numerator) / Number(time.denominator);
    for (const [k, window] of FROZEN.encode.entries()) {
      if (window.end <= second.startFrame) continue;
      const recipe = recipeOf(requestOf(encId(k)));
      const slot = (window.start - second.startFrame + second.inFrame) / 25;
      // Frame 0 is [0, 0.02) s; frame i ≥ 1 starts at 0.04i − 0.02.
      const covering = slot < 0.02 ? 0 : Math.floor((slot + 0.02) / 0.04 + 1e-9);
      expect((recipe.window as FrameWindow).start, `chunk ${k}`).toBe(covering);
      const [first] = recipe.entries as { kind: string; displayStart: { numerator: string; denominator: string }; clipStart: { numerator: string; denominator: string } }[];
      expect(seconds(first!.displayStart), `chunk ${k} display start`).toBeCloseTo(slot, 9);
      // The one edit shows media from 0.1 s at presentation 0.
      expect(seconds(first!.clipStart), `chunk ${k} clip start`).toBeCloseTo(slot + 0.1, 9);
    }
  });
});

describe("each clip sits in its fitted rectangle in every chunk (§7.17; the preview's contain)", () => {
  it("TF01 a 160x96 clip after a 320x180 one is contained at 300x180 from x 10 in its encode chunks; the first fills the frame", async () => {
    const value = { ...run({ kind: "cut", duration: 0 }, SILENT, 1.48, 48), layout: { encode: [{ start: 0, end: 96 }, { start: 96, end: 133 }], window: [] } };
    serve(plan(value));
    await drive();
    expect((recipeOf(requestOf(encId(0))).target as { displayRect: unknown }).displayRect).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    expect((recipeOf(requestOf(encId(1))).target as { displayRect: unknown }).displayRect).toEqual({ x: 10, y: 0, width: 300, height: 180 });
  });

  it("TF02 a window chunk gives each clip the rectangle its encode chunks use", async () => {
    const value = run({ kind: "fade", duration: 1 }, B, 3.84, 24);
    serve(plan(value));
    await drive();
    for (const [k] of value.layout.window.entries()) {
      expect((recipeOf(requestOf(winId(k))).clips as { fit: unknown }[]).map((clip) => clip.fit)).toEqual([{ x: 0, y: 0, width: 320, height: 180 }, { x: 0, y: 0, width: 320, height: 180 }]);
    }
  });
});

describe("a Cut transition (§5.4 派发: 转场选「直接切换」时不派 transition_window; §97 D23)", () => {
  // The current video, a Cut, then 1.48 s (37 frames) of a source without audio; chunks of at most 48 frames.
  const cut = (): Run => run({ kind: "cut", duration: 0 }, SILENT, 1.48, 48);

  it("TC00 the fixture has no window and three encode chunks", () => {
    const value = cut();
    expect(value.timeline.window).toBeNull();
    expect(value.layout).toEqual({ encode: [{ start: 0, end: 48 }, { start: 48, end: 96 }, { start: 96, end: 133 }], window: [] });
  });

  it("TC01 sends no transition_window and nothing to MiniToolContainerGl; the stitch has no crossfade and an audio entry for every clip, the silent source's included", async () => {
    const value = cut();
    serve(plan(value));
    const completion = await drive();
    expect(h.removal).not.toHaveBeenCalled();
    expect(sent().filter((request) => request.jobId.includes(":win:") || request.containerClass === "MiniToolContainerGl"
      || request.outputs.some((output) => (output.recipe as unknown as Recipe).kind === "transition_window"))).toEqual([]);
    expect(sent().map((request) => request.jobId).sort()).toEqual([encId(0), encId(1), encId(2), STITCH].sort());
    const request = requestOf(STITCH);
    const recipe = recipeOf(request);
    expect(recipe).toMatchObject({ kind: "stitch", crossfade: null, profile: value.profile });
    const clips = recipe.clips as { inputId: string; audio: unknown }[];
    expect(clips.map((clip) => bound(request, clip.inputId))).toEqual([A.key, SILENT.key]);
    // The plan cannot tell a silent source from one with audio (`audioSpans: null` is ambiguous), so the stitch names both
    // clips' audio and the container reads the real file, filling silence where it has no audio track.
    expect(clips.every((clip) => clip.audio !== null && typeof clip.audio === "object")).toBe(true);
    // Each clip's audio covers exactly the time its output frames show (frames-split §7.17 stitch row), so the second clip's
    // sound starts with its picture; the silent source's 38 frames over 1.5 s do not end on the 25 fps grid at 1.48 s.
    for (const { audio, video } of audioAgainstVideo(value, clips)) {
      expect(audio[0]).toBeCloseTo(video[0], 9);
      expect(audio[1]).toBeCloseTo(video[1], 9);
    }
    expect(statuses(completion)).toEqual(["registered"]);
  });
});
