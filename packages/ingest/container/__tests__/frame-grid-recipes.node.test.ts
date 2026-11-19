// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Grid recipes on real media (inner#1306 test plan §65.3 R01, R02, R06, R08, R09; frames-split design §4.1, §4.2, §4.3,
 * §5.4, §5.5, §7.16, §7.17).
 *
 * Every recipe reads its tool source by grid slot: the worker writes the grid (fps, gridStart, frameCount, the real video
 * slots realFrameCount) and the tool source (the original with its keyframe statistics, or the edit-friendly file), and the
 * container places source frames with the design's chain `setpts=PTS-gridStart/TB,tpad=stop=-1,fps=...:start_time=0:round=near,trim`.
 * The oracle decodes the whole file through that chain; a recipe's picture for slot i must be the oracle's slot i. Pixel
 * cases encode at crf 0, so H.264 is lossless and only the RGB conversion differs.
 *
 * Samples: the committed ones under `fixtures/frame-grid/` (provenance beside each) and ProRes 4444 with alpha made here.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveVideoColorMatrix } from "@ingest/container/physical-video-probe.js";
import {
  FIXTURES, NOISE, expectSlot, gridOf, mad, oracleFrames, produce, rawFrames, run, stubContainerFetch, type GridFacts,
} from "./helpers/frame-grid-harness.js";

const SOURCE = "10000000-0000-4000-8000-000000000001";
const CHUNK_A = "10000000-0000-4000-8000-0000000000a1";
const CHUNK_B = "10000000-0000-4000-8000-0000000000b1";
const EDIT = "10000000-0000-4000-8000-0000000000e1";

let dir: string;
const samples = new Map<string, { path: string; facts: GridFacts; matrix: string }>();

/**
 * Read one sample's grid and plan matrix.
 * @param name - The file name.
 * @param path - Its path.
 * @param fps - The sample set's rate for it.
 * @returns Nothing.
 */
async function learn(name: string, path: string, fps: [number, number]): Promise<void> {
  const facts = await gridOf(path, { numerator: fps[0], denominator: fps[1] });
  const streams = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", path])).stdout) as { streams: Record<string, unknown>[] };
  samples.set(name, { path, facts, matrix: resolveVideoColorMatrix(streams.streams[0]!) });
}

/**
 * The sample.
 * @param name - Its name.
 * @returns It.
 */
function sample(name: string): { path: string; facts: GridFacts; matrix: string } { return samples.get(name)!; }

/**
 * A `frame` recipe for one slot (§7.17 frame row).
 * @param name - The sample.
 * @param frameIndex - The slot.
 * @param extra - Other fields (alpha target, crop).
 * @returns The recipe.
 */
function frameRecipe(name: string, frameIndex: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { facts, matrix } = sample(name);
  return { kind: "frame", inputId: SOURCE, grid: facts.grid, source: facts.source, frameIndex,
    target: { width: facts.width, height: facts.height, colorMatrix: matrix, toneMap: "none", pngBitDepth: 8, alpha: "none" }, ...extra };
}

/**
 * A lossless video target on the sample's size.
 * @param name - The sample.
 * @param fields - Fields that differ.
 * @returns The target.
 */
function videoTarget(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const { facts, matrix } = sample(name);
  return { width: facts.width, height: facts.height, displayRect: null, colorMatrix: matrix, toneMap: "none", alpha: "none", crf: 0, preset: "ultrafast", ...fields };
}

/**
 * A playback chunk (`chunk_encode`, §5.4) over [start, end) from the original.
 * @param name - The sample.
 * @param start - First slot.
 * @param end - End slot.
 * @param fields - Target fields that differ.
 * @returns The recipe.
 */
function chunkRecipe(name: string, start: number, end: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const { facts } = sample(name);
  return { kind: "chunk_encode", inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start, end }, target: videoTarget(name, fields) };
}

/**
 * The playback file of a sample: two chunks split at `cut`, stitched with the original's audio.
 * @param name - The sample.
 * @param cut - The slot the second chunk starts at.
 * @param fields - Target fields that differ.
 * @returns The stitched MP4's path.
 */
