// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { executePlanRecipe, inspectPlanInput, type PlanRecipeRequest, type PlanSource } from "@ingest/container/plan-recipes.js";
import { runPlanCommand } from "@ingest/container/plan-command.js";
import { runAnalysisPipeline } from "@ingest/container/analysis-pipeline.js";

vi.mock("@ingest/container/plan-command.js", () => ({ runPlanCommand: vi.fn() }));
vi.mock("@ingest/container/analysis-pipeline.js", () => ({ runAnalysisPipeline: vi.fn() }));

const ID = "20000000-0000-4000-8000-000000000001";
const LIMITS = { probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 8192 };
const FRAMES = [{ frameIndex: 0, pts: 0 }, { frameIndex: 1, pts: 0.25 }, { frameIndex: 2, pts: 0.55 }, { frameIndex: 3, pts: 0.9 }];
const RAW = {
  streams: [{ index: 0, codec_type: "video", width: 400, height: 200, time_base: "1/1000", side_data_list: [{ rotation: 90 }] }, { index: 1, codec_type: "audio" }],
  frames: FRAMES.map((frame) => ({ best_effort_timestamp_time: String(frame.pts), duration_time: "0.2" })),
  format: { duration: "1.1" },
};
const FACTS: PlanSource = { source: { frameTable: { frames: FRAMES, videoEnd: 1.1 }, width: 400, height: 200, rotation: 90, hasAudio: true, timeBase: "1/1000" }, raw: RAW };
const PEOPLE = { id: "opencv-yunet-2023mar", version: "2023mar", weightsHash: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4", params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } };
const SCENE = { id: "pyscenedetect-content", version: "0.7.2", weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };
let directory: string;
let request: PlanRecipeRequest;

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(join(tmpdir(), "plan-recipe-unit-"));
  request = { recipe: { kind: "inspect_video", inputId: ID }, input: join(directory, "source"), output: join(directory, "result"), directory, facts: FACTS, signal: new AbortController().signal, limits: LIMITS };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("owned plan recipe orchestration, with subprocesses mocked", () => {
  it("stores full raw inspection facts without editing negative source PTS or the source clock", async () => {
    const negative: PlanSource = { source: { ...FACTS.source, frameTable: { frames: [{ frameIndex: 0, pts: -0.25 }, ...FRAMES.slice(1)], videoEnd: 1.1 } }, raw: { ...RAW, frames: [{ best_effort_timestamp_time: "-0.25", duration_time: "0.2" }, ...RAW.frames.slice(1)] } };
    expect(await executePlanRecipe({ ...request, facts: negative })).toEqual({ width: null, height: null, durationSeconds: null, cover: null });
    expect(JSON.parse(await readFile(request.output, "utf8"))).toEqual({ schemaVersion: 1, kind: "inspect_video", source: negative.source, probe: negative.raw });
    expect(runPlanCommand).not.toHaveBeenCalled();
  });

  it("reads all streams separately from a complete primary-video frame probe", async () => {
    vi.mocked(runPlanCommand).mockImplementation(async (_program, args) => Buffer.from(JSON.stringify(args.includes("-show_frames") ? { frames: RAW.frames } : { streams: RAW.streams, format: RAW.format })));
    expect(await inspectPlanInput(request.input, request.signal, LIMITS)).toEqual(FACTS);
    expect(runPlanCommand).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(runPlanCommand).mock.calls;
    expect(calls.some(([, args]) => args.includes("-show_frames") && args.includes("v:0"))).toBe(true);
    expect(calls.every(([, args, options]) => args.includes("file") && options.signal === request.signal && options.stdoutBytes === LIMITS.probeStdoutBytes)).toBe(true);
  });

  it("extracts the exact frame ordinal with no fps-derived seek", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    vi.mocked(runPlanCommand).mockImplementation(async (_program, args) => { await writeFile(args.at(-1)!, png); return Buffer.alloc(0); });
    await executePlanRecipe({ ...request, recipe: { kind: "frame", inputId: ID, frameIndex: 2 } });
    const [program, args, options] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(program).toBe("ffmpeg");
    expect(args).toContain("-noautorotate");
    expect(args).toContain("select=eq(n\\,2)");
    expect(args).not.toContain("-ss");
    expect(options.signal).toBe(request.signal);
  });

  it("keeps detector BGR geometry encoded and emits owned face candidates", async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ faces: [[40, 20, 80, 60, 60, 40, 100, 40, 80, 50, 65, 65, 95, 65, 0.9]] }));
    const anchor = { frameIndex: 1, pts: 0.25 };
    await executePlanRecipe({ ...request, recipe: { kind: "people", inputId: ID, anchor, profile: PEOPLE } });
    const analysis = vi.mocked(runAnalysisPipeline).mock.calls[0]![0];
    expect(analysis).toMatchObject({ width: 400, height: 200, expectedFrameCount: 1, signal: request.signal, limits: { stdoutBytes: LIMITS.analysisStdoutBytes, stderrTailBytes: LIMITS.stderrTailBytes } });
    expect(analysis.decoder.args).toContain("-noautorotate");
    expect(analysis.decoder.args).toContain("select=eq(n\\,1)");
    expect(JSON.parse(await readFile(request.output, "utf8"))).toEqual({ schemaVersion: 1, kind: "people", anchor, width: 400, height: 200, candidates: [{ detectionIndex: 0, faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.3 } }] });
  });

  it("maps local scene cuts through exact source-PTS range membership without resetting indices", async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ cuts: [{ detectorFrameIndex: 1, detectionScore: 85 }] }));
    await executePlanRecipe({ ...request, recipe: { kind: "scene_cuts", inputId: ID, range: { start: 0.25, end: 1 }, profile: SCENE } });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ expectedFrameCount: 3, width: 400, height: 200, signal: request.signal });
    expect(JSON.parse(await readFile(request.output, "utf8"))).toEqual({ schemaVersion: 1, kind: "scene_cuts", timeBase: "1/1000", frameCount: 4, sourceFrameMapping: FRAMES.slice(1), cuts: [{ frameIndex: 2, pts: 0.55, detectionScore: 85 }] });
  });

  it("rejects an anchor whose PTS no longer matches the frozen source frame", async () => {
    await expect(executePlanRecipe({ ...request, recipe: { kind: "people", inputId: ID, anchor: { frameIndex: 1, pts: 0.3 }, profile: PEOPLE } })).rejects.toThrow();
    expect(runAnalysisPipeline).not.toHaveBeenCalled();
  });

  it("uses source-PTS trim and independent original audio coverage for a segment", async () => {
    vi.mocked(runPlanCommand).mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 400, height: 200 }], format: { duration: "0.65" } })));
    await executePlanRecipe({ ...request, recipe: { kind: "segment", inputId: ID, range: { start: 0.25, end: 0.9 }, audioEnd: 1.1 } });
    const [, args, options] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(args).toContain("-copyts");
    expect(args).toContain("trim=start=0.25:end=0.9,setpts=PTS-0.25/TB");
    expect(args).toContain("atrim=start=0.25:end=1.1,asetpts=PTS-0.25/TB");
    expect(options.signal).toBe(request.signal);
  });

  it("gives a VFR segment its frozen final display boundary without changing PTS", async () => {
    const frames = [9.3, 9.92, 10.56, 11.22, 11.9, 12.6, 13.32, 14.06, 14.82, 15.6, 16.4].map((pts, frameIndex) => ({ frameIndex, pts }));
    const facts: PlanSource = { ...FACTS, source: { ...FACTS.source, hasAudio: false, frameTable: { frames, videoEnd: 17.22 } } };
    vi.mocked(runPlanCommand).mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 400, height: 200 }], format: { duration: "7.1" } })));
    await executePlanRecipe({ ...request, facts, recipe: { kind: "segment", inputId: ID, range: { start: 9.3, end: 16.4 } } });
    const [, args] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(args[args.indexOf("-bf") + 1]).toBe("0");
    const timing = args[args.indexOf("-bsf:v") + 1];
    expect(timing).toContain("pts=PTS:dts=DTS");
    expect(timing).toContain("eq(N,9)");
    expect(timing).toContain("NEXT_PTS-PTS");
    expect(Number(timing?.match(/,([^,]+)\/TB-PTS/)?.[1])).toBeCloseTo(7.1, 12);
  });

  it("refuses an empty source-frame segment before spawning", async () => {
    vi.mocked(runPlanCommand).mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 400, height: 200 }], format: { duration: "1" } })));
    await expect(executePlanRecipe({ ...request, recipe: { kind: "segment", inputId: ID, range: { start: 2, end: 3 } } })).rejects.toThrow();
    expect(runPlanCommand).not.toHaveBeenCalled();
  });


  it("represents both source video and decoded audio clocks in MP4 edit lists", async () => {
    const facts: PlanSource = { ...FACTS, source: { ...FACTS.source, timeBase: "1/16384" }, raw: { ...RAW, streams: [...RAW.streams.slice(0, 1), { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000" }] } };
    vi.mocked(runPlanCommand).mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 400, height: 200 }], format: { duration: "0.65" } })));
    await executePlanRecipe({ ...request, facts, recipe: { kind: "segment", inputId: ID, range: { start: 0.25, end: 0.9 } } });
    const [, args] = vi.mocked(runPlanCommand).mock.calls[0]!;
    expect(args[args.indexOf("-movie_timescale") + 1]).toBe("6144000");
    expect(args).toContain("atrim=start=0.25:end=0.9,asetpts=PTS-0.25/TB");
  });

  it("preserves both rational clock divisors for bounded arbitrary source clocks", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 16384 }), fc.constantFrom(44100, 48000), async (denominator, rate) => {
      vi.mocked(runPlanCommand).mockClear().mockResolvedValue(Buffer.from(JSON.stringify({ streams: [{ codec_type: "video", width: 400, height: 200 }], format: { duration: "0.65" } })));
      const facts: PlanSource = { ...FACTS, source: { ...FACTS.source, timeBase: `1/${denominator}` }, raw: { ...RAW, streams: [...RAW.streams.slice(0, 1), { index: 1, codec_type: "audio", sample_rate: String(rate) }] } };
      await executePlanRecipe({ ...request, facts, recipe: { kind: "segment", inputId: ID, range: { start: 0.25, end: 0.9 } } });
      const [, args] = vi.mocked(runPlanCommand).mock.calls[0]!;
      const scale = Number(args[args.indexOf("-movie_timescale") + 1]);
      expect(Number.isSafeInteger(scale) && scale > 0).toBe(true);
      expect(scale % denominator).toBe(0);
      expect(scale % rate).toBe(0);
    }), { numRuns: 20 });
  });

});
