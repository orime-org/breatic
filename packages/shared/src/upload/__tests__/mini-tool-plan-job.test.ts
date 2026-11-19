// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { miniToolJobRequestSchema, MINI_TOOL_JOB_MAX_OUTPUTS } from "../mini-tool-job.js";
import { miniToolPlanAccess, miniToolPlanJobRequestSchema, miniToolPlanRecipeSchema, readMiniToolPlanJobReport, sameMiniToolPlanJob } from "../mini-tool-plan-job.js";
import { chunkVideoOutputs } from "../../mini-tools/video-plan.js";

const INPUT_A = "20000000-0000-4000-8000-000000000001";
const INPUT_B = "20000000-0000-4000-8000-000000000002";
const DEADLINE = Date.parse("2026-10-25T11:03:03.100Z");
const inputs = [{ inputId: INPUT_A, storageKey: "fixtures/source-a.mp4" }, { inputId: INPUT_B, storageKey: "fixtures/source-b.mp4" }];
const limits = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
// frames-split design §7.17 (「唯一写点：worker的配方构造」, frame/segment/people/scene_cuts rows, 「去掉inspect_video步骤」):
// every job recipe names the grid, the tool source and grid frame numbers the worker wrote from the frozen plan.
const GRID = { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 125, realFrameCount: 125 };
const SOURCE_REF = { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false } };
const FRAME_TARGET = { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" };
/** A frame recipe of grid frame `n`. @returns It. */
const frameAt = (inputId: string, n: number): Record<string, unknown> => ({ kind: "frame", inputId, grid: GRID, source: SOURCE_REF, frameIndex: n, target: FRAME_TARGET });
const outputs = Array.from({ length: 17 }, (_, outputIndex) => ({
  outputIndex, storageKey: `results/T/o${String(outputIndex).padStart(2, "0")}.png`, contentType: "image/png",
  ...(outputIndex % 8 === 0 ? { coverKey: `results/T/o${String(outputIndex).padStart(2, "0")}.cover.webp` } : {}),
  recipe: frameAt(outputIndex % 2 === 0 ? INPUT_A : INPUT_B, outputIndex),
}));
const base = { schemaVersion: 2, jobId: "task:10000000-0000-4000-8000-000000000001:chunk:0", containerClass: "MiniToolContainerStd1", deadlineAt: DEADLINE, inputs, outputs: outputs.slice(0, 8), limits };
const legacy = { jobId: "legacy", containerClass: "MiniToolContainerStd1", deadlineAt: DEADLINE, op: "cut", params: { range: { start: 0, end: 1 } }, input: { storageKey: "fixtures/source-a.mp4" }, outputs: [{ storageKey: "results/legacy.mp4", contentType: "video/mp4" }] };
const profile = { id: "pyscenedetect-content", version: "0.7.2", weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };

/** A measured output, with its global index independent from report ordering. */
function measured(output: typeof outputs[number]): Record<string, unknown> {
  return { outputIndex: output.outputIndex, storageKey: output.storageKey, sha256: "c".repeat(64), sizeBytes: 123, contentType: output.contentType, width: 32, height: 18, durationSeconds: null, cover: null, upright: null };
}

describe("planned media job requests", () => {
  it("retains the versionless legacy request and its unknown-field policy", () => {
    expect(miniToolJobRequestSchema.parse({ ...legacy, extra: "ignored" })).toEqual(legacy);
  });

  it.each([0, 3, "2", null])("rejects explicit unknown version %s even with a legacy-shaped body", (schemaVersion) => {
    expect(miniToolJobRequestSchema.safeParse({ ...legacy, schemaVersion }).success).toBe(false);
  });

  it("retains all seventeen global indices and recipes across three valid chunks", () => {
    const chunks = chunkVideoOutputs(outputs, MINI_TOOL_JOB_MAX_OUTPUTS);
    expect(chunks.map((chunk) => chunk.map((output) => output.outputIndex))).toEqual([[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11, 12, 13, 14, 15], [16]]);
    const requests = chunks.map((chunk, index) => miniToolPlanJobRequestSchema.parse({ ...base, jobId: `task:T:chunk:${index}`, outputs: chunk }));
    expect(requests).toEqual(chunks.map((chunk, index) => ({ ...base, jobId: `task:T:chunk:${index}`, outputs: chunk })));
  });

  it("accepts distinct input identities reading the same registered source", () => {
    const request = { ...base, inputs: [{ ...inputs[0] }, { ...inputs[1], storageKey: inputs[0]!.storageKey }] };
    expect(miniToolPlanJobRequestSchema.parse(request)).toEqual(request);
    expect(miniToolPlanAccess(request).reads).toEqual(["fixtures/source-a.mp4"]);
  });

  it.each([
    ["duplicate input id", { ...base, inputs: [inputs[0], { ...inputs[1], inputId: INPUT_A }] }],
    ["duplicate output index", { ...base, outputs: [outputs[0], { ...outputs[1], outputIndex: 0 }] }],
    ["duplicate main key", { ...base, outputs: [outputs[0], { ...outputs[1], storageKey: outputs[0]!.storageKey }] }],
    ["main and cover alias", { ...base, outputs: [outputs[0], { ...outputs[1], storageKey: outputs[0]!.coverKey }] }],
    ["duplicate cover", { ...base, outputs: [outputs[0], { ...outputs[1], coverKey: outputs[0]!.coverKey }] }],
    ["output overwrites source", { ...base, outputs: [{ ...outputs[0], storageKey: inputs[0]!.storageKey }] }],
    ["cover overwrites source", { ...base, outputs: [{ ...outputs[0], coverKey: inputs[0]!.storageKey }] }],
    ["missing source binding", { ...base, inputs: [inputs[0]] }],
    ["nine outputs", { ...base, outputs: outputs.slice(0, 9) }],
    ["missing version", { ...base, schemaVersion: undefined }],
    ["free shell", { ...base, command: "ffmpeg -i arbitrary" }],
    ["free argv", { ...base, outputs: [{ ...outputs[0], recipe: { ...frameAt(INPUT_A, 0), args: ["-i", "https://external.test.invalid/source"] } }] }],
    ["negative global index", { ...base, outputs: [{ ...outputs[0], outputIndex: -1 }] }],
    ["fractional global index", { ...base, outputs: [{ ...outputs[0], outputIndex: 0.5 }] }],
  ])("rejects %s before object capabilities are granted", (_name, body) => {
    expect(miniToolPlanJobRequestSchema.safeParse(body).success).toBe(false);
  });

  // The inspect_video recipe is gone (its own pin is staged-wire DP07); the four tool recipes read the grid by frame number.
  it.each([
    frameAt(INPUT_A, 0),
    { kind: "segment", inputId: INPUT_A, grid: GRID, source: SOURCE_REF, frames: { start: 25, end: 53 },
      target: { width: 32, height: 18, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" }, audio: true },
    { kind: "people", inputId: INPUT_A, grid: GRID, source: SOURCE_REF, frameIndex: 1, target: FRAME_TARGET, profile: { id: "opencv-yunet-2023mar", version: "2023mar", weightsHash: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } } },
    { kind: "scene_cuts", inputId: INPUT_A, grid: GRID, source: { kind: "edit" }, frames: { start: 0, end: 125 }, profile,
      target: { width: 32, height: 18, colorMatrix: "bt709", toneMap: "none" } },
  ])("accepts the complete owned $kind recipe", (recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });



  // The frame recipe has no orientation (it is always upright); its PNG target is what a caller can change.
  it("freezes the PNG target as part of the original job recipe", () => {
    const deeper = { ...base, outputs: base.outputs.map((output) => ({ ...output, recipe: { ...output.recipe, target: { ...FRAME_TARGET, pngBitDepth: 16 } } })) };
    expect(sameMiniToolPlanJob(deeper, structuredClone(deeper))).toBe(true);
    expect(sameMiniToolPlanJob(base, deeper)).toBe(false);
  });

  it.each([
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 3, y: 1, width: 5, height: 3 } },
    { sourceWidth: 7, sourceHeight: 5, rect: { x: 6, y: 4, width: 1, height: 1 } },
  ])("retains an integer display crop and its original geometry", (crop) => {
    // The crop names the target's display geometry (staged-wire FR02).
    const recipe = { ...frameAt(INPUT_A, 1), target: { ...FRAME_TARGET, width: crop.sourceWidth, height: crop.sourceHeight }, crop };
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each([
    { sourceWidth: 0, sourceHeight: 9, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { sourceWidth: 11, sourceHeight: 0, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { sourceWidth: 11.5, sourceHeight: 9, rect: { x: 0, y: 0, width: 1, height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: -1, y: 0, width: 1, height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: -1, width: 1, height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: 0, width: 0, height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: 0, width: 1, height: 0 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 1.25, y: 1, width: 2, height: 2 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 1, y: 1, width: 2.5, height: 2 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 10, y: 0, width: 2, height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: 8, width: 1, height: 2 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: 0, width: "1", height: 1 } },
    { sourceWidth: 11, sourceHeight: 9, rect: { x: 0, y: 0, width: Infinity, height: 1 } },
  ])("refuses invalid saved pixel geometry", (crop) => {
    const side = (value: unknown, fallback: number): number => (Number.isSafeInteger(value) && (value as number) > 0 ? value as number : fallback);
    const target = { ...FRAME_TARGET, width: side(crop.sourceWidth, 11), height: side(crop.sourceHeight, 9) };
    expect(miniToolPlanRecipeSchema.safeParse({ ...frameAt(INPUT_A, 1), target, crop }).success).toBe(false);
  });


  it("freezes the original pixel selection together with its source geometry", () => {
    const original = { ...base, outputs: [{ ...outputs[1], recipe: { ...frameAt(INPUT_A, 1), target: { ...FRAME_TARGET, width: 11, height: 9 },
      crop: { sourceWidth: 11, sourceHeight: 9, rect: { x: 3, y: 1, width: 5, height: 3 } } } }] };
    const changed = { ...original, outputs: [{ ...original.outputs[0], recipe: { ...original.outputs[0]!.recipe,
      crop: { sourceWidth: 11, sourceHeight: 9, rect: { x: 3, y: 1, width: 4, height: 3 } } } }] };
    expect(sameMiniToolPlanJob(original, structuredClone(original))).toBe(true);
    expect(sameMiniToolPlanJob(original, changed)).toBe(false);
  });

  it("grants exactly the two frozen reads and declared main and cover writes", () => {
    expect(miniToolPlanAccess(base)).toEqual({
      reads: ["fixtures/source-a.mp4", "fixtures/source-b.mp4"],
      writes: Object.fromEntries(base.outputs.flatMap((output) => [[output.storageKey, "image/png"], ...(output.coverKey ? [[output.coverKey, "image/png"]] : [])])),
    });
  });

  it("recognizes semantically identical object fields without changing array order", () => {
    const reordered = { limits: { stderrTailBytes: limits.stderrTailBytes, analysisStdoutBytes: limits.analysisStdoutBytes, probeStdoutBytes: limits.probeStdoutBytes }, outputs: base.outputs.map(({ recipe, ...output }) => ({ recipe: { target: recipe.target, frameIndex: recipe.frameIndex, source: recipe.source, grid: recipe.grid, inputId: recipe.inputId, kind: recipe.kind }, ...output })), inputs: base.inputs, deadlineAt: base.deadlineAt, containerClass: base.containerClass, jobId: base.jobId, schemaVersion: 2 };
    expect(sameMiniToolPlanJob(base, reordered)).toBe(true);
    expect(sameMiniToolPlanJob(base, { ...base, outputs: [...base.outputs].reverse() })).toBe(false);
  });

  it.each([
    { ...base, deadlineAt: DEADLINE + 1 },
    { ...base, limits: { ...limits, analysisStdoutBytes: limits.analysisStdoutBytes + 1 } },
    { ...base, containerClass: "MiniToolContainerStd4" },
    { ...base, inputs: [{ ...inputs[0], storageKey: "fixtures/other.mp4" }, inputs[1]] },
    { ...base, outputs: [{ ...outputs[0], recipe: { ...outputs[0]!.recipe, frameIndex: 1 } }, ...base.outputs.slice(1)] },
  ])("rejects a changed frozen request while preserving the accepted identity", (changed) => {
    const before = structuredClone(base);
    expect(sameMiniToolPlanJob(base, changed)).toBe(false);
    expect(base).toEqual(before);
  });

  it("retains every output under arbitrary legal chunk boundaries", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), (count) => {
      const complete = Array.from({ length: count }, (_, outputIndex) => ({ ...outputs[0]!, outputIndex, storageKey: `results/${outputIndex}.png`, coverKey: undefined, recipe: frameAt(INPUT_A, outputIndex) }));
      const chunks = chunkVideoOutputs(complete, MINI_TOOL_JOB_MAX_OUTPUTS);
      const accepted = chunks.map((chunk, index) => miniToolPlanJobRequestSchema.parse({ ...base, jobId: `task:T:${index}`, outputs: chunk }));
      expect(accepted).toEqual(chunks.map((chunk, index) => ({ ...base, jobId: `task:T:${index}`, outputs: chunk })));
      expect(chunks.flat()).toEqual(complete);
    }), { numRuns: 60 });
  });

  it.each([
    undefined,
    { ...limits, probeStdoutBytes: 0 },
    { ...limits, analysisStdoutBytes: -1 },
    { ...limits, stderrTailBytes: 0.5 },
    { ...limits, probeStdoutBytes: Number.POSITIVE_INFINITY },
    { ...limits, analysisStdoutBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...limits, stderrTailBytes: "65536" },
    { ...limits, extra: 1 },
  ])("requires complete finite positive integer limits before starting planned work: %j", (invalid) => {
    expect(miniToolPlanJobRequestSchema.safeParse({ ...base, limits: invalid }).success).toBe(false);
  });
});

