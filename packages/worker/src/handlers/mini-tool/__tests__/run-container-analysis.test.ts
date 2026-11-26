// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The scene analysis runner (O-* oracle ids below; inner#1306 test plan §67.2 A03, §67.3 W01; frames-split design §7.16,
 * §7.17 「唯一写点：worker的配方构造」 and scene_cuts rows): the runner reads the frozen version's grid, tool source and source
 * keyframe statistics and writes the job recipe on them; there is no inspect_video output, and scene cuts come back as grid
 * frame numbers. The job is opened with the payer the analysis froze. The recipe reads the plan colour the frozen version
 * carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import type { OpenMiniToolPlanJobInput, miniToolAnalysisService } from "@breatic/domain";
import { DeadlinePassed, DEFAULT_TIMEOUT_MS, miniToolPlanJobRequestSchema, type MiniToolPlanJobRequest, type StudioAssetEntity } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import type { RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { sceneCutsRecipeOf, toolInputOf } from "@worker/handlers/video-presentation-recipes.js";
import { frozenVersion } from "./frozen-presentation.js";
import { StillRunning } from "@worker/handlers/still-running.js";
import { runMiniToolContainerAnalysis } from "../run-container-analysis.js";

const h = vi.hoisted(() => ({ config: vi.fn(), list: vi.fn(), ensure: vi.fn(), inline: vi.fn(), grants: vi.fn(),
  advance: vi.fn(), read: vi.fn(), finish: vi.fn(), charge: vi.fn(),
  // Every application-layer catch logs (root AGENTS.md).
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@breatic/core", async (original) => ({ ...await original<typeof coreModule>(), getMiniToolsConfig: h.config,
  logger: h.logger as unknown as typeof coreModule.logger }));
vi.mock("@breatic/domain", async (original) => {
  const actual = await original<typeof domainModule>();
  return { ...actual, openContainerOutputs: h.grants, settleMiniToolCharge: h.charge,
    miniToolAnalysisService: { ...actual.miniToolAnalysisService, finishMiniToolAnalysis: h.finish },
    upstreamStepRepo: { ...actual.upstreamStepRepo, listSteps: h.list, ensureSteps: h.ensure, recordInline: h.inline } };
});
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", async (original) => ({ ...await original<Record<string, unknown>>(), advanceRegisteredMiniToolPlanJob: h.advance }));
vi.mock("@worker/handlers/mini-tool/read-analysis-json.js", () => ({ readMiniToolAnalysisJson: h.read }));

const TASK = "10000000-0000-4000-8000-000000000001";
const SOURCE = "20000000-0000-4000-8000-000000000001";
const PROJECT = "30000000-0000-4000-8000-000000000001";
const SPACE = "40000000-0000-4000-8000-000000000001";
const HOST = "50000000-0000-4000-8000-000000000001";
const USER = "60000000-0000-4000-8000-000000000001";
const SOURCE_KEY = "original/sql-owned-source.mp4";
const DEADLINE = 1792927200000;
/**
 * A read of a registered result is bounded by the reporting window (two 5 s polls past D) or the transport's own bound,
 * whichever ends later, and is never refused at D (planReadUntil).
 * @param now - The clock when the read starts.
 * @returns The read's absolute bound.
 */
const readUntil = (now: number = Date.now()): number => Math.max(DEADLINE + 2 * 5000, now + DEFAULT_TIMEOUT_MS);
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
// The frozen version: 320x180, 25 fps, 96 grid frames, read from its original; a case may freeze another display.
let version = frozenVersion();
/** The frozen tool input of the analysis: presentation ref, selected version and payer. @returns It. */
function frozenPresentation(): Record<string, unknown> {
  return { presentationRef: { source: { toolInputId: version.toolInputId, planSha256: version.planSha256 } }, presentations: { source: version },
    versionIds: { source: version.versionId }, chargeTo: "user" };
}
// The scanned scene range is grid frames [48, 96), the display end.
const SCENE_RANGE = { start: 48, end: 96 };
// Design §7.17 scene_cuts row 「切点按网格帧号记录」: the container records each cut by its grid frame number.
const scenes = { schemaVersion: 1, kind: "scene_cuts", cuts: [{ frameIndex: 60, detectionScore: 85 }] };
type Execution = miniToolAnalysisService.MiniToolAnalysisExecution;
type Step = Awaited<ReturnType<typeof domainModule.upstreamStepRepo.listSteps>>[number];
type StepPlan = Parameters<typeof domainModule.upstreamStepRepo.ensureSteps>[1];
type GrantInput = Parameters<typeof domainModule.openContainerOutputs>[0];
let steps: Step[];
let payload: unknown;
let grantSequence: number;

/** Construct a valid SQL-owned execution using the independent scene source clock. @returns The accepted execution. */
function execution(kind: "scene_cuts" = "scene_cuts", range: { start: number; end: number } = SCENE_RANGE): Execution {
  const profile = { id: `original-${kind}-profile`, version: "original-version", weightsHash: null, params: { threshold: 27 } };
  const input = { schemaVersion: 1, kind, sourceURL: "https://assets.test.invalid/original.mp4", profile, range };
  const presented = frozenPresentation();
  const record = miniToolAnalysisRecordSchema.parse({ schemaVersion: 1, draftId: "70000000-0000-4000-8000-000000000001",
    revision: "80000000-0000-4000-8000-000000000001", analysisRunId: TASK, acceptedAt: "2026-10-25T01:02:03.123456Z", kind,
    inputFingerprint: "a".repeat(64), analysisInput: input, binding: { assetId: SOURCE, contentHash: version.sourceFingerprint,
      canonicalURL: input.sourceURL, kind: "video", mediaInfo: { width: 400, height: 200, duration: 36, mimeType: "video/mp4" } },
    status: "running", result: null, error: null, usage: [], artifactUnavailable: false });
  return { record, context: { taskId: TASK, userId: USER, projectId: PROJECT, spaceId: SPACE, hostNodeId: HOST },
    params: { sourceKey: SOURCE_KEY, credits: 0, requestFingerprint: "c".repeat(64), analysis: {
      schemaVersion: 1, analysisRunId: TASK, projectId: PROJECT, spaceId: SPACE, hostNodeId: HOST, draftId: record.draftId,
      revision: record.revision, kind, binding: record.binding, analysisInput: record.analysisInput, inputFingerprint: record.inputFingerprint,
      source: { nodeId: HOST, canonicalURL: record.binding.canonicalURL, mediaInfo: record.binding.mediaInfo },
      ...presented,
    } } } as Execution;
}

/** Build the canonical row for a written output without claiming a real media execution. @returns The registered fixture row. */
function asset(outputIndex: number, image: boolean, width: number | null = null, height: number | null = null): StudioAssetEntity {
  return { id: `${image ? "a" : "9"}0000000-0000-4000-8000-${String(outputIndex + 1).padStart(12, "0")}`, studioId: "b0000000-0000-4000-8000-000000000001",
    contentHash: String(outputIndex + 1).padStart(64, "0"), storageKey: `canonical-winner/${image ? "image" : "json"}-${outputIndex}`,
    fileUrl: `https://assets.test.invalid/canonical-winner/${image ? "image" : "json"}-${outputIndex}`, sizeBytes: 100 + outputIndex,
    mimeType: image ? "image/png" : "text/plain", kind: image ? "image" : "document", source: "upload", producedByUserId: USER,
    generationTaskId: null, width, height, durationSeconds: null, createdAt: new Date("2026-10-24T00:00:00Z"), deletedAt: null };
}

/** Return measured and canonical IO fixture facts; the domain assemblers remain real. @returns The original planned job wrapper. */
function registered(request: MiniToolPlanJobRequest): RegisteredMiniToolPlanJob {
  const assets = request.outputs.map((output) => {
    const crop = output.recipe.kind === "frame" ? output.recipe.crop : undefined;
    return { outputIndex: output.outputIndex, asset: asset(output.outputIndex, crop !== undefined, crop?.rect.width ?? null, crop?.rect.height ?? null) };
  });
  return { request, assets: assets.slice().reverse(), report: { schemaVersion: 2, state: "done", usage: { wallMs: 1250, cpuUsec: 123456 },
    outputs: request.outputs.map((output, index) => ({ outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: assets[index]!.asset.contentHash,
      sizeBytes: assets[index]!.asset.sizeBytes, contentType: output.contentType, width: assets[index]!.asset.width, height: assets[index]!.asset.height,
      durationSeconds: null, cover: null, upright: null })).reverse() } };
}


beforeEach(() => {
  vi.resetAllMocks(); steps = []; grantSequence = 0; payload = structuredClone(scenes);
  version = frozenVersion();
  vi.spyOn(Date, "now").mockReturnValue(DEADLINE - 60000);
  h.config.mockReturnValue({ plan_limits: LIMITS, poll_interval_ms: 5000, analyses: {
    scene_cuts: { container_class: "MiniToolContainerStd1" },
  } });
  h.list.mockImplementation(async () => steps);
  h.ensure.mockImplementation(async (_taskId: string, plan: StepPlan) => {
    for (const [position, planned] of plan.entries()) {
      if (!steps.some((step) => step.position === position)) steps.push({ ...planned, position,
        id: `c0000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`, status: "pending", predictionId: null, output: {}, inlineCostUsd: 0 });
    }
    return steps;
  });
  h.inline.mockImplementation(async (stepId: string, values: Record<string, unknown>) => {
    const step = steps.find((item) => item.id === stepId);
    if (step === undefined) throw new Error("Fixture lost its persisted step");
    step.output = { ...step.output, ...structuredClone(values) };
  });
  h.grants.mockImplementation(async (input: GrantInput) => {
    const sequence = grantSequence++;
    return input.outputs.map((output, index) => ({ storageKey: `derived/grant-${sequence}/${index}.${output.modality === "text" ? "txt" : "png"}`,
      contentType: output.modality === "text" ? "text/plain" : "image/png" }));
  });
  h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
    const step = steps.find((item) => item.id === input.stepId);
    if (step === undefined) throw new Error("Fixture advance lost its original step");
    const request = step.output.miniToolPlanJob === undefined ? input.request : miniToolPlanJobRequestSchema.parse(step.output.miniToolPlanJob);
    if (step.endpoint !== request.containerClass) throw new Error("Fixture preserves the original plan owner class fence");
    const ended = registered(request);
    step.output = { ...step.output, miniToolPlanJob: structuredClone(request),
      ...Object.fromEntries(ended.assets.map((entry) => [`miniToolAsset:${entry.outputIndex}`, entry.asset.id])) };
    return ended;
  });
  h.read.mockImplementation(async (assetId: string) => {
    const index = assetId === asset(1, false).id ? 1 : 0;
    return { asset: asset(index, false), json: structuredClone(payload) };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * Today's configuration on a replay: the run class and limits come from the stored request, so reading them throws.
 * @param message - The thrown message.
 * @returns The configuration double.
 */
function replayConfig(message: string): Record<string, unknown> {
  return { poll_interval_ms: 5000, get plan_limits(): never { throw new Error(message); }, get analyses(): never { throw new Error(message); } };
}

/** Make the original initial request independently from the new orchestration. @returns The stored first plan. */
function initialRequest(original: Execution = execution()): MiniToolPlanJobRequest {
  const input = original.record.analysisInput;
  // Design §7.17 scene_cuts row, 「去掉inspect_video步骤」: one scene_cuts output on the range's grid frames, no inspect_video.
  const outputs: MiniToolPlanJobRequest["outputs"] = [
    { outputIndex: 0, storageKey: "persisted/scenes.txt", contentType: "text/plain", recipe: sceneCutsRecipeOf(version, toolInputOf(version, SOURCE_KEY, SOURCE), input.range, input.profile) },
  ];
  return { schemaVersion: 2, jobId: `task:${original.context.taskId}/chunk:0`, containerClass: "MiniToolContainerStd1", deadlineAt: DEADLINE,
    limits: structuredClone(LIMITS), inputs: [{ inputId: SOURCE, storageKey: SOURCE_KEY }], outputs };
}

/** Restore one original task step with its first plan and optional initial JSON values. @returns The owned fixture step. */
function storedStep(request: MiniToolPlanJobRequest, position: number, json: Record<string, unknown> = {}): Step {
  const ended = registered(request);
  const step: Step = { id: `c0000000-0000-4000-8000-${String(position + 1).padStart(12, "0")}`, kind: "container_job", endpoint: request.containerClass,
    position, itemIndex: position, status: "done", predictionId: null, inlineCostUsd: 0, output: { miniToolPlanJob: structuredClone(request),
      miniToolConsumption: { marker: "original-policy-and-usage" }, sibling: "original-sibling",
      ...Object.fromEntries(ended.assets.map((entry) => [`miniToolAsset:${entry.outputIndex}`, entry.asset.id])), ...structuredClone(json) } };
  steps.push(step); return step;
}

/** Retain the complete original accepted scene identity and nonlinear source clock. @returns The exact scene expected value. */
function expectedScene(original: Execution): Extract<MiniToolAnalysisResult, { kind: "scene_cuts" }> {
  const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = original.record;
  // The version's grid: 25 fps, 96 frames; the cut keeps its grid frame number.
  return { ...identity, kind: "scene_cuts", fps: { numerator: 25, denominator: 1 }, frameCount: 96, cuts: [{ frameIndex: 60, detectionScore: 85 }] };
}

// O-A1/A2/A4, O-S1/S3, O-P1 and O-F1/F2: IO is mocked; both domain assemblers stay real.
describe("accepted container analysis orchestration", () => {
  // Design §7.17 scene_cuts row 「去掉inspect_video步骤」, 「唯一写点：worker的配方构造」: the one job carries a single scene_cuts
  // output on the range's grid frames; its cuts are grid frame numbers.
  it("AR01 runs one user-funded scene_cuts output on the frozen grid, no inspect_video, cuts on grid frame numbers", async () => {
    const original = execution("scene_cuts"); payload = structuredClone(scenes);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    expect(h.grants).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: PROJECT, actingUserId: USER, taskId: TASK, deadlineAt: DEADLINE,
      outputs: [expect.objectContaining({ modality: "text" })] }));
    const call: OpenMiniToolPlanJobInput = h.advance.mock.calls[0]![0];
    expect(call).toEqual({ taskId: TASK, stepId: steps[0]!.id, chunkIndex: 0, chargeTo: "user", request: { ...initialRequest(original),
      outputs: initialRequest(original).outputs.map((output, index) => ({ ...output, storageKey: `derived/grant-0/${index}.txt` })) } });
    // The job is the scan alone: one scene_cuts output and no separate inspection output beside it.
    expect(call.request.outputs.map((output) => output.recipe.kind)).toEqual(["scene_cuts"]);
    expect(h.advance).toHaveBeenCalledTimes(1);
    expect(h.read.mock.calls).toEqual([[asset(0, false).id, readUntil()]]);
    expect(steps[0]!.output).toMatchObject({ "miniToolAnalysisJson:0": scenes });
    expect(h.finish).not.toHaveBeenCalled(); expect(h.charge).not.toHaveBeenCalled();
  });

  it("retains an empty scene result without creating media or split outputs", async () => {
    const original = execution("scene_cuts"); payload = { ...scenes, cuts: [] };
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual({ ...expectedScene(original), cuts: [] });
    expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).toHaveBeenCalledTimes(1);
  });
});

