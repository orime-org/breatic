// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
const outputs = Array.from({ length: 17 }, (_, outputIndex) => ({
  outputIndex, storageKey: `results/T/o${String(outputIndex).padStart(2, "0")}.png`, contentType: "image/png",
  ...(outputIndex % 8 === 0 ? { coverKey: `results/T/o${String(outputIndex).padStart(2, "0")}.cover.webp` } : {}),
  recipe: { kind: "frame", inputId: outputIndex % 2 === 0 ? INPUT_A : INPUT_B, frameIndex: outputIndex },
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
    ["free argv", { ...base, outputs: [{ ...outputs[0], recipe: { kind: "frame", inputId: INPUT_A, frameIndex: 0, args: ["-i", "https://external.test.invalid/source"] } }] }],
    ["negative global index", { ...base, outputs: [{ ...outputs[0], outputIndex: -1 }] }],
    ["fractional global index", { ...base, outputs: [{ ...outputs[0], outputIndex: 0.5 }] }],
  ])("rejects %s before object capabilities are granted", (_name, body) => {
    expect(miniToolPlanJobRequestSchema.safeParse(body).success).toBe(false);
  });

  it.each([
    { kind: "inspect_video", inputId: INPUT_A },
    { kind: "frame", inputId: INPUT_A, frameIndex: 0 },
    { kind: "segment", inputId: INPUT_A, range: { start: 1, end: 2.125 }, audioEnd: 4 },
    { kind: "people", inputId: INPUT_A, anchor: { frameIndex: 1, pts: 0.25 }, profile: { id: "opencv-yunet-2023mar", version: "2023mar", weightsHash: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } } },
    { kind: "scene_cuts", inputId: INPUT_A, range: { start: 0, end: 5 }, profile },
  ])("accepts the complete owned $kind recipe", (recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each([
    { kind: "frame", inputId: INPUT_A, frameIndex: 1, orientation: "display" },
    { kind: "people", inputId: INPUT_A, anchor: { frameIndex: 1, pts: 0.25 }, profile, orientation: "display" },
  ])("preserves explicitly requested display orientation for $kind", (recipe) => {
    expect(miniToolPlanRecipeSchema.parse(recipe)).toEqual(recipe);
  });

  it.each(["clockwise", true, null, 90])("refuses an undefined orientation rule: %s", (orientation) => {
    expect(miniToolPlanRecipeSchema.safeParse({ kind: "frame", inputId: INPUT_A, frameIndex: 1, orientation }).success).toBe(false);
  });

  it("freezes display orientation as part of the original job recipe", () => {
    const display = { ...base, outputs: base.outputs.map((output) => ({ ...output, recipe: { ...output.recipe, orientation: "display" } })) };
    expect(sameMiniToolPlanJob(display, structuredClone(display))).toBe(true);
    expect(sameMiniToolPlanJob(base, display)).toBe(false);
  });

  it("grants exactly the two frozen reads and declared main and cover writes", () => {
    expect(miniToolPlanAccess(base)).toEqual({
      reads: ["fixtures/source-a.mp4", "fixtures/source-b.mp4"],
      writes: Object.fromEntries(base.outputs.flatMap((output) => [[output.storageKey, "image/png"], ...(output.coverKey ? [[output.coverKey, "image/png"]] : [])])),
    });
  });

  it("recognizes semantically identical object fields without changing array order", () => {
    const reordered = { limits: { stderrTailBytes: limits.stderrTailBytes, analysisStdoutBytes: limits.analysisStdoutBytes, probeStdoutBytes: limits.probeStdoutBytes }, outputs: base.outputs.map(({ recipe, ...output }) => ({ recipe: { frameIndex: recipe.frameIndex, inputId: recipe.inputId, kind: recipe.kind }, ...output })), inputs: base.inputs, deadlineAt: base.deadlineAt, containerClass: base.containerClass, jobId: base.jobId, schemaVersion: 2 };
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
      const complete = Array.from({ length: count }, (_, outputIndex) => ({ ...outputs[0]!, outputIndex, storageKey: `results/${outputIndex}.png`, coverKey: undefined, recipe: { kind: "frame", inputId: INPUT_A, frameIndex: outputIndex } }));
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
