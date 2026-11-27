// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Seeking to a grid slot in the original (inner#1306 test plan §65.3 R03, R04; frames-split design §7.16 工具源为原片 row,
 * §7.17 抽帧解码 row, §5.4 估算 row).
 *
 * A recipe reads slot i of the original by seeking (`-copyts -seek_timestamp 1 -noaccurate_seek -ss`) to one frame before
 * the slot's source position, or from the file's start when that position is earlier than the earliest keyframe packet
 * time plus max(largest keyframe interval, 3/23 s); it checks the first decoded frame's slot and backs off by doubling when
 * it landed late. Every slot read alone, and every 7-slot chunk, must be the whole-file decode's slot (the method of the
 * maintainers' frame-grid sample set, its `seek/check.py`). The samples are the ones FFmpeg's CLI seek gets wrong near the
 * start: Xvid with B-frames in AVI (frames 0–12 decode from a non-keyframe after `-ss 0`), an MP4 cut mid-GOP whose first
 * keyframe the edit list discards (-0.36 s), a TS starting at 1.48 s, negative CTS offsets, video starting after audio,
 * open GOPs, keyframe intervals shorter than 3/23 s (`x50g5.avi`, `x60g6.avi`), and single-keyframe files.
 */
import type * as planCommand from "@ingest/container/plan-command.js";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVideoColorMatrix } from "@ingest/container/physical-video-probe.js";
import { FIXTURES, expectSlot, gridOf, oracleFrames, produce, rawFrames, run, stubContainerFetch, type GridFacts } from "./helpers/frame-grid-harness.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const calls = vi.hoisted(() => [] as { program: string; args: string[] }[]);
vi.mock("@ingest/container/plan-command.js", async (original) => {
  const actual = await original<typeof planCommand>();
  return { ...actual, runPlanCommand: vi.fn(async (program: string, args: readonly string[], options: Parameters<typeof actual.runPlanCommand>[2]) => {
    calls.push({ program, args: [...args] });
    return actual.runPlanCommand(program, args, options);
  }) };
});

const SOURCE = "10000000-0000-4000-8000-000000000001";
/** At most this many outputs per planned job (`MINI_TOOL_JOB_MAX_OUTPUTS`). */
const PER_JOB = 8;
/** The chunk length of the sample set's check. */
const CHUNK = 7;

/** The samples and the grid rate the sample set's rate table gives each (the nominal rate; `slides.mp4` 30). */
const SAMPLES: Record<string, [number, number]> = {
  "avi_xvid_bf.avi": [25, 1], "elst.mp4": [25, 1], "ts14.m2t": [25, 1], "negcts.mp4": [25, 1], "vlate.mp4": [25, 1], "opengop.mp4": [25, 1],
  "hevc_open.mp4": [60000, 1001], "avi_h264_12_5.avi": [25, 2],
  "x50g5.avi": [50, 1], "x60g6.avi": [60, 1], "avi_h264_bf.avi": [30000, 1001], "ts_h264.m2t": [30000, 1001], "slides.mp4": [30, 1],
};
const facts = new Map<string, { facts: GridFacts; matrix: string; oracle: Buffer[] }>();
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "frame-grid-seek-"));
  await Promise.all(Object.entries(SAMPLES).map(async ([name, fps]) => {
    const path = join(FIXTURES, name);
    // The check reads the video only, as `seek/check.py` does: frameCount = V.
    const read = await gridOf(path, { numerator: fps[0], denominator: fps[1] }, false);
    const streams = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", path])).stdout) as { streams: Record<string, unknown>[] };
    facts.set(name, { facts: read, matrix: resolveVideoColorMatrix(streams.streams[0]!), oracle: await oracleFrames(path, read.grid) });
  }));
}, 300_000);
beforeEach(() => { stubContainerFetch(); });

/**
 * Split a list into jobs.
 * @param list - The items.
 * @returns Groups of at most PER_JOB.
 */
function jobs<T>(list: readonly T[]): T[][] {
  return Array.from({ length: Math.ceil(list.length / PER_JOB) }, (_, at) => list.slice(at * PER_JOB, (at + 1) * PER_JOB));
}

/**
 * Read slots one by one with `frame` recipes and expect each to be the oracle's.
 * @param name - The sample.
 * @param slots - The slots.
 */
async function readFrames(name: string, slots: readonly number[]): Promise<void> {
  const { facts: read, matrix, oracle } = facts.get(name)!;
  for (const group of jobs(slots)) {
    const pngs = await produce({ [SOURCE]: join(FIXTURES, name) }, group.map((frameIndex) => ({
      recipe: { kind: "frame", inputId: SOURCE, grid: read.grid, source: read.source, frameIndex,
        target: { width: read.width, height: read.height, colorMatrix: matrix, toneMap: "none", pngBitDepth: 8, alpha: "none" } },
      contentType: "image/png",
    })));
    for (const [at, png] of pngs.entries()) {
      const file = join(dir, `${name}-${group[at]}.png`);
      await writeFile(file, png);
      expectSlot((await rawFrames(file, "rgb24"))[0]!, oracle, group[at]!, `${name} frame ${group[at]}`);
    }
  }
}

/**
 * Read slot ranges with lossless `chunk_encode` recipes and expect every frame to be the oracle's.
 * @param name - The sample.
 * @param starts - Each chunk's first slot; each runs CHUNK slots or to the end.
 */
