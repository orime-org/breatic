// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The people and scene analysis runner (O-* oracle ids below; inner#1306 test plan §67.2 A03, §67.3 W01; frames-split design
 * §7.16, §7.17 「唯一写点：worker的配方构造」, people anchor and scene_cuts rows): the runner reads the frozen version's grid,
 * tool source and source keyframe statistics and writes the job recipes on them; there is no inspect_video output, and
 * scene cuts come back as grid frame numbers. The people anchor and its thumbnails read the original under the binding's
 * id, the source the domain people assembly checks. Each job is opened with the payer the analysis froze. The recipes read
 * the plan colour the frozen version carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as domainModule from "@breatic/domain";
import type * as coreModule from "@breatic/core";
import type { OpenMiniToolPlanJobInput, miniToolAnalysisService, MiniToolDisplayPeople } from "@breatic/domain";
import { DeadlinePassed, DEFAULT_TIMEOUT_MS, miniToolPlanJobRequestSchema, type MiniToolPlanJobRequest, type StudioAssetEntity } from "@breatic/shared";
import { miniToolAnalysisRecordSchema, type MiniToolAnalysisResult } from "@breatic/shared/mini-tools";
import type { RegisteredMiniToolPlanJob } from "@worker/handlers/mini-tool/registered-plan-job.js";
import { ContainerJobFailed } from "@worker/handlers/container/run-container-job.js";
import { frameTarget, originalInputOf, peopleRecipeOf, sceneCutsRecipeOf, toolInputOf } from "@worker/handlers/video-presentation-recipes.js";
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
vi.mock("@worker/handlers/mini-tool/registered-plan-job.js", () => ({ advanceRegisteredMiniToolPlanJob: h.advance }));
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
function frozenPresentation(kind: "people" | "scene_cuts"): Record<string, unknown> {
  return { presentationRef: { source: { toolInputId: version.toolInputId, planSha256: version.planSha256 } }, presentations: { source: version },
    versionIds: { source: version.versionId }, chargeTo: kind === "people" ? "platform" : "user" };
}
// The anchor is grid frame 48; the crops lie inside the 320x180 display.
const ANCHOR = { frameIndex: 48 };
/** Display people as the container writes them on an entry: no anchor echo (§93 D5-8). */
type Display = Omit<MiniToolDisplayPeople, "anchor">;
const people: Display = { schemaVersion: 1, kind: "people", coordinateSpace: "display",
  width: 320, height: 180, candidates: [
    { detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, pixelCrop: { x: 40, y: 20, width: 80, height: 60 } },
    { detectionIndex: 2, faceBox: { x: 0.5, y: 0.2, width: 0.1, height: 0.25 }, pixelCrop: { x: 200, y: 40, width: 40, height: 50 } },
    { detectionIndex: 5, faceBox: { x: 0.7, y: 0.5, width: 0.2, height: 0.3 }, pixelCrop: { x: 240, y: 100, width: 80, height: 60 } },
  ] };
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