// O-A7/A13, O-C1–C4/C12: caches belong to the complete stored initial step, not the current configuration.
describe("original request and JSON cache recovery", () => {
  it("replays stored scene requests and caches without reading current configuration or opening grants", async () => {
    const original = execution("scene_cuts"); const request = initialRequest(original);
    const step = storedStep(request, 0, { "miniToolAnalysisJson:0": scenes });
    h.config.mockReturnValue(replayConfig("Replay must not read changed configuration"));
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    expect(h.advance).toHaveBeenCalledExactlyOnceWith({ taskId: TASK, stepId: step.id, chunkIndex: 0, chargeTo: "user", request });
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(step.output).toMatchObject({ miniToolPlanJob: request, "miniToolAnalysisJson:0": scenes, miniToolConsumption: { marker: "original-policy-and-usage" } });
  });

  it("reads and stores the missing scene JSON of a stored plan by its canonical output index", async () => {
    const original = execution("scene_cuts"); const request = initialRequest(original); payload = structuredClone(scenes);
    const step = storedStep(request, 0);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    expect(h.read).toHaveBeenCalledExactlyOnceWith(asset(0, false).id, readUntil());
    expect(h.inline).toHaveBeenCalledWith(step.id, { "miniToolAnalysisJson:0": scenes }, 0);
    expect(step.output).toMatchObject({ miniToolPlanJob: request, "miniToolAnalysisJson:0": scenes,
      miniToolConsumption: { marker: "original-policy-and-usage" }, sibling: "original-sibling" });
  });

  it("keeps the stored scene plan after a read failure and rereads only its canonical object", async () => {
    const original = execution("scene_cuts"); payload = structuredClone(scenes);
    const normal = h.read.getMockImplementation()!; const error = new TypeError("scene JSON connection dropped");
    h.read.mockImplementation(async () => { throw error; });
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBe(error);
    const request = structuredClone(steps[0]!.output.miniToolPlanJob);
    h.read.mockClear(); h.read.mockImplementation(normal); h.grants.mockClear();
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    expect(h.read).toHaveBeenCalledExactlyOnceWith(asset(0, false).id, readUntil());
    expect(h.grants).not.toHaveBeenCalled(); expect(steps[0]!.output.miniToolPlanJob).toEqual(request);
  });

});