async function playback(name: string, cut: number, fields: Record<string, unknown> = {}): Promise<string> {
  const { path, facts } = sample(name);
  const end = facts.grid.frameCount;
  const [a, b] = await produce({ [SOURCE]: path }, [{ recipe: chunkRecipe(name, 0, cut, fields), contentType: "video/mp4" }, { recipe: chunkRecipe(name, cut, end, fields), contentType: "video/mp4" }]);
  const files = [join(dir, `${name}-${cut}-a.mp4`), join(dir, `${name}-${cut}-b.mp4`)];
  await writeFile(files[0]!, a!);
  await writeFile(files[1]!, b!);
  const [stitched] = await produce({ [SOURCE]: path, [CHUNK_A]: files[0]!, [CHUNK_B]: files[1]! }, [{
    recipe: { kind: "stitch", chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: cut } }, { inputId: CHUNK_B, frames: { start: cut, end } }],
      inputId: SOURCE, grid: facts.grid, audio: facts.audioEnd !== null, target: videoTarget(name, fields) },
    contentType: "video/mp4",
  }]);
  const out = join(dir, `${name}-${cut}-playback.mp4`);
  await writeFile(out, stitched!);
  return out;
}

/**
 * Save bytes and decode them.
 * @param bytes - The output.
 * @param suffix - Its file suffix.
 * @param format - Raw format.
 * @param input - Input options.
 * @returns The pictures.
 */
async function decoded(bytes: Uint8Array, suffix: string, format: "rgb24" | "rgba" = "rgb24", input: string[] = []): Promise<Buffer[]> {
  const path = join(dir, `out-${Math.random().toString(36).slice(2)}${suffix}`);
  await writeFile(path, bytes);
  return rawFrames(path, format, undefined, input);
}

/**
 * A stream's facts.
 * @param path - The file.
 * @param stream - The selector.
 * @returns The first matching ffprobe stream.
 */
async function streamOf(path: string, stream: string): Promise<Record<string, unknown> | undefined> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", stream, "-show_streams", "-of", "json", path]);
  return (JSON.parse(stdout) as { streams: Record<string, unknown>[] }).streams[0];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "frame-grid-recipes-"));
  await learn("negcts.mp4", join(FIXTURES, "negcts.mp4"), [25, 1]);
  await learn("vlate.mp4", join(FIXTURES, "vlate.mp4"), [25, 1]);
  await learn("ts14.m2t", join(FIXTURES, "ts14.m2t"), [25, 1]);
  await learn("x50g5.avi", join(FIXTURES, "x50g5.avi"), [50, 1]);
  await learn("slides.mp4", join(FIXTURES, "slides.mp4"), [30, 1]);
  await learn("tm2.mp4", join(FIXTURES, "tm2.mp4"), [60, 1]);
  // Half-transparent ProRes 4444 (the transparent edit-friendly format, §4.2), alpha varying across the picture.
  const prores = join(dir, "alpha4444.mov");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=s=160x96:r=25:d=1",
    "-vf", "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='64+X',format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", prores]);
  await learn("alpha4444.mov", prores, [25, 1]);
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => { stubContainerFetch(); });

describe("the grid the samples present (oracle sanity)", () => {
  it("R01 negcts.mp4 holds one slot for its longer audio, vlate.mp4 pads its head, tm2.mp4 keeps its last source frame", async () => {
    expect(sample("negcts.mp4").facts.grid).toMatchObject({ frameCount: 151, realFrameCount: 150 });
    expect(sample("vlate.mp4").facts.grid.gridStart).toEqual({ numerator: 0, denominator: 1 });
    expect(sample("vlate.mp4").facts.firstVideo).toBeCloseTo(0.5, 6);
    expect(sample("tm2.mp4").facts.grid).toMatchObject({ frameCount: 1360, realFrameCount: 1360 });
    // Per the sample set's rate table, tm2.mp4 keeps 319 distinct source frames on its 60 fps grid, the last one included.
    const oracle = await oracleFrames(sample("tm2.mp4").path, sample("tm2.mp4").facts.grid);
    expect(new Set(oracle.map((frame) => frame.toString("base64"))).size).toBe(319);
  }, 120_000);
});