/** Construct a valid SQL-owned execution using the independent people and scene source clocks. @returns The accepted execution. */
function execution(kind: "people" | "scene_cuts" = "people", range: { start: number; end: number } = SCENE_RANGE): Execution {
  const profile = { id: `original-${kind}-profile`, version: "original-version", weightsHash: null, params: { threshold: 27 } };
  const input = kind === "people" ? { schemaVersion: 1, kind, sourceURL: "https://assets.test.invalid/original.mp4", profile, anchor: ANCHOR }
    : { schemaVersion: 1, kind, sourceURL: "https://assets.test.invalid/original.mp4", profile, range };
  const presented = frozenPresentation(kind);
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

/** Project the independent oracle's canonical thumbnail facts. @returns The exact expected public people result. */
function expectedPeople(original: Execution, observations: Display = people): Extract<MiniToolAnalysisResult, { kind: "people" }> {
  const { status: _status, result: _result, error: _error, usage: _usage, artifactUnavailable: _unavailable, ...identity } = original.record;
  return { ...identity, kind: "people", anchor: ANCHOR, people: observations.candidates.map((candidate) => {
    const row = asset(candidate.detectionIndex, true, candidate.pixelCrop.width, candidate.pixelCrop.height);
    return { personId: `person:${original.record.analysisRunId}:${candidate.detectionIndex}`, faceBox: candidate.faceBox, artifactRefs: [{ role: "thumbnail", assetId: row.id,
      canonicalURL: row.fileUrl, contentHash: row.contentHash, kind: "image", mimeType: row.mimeType, size: row.sizeBytes, frameMetadata: null }] };
  }) };
}

beforeEach(() => {
  vi.resetAllMocks(); steps = []; grantSequence = 0; payload = structuredClone(people);
  version = frozenVersion();
  vi.spyOn(Date, "now").mockReturnValue(DEADLINE - 60000);
  h.config.mockReturnValue({ plan_limits: LIMITS, poll_interval_ms: 5000, analyses: {
    people: { container_class: "MiniToolContainerStd1" }, scene_cuts: { container_class: "MiniToolContainerStd1" },
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
  // Design §7.17 people anchor row, 「唯一写点：worker的配方构造」: the anchor is its grid frame of the original and the PNG target.
  // Design §7.17 scene_cuts row, 「去掉inspect_video步骤」: one scene_cuts output on the range's grid frames, no inspect_video.
  const outputs: MiniToolPlanJobRequest["outputs"] = input.kind === "people" ? [{ outputIndex: 0, storageKey: "persisted/people.txt", contentType: "text/plain",
    recipe: peopleRecipeOf(version, originalInputOf(version, SOURCE_KEY, SOURCE), input.anchor.frameIndex, input.profile) }]
    : input.kind === "scene_cuts" ? [
      { outputIndex: 0, storageKey: "persisted/scenes.txt", contentType: "text/plain", recipe: sceneCutsRecipeOf(version, toolInputOf(version, SOURCE_KEY, SOURCE), input.range, input.profile) },
    ] : [];
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

/** The golden thumbnail request consumes original display pixels without normalized inversion. @returns The stored thumbnail plan. */
function thumbnailRequest(candidates: Display["candidates"] = people.candidates, position = 1): MiniToolPlanJobRequest {
  // Design §7.17 「唯一写点：worker的配方构造」: each crop is the anchor's grid frame of the original and its PNG target, plus the
  // display crop the detector measured.
  const { grid, source } = originalInputOf(version, SOURCE_KEY, SOURCE);
  const { width, height } = version.display;
  return { ...initialRequest(), jobId: `task:${TASK}/chunk:${position}`, outputs: candidates.map((candidate) => ({
    outputIndex: candidate.detectionIndex, storageKey: `persisted/thumbnail-${candidate.detectionIndex}.png`, contentType: "image/png",
    recipe: { kind: "frame", inputId: SOURCE, grid, source, frameIndex: ANCHOR.frameIndex, target: frameTarget(version), crop: { sourceWidth: width, sourceHeight: height, rect: candidate.pixelCrop } },
  })) };
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

  it("AR02 executes display people0 then exact original pixel thumbnails with platform ownership", async () => {
    const original = execution();
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    expect(h.advance).toHaveBeenCalledTimes(2);
    const first: OpenMiniToolPlanJobInput = h.advance.mock.calls[0]![0];
    const second: OpenMiniToolPlanJobInput = h.advance.mock.calls[1]![0];
    expect(first).toEqual({ taskId: TASK, stepId: steps[0]!.id, chunkIndex: 0, chargeTo: "platform", request: {
      ...initialRequest(original), outputs: [{ ...initialRequest(original).outputs[0]!, storageKey: "derived/grant-0/0.txt" }] } });
    expect(second).toEqual({ taskId: TASK, stepId: steps[1]!.id, chunkIndex: 1, chargeTo: "platform", request: { ...thumbnailRequest(),
      outputs: thumbnailRequest().outputs.map((output, index) => ({ ...output, storageKey: `derived/grant-1/${index}.png` })) } });
    expect(h.read).toHaveBeenCalledExactlyOnceWith(asset(0, false).id, readUntil());
    expect(h.inline).toHaveBeenCalledWith(steps[0]!.id, { "miniToolAnalysisJson:0": people }, 0);
    const cacheCall = h.inline.mock.calls.findIndex((call) => Object.hasOwn(call[1], "miniToolAnalysisJson:0"));
    expect(h.inline.mock.invocationCallOrder[cacheCall]).toBeLessThan(h.grants.mock.invocationCallOrder[1]!);
    const grants: GrantInput[] = h.grants.mock.calls.map((call) => call[0]);
    expect(grants.every((input) => !("nodeId" in input))).toBe(true);
    expect(h.finish).not.toHaveBeenCalled(); expect(h.charge).not.toHaveBeenCalled();
  });

  it("preserves supplied candidate order 5/0/2 in plans and public identities", async () => {
    const original = execution(); const observations = { ...people, candidates: [people.candidates[2]!, people.candidates[0]!, people.candidates[1]!] };
    payload = observations;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    expect(h.advance.mock.calls[1]?.[0].request.outputs.map((output: { outputIndex: number }) => output.outputIndex)).toEqual([5, 0, 2]);
  });

  it("preserves all nine original indices across complete step prefixes and eight-plus-one chunks", async () => {
    const original = execution(); const observations = { ...people, candidates: Array.from({ length: 9 }, (_, index) => ({ ...people.candidates[0]!, detectionIndex: index * 2 })) };
    payload = observations;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    const advances: OpenMiniToolPlanJobInput[] = h.advance.mock.calls.map((call) => call[0]);
    expect(advances.map((input) => ({ chunk: input.chunkIndex, outputs: input.request.outputs.map((output) => output.outputIndex) })))
      .toEqual([{ chunk: 0, outputs: [0] }, { chunk: 1, outputs: [0, 2, 4, 6, 8, 10, 12, 14] }, { chunk: 2, outputs: [16] }]);
    expect(steps.map((step) => step.position)).toEqual([0, 1, 2]);
    expect(h.ensure.mock.calls.at(-1)?.[1]).toHaveLength(3);
    expect(advances.every((input) => input.chargeTo === "platform")).toBe(true);
  });

  it("accepts empty detections without allocating a thumbnail step, job or grant", async () => {
    const original = execution(); const observations = { ...people, candidates: [] }; payload = observations;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).toHaveBeenCalledTimes(1); expect(steps).toHaveLength(1);
  });

  it("retains one-pixel crops with their nonzero detector index", async () => {
    const original = execution(); const observations = { ...people, candidates: [{ detectionIndex: 5,
      faceBox: { x: 0.1, y: 0.1, width: 0.01, height: 0.01 }, pixelCrop: { x: 40, y: 20, width: 1, height: 1 } }] }; payload = observations;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    expect(h.advance.mock.calls[1]?.[0].request.outputs[0]).toMatchObject({ outputIndex: 5, recipe: { crop: { rect: { x: 40, y: 20, width: 1, height: 1 } } } });
  });

  // Design §7.17 「方向与几何」: a portrait display comes from the frozen version (180x320); the crop and the PNG target both
  // use it while the binding keeps the encoded 400x200.
  it("AR03 uses actual portrait display geometry while preserving the original encoded binding", async () => {
    version = frozenVersion({ width: 180, height: 320 });
    const original = execution(); const observations = { ...people, width: 180, height: 320, candidates: [{ detectionIndex: 2,
      faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 }, pixelCrop: { x: 20, y: 40, width: 40, height: 120 } }] }; payload = observations;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    expect(h.advance.mock.calls[1]?.[0].request.outputs[0]).toMatchObject({ recipe: { target: { width: 180, height: 320 },
      crop: { sourceWidth: 180, sourceHeight: 320, rect: observations.candidates[0]!.pixelCrop } } });
    expect(original.record.binding.mediaInfo).toMatchObject({ width: 400, height: 200 });
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

  it("derives new nine-person thumbnail chunks from the first class and limits while preserving stored descriptors", async () => {
    const original = execution(); const observations = { ...people, candidates: Array.from({ length: 9 }, (_, index) => ({ ...people.candidates[0]!, detectionIndex: index * 2 })) };
    const request = initialRequest(original); const step = storedStep(request, 0, { "miniToolAnalysisJson:0": observations });
    step.itemIndex = 7;
    const firstDescriptor = { kind: step.kind, endpoint: step.endpoint, itemIndex: step.itemIndex };
    h.config.mockReturnValue(replayConfig("Original request owns the remaining run class and limits"));
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    const calls: OpenMiniToolPlanJobInput[] = h.advance.mock.calls.map((call) => call[0]);
    expect(calls.map((call) => ({ chunk: call.chunkIndex, class: call.request.containerClass, limits: call.request.limits, deadline: call.request.deadlineAt })))
      .toEqual([0, 1, 2].map((chunk) => ({ chunk, class: request.containerClass, limits: LIMITS, deadline: DEADLINE })));
    expect(h.ensure.mock.calls.at(-1)?.[1]).toEqual([firstDescriptor,
      expect.objectContaining({ kind: "container_job", endpoint: request.containerClass }), expect.objectContaining({ kind: "container_job", endpoint: request.containerClass })]);
    expect(calls.map((call) => call.stepId)).toEqual(steps.map((item) => item.id));
    expect(h.grants).toHaveBeenCalledTimes(2); expect(h.read).not.toHaveBeenCalled();
    expect(step.output).toMatchObject({ miniToolConsumption: { marker: "original-policy-and-usage" }, sibling: "original-sibling", "miniToolAnalysisJson:0": observations });
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

  it("does not open thumbnail work when persisting the downloaded JSON fails", async () => {
    const original = execution(); const error = new Error("JSON cache write unavailable"); h.inline.mockRejectedValueOnce(error);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBe(error);
    expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).toHaveBeenCalledTimes(1);
    expect(steps[0]!.output).not.toHaveProperty("miniToolAnalysisJson:0");
    const request = structuredClone(steps[0]!.output.miniToolPlanJob);
    h.grants.mockClear(); h.read.mockClear();
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    expect(h.read).toHaveBeenCalledExactlyOnceWith(asset(0, false).id, readUntil());
    expect(h.grants).toHaveBeenCalledTimes(1); expect(steps[0]!.output.miniToolPlanJob).toEqual(request);
  });

  it("reuses persisted candidate JSON and all thumbnail plans with identical public identities", async () => {
    const original = execution();
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    const requests = steps.map((step) => structuredClone(step.output.miniToolPlanJob));
    h.grants.mockClear(); h.read.mockClear();
    h.config.mockReturnValue(replayConfig("Replay must not read new deployment policy"));
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(steps.map((step) => step.output.miniToolPlanJob)).toEqual(requests);
  });

  it.each([null, false, 0, "", { ...people, coordinateSpace: "raw" }, { ...people, anchor: ANCHOR }])("validates a present cached JSON value rather than refetching it: %j", async (json) => {
      const original = execution(); storedStep(initialRequest(original), 0, { "miniToolAnalysisJson:0": json });
      await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toThrow();
      expect(h.read).not.toHaveBeenCalled(); expect(h.grants).not.toHaveBeenCalled();
    });

  it("requires a canonical registered source for cached JSON", async () => {
    const original = execution(); const request = initialRequest(original); storedStep(request, 0, { "miniToolAnalysisJson:0": people });
    h.advance.mockResolvedValue({ ...registered(request), assets: [] });
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toThrow();
    expect(h.read).not.toHaveBeenCalled(); expect(h.grants).not.toHaveBeenCalled();
  });

  it.each(["wrong endpoint", "missing limits"])("keeps malformed persisted plans explicit: %s", async (fault) => {
    const original = execution(); const request = initialRequest(original); const step = storedStep(request, 0, { "miniToolAnalysisJson:0": people });
    if (fault === "wrong endpoint") step.endpoint = "DifferentClass";
    else { const { limits: _limits, ...incomplete } = request; step.output.miniToolPlanJob = incomplete; }
    const before = structuredClone(step.output);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toThrow();
    expect(h.grants).not.toHaveBeenCalled(); expect(step.output).toEqual(before);
  });
});

// O-C6–C10/O-D5–D7: report grace never renews computation or uncached JSON reads.
describe("unchanged deadline and late pure assembly", () => {
  it.each([DEADLINE, DEADLINE + 1])("refuses new grants at or beyond the original deadline %s", async (now) => {
    vi.mocked(Date.now).mockReturnValue(now);
    await expect(runMiniToolContainerAnalysis(execution(), DEADLINE)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.grants).not.toHaveBeenCalled(); expect(h.advance).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

  it("allows complete cached people results after the report window without new grants or JSON GET", async () => {
    const original = execution(); storedStep(initialRequest(original), 0, { "miniToolAnalysisJson:0": people });
    storedStep(thumbnailRequest(), 1);
    vi.mocked(Date.now).mockReturnValue(DEADLINE + 10001);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
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

  // User decision (same rule as runs): a pickup after D still reads what already finished and hands it to the user; reading the
  // stored JSON starts no new work, so it is bounded by planReadUntil, not refused at D.
  it.each([
    ["people", DEADLINE + 1], ["scene_cuts", DEADLINE + 1], ["people", DEADLINE + 2 * 5000 + 1], ["scene_cuts", DEADLINE + 2 * 5000 + 1],
  ] as const)("reads a stored %s report's JSON after D and completes (first pickup at %s)", async (kind, now) => {
    const original = execution(kind); storedStep(initialRequest(original), 0);
    if (kind === "people") storedStep(thumbnailRequest(), 1); else payload = structuredClone(scenes);
    vi.mocked(Date.now).mockReturnValue(now);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(kind === "people" ? expectedPeople(original) : expectedScene(original));
    // Each stored job is advanced once (its usage recorded once); no new grant, step or job is opened after D.
    expect(h.advance).toHaveBeenCalledTimes(kind === "people" ? 2 : 1); expect(h.grants).not.toHaveBeenCalled(); expect(h.ensure).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledExactlyOnceWith(asset(0, false).id, readUntil(now));
  });

  it("reads an existing running thumbnail after D and preserves StillRunning for the outer lane", async () => {
    const original = execution(); storedStep(initialRequest(original), 0, { "miniToolAnalysisJson:0": people });
    const thumbnail = storedStep(thumbnailRequest(), 1); const normal = h.advance.getMockImplementation()!;
    const waiting = new StillRunning(DEADLINE + 5000);
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => { if (input.stepId === thumbnail.id) throw waiting; return normal(input); });
    vi.mocked(Date.now).mockReturnValue(DEADLINE + 1);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBe(waiting);
    expect(h.advance).toHaveBeenCalledTimes(2); expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled(); expect(h.charge).not.toHaveBeenCalled();
  });

  it("does not create a missing ninth-person chunk after D while retaining the first eight originals", async () => {
    const original = execution(); const observations = { ...people, candidates: Array.from({ length: 9 }, (_, index) => ({ ...people.candidates[0]!, detectionIndex: index * 2 })) };
    const initial = storedStep(initialRequest(original), 0, { "miniToolAnalysisJson:0": observations });
    const first = storedStep(thumbnailRequest(observations.candidates.slice(0, 8)), 1);
    const before = structuredClone([initial.output, first.output]);
    vi.mocked(Date.now).mockReturnValue(DEADLINE + 1);
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBeInstanceOf(DeadlinePassed);
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(steps.filter((step) => step.output.miniToolPlanJob !== undefined)).toHaveLength(2);
    expect([initial.output, first.output]).toEqual(before);
  });
});

// O-P6/P8/P9/P15 and O-S4/S5/S6: real domain parsers observe content and cross-artifact relationships.
describe("registered content and failure propagation", () => {
  it.each([
    { ...people, coordinateSpace: "raw" }, { ...people, anchor: ANCHOR },
    { ...people, candidates: [people.candidates[0], people.candidates[0]] },
    { ...people, candidates: [{ ...people.candidates[0], pixelCrop: { x: 319, y: 0, width: 2, height: 1 } }] },
    // §93 D5-8: an anchor echo, and display people measured at another size than the people recipe's 320x180 target.
    { ...people, width: 640, height: 360 },
  ])("does not allocate thumbnails for invalid display content %j", async (json) => {
    payload = json;
    await expect(runMiniToolContainerAnalysis(execution(), DEADLINE)).rejects.toThrow();
    expect(h.advance).toHaveBeenCalledTimes(1); expect(h.grants).toHaveBeenCalledTimes(1);
  });

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

  it.each(["wrong source", "wrong rectangle", "wrong measured width", "wrong hash", "missing row"])("rejects %s from a registered thumbnail wrapper", async (fault) => {
    const normal = h.advance.getMockImplementation()!;
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const ended: RegisteredMiniToolPlanJob = await normal(input);
      if (input.chunkIndex === 1) {
        const output = ended.request.outputs[1]!;
        if (fault === "wrong source") ended.request.inputs[0]!.storageKey = "another/source.mp4";
        if (fault === "wrong rectangle" && output.recipe.kind === "frame") output.recipe.crop!.rect = people.candidates[0]!.pixelCrop;
        if (fault === "wrong measured width") ended.report.outputs[0]!.width = 1;
        if (fault === "wrong hash") ended.assets[0]!.asset.contentHash = "d".repeat(64);
        if (fault === "missing row") ended.assets.pop();
      }
      return ended;
    });
    await expect(runMiniToolContainerAnalysis(execution(), DEADLINE)).rejects.toThrow();
    expect(h.advance).toHaveBeenCalledTimes(2);
  });

  it("accepts nullable legacy dedup metadata while preserving canonical references", async () => {
    const original = execution(); const normal = h.advance.getMockImplementation()!;
    const expected = expectedPeople(original);
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const ended: RegisteredMiniToolPlanJob = await normal(input);
      if (input.chunkIndex === 1) {
        for (const entry of ended.assets) {
          entry.asset.width = null; entry.asset.height = null;
          entry.asset.producedByUserId = "d0000000-0000-4000-8000-000000000001";
          entry.asset.generationTaskId = "e0000000-0000-4000-8000-000000000001";
          entry.asset.mimeType = "image/webp";
        }
      }
      return ended;
    });
    for (const person of expected.people) person.artifactRefs[0]!.mimeType = "image/webp";
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expected);
  });

  it("retains separate people when equal thumbnail bytes deduplicate to one canonical row", async () => {
    const original = execution(); const normal = h.advance.getMockImplementation()!;
    const expected = expectedPeople(original);
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const ended: RegisteredMiniToolPlanJob = await normal(input);
      if (input.chunkIndex === 1) {
        const first = ended.assets.find((entry) => entry.outputIndex === 0)!.asset;
        ended.assets.find((entry) => entry.outputIndex === 5)!.asset = structuredClone(first);
        const measured = ended.report.outputs.find((output) => output.outputIndex === 5)!;
        measured.sha256 = first.contentHash; measured.sizeBytes = first.sizeBytes;
      }
      return ended;
    });
    expected.people[2]!.artifactRefs = structuredClone(expected.people[0]!.artifactRefs);
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expected);
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

  it("resumes the last of nine people without reopening the first eight original thumbnail grants", async () => {
    const original = execution(); const observations = { ...people, candidates: Array.from({ length: 9 }, (_, index) => ({ ...people.candidates[0]!, detectionIndex: index * 2 })) };
    payload = observations; const normal = h.advance.getMockImplementation()!; const waiting = new StillRunning(DEADLINE - 1000);
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => { if (input.chunkIndex === 2) { await normal(input); throw waiting; } return normal(input); });
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBe(waiting);
    expect(steps.map((step) => step.position)).toEqual([0, 1, 2]);
    const originals = steps.map((step) => structuredClone(step.output.miniToolPlanJob));
    h.advance.mockClear(); h.advance.mockImplementation(normal); h.grants.mockClear(); h.read.mockClear();
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original, observations));
    expect(h.grants).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(steps.map((step) => step.output.miniToolPlanJob)).toEqual(originals);
  });

  it("retains a failed ninth-person job and prior siblings without starting a replacement chunk", async () => {
    const original = execution(); const observations = { ...people, candidates: Array.from({ length: 9 }, (_, index) => ({ ...people.candidates[0]!, detectionIndex: index * 2 })) };
    payload = observations; const normal = h.advance.getMockImplementation()!;
    h.advance.mockImplementation(async (input: OpenMiniToolPlanJobInput) => {
      const ended: RegisteredMiniToolPlanJob = await normal(input);
      return input.chunkIndex === 2 ? { ...ended, report: { ...ended.report, state: "failed", reason: "tool_failed" } } : ended;
    });
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toBeInstanceOf(ContainerJobFailed);
    expect(h.advance).toHaveBeenCalledTimes(3); expect(h.grants).toHaveBeenCalledTimes(3);
    expect(steps[1]!.output.miniToolPlanJob).toEqual({ ...thumbnailRequest(observations.candidates.slice(0, 8)),
      outputs: thumbnailRequest(observations.candidates.slice(0, 8)).outputs.map((output, index) => ({ ...output, storageKey: `derived/grant-1/${index}.png` })) });
    expect(steps[2]!.output.miniToolPlanJob).toEqual({ ...thumbnailRequest(observations.candidates.slice(8), 2),
      outputs: thumbnailRequest(observations.candidates.slice(8), 2).outputs.map((output, index) => ({ ...output, storageKey: `derived/grant-2/${index}.png` })) });
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

  it("does not route a tracked-mask execution through the people or scene branches", async () => {
    const original = execution();
    original.record = miniToolAnalysisRecordSchema.parse({ ...original.record, kind: "tracked_mask", analysisInput: {
      ...original.record.analysisInput, kind: "tracked_mask", anchor: ANCHOR, range: { start: 0, end: 1 },
      region: { box: people.candidates[0]!.faceBox, points: [] }, trackingPrompt: "the selected person",
    } });
    original.params.analysis.kind = "tracked_mask"; original.params.analysis.analysisInput = original.record.analysisInput;
    await expect(runMiniToolContainerAnalysis(original, DEADLINE)).rejects.toThrow();
    expect(h.grants).not.toHaveBeenCalled(); expect(h.advance).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });

  it("uses a new accepted run's identity while keeping same-source dedup references legal", async () => {
    const original = execution(); const next = "10000000-0000-4000-8000-000000000002";
    original.record.analysisRunId = next; original.params.analysis.analysisRunId = next; original.context.taskId = next;
    expect(await runMiniToolContainerAnalysis(original, DEADLINE)).toEqual(expectedPeople(original));
    expect(h.advance.mock.calls[0]?.[0].request.jobId).toBe(`task:${next}/chunk:0`);
  });
});
