// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPlanJob, type PlanRunBody } from "@ingest/container/plan-run.js";
import { executePlanRecipe, inspectPlanInput } from "@ingest/container/plan-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { download, put, cpuUsec } from "@ingest/container/mini-tool-run.js";

vi.mock("@ingest/container/plan-recipes.js", () => ({ executePlanRecipe: vi.fn(), inspectPlanInput: vi.fn() }));
vi.mock("@ingest/container/plan-command.js", () => ({ runPlanCommand: vi.fn() }));
vi.mock("@ingest/container/mini-tool-run.js", () => ({ download: vi.fn(), put: vi.fn(), cpuUsec: vi.fn() }));

const NOW = 1700000000000;
const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const ALIAS = "20000000-0000-4000-8000-000000000003";
const MEDIA = { width: 400, height: 200, durationSeconds: null, cover: null };
const FACTS = { source: { frameTable: { frames: [{ frameIndex: 0, pts: 0 }], videoEnd: 1 }, width: 400, height: 200, rotation: 0, hasAudio: false, timeBase: "1/1000" }, raw: {} };
const JOB: PlanRunBody = {
  schemaVersion: 2, attemptId: "30000000-0000-4000-8000-000000000001", deadlineAt: NOW + 7200000,
  limits: { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 },
  inputs: [{ inputId: A, url: "http://r2.local/source-a?attempt=current" }, { inputId: B, url: "http://r2.local/source-b?attempt=current" }, { inputId: ALIAS, url: "http://r2.local/source-a?attempt=current" }],
  outputs: [
    { outputIndex: 8, key: "results/T/o08.png", url: "http://r2.local/out-8?attempt=current", contentType: "image/png", recipe: { kind: "frame", inputId: ALIAS, frameIndex: 0 } },
    { outputIndex: 9, key: "results/T/o09.png", url: "http://r2.local/out-9?attempt=current", contentType: "image/png", recipe: { kind: "frame", inputId: B, frameIndex: 0 } },
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
  vi.mocked(inspectPlanInput).mockResolvedValue(FACTS);
  vi.mocked(executePlanRecipe).mockResolvedValue(MEDIA);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("planned local owner with IO and recipes mocked, not actual media", () => {
  it("retains input aliases, downloads each actual URL once, and preserves output indices", async () => {
    await runPlanJob(JOB);
    expect(download).toHaveBeenCalledTimes(2);
    expect(inspectPlanInput).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(executePlanRecipe).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map(([request]) => request.recipe)).toEqual(JOB.outputs.map((output) => output.recipe));
    expect(calls[0]![0].input).toBe(vi.mocked(download).mock.calls[0]![1]);
    expect(calls[1]![0].input).toBe(vi.mocked(download).mock.calls[1]![1]);
    const options = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(JSON.parse(String(options.body))).toEqual({ schemaVersion: 2, attemptId: JOB.attemptId, ok: true, cpuUsec: 123, outputs: JOB.outputs.map((output) => ({ outputIndex: output.outputIndex, storageKey: output.key, ...MEDIA })) });
  });

  it("uses the original deadline and one shared lifetime for downloads, commands and writes", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await runPlanJob(JOB);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(7200000);
    const signal = vi.mocked(executePlanRecipe).mock.calls[0]![0].signal;
    expect(vi.mocked(download).mock.calls.every((args) => args[2] === signal)).toBe(true);
    expect(vi.mocked(put).mock.calls.every((args) => args[2] === signal)).toBe(true);
    expect(vi.mocked(inspectPlanInput).mock.calls.every((args) => args[1] === signal && args[2] === JOB.limits)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0]![1]?.signal).toBe(signal);
  });

  it("reports index8 as the actual completed subset when the next recipe fails", async () => {
    vi.mocked(executePlanRecipe).mockResolvedValueOnce(MEDIA).mockRejectedValueOnce(new Error("second recipe failed"));
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
    const job = { ...JOB, outputs: [{ ...JOB.outputs[0]!, recipe: { kind: "frame" as const, inputId: "unbound", frameIndex: 0 } }] };
    await runPlanJob(job);
    expect(download).not.toHaveBeenCalled();
    expect(executePlanRecipe).not.toHaveBeenCalled();
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({ ok: false, outputs: [] });
  });

  it("does not begin any source IO or compute when the original deadline already passed", async () => {
    await runPlanJob({ ...JOB, deadlineAt: NOW - 1 });
    expect(download).not.toHaveBeenCalled();
    expect(executePlanRecipe).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

// S6d D4-6 (inner#1306 §92; design §7.17 「容器不读帧表」, scene_cuts 「去掉inspect_video步骤」): once frame, segment, people and
// scene_cuts carry full-ledger entries, no recipe reads the per-frame probe, so a job of them never runs inspectPlanInput
// (the `-show_frames` probe behind `frameTable`).
describe("no recipe inspects the source frame by frame after D4 (§92 D4-6)", () => {
  const r = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
  const entry = { kind: "source", decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(1, 25), rate: r(1) };
  const png = { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none", pngBitDepth: 8, alpha: "none" };
  const video = { width: 400, height: 200, displayRect: null, colorMatrix: "bt709", toneMap: "none", alpha: "none", crf: 18, preset: "medium", format: "mp4-h264" };
  it.each([
    ["frame", { kind: "frame", inputId: A, entry, target: png }],
    ["people", { kind: "people", inputId: A, entry, target: png, profile: "standard" }],
    ["scene_cuts", { kind: "scene_cuts", inputId: A, window: { start: 0, end: 1 }, timescale: 25, profile: "standard", entries: [{ ...entry, ordinalOffset: 0 }], target: { width: 400, height: 200, colorMatrix: "bt709", toneMap: "none" } }],
    ["segment", { kind: "segment", inputId: A, window: { start: 0, end: 1 }, timescale: 25, entries: [entry], target: video, audio: null }],
  ])("DP06 a %s recipe on full-ledger entries runs without inspectPlanInput", async (_name, recipe) => {
    await runPlanJob({ ...JOB, outputs: [{ ...JOB.outputs[0]!, recipe }] } as unknown as PlanRunBody);
    expect(inspectPlanInput).not.toHaveBeenCalled();
  });
});