describe.concurrent("frame: the PNG of one grid slot (§7.17 frame row)", () => {
  it.each([
    ["negcts.mp4", [0, 1, 30, 65, 101, 149]],
    ["vlate.mp4", [0, 6, 12, 13, 14, 100, 161]],
    ["ts14.m2t", [0, 1, 2, 75, 150]],
    ["tm2.mp4", [0, 300, 1358, 1359]],
  ] as const)("R01 %s: frames %j are the oracle's slots, head pad and last source frame included", async (name, slots) => {
    const { path, facts } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const pngs = await produce({ [SOURCE]: path }, slots.map((slot) => ({ recipe: frameRecipe(name, slot), contentType: "image/png" })));
    for (const [at, png] of pngs.entries()) expectSlot((await decoded(png, ".png"))[0]!, oracle, slots[at]!, `${name} frame ${slots[at]}`);
  }, 120_000);

  it("R01 a transparent source's frame is an RGBA PNG whose alpha is the source's", async () => {
    const { path, facts } = sample("alpha4444.mov");
    const oracle = await oracleFrames(path, facts.grid, "rgba");
    const [png] = await produce({ [SOURCE]: path }, [{ recipe: frameRecipe("alpha4444.mov", 12, { target: { width: 160, height: 96, colorMatrix: sample("alpha4444.mov").matrix, toneMap: "none", pngBitDepth: 16, alpha: "straight" } }), contentType: "image/png" }]);
    const view = new DataView(png!.buffer, png!.byteOffset);
    expect({ bitDepth: png![24], colorType: png![25] }, "a 16-bit RGBA PNG for the 10-bit transparent source").toEqual({ bitDepth: 16, colorType: 6 });
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([160, 96]);
    expectSlot((await decoded(png!, ".png", "rgba"))[0]!, oracle, 12, "alpha4444.mov frame 12 with alpha");
  }, 120_000);
});

describe.concurrent("R06 a slot in the hold takes the last source frame (§4.1 网格终点 row, §7.16)", () => {
  it.each([["negcts.mp4"], ["x50g5.avi"], ["slides.mp4"]] as const)("R06 %s: every hold slot is the last source frame", async (name) => {
    const { path, facts } = sample(name);
    const { frameCount, realFrameCount } = facts.grid;
    expect(frameCount, `${name} has a hold`).toBeGreaterThan(realFrameCount);
    const oracle = await oracleFrames(path, facts.grid);
    const slots = [...new Set([realFrameCount - 1, realFrameCount, frameCount - 1])];
    const pngs = await produce({ [SOURCE]: path }, slots.map((slot) => ({ recipe: frameRecipe(name, slot), contentType: "image/png" })));
    for (const [at, png] of pngs.entries()) {
      const picture = (await decoded(png, ".png"))[0]!;
      expectSlot(picture, oracle, slots[at]!, `${name} frame ${slots[at]}`);
      expect(mad(picture, oracle[realFrameCount - 1]!), `${name} slot ${slots[at]} is the last source frame`).toBeLessThanOrEqual(NOISE);
    }
  }, 120_000);
});

describe.concurrent("segment: a split output over grid slots (§7.17 segment row, §4.4)", () => {
  it.each([
    ["negcts.mp4", 30, 77],
    ["vlate.mp4", 0, 40],
    ["negcts.mp4", 140, 151],
  ] as const)("R01 %s [%i, %i): exactly those slots, and audio of the same grid time", async (name, start, end) => {
    const { path, facts } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const [mp4] = await produce({ [SOURCE]: path }, [{
      recipe: { kind: "segment", inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start, end }, target: videoTarget(name, { format: "mp4-h264" }), audio: true },
      contentType: "video/mp4",
    }]);
    const file = join(dir, `seg-${name}-${start}.mp4`);
    await writeFile(file, mp4!);
    const frames = await rawFrames(file, "rgb24");
    expect(frames).toHaveLength(end - start);
    frames.forEach((frame, at) => expectSlot(frame, oracle, start + at, `${name} segment slot ${start + at}`));
    const audio = await streamOf(file, "a:0");
    const fps = facts.grid.fps.numerator / facts.grid.fps.denominator;
    expect(audio, "the segment carries the original's audio").toMatchObject({ codec_name: "aac", sample_rate: "48000" });
    // §4.4: [start/fps, end/fps) on the 48 kHz grid.
    const samplesIn = Math.round((end / fps) * 48000) - Math.round((start / fps) * 48000);
    expect(Number(audio!.duration)).toBeCloseTo(samplesIn / 48000, 4);
    expect(Number((await streamOf(file, "v:0"))!.duration)).toBeCloseTo((end - start) / fps, 4);
  }, 120_000);

  it("R01 a transparent source splits to VP9 with its alpha", async () => {
    const { path, facts } = sample("alpha4444.mov");
    const oracle = await oracleFrames(path, facts.grid, "rgba");
    const [webm] = await produce({ [SOURCE]: path }, [{
      recipe: { kind: "segment", inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start: 5, end: 15 },
        target: videoTarget("alpha4444.mov", { alpha: "straight", format: "webm-vp9" }), audio: false },
      contentType: "video/webm",
    }]);
    const frames = await decoded(webm!, ".webm", "rgba", ["-c:v", "libvpx-vp9"]);
    expect(frames).toHaveLength(10);
    frames.forEach((frame, at) => expectSlot(frame, oracle, 5 + at, `alpha segment slot ${5 + at}`));
  }, 120_000);
});