// O-C6–C10/O-D5–D7: report grace never renews computation or uncached JSON reads.
describe("unchanged deadline and late pure assembly", () => {
  it.each([DEADLINE, DEADLINE + 1])("refuses new grants at or beyond the original deadline %s", async (now) => {
    vi.mocked(Date.now).mockReturnValue(now);
    await expect(runMiniToolContainerAnalysis(execution(), DEADLINE)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.grants).not.toHaveBeenCalled(); expect(h.advance).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

  // The step caches the scene JSON, so a complete run replayed after D reads nothing again (no new read after D).
  it("AR06 replays a completed scene result after the report window from its cached cuts, reading no JSON", async () => {
    const original = execution("scene_cuts"); payload = structuredClone(scenes);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    h.grants.mockClear(); h.read.mockClear();
    vi.mocked(Date.now).mockReturnValue(DEADLINE + 10001);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedScene(original));
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

});

// O-P6/P8/P9/P15 and O-S4/S5/S6: real domain parsers observe content and cross-artifact relationships.
describe("registered content and failure propagation", () => {

  // Cuts outside the scanned range or the grid, repeated frames, the presentation-ordinal and pts shapes are refused.
  it.each([
    { ...scenes, cuts: [{ frameIndex: 40, detectionScore: 85 }] }, { ...scenes, cuts: [{ frameIndex: 96, detectionScore: 85 }] },
    { ...scenes, cuts: [...scenes.cuts, ...scenes.cuts] }, { ...scenes, timeBase: "1/100" },
    { ...scenes, cuts: [{ frameIndex: 60, pts: 2.4, detectionScore: 85 }] }, { ...scenes, cuts: [{ ordinal: 60, detectionScore: 85 }] },
    { ...scenes, cuts: [{ frameIndex: 60, detectionScore: "85" }] },
  ])("does not turn conflicting scene observations into a complete result %j", async (json) => {
    payload = json;
    await expect(runMiniToolContainerAnalysis(execution("scene_cuts"), DEADLINE)).rejects.toThrow();
    expect(h.advance).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves a failed scene report rather than reinterpreting its complete=%s output set", async (complete) => {
    const original = execution("scene_cuts"); const request = initialRequest(original); storedStep(request, 0);
    const ended = registered(request); const subset = complete ? ended.report.outputs : [];
    const failed: RegisteredMiniToolPlanJob = { ...ended, report: { ...ended.report, state: "failed", reason: "tool_failed", outputs: subset },
      assets: complete ? ended.assets : ended.assets.filter((entry) => subset.some((output) => output.outputIndex === entry.outputIndex)) };
    const before = structuredClone(failed); h.advance.mockResolvedValue(failed);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toMatchObject({ name: "ContainerJobFailed", reason: "tool_failed" });
    expect(failed).toEqual(before); expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

  it("AR07 a scene job ingest ended at its deadline (reason expired) ends the analysis as expired, not as a job failure", async () => {
    const original = execution("scene_cuts"); const request = initialRequest(original); storedStep(request, 0);
    const ended = registered(request);
    h.advance.mockResolvedValue({ ...ended, report: { ...ended.report, state: "failed", reason: "expired", outputs: [] }, assets: [] });
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBeInstanceOf(DeadlinePassed);
  });

  it.each(["running", "repository", "grant", "registration", "JSON"])("preserves the original %s failure without finalization", async (stage) => {
    const original = execution(); const error = stage === "running" ? new StillRunning(DEADLINE - 1000) : new Error(`${stage} unavailable`);
    if (stage === "repository") h.ensure.mockRejectedValue(error);
    else if (stage === "grant") h.grants.mockRejectedValue(error);
    else if (stage === "JSON") h.read.mockRejectedValue(error);
    else h.advance.mockRejectedValue(error);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBe(error);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.charge).not.toHaveBeenCalled();
    if (stage === "running") { expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).toHaveBeenCalledTimes(1); }
  });

});