async function readChunks(name: string, starts: readonly number[]): Promise<void> {
  const { facts: read, matrix, oracle } = facts.get(name)!;
  const end = read.grid.frameCount;
  for (const group of jobs(starts)) {
    const mp4s = await produce({ [SOURCE]: join(FIXTURES, name) }, group.map((start) => ({
      recipe: { kind: "chunk_encode", inputId: SOURCE, grid: read.grid, source: read.source, frames: { start, end: Math.min(start + CHUNK, end) },
        target: { width: read.width, height: read.height, displayRect: null, colorMatrix: matrix, toneMap: "none", alpha: "none", crf: 0, preset: "ultrafast" } },
      contentType: "video/mp4",
    })));
    for (const [at, mp4] of mp4s.entries()) {
      const start = group[at]!;
      const file = join(dir, `${name}-chunk-${start}.mp4`);
      await writeFile(file, mp4);
      const frames = await rawFrames(file, "rgb24");
      expect(frames, `${name} chunk from ${start}`).toHaveLength(Math.min(start + CHUNK, end) - start);
      frames.forEach((frame, offset) => expectSlot(frame, oracle, start + offset, `${name} chunk from ${start}, slot ${start + offset}`));
    }
  }
}

/**
 * Every slot of a sample, or for a long one every tenth plus the last five.
 * @param name - The sample.
 * @returns The slots.
 */
function slotsOf(name: string): number[] {
  const count = facts.get(name)!.facts.grid.frameCount;
  const all = Array.from({ length: count }, (_, at) => at);
  return count <= 200 ? all : [...all.filter((slot) => slot % 10 === 0), ...all.slice(-5)];
}

/**
 * Chunk starts: two tilings of the sample, from 0 and from 3, so chunks start at every phase of a GOP.
 * @param name - The sample.
 * @returns The starts.
 */
function chunkStartsOf(name: string): number[] {
  const count = facts.get(name)!.facts.grid.frameCount;
  const starts: number[] = [];
  for (let start = 0; start < count; start += CHUNK) starts.push(start);
  for (let start = 3; start < count; start += CHUNK) starts.push(start);
  return starts;
}

describe("R03 a seek near the start of a hard sample (§7.16)", () => {
  it("R03 avi_xvid_bf.avi: frames 0 to 12 one by one, and a chunk from frame 2, are the whole-file decode's", async () => {
    await readFrames("avi_xvid_bf.avi", Array.from({ length: 13 }, (_, at) => at));
    await readChunks("avi_xvid_bf.avi", [2]);
  }, 600_000);

  it("R03 elst.mp4: a seek decodes no more than the largest keyframe interval before its slot, never from the discarded keyframe twice", async () => {
    const { facts: read } = facts.get("elst.mp4")!;
    expect(read.source).toEqual({ kind: "original", keyframes: { earliestKeyframeTime: expect.closeTo(-0.36, 9), maxKeyframeInterval: expect.closeTo(0.48, 9), allKeyframes: false } });
    calls.length = 0;
    const slots = [0, 3, 4, 5, 15, 40, 77, read.grid.frameCount - 1];
    await readFrames("elst.mp4", slots);
    // The tool source is read through the loopback reader, so its decodes name a loopback URL as their input.
    const decodes = calls.filter((call) => call.program === "ffmpeg" && call.args.some((arg) => arg.startsWith("http://127.0.0.1:")));
    const fps = 25;
    const keyframes = [-0.36, 0.12, 0.6, 1.08, 1.56, 2.04, 2.52, 3.0, 3.48, 3.96];
    // The first decode of each output: where it starts decoding (the keyframe at or before -ss, or the first one without).
    const outputs = new Map<string, string[]>();
    for (const call of decodes) {
      const output = call.args.find((arg) => /output-\d+/u.test(arg)) ?? "";
      if (!outputs.has(output)) outputs.set(output, call.args);
    }
    expect(outputs.size, "one decode per frame read").toBe(slots.length);
    [...outputs.values()].forEach((args, at) => {
      const ss = args.includes("-ss") ? Number(args[args.indexOf("-ss") + 1]) : null;
      const start = ss === null ? keyframes[0]! : keyframes.filter((key) => key <= ss + 1e-9).at(-1)!;
      const target = slots[at]! / fps;
      expect(target - start, `frame ${slots[at]}: preroll from ${start} (-ss ${ss})`).toBeLessThanOrEqual(0.48 + 1 / fps + 1e-9);
    });
  }, 600_000);

  it.each(["elst.mp4", "ts14.m2t", "negcts.mp4", "vlate.mp4", "opengop.mp4", "hevc_open.mp4", "avi_h264_12_5.avi"])("R03 %s: every slot read alone is the whole-file decode's", async (name) => {
    await readFrames(name, slotsOf(name));
  }, 600_000);

  it.each(["elst.mp4", "ts14.m2t", "negcts.mp4", "vlate.mp4", "opengop.mp4", "hevc_open.mp4", "avi_h264_12_5.avi"])("R03 %s: every 7-slot chunk is the whole-file decode's", async (name) => {
    await readChunks(name, chunkStartsOf(name));
  }, 600_000);
});

describe("R04 keyframes closer than 3/23 s, and a single keyframe (§7.16)", () => {
  it.each(["x50g5.avi", "x60g6.avi", "avi_h264_bf.avi", "ts_h264.m2t", "slides.mp4"])("R04 %s: every slot read alone is the whole-file decode's, and every job ends", async (name) => {
    await readFrames(name, slotsOf(name));
  }, 600_000);

  // slides.mp4's chunks took 413 s on a CI runner, and the same suite ran 1.6 times slower on others (its single-slot
  // case 38 s against 60 s), past 600 s.
  it.each(["x50g5.avi", "x60g6.avi", "avi_h264_bf.avi", "ts_h264.m2t", "slides.mp4"])("R04 %s: every 7-slot chunk is the whole-file decode's", async (name) => {
    await readChunks(name, chunkStartsOf(name));
  }, 1_200_000);
});