describe.concurrent("chunk_encode and stitch: the playback file (§5.4, §7.17)", () => {
  it.each([["negcts.mp4", 75], ["vlate.mp4", 40], ["ts14.m2t", 61], ["tm2.mp4", 700]] as const)("R01 %s split at %i: the stitched file is every grid slot, audio to the grid end", async (name, cut) => {
    const { path, facts } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const out = await playback(name, cut);
    const frames = await rawFrames(out, "rgb24");
    expect(frames).toHaveLength(facts.grid.frameCount);
    frames.forEach((frame, at) => expectSlot(frame, oracle, at, `${name} playback slot ${at}`));
    const fps = facts.grid.fps.numerator / facts.grid.fps.denominator;
    expect(Number((await streamOf(out, "v:0"))!.duration)).toBeCloseTo(facts.grid.frameCount / fps, 4);
    const audio = await streamOf(out, "a:0");
    if (facts.audioEnd === null) expect(audio).toBeUndefined();
    else expect(Number(audio!.duration)).toBeCloseTo(Math.round((facts.grid.frameCount / fps) * 48000) / 48000, 4);
  }, 180_000);

  it("R02 a frame decoded from a mid-GOP keyframe is the playback file's frame at the same slot (§1.2)", async () => {
    const name = "negcts.mp4";
    const { path, facts } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const played = await rawFrames(await playback(name, 75), "rgb24");
    // negcts.mp4 has a keyframe every 12 frames; these slots sit inside GOPs that start after the file's first.
    const slots = [17, 30, 65, 101, 143];
    const pngs = await produce({ [SOURCE]: path }, slots.map((slot) => ({ recipe: frameRecipe(name, slot), contentType: "image/png" })));
    for (const [at, png] of pngs.entries()) {
      const picture = (await decoded(png, ".png"))[0]!;
      expectSlot(picture, oracle, slots[at]!, `frame ${slots[at]}`);
      expect(mad(picture, played[slots[at]!]!), `frame ${slots[at]} matches the playback file`).toBeLessThanOrEqual(NOISE);
    }
  }, 180_000);
});

describe.concurrent("R08 the playback file's video packets (§4.3 不透明 row)", () => {
  it.each([["negcts.mp4", 75], ["ts14.m2t", 61], ["x50g5.avi", 38]] as const)("R08 %s: first pts 0, every packet 1/fps, no B-frames, H.264 High 4:2:0 with AAC 48 kHz", async (name, cut) => {
    const { facts } = sample(name);
    const out = await playback(name, cut, { crf: 18, preset: "medium" });
    const video = (await streamOf(out, "v:0"))!;
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", has_b_frames: 0 });
    expect(await streamOf(out, "a:0")).toMatchObject({ codec_name: "aac", sample_rate: "48000" });
    const [tbNum, tbDen] = String(video.time_base).split("/").map(Number);
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts,dts,duration", "-of", "csv=p=0", out]);
    const packets = stdout.trim().split("\n").map((line) => line.split(",").map(Number));
    expect(packets).toHaveLength(facts.grid.frameCount);
    expect(packets[0]![0], "the first video packet is shown at 0").toBe(0);
    const { numerator, denominator } = facts.grid.fps;
    for (const [pts, dts, duration] of packets) {
      expect(pts, "no B-frames: shown when decoded").toBe(dts);
      // duration × time base = 1/fps exactly.
      expect(duration! * tbNum! * numerator).toBe(tbDen! * denominator);
    }
  }, 180_000);
});

