// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlanJob, type PlanRunBody } from "@ingest/container/plan-run.js";
import { countPresentationGrid, executePresentationRecipe } from "@ingest/container/presentation-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { download, put } from "@ingest/container/mini-tool-run.js";
import { cpuUsec } from "@ingest/container/run-steps.js";

// Frames-split design §7.17 (「唯一写点：worker的配方构造」): every job recipe is written on grid frame numbers and runs as a
// presentation recipe; the download, alias and lifetime facts are asserted on the presentation executor.
vi.mock("@ingest/container/presentation-recipes.js", async (original) => ({ ...await original<Record<string, unknown>>(), executePresentationRecipe: vi.fn(), countPresentationGrid: vi.fn() }));
vi.mock("@ingest/container/plan-command.js", () => ({ runPlanCommand: vi.fn() }));
vi.mock("@ingest/container/mini-tool-run.js", () => ({ download: vi.fn(), put: vi.fn() }));
vi.mock("@ingest/container/run-steps.js", () => ({ cpuUsec: vi.fn() }));

const NOW = 1700000000000;
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const ALIAS = "20000000-0000-4000-8000-000000000003";
const MEDIA = { width: 400, height: 200, durationSeconds: null, cover: null };
const GRID = { fps: { numerator: 25, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 25, realFrameCount: 25 };
const SOURCE = { kind: "original", keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 1, allKeyframes: false } } as const;
const STILL = { grid: GRID, source: SOURCE, frameIndex: 0 };
const PNG = { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" } as const;
const JOB: PlanRunBody = {
  schemaVersion: 2, attemptId: "30000000-0000-4000-8000-000000000001", deadlineAt: NOW + 7200000,
  limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  inputs: [{ inputId: A, url: "http://r2.local/source-a?attempt=current" }, { inputId: B, url: "http://r2.local/source-b?attempt=current" }, { inputId: ALIAS, url: "http://r2.local/source-a?attempt=current" }],
  outputs: [
    { outputIndex: 8, key: "results/T/o08.png", url: "http://r2.local/out-8?attempt=current", contentType: "image/png", recipe: { kind: "frame", inputId: ALIAS, ...STILL, target: PNG } },
    { outputIndex: 9, key: "results/T/o09.png", url: "http://r2.local/out-9?attempt=current", contentType: "image/png", recipe: { kind: "frame", inputId: B, ...STILL, target: PNG } },
  ],
  reportUrl: "http://jobs.local/report?attempt=current",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(download).mockResolvedValue();
  vi.mocked(put).mockResolvedValue();
  vi.mocked(cpuUsec).mockResolvedValue(123);
  vi.mocked(runPlanCommand).mockRejectedValue(new Error("optional cover unavailable"));
  vi.mocked(executePresentationRecipe).mockResolvedValue(MEDIA);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("planned local owner with IO and recipes mocked, not actual media", () => {
  it("retains input aliases, downloads each actual URL once, and preserves output indices", async () => {
    await runPlanJob(JOB);
    expect(download).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(executePresentationRecipe).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([request]) => request.recipe)).toEqual(JOB.outputs.map((output) => output.recipe));
    expect(calls[0]![0].inputs.get(ALIAS)).toBe(vi.mocked(download).mock.calls[0]![1]);
    expect(calls[1]![0].inputs.get(B)).toBe(vi.mocked(download).mock.calls[1]![1]);
    const options = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toEqual({ schemaVersion: 2, attemptId: JOB.attemptId, ok: true, cpuUsec: 123, outputs: JOB.outputs.map((output) => ({ outputIndex: output.outputIndex, storageKey: output.key, ...MEDIA })) });
  });

  it("uses the original deadline and one shared lifetime for downloads, commands and writes", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await runPlanJob(JOB);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(7200000);
    const signal = vi.mocked(executePresentationRecipe).mock.calls[0]![0].signal;
    expect(vi.mocked(download).mock.calls.every((args) => args[2] === signal)).toBe(true);
    expect(vi.mocked(put).mock.calls.every((args) => args[2] === signal)).toBe(true);
    expect(vi.mocked(executePresentationRecipe).mock.calls.every(([request]) => request.signal === signal && request.limits === JOB.limits)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal).toBe(signal);
  });

  it("reports index8 as the actual completed subset when the next recipe fails", async () => {
    vi.mocked(executePresentationRecipe).mockResolvedValueOnce(MEDIA).mockRejectedValueOnce(new Error("second recipe failed"));
    await runPlanJob(JOB);
    expect(put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ schemaVersion: 2, attemptId: JOB.attemptId, ok: false, cpuUsec: 123, reason: "tool_failed", outputs: [{ outputIndex: 8, storageKey: JOB.outputs[0]!.key, ...MEDIA }] });
    expect(console.error).toHaveBeenCalledWith("mini_tool_plan_run_failed", expect.objectContaining({ attemptId: JOB.attemptId, outputIndex: 9 }));
  });

  it("keeps an output standing when its optional cover fails", async () => {
    const job = { ...JOB, outputs: [{ ...JOB.outputs[0]!, coverUrl: "http://r2.local/cover-8?attempt=current" }] };
    await runPlanJob(job);
    const report = JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body));
    expect(report.ok).toBe(true);
    expect(report.outputs).toEqual([{ outputIndex: 8, storageKey: JOB.outputs[0]!.key, ...MEDIA }]);
  });

  it("does not fetch or execute against an unbound recipe input", async () => {
    const job = { ...JOB, outputs: [{ ...JOB.outputs[0]!, recipe: { kind: "frame" as const, inputId: "unbound", ...STILL, target: PNG } }] };
    await runPlanJob(job);
    expect(download).not.toHaveBeenCalled();
    expect(executePresentationRecipe).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({ ok: false, outputs: [] });
  });

  it("does not begin any source IO or compute when the original deadline already passed", async () => {
    await runPlanJob({ ...JOB, deadlineAt: NOW - 1 });
    expect(download).not.toHaveBeenCalled();
    expect(executePresentationRecipe).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

// Frames-split design §7.17: frame, segment and scene_cuts read grid frames from the tool source, and each runs as a
// presentation recipe.
describe("frame, segment and scene_cuts run as presentation recipes (§7.17)", () => {
  const png = { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" };
  const video = { width: 400, height: 200, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" };
  const frames = { start: 0, end: 1 };
  it.each([
    ["frame", { kind: "frame", inputId: A, ...STILL, target: png }],
    ["scene_cuts", { kind: "scene_cuts", inputId: A, grid: GRID, source: SOURCE, frames, profile: "standard", target: { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none" } }],
    ["segment", { kind: "segment", inputId: A, grid: GRID, source: SOURCE, frames, target: video, audio: false }],
  ])("DP06 a %s recipe on grid frames runs as a presentation recipe", async (_name, recipe) => {
    await runPlanJob({ ...JOB, outputs: [{ ...JOB.outputs[0]!, recipe }] } as unknown as PlanRunBody);
    expect(vi.mocked(executePresentationRecipe).mock.calls.map(([request]) => request.recipe)).toEqual([recipe]);
  });
});

// Frames-split design §7.17 grid_count: the job declares no output; it decodes its one input and reports the count, writing nothing.
describe("a grid count job reports its count and writes no object (§7.17 grid_count)", () => {
  const COUNT = { kind: "grid_count", inputId: A, gridStart: { numerator: 0, denominator: 1 }, fps: { numerator: 25, denominator: 1 }, gridEnd: null } as const;
  const COUNTED = { lastVideoTime: { numerator: 49, denominator: 25 }, sourceFrames: 50 };

  it("GC10 downloads the counted input once, writes nothing and reports the count", async () => {
    vi.mocked(countPresentationGrid).mockResolvedValue(COUNTED);
    await runPlanJob({ ...JOB, outputs: [], count: COUNT });
    expect(download).toHaveBeenCalledTimes(1);
    expect(vi.mocked(countPresentationGrid).mock.calls[0]![0]).toMatchObject({ recipe: COUNT, limits: JOB.limits });
    expect(vi.mocked(countPresentationGrid).mock.calls[0]![0].inputs.get(A)).toBe(vi.mocked(download).mock.calls[0]![1]);
    expect(put).not.toHaveBeenCalled();
    expect(executePresentationRecipe).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ schemaVersion: 2, attemptId: JOB.attemptId, ok: true, cpuUsec: 123, outputs: [], count: COUNTED });
  });

  it("GC11 a count that fails reports the failure and no count", async () => {
    vi.mocked(countPresentationGrid).mockRejectedValue(new Error("The counted video decoded no frame"));
    await runPlanJob({ ...JOB, outputs: [], count: COUNT });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toEqual({ schemaVersion: 2, attemptId: JOB.attemptId, ok: false, cpuUsec: 123, outputs: [], reason: "tool_failed" });
  });
});