describe("planned media job output reports", () => {
  const request = { ...base, jobId: "task:T:chunk:1", outputs: outputs.slice(8, 16) };
  const report = { schemaVersion: 2, state: "done", outputs: request.outputs.map(measured).reverse(), usage: { wallMs: 1234, cpuUsec: 567 } };

  it("maps shuffled measured outputs by original index and key", () => {
    expect(readMiniToolPlanJobReport(request, report)).toEqual(report);
  });

  it("retains the actually written subset when a later output fails", () => {
    const partial = { schemaVersion: 2, state: "failed", reason: "tool_failed", outputs: request.outputs.slice(0, 2).map(measured), usage: { wallMs: 1234, cpuUsec: null } };
    expect(readMiniToolPlanJobReport(request, partial)).toEqual(partial);
  });

  it("reads a job ingest expired at its deadline as failed with reason expired, and still reads every older reason", () => {
    for (const reason of ["expired", "tool_failed", "no_audio_track", "internal", "empty_foreground", "no_face", "tracking_output_mismatch", "model_output_mismatch"]) {
      const failed = { schemaVersion: 2, state: "failed", reason, outputs: [], usage: null };
      expect(readMiniToolPlanJobReport(request, failed)).toEqual(failed);
    }
  });

  it.each([
    { ...report, outputs: report.outputs.slice(1) },
    { ...report, outputs: [...report.outputs.slice(1), report.outputs[1]] },
    { ...report, outputs: [{ ...report.outputs[0], outputIndex: 0 }, ...report.outputs.slice(1)] },
    { ...report, outputs: [{ ...report.outputs[0], storageKey: request.outputs[0]!.storageKey }, ...report.outputs.slice(1)] },
    { ...report, outputs: [{ ...report.outputs[0], contentType: "video/mp4" }, ...report.outputs.slice(1)] },
    { ...report, outputs: [{ ...report.outputs[0], cover: { storageKey: "unissued-cover.png", sha256: "a".repeat(64), sizeBytes: 1, contentType: "image/png", width: 1, height: 1 } }, ...report.outputs.slice(1)] },
    { ...report, schemaVersion: 3 },
  ])("rejects missing, duplicated, foreign or mismatched output identities", (invalid) => {
    expect(() => readMiniToolPlanJobReport(request, invalid)).toThrow();
  });
});

// inner#1306 test plan §97 items 2 and 3 (frames-split §7.17 recipe table; D11-3, D11-4): the planned job lane names the
// transition window and the erase/expand model composite as recipe kinds of its own union. Their fields beyond the kind
// are not asserted here (§97 需要确认: field names not fixed by the design).
describe("the recipe kinds of the batch-six container jobs (§97 D11-3, D11-4)", () => {
  it.each(["transition_window", "model_composite"])("RK01 the recipe union has the %s kind", (kind) => {
    expect(miniToolPlanRecipeSchema.options.map((option) => option.shape.kind.value)).toContain(kind);
  });
});