describe.concurrent("edit_encode and its stitch: the edit-friendly file (§4.2)", () => {
  it("R01 an opaque source's edit file is all-intra H.264 from 0, every grid slot, no audio; a playback chunk read from it is the same slots", async () => {
    const name = "vlate.mp4";
    const { path, facts, matrix } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const edit = (start: number, end: number): Record<string, unknown> => ({
      kind: "edit_encode", inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start, end },
      edit: { profile: "edit_h264_intra_8bit_420", crf: 0, preset: "ultrafast" },
      color: { matrix, transfer: null, primaries: null, range: "tv", chromaLocation: "left" }, toneMap: "none",
    });
    const end = facts.grid.frameCount;
    const [a, b] = await produce({ [SOURCE]: path }, [{ recipe: edit(0, 70), contentType: "video/mp4" }, { recipe: edit(70, end), contentType: "video/mp4" }]);
    const parts = [join(dir, "edit-a.mp4"), join(dir, "edit-b.mp4")];
    await writeFile(parts[0]!, a!);
    await writeFile(parts[1]!, b!);
    const [stitched] = await produce({ [CHUNK_A]: parts[0]!, [CHUNK_B]: parts[1]! }, [{
      recipe: { kind: "stitch", chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 70 } }, { inputId: CHUNK_B, frames: { start: 70, end } }], grid: facts.grid,
        edit: { profile: "edit_h264_intra_8bit_420" } },
      contentType: "video/mp4",
    }]);
    const file = join(dir, "vlate-edit.mp4");
    await writeFile(file, stitched!);
    expect(await streamOf(file, "a:0"), "the edit file has no audio").toBeUndefined();
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", file]);
    const packets = stdout.trim().split("\n").map((line) => line.split(","));
    expect(packets).toHaveLength(end);
    expect(Number(packets[0]![0]), "the first frame is at 0").toBe(0);
    expect(packets.every(([, flags]) => flags!.startsWith("K")), "every frame is a keyframe").toBe(true);
    const frames = await rawFrames(file, "rgb24");
    frames.forEach((frame, at) => expectSlot(frame, oracle, at, `edit file slot ${at}`));
    // A playback chunk whose tool source is the edit file reads slot i at i/fps (§7.16 工具源为编辑用文件).
    const editGrid = { ...facts.grid, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: end };
    const [chunk] = await produce({ [EDIT]: file }, [{
      recipe: { kind: "chunk_encode", inputId: EDIT, grid: editGrid, source: { kind: "edit" }, frames: { start: 33, end: 47 }, target: videoTarget(name) },
      contentType: "video/mp4",
    }]);
    const read = await decoded(chunk!, ".mp4");
    expect(read).toHaveLength(14);
    read.forEach((frame, at) => expectSlot(frame, oracle, 33 + at, `chunk from the edit file slot ${33 + at}`));
  }, 180_000);

  it("R01 a transparent source's edit file is ProRes 4444 with its alpha", async () => {
    const { path, facts, matrix } = sample("alpha4444.mov");
    const oracle = await oracleFrames(path, facts.grid, "rgba");
    const [mov] = await produce({ [SOURCE]: path }, [{
      recipe: { kind: "edit_encode", inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start: 0, end: facts.grid.frameCount },
        edit: { profile: "edit_prores", crf: 0, preset: "ultrafast" }, color: { matrix, transfer: null, primaries: null, range: "tv", chromaLocation: "left" }, toneMap: "none" },
      contentType: "video/quicktime",
    }]);
    const file = join(dir, "alpha-edit.mov");
    await writeFile(file, mov!);
    expect(await streamOf(file, "v:0")).toMatchObject({ codec_name: "prores", profile: "4444", pix_fmt: "yuva444p10le" });
    const frames = await rawFrames(file, "rgba");
    expect(frames).toHaveLength(facts.grid.frameCount);
    frames.forEach((frame, at) => expectSlot(frame, oracle, at, `ProRes edit slot ${at}`));
  }, 180_000);
});

describe.concurrent("R09 the video focus crop: frame plus crop (§5.5 配方 row)", () => {
  it.each([["negcts.mp4", 65], ["vlate.mp4", 3], ["negcts.mp4", 150]] as const)("R09 %s slot %i: the PNG is the tool source's frame cut to the box", async (name, slot) => {
    const { path, facts } = sample(name);
    const oracle = await oracleFrames(path, facts.grid);
    const rect = { x: 50, y: 30, width: 101, height: 77 };
    const [png] = await produce({ [SOURCE]: path }, [{
      recipe: frameRecipe(name, slot, { crop: { sourceWidth: facts.width, sourceHeight: facts.height, rect } }), contentType: "image/png",
    }]);
    const picture = (await decoded(png!, ".png"))[0]!;
    const row = facts.width * 3;
    const expected = Buffer.concat(Array.from({ length: rect.height }, (_, y) => oracle[slot]!.subarray((rect.y + y) * row + rect.x * 3, (rect.y + y) * row + (rect.x + rect.width) * 3)));
    expect(picture.length, "the PNG is the box's size").toBe(expected.length);
    expect(mad(picture, expected), `slot ${slot} cut to the box`).toBeLessThanOrEqual(NOISE);
  }, 120_000);
});
