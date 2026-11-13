// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The erase and expand container recipes on real media (inner#1306 execution design §10.2–§10.5; frames-split design §7.17
 * rows as §10.8 changes them).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the standard-4 container does, with every fixture generated here by
 * FFmpeg and every assertion a fact FFmpeg reads back. The edge is faked at `fetch`. Recipe shapes (none is in
 * `miniToolPlanRecipeSchema` yet; they follow §10.2–§10.5 and the conventions of `mini-tool-plan-job.ts`):
 *
 * - `rle_join`: `{ kind, inputs: [{ inputId, order: "forward" | "reverse", frameCount }], width, height }` writes the range's
 *   RLE as a JSON array (`text/plain`): the reversed clip's frames from the range start up to the anchor, then the forward
 *   clip's; when both exist the anchor frame is the forward clip's first. A null entry is a frame without a mask.
 * - `bria_mask`: `{ kind, inputId (RLE), table, range: { startFrame, frameCount }, grid: { mode, rate, frameCount }, target }`
 *   writes `grid.frameCount` lossless full-range frames on `1 / rate`, white where the RLE frame of that grid slot has
 *   foreground and black elsewhere.
 * - `prepare_model_input` gains `order` (`"reverse"` plays the window backwards) and `grid` (`frames`: the window's frames as
 *   they are, re-stamped `N / rate`; `resample`: slot j shows the frame covering window start + j / rate).
 * - `model_window`: the window recipe plus `grid: { fps, frameCount }`, `frame`, `sourceRoi`, `fill`, `span`; slot j shows the
 *   frame covering span.start + j / fps scaled into `sourceRoi` over `fill`, and the last frame of the span repeats to
 *   `frameCount`; lossless.
 * - `model_window_mask`: `{ kind, grid, frame, sourceRoi, span }`, black inside `sourceRoi`, white elsewhere, lossless full range.
 * - `frame_at`: `{ kind, inputId, time, target: { width, height } }` writes the PNG of the frame whose PTS is closest to
 *   `time`, the earlier on a tie.
 * - `model_composite` erase: the window recipe plus `{ mode: "erase", result, rle, table, range, grid, matte: { dilate,
 *   feather }, rleSize }`; each presented frame in the range takes its grid slot's result frame (the result's own timestamps
 *   ignored), blended as source × (1 − m) + result × m with m the frame's RLE mask dilated and feathered; outside the range
 *   the source. A result whose frame count differs from `grid.frameCount` fails with `model_output_mismatch`.
 *
 * Readings this file makes (recorded for review): `window` holds presentation frame indices, as the admission's chunk
 * windows do; a grid slot of a frame is the last slot whose time is not after the frame's start (§10.4).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { modelResultDecode } from '@ingest/container/presentation-recipes.js';
import { canonicalMediaType } from '@shared/upload/media-type.js';
import { sniffMimeType } from '@shared/upload/sniff-mime.js';
import type { VideoPresentationTable } from '@shared/mini-tools/video-presentation-table.js';
import { cocoCounts } from './helpers/coco-counts.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
interface Report { ok: boolean; reason?: string; outputs: { outputIndex: number }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; color_range?: string; color_space?: string }
type Rgb = readonly [number, number, number];
interface Packet { pts_time: string; duration_time: string; flags: string }

const r = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const W = 64;
const H = 36;
const TARGET = { width: W, height: H, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
// A lossless segment, so a colour comparison measures the decode matrices and not the encoder's error.
const LOSSLESS_TARGET = { ...TARGET, crf: 0 };
const HDR = { colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const RESULT = '10000000-0000-4000-8000-0000000000e0';
const RLE = '10000000-0000-4000-8000-0000000000d0';
const FORWARD = '10000000-0000-4000-8000-0000000000d1';
const REVERSE = '10000000-0000-4000-8000-0000000000d2';
const BACKGROUND = '10000000-0000-4000-8000-0000000000b0';
const cfr = (fps: number, count: number): VideoPresentationTable => ({ schemaVersion: 1, timescale: fps, runs: [{ start: 0, count, step: 1, duration: 1 }] });
// The VFR fixture's eight frames in milliseconds: 50 ms and 33 ms alternating, 332 ms in all (24.1 fps on average).
const VFR_STARTS = [0, 50, 83, 133, 166, 216, 249, 299];
const VFR_END = 332;
const VFR: VideoPresentationTable = {
  schemaVersion: 1, timescale: 1000,
  runs: VFR_STARTS.map((start, at) => ({ start, count: 1, step: (VFR_STARTS[at + 1] ?? VFR_END) - start, duration: (VFR_STARTS[at + 1] ?? VFR_END) - start })),
};
const LEFT = (x: number): boolean => x < 32;
const LEFT_IN: Rect = { x: 2, y: 2, width: 26, height: 32 };
const RIGHT_IN: Rect = { x: 36, y: 2, width: 26, height: 32 };
// greys-tone.mp4's AAC audio as the probe's plan records it: one edit skipping the AAC priming.
const TONE_AUDIO = { start: r(0), end: r(2), origin: r(0), spans: [{ sourceStart: r(256, 11025), sourceEnd: r(22306, 11025), presentationStart: r(0), rate: r(1) }] };

let dir: string;
let served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
let reports: Report[] = [];

/**
 * Generate one fixture with FFmpeg.
 * @param name - Its file name.
 * @param args - FFmpeg arguments before the output path.
 * @returns Nothing.
 */
async function make(name: string, args: string[]): Promise<void> {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, join(dir, name)]);
}

/**
 * Generate a lossless H.264 video whose luma is a geq expression of X, Y and the frame N.
 * @param name - Its file name.
 * @param luma - The luma expression.
 * @param clip - Its size, rate, frame count and track timescale.
 * @param chroma - The constant Cb and Cr.
 * @returns Nothing.
 */
async function lossless(name: string, luma: string, clip: { width?: number; height?: number; fps: string; frames: number; timescale: number }, chroma = { cb: 128, cr: 128 }): Promise<void> {
  const [width, height] = [clip.width ?? W, clip.height ?? H];
  await make(name, ['-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${clip.fps},format=yuv420p,geq=lum='${luma}':cb=${chroma.cb}:cr=${chroma.cr}`,
    '-frames:v', String(clip.frames), '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-video_track_timescale', String(clip.timescale)]);
}

/**
 * Write an RLE file: one COCO counts string, or null, per frame.
 * @param name - Its file name.
 * @param frames - Each frame's foreground test, or null for a frame without a mask.
 * @param size - The mask size, 64x36 when absent.
 * @returns Its path.
 */
async function rle(name: string, frames: (((x: number, y: number) => boolean) | null)[], size = { width: W, height: H }): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(frames.map(foreground => (foreground === null ? null : cocoCounts(size.width, size.height, foreground)))));
  return path;
}

/**
 * Run one planned job with one output per recipe and read back what it wrote.
 * @param inputs - Input id to served file path.
 * @param recipes - One recipe per output.
 * @param contentType - The outputs' content type.
 * @returns The report and the written output paths in output order.
 */
async function runJob(inputs: Record<string, string>, recipes: Recipe[], contentType = 'video/mp4'): Promise<{ report: Report; files: string[] }> {
  const tag = Math.random().toString(36).slice(2);
  const bound = Object.entries(inputs).map(([inputId, path]) => {
    const url = `http://inputs.test/${tag}/${inputId}`;
    served.set(url, path);
    return { inputId, url };
  });
  const outputs = recipes.map((recipe, outputIndex) => ({
    outputIndex, key: `video/source.mp4.job-${tag}-${outputIndex}`, url: `http://outputs.test/${tag}/${outputIndex}`, contentType, recipe,
  }));
  reports = [];
  await runPlanJob({
    schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: bound, outputs, reportUrl: 'http://jobs.test/report',
  } as unknown as PlanRunBody);
  const files = await Promise.all(outputs.map(async ({ url, outputIndex }) => {
    const path = join(dir, `${tag}-${outputIndex}.out`);
    const bytes = written.get(url);
    if (bytes !== undefined) await writeFile(path, bytes);
    return path;
  }));
  return { report: reports[0]!, files };
}

/**
 * Run one job with one output, require it to succeed and its bytes to read as the planned type.
 * @param inputs - Input id to served file path.
 * @param recipe - The recipe.
 * @param contentType - The output's content type.
 * @returns The written output path.
 */
async function produce(inputs: Record<string, string>, recipe: Recipe, contentType = 'video/mp4'): Promise<string> {
  const { report, files } = await runJob(inputs, [recipe], contentType);
  expect(report.ok, `the job reports ok (${JSON.stringify(vi.mocked(console.error).mock.calls)})`).toBe(true);
  expect(report.outputs.map(output => output.outputIndex)).toEqual([0]);
  expect(canonicalMediaType(await sniffMimeType(new Uint8Array(await readFile(files[0]!)))), 'the output reads as its planned type').toBe(contentType);
  return files[0]!;
}

/**
 * Run one job with one output and require it to fail with a reason.
 * @param inputs - Input id to served file path.
 * @param recipe - The recipe.
 * @param reason - The expected failure reason.
 * @param contentType - The output's content type.
 * @returns Nothing.
 */
async function fails(inputs: Record<string, string>, recipe: Recipe, reason: string, contentType = 'video/mp4'): Promise<void> {
  const { report } = await runJob(inputs, [recipe], contentType);
  expect([report.ok, report.reason, report.outputs]).toEqual([false, reason, []]);
}

/**
 * The video stream of a file.
 * @param path - The file.
 * @returns Its first video stream.
 */
async function video(path: string): Promise<Stream> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
  return (JSON.parse(stdout) as { streams: Stream[] }).streams.find(stream => stream.codec_type === 'video')!;
}

/**
 * The video packets of a file in presentation order.
 * @param path - The file.
 * @returns Their pts, duration and flags.
 */
async function packets(path: string): Promise<Packet[]> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'json', path]);
  return (JSON.parse(stdout) as { packets: Packet[] }).packets.sort((a, b) => Number(a.pts_time) - Number(b.pts_time));
}

/**
 * The stored Y plane of every stored frame, with passthrough timing.
 * @param path - The file.
 * @returns The plane width and one plane per frame.
 */
async function yPlanes(path: string): Promise<{ width: number; frames: Buffer[] }> {
  const stream = await video(path);
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-vf', 'extractplanes=y', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const size = stream.width! * stream.height!;
  return { width: stream.width!, frames: Array.from({ length: bytes.length / size }, (_unused, frame) => bytes.subarray(frame * size, frame * size + size)) };
}

/**
 * The mean of a rectangle of one plane.
 * @param plane - The plane bytes.
 * @param width - The plane width.
 * @param rect - The rectangle.
 * @returns The mean.
 */
function mean(plane: Buffer, width: number, rect: Rect): number {
  let sum = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) sum += plane[y * width + x]!;
  return sum / (rect.width * rect.height);
}

/**
 * The mean stored luma of a rectangle of every stored frame.
 * @param path - The file.
 * @param rect - The rectangle, the whole 64x36 picture when absent.
 * @returns One mean per frame.
 */
async function lumaMeans(path: string, rect: Rect = { x: 0, y: 0, width: W, height: H }): Promise<number[]> {
  const { width, frames } = await yPlanes(path);
  return frames.map(plane => mean(plane, width, rect));
}

/**
 * The mean red, green and blue of a rectangle of every frame, decoded to RGB by FFmpeg from the stream's own tags with
 * accurate rounding and full chroma interpolation (swscale's fast YUV-to-RGB path is off by up to three).
 * @param path - The file.
 * @param size - The picture size.
 * @param rect - The rectangle.
 * @returns Per frame, [R, G, B].
 */
async function rgbMeans(path: string, size: { width: number; height: number }, rect: Rect): Promise<number[][]> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-sws_flags', 'accurate_rnd+full_chroma_int',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const frame = size.width * size.height * 3;
  return Array.from({ length: bytes.length / frame }, (_unused, at) => [0, 1, 2].map((channel) => {
    let sum = 0;
    for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) sum += bytes[at * frame + (y * size.width + x) * 3 + channel]!;
    return sum / (rect.width * rect.height);
  }));
}

// Saturated colours whose BT.601 and BT.709 decodes differ by well over the tolerance below.
const RED: Rgb = [200, 40, 60];
const GREEN: Rgb = [40, 180, 70];
const BLUE: Rgb = [50, 70, 210];
// How the providers write a result (measured on VACE expand and Bria eraser output): RGB converted by swscale's default
// BT.601 with no colour tags; the tagged case is a BT.709 limited-range result such as lip-sync returns.
// Each band's rows clear of the chroma resampling across its edges (a 4:2:0 to 4:4:4 round trip spreads it about four rows).
const threeBands = (_x: number, y: number): Rgb => (y < 12 ? RED : y < 24 ? GREEN : BLUE);
const BAND_ROWS = [{ y: 2, height: 6, colour: RED }, { y: 16, height: 4, colour: GREEN }, { y: 28, height: 6, colour: BLUE }] as const;
const RESULT_TAGGINGS = [['untagged and encoded BT.601, as the providers write it', false], ['tagged BT.709 limited range', true]] as const;

/**
 * Encode an RGB picture, repeated, as a model provider does: rgb24 to yuv420p by swscale's default BT.601 with no colour
 * tags, or converted and tagged BT.709 limited range.
 * @param name - Its file name.
 * @param clip - Its size, rate and frame count.
 * @param colourAt - Each pixel's RGB.
 * @param tagged - Whether the result is tagged BT.709.
 * @returns Its path.
 */
async function providerVideo(name: string, clip: { width: number; height: number; fps: number; frames: number }, colourAt: (x: number, y: number) => Rgb, tagged: boolean): Promise<string> {
  const picture = Buffer.alloc(clip.width * clip.height * 3);
  for (let y = 0; y < clip.height; y += 1) for (let x = 0; x < clip.width; x += 1) picture.set(colourAt(x, y), (y * clip.width + x) * 3);
  const raw = join(dir, `${name}.rgb`);
  await writeFile(raw, Buffer.concat(Array.from({ length: clip.frames }, () => picture)));
  const tags = tagged ? ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_range', 'tv'] : [];
  await make(name, ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${clip.width}x${clip.height}`, '-framerate', String(clip.fps), '-i', raw, ...tags,
    '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(clip.fps)]);
  const path = join(dir, name);
  expect((await video(path)).color_space, 'the fixture carries the provider\'s tags').toBe(tagged ? 'bt709' : undefined);
  return path;
}

// swscale's default (not accurate_rnd) BT.601-to-BT.709 conversion of a 4:2:0 picture is off by up to 5 on a saturated
// channel in the amd64 media image (up to 4 on arm64); decoding with the wrong matrix is off by 11 or more on these colours.
const RGB_TOLERANCE = 6;

/**
 * Require a measured mean RGB to be an expected colour within the conversion's rounding ({@link RGB_TOLERANCE}).
 * @param measured - The mean [R, G, B].
 * @param expected - The colour.
 * @param label - What was measured.
 * @returns Nothing.
 */
function expectRgb(measured: number[], expected: readonly number[], label: string): void {
  measured.forEach((channel, at) => expect(Math.abs(channel - expected[at]!), `${label} ${'RGB'[at]} (${measured.map(Math.round).join(',')} vs ${expected.join(',')})`).toBeLessThan(RGB_TOLERANCE));
}

/**
 * Require every frame's Y plane to be exactly white where a mask holds and exactly black elsewhere.
 * @param path - The file.
 * @param masks - Per frame, whether a pixel is white.
 * @returns Nothing.
 */
async function expectBinaryFrames(path: string, masks: ((x: number, y: number) => boolean)[]): Promise<void> {
  const { width, frames } = await yPlanes(path);
  expect(frames).toHaveLength(masks.length);
  frames.forEach((plane, at) => {
    let wrong = 0;
    for (let y = 0; y < plane.length / width; y += 1) for (let x = 0; x < width; x += 1) if (plane[y * width + x] !== (masks[at]!(x, y) ? 255 : 0)) wrong += 1;
    expect(wrong, `frame ${at} pixels off the binary mask`).toBe(0);
  });
}

/**
 * A source span over [start, end) seconds from a keyframe at the start.
 * @param start - Its presentation start.
 * @param end - Its presentation end.
 * @returns The span.
 */
function span(start: Exact, end: Exact): Recipe {
  return { kind: 'source', decodeStart: start, clipStart: start, displayStart: start, displayEnd: end, rate: r(1) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'erase-expand-recipes-'));
  // Sources: 25 fps (frame n luma 16 + 20n), 60 fps (16 + 15n), 29.97 fps on a 1 ms track clock (16 + 12n), VFR (40 + 20n).
  await lossless('greys25.mp4', '16+20*N', { fps: '25', frames: 10, timescale: 25 });
  await lossless('greys60.mp4', '16+15*N', { fps: '60', frames: 12, timescale: 60 });
  await lossless('greys2997.mp4', '16+12*N', { fps: '30000/1001', frames: 15, timescale: 1000 });
  // Nine stored frames so the eighth ends at 332 ms; the table and every recipe use the first eight. FFmpeg 8's setpts keeps
  // the 30 fps rate, so without the explicit encoder time base the timestamps are quantized to 1/30 s.
  await make('vfr.mp4', ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30,format=yuv420p,geq=lum='40+20*N':cb=128:cr=128,settb=1/1000,setpts='floor(N/2)*83+mod(N,2)*50'`,
    '-frames:v', '9', '-fps_mode', 'passthrough', '-enc_time_base:v', '1/1000', '-c:v', 'libx264', '-qp', '0', '-g', '4', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-video_track_timescale', '1000']);
  await make('greys-tone.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=2,format=yuv420p,geq=lum='16+4*N':cb=128:cr=128", '-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=2',
    '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-g', '25', '-video_track_timescale', '25', '-c:a', 'aac', '-shortest']);
  await make('clip-hdr.mp4', ['-f', 'lavfi', '-i', 'color=c=0xB08060:s=64x36:r=25:d=0.4', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p10le',
    '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-g', '10', '-video_track_timescale', '25']);
  // Model results, each on a clock of its own that the composite ignores: 30 fps with Cb 90 and Cr 170.
  const result = { cb: 90, cr: 170 };
  await lossless('result4.mp4', '200+10*N', { fps: '30', frames: 4, timescale: 30 }, result);
  await lossless('result5.mp4', '200+10*N', { fps: '30', frames: 5, timescale: 30 }, result);
  await lossless('result6.mp4', '170+12*N', { fps: '30', frames: 6, timescale: 30 }, result);
  await lossless('result8.mp4', '120+12*N', { fps: '30', frames: 8, timescale: 30 }, result);
  await lossless('result10.mp4', '230', { fps: '30', frames: 10, timescale: 30 }, result);
  // A VACE output at 16 fps: frame n luma 40 + 20n.
  await lossless('vace16.mp4', '40+20*N', { fps: '16', frames: 8, timescale: 16 });
  // A ten-second 25 fps source and a 159-frame 16 fps background (one frame short of a ten-second window), 128x72.
  await lossless('long.mp4', '16+N/2', { fps: '25', frames: 250, timescale: 25 });
  await lossless('bg159.mp4', '60+N', { width: 128, height: 72, fps: '16', frames: 159, timescale: 16 });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  served = new Map();
  written.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') {
      written.set(url, new Uint8Array(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (init?.method === 'POST') {
      reports.push(JSON.parse(String(init.body)) as Report);
      return new Response(null, { status: 200 });
    }
    const path = served.get(url);
    if (path === undefined) return new Response(null, { status: 404 });
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

describe('rle_join (execution design §10.2)', () => {
  // Range [0, 6) anchored at 2: frame k's foreground is x < 4 + 4k; the forward clip holds frames 2..5 with frame 4 unmasked,
  // the reversed clip holds frames 2, 1, 0, its anchor frame drawn differently (x < 60) so the join shows which one it took.
  const frame = (k: number) => (x: number): boolean => x < 4 + 4 * k;
  const counts = (k: number): string => cocoCounts(W, H, frame(k));

  /**
   * Read a written RLE file.
   * @param path - The file.
   * @returns Its entries.
   */
  async function entries(path: string): Promise<(string | null)[]> {
    return JSON.parse(await readFile(path, 'utf8')) as (string | null)[];
  }

  it('RJ01 joins the reversed clip up to the anchor and the forward clip from it, the anchor from the forward clip, keeping null frames', async () => {
    const forward = await rle('fwd.json', [frame(2), frame(3), null, frame(5)]);
    const reverse = await rle('rev.json', [(x: number): boolean => x < 60, frame(1), frame(0)]);
    const file = await produce({ [FORWARD]: forward, [REVERSE]: reverse },
      { kind: 'rle_join', inputs: [{ inputId: FORWARD, order: 'forward', frameCount: 4 }, { inputId: REVERSE, order: 'reverse', frameCount: 3 }], width: W, height: H }, 'text/plain');
    expect(await entries(file)).toEqual([counts(0), counts(1), counts(2), counts(3), null, counts(5)]);
  });

  it('RJ02 an anchor on the last frame joins the reversed clip alone, anchor included', async () => {
    const reverse = await rle('rev-only.json', [frame(5), frame(4), frame(3), frame(2), frame(1), frame(0)]);
    const file = await produce({ [REVERSE]: reverse }, { kind: 'rle_join', inputs: [{ inputId: REVERSE, order: 'reverse', frameCount: 6 }], width: W, height: H }, 'text/plain');
    expect(await entries(file)).toEqual([0, 1, 2, 3, 4, 5].map(counts));
  });

  it('RJ03 an anchor on the first frame keeps the forward clip as it is', async () => {
    const forward = await rle('fwd-only.json', [0, 1, 2].map(frame));
    const file = await produce({ [FORWARD]: forward }, { kind: 'rle_join', inputs: [{ inputId: FORWARD, order: 'forward', frameCount: 3 }], width: W, height: H }, 'text/plain');
    expect(await entries(file)).toEqual([0, 1, 2].map(counts));
  });

  it('RJ04 a clip whose frame count differs from its declared count fails with tracking_output_mismatch', async () => {
    const forward = await rle('fwd-short.json', [0, 1, 2].map(frame));
    await fails({ [FORWARD]: forward }, { kind: 'rle_join', inputs: [{ inputId: FORWARD, order: 'forward', frameCount: 4 }], width: W, height: H }, 'tracking_output_mismatch', 'text/plain');
  });

  it('RJ05 a mask whose runs do not cover width × height fails with tracking_output_mismatch', async () => {
    const forward = await rle('fwd-size.json', [frame(0), frame(1)], { width: W, height: 30 });
    await fails({ [FORWARD]: forward }, { kind: 'rle_join', inputs: [{ inputId: FORWARD, order: 'forward', frameCount: 2 }], width: W, height: H }, 'tracking_output_mismatch', 'text/plain');
  });

  it('RJ06 a range with no foreground on any frame fails with empty_foreground', async () => {
    const forward = await rle('fwd-empty.json', [() => false, null, () => false]);
    await fails({ [FORWARD]: forward }, { kind: 'rle_join', inputs: [{ inputId: FORWARD, order: 'forward', frameCount: 3 }], width: W, height: H }, 'empty_foreground', 'text/plain');
  });
});

describe('bria_mask (execution design §10.4 model grid and steps rows)', () => {
  const growing = (k: number, step: number) => (x: number): boolean => x < 4 + step * k;

  it('BM01 frame for frame: one lossless full-range binary frame per range frame, white where the RLE frame has foreground', async () => {
    const path = await rle('bm-frames.json', [0, 1, 2, 3].map(k => growing(k, 8)));
    const file = await produce({ [RLE]: path }, { kind: 'bria_mask', inputId: RLE, table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 }, target: { width: W, height: H } });
    const stream = await video(file);
    expect([stream.width, stream.height, stream.color_range]).toEqual([W, H, 'pc']);
    await expectBinaryFrames(file, [0, 1, 2, 3].map(k => growing(k, 8)));
    expect((await packets(file)).map(packet => Number(packet.pts_time))).toEqual([0, 0.04, 0.08, 0.12]);
  });

  it('BM02 a 60 fps range is resampled on the 30 fps grid: slot j takes RLE frame 2j', async () => {
    const path = await rle('bm-resample.json', Array.from({ length: 12 }, (_unused, k) => growing(k, 4)));
    const file = await produce({ [RLE]: path }, { kind: 'bria_mask', inputId: RLE, table: cfr(60, 12), range: { startFrame: 0, frameCount: 12 }, grid: { mode: 'resample', rate: 30, frameCount: 6 }, target: { width: W, height: H } });
    await expectBinaryFrames(file, Array.from({ length: 6 }, (_unused, j) => growing(2 * j, 4)));
    (await packets(file)).forEach((packet, j) => expect(Number(packet.pts_time)).toBeCloseTo(j / 30, 3));
  });

  it('BM03 a 29.97 fps average rate re-stamps the frames N / rate', async () => {
    const path = await rle('bm-2997.json', [0, 1, 2, 3].map(k => growing(k, 8)));
    const rate = 30000 / 1001;
    const file = await produce({ [RLE]: path }, { kind: 'bria_mask', inputId: RLE, table: cfr(25, 4), range: { startFrame: 0, frameCount: 4 }, grid: { mode: 'frames', rate, frameCount: 4 }, target: { width: W, height: H } });
    (await packets(file)).forEach((packet, k) => expect(Math.abs(Number(packet.pts_time) - k / rate)).toBeLessThanOrEqual(0.001));
  });
});

describe('prepare_model_input order and grid (execution design §10.2, §10.4)', () => {
  /**
   * A model-input recipe over a whole source.
   * @param window - Its presentation frames.
   * @param timescale - Its clock.
   * @param end - The source's presentation end.
   * @param extra - The order or grid fields.
   * @returns The recipe.
   */
  function prepare(window: { start: number; end: number }, timescale: number, end: Exact, extra: Recipe): Recipe {
    return { kind: 'prepare_model_input', inputId: SOURCE, window, timescale, entries: [span(r(0), end)], target: TARGET, audio: null, ...extra };
  }

  it('PG01 order reverse plays the window backwards on its own clock', async () => {
    const file = await produce({ [SOURCE]: join(dir, 'greys25.mp4') }, prepare({ start: 0, end: 10 }, 25, r(2, 5), { order: 'reverse' }));
    const [source, prepared] = [await lumaMeans(join(dir, 'greys25.mp4')), await lumaMeans(file)];
    expect(prepared).toHaveLength(10);
    prepared.forEach((value, k) => expect(Math.abs(value - source[9 - k]!), `frame ${k}`).toBeLessThan(3));
    expect((await packets(file)).map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 10 }, (_unused, k) => k / 25));
  });

  it('PG04 a reversed clip in two chunks, the later chunk stitched first, plays the whole window backwards', async () => {
    const source = join(dir, 'greys25.mp4');
    const reversed = async (window: { start: number; end: number }, start: Exact, end: Exact): Promise<string> =>
      produce({ [SOURCE]: source }, { kind: 'prepare_model_input', inputId: SOURCE, window, timescale: 25, entries: [span(start, end)], target: TARGET, audio: null, order: 'reverse' });
    const [late, early] = [await reversed({ start: 5, end: 10 }, r(1, 5), r(2, 5)), await reversed({ start: 0, end: 5 }, r(0), r(1, 5))];
    const [LATE, EARLY] = ['10000000-0000-4000-8000-0000000000d1', '10000000-0000-4000-8000-0000000000d0'];
    const file = await produce({ [SOURCE]: source, [LATE]: late, [EARLY]: early },
      { kind: 'stitch', inputId: SOURCE, target: TARGET, chunks: [{ inputId: LATE, duration: r(1, 5) }, { inputId: EARLY, duration: r(1, 5) }], audio: null });
    const [original, joined] = [await lumaMeans(source), await lumaMeans(file)];
    expect(joined).toHaveLength(10);
    joined.forEach((value, k) => expect(Math.abs(value - original[9 - k]!), `frame ${k}`).toBeLessThan(3));
    (await packets(file)).forEach((packet, k) => expect(Number(packet.pts_time)).toBeCloseTo(k / 25, 3));
  });

  it.each([
    ['a 29.97 fps source on a 1 ms clock', 'greys2997.mp4', 15, null],
    ['a jittery VFR source', 'vfr.mp4', 8, VFR_END],
  ] as const)('PG02 a frames grid keeps every frame of %s and re-stamps it N / rate', async (_case, name, count, knownEnd) => {
    const source = join(dir, name);
    const stored = await packets(source);
    const end = knownEnd ?? Math.round((Number(stored.at(-1)!.pts_time) + Number(stored.at(-1)!.duration_time)) * 1000);
    const rate = (count * 1000) / end;
    const file = await produce({ [SOURCE]: source }, prepare({ start: 0, end: count }, 1000, r(end, 1000), { grid: { mode: 'frames', rate, frameCount: count } }));
    const [original, prepared] = [await lumaMeans(source), await lumaMeans(file)];
    expect(prepared).toHaveLength(count);
    prepared.forEach((value, k) => expect(Math.abs(value - original[k]!), `frame ${k}`).toBeLessThan(3));
    (await packets(file)).forEach((packet, k) => expect(Math.abs(Number(packet.pts_time) - k / rate), `pts of frame ${k}`).toBeLessThanOrEqual(0.001));
  });

  it('PG03 a resample grid takes the frame covering each 30 fps slot of a 60 fps source', async () => {
    const file = await produce({ [SOURCE]: join(dir, 'greys60.mp4') }, prepare({ start: 0, end: 12 }, 60, r(1, 5), { grid: { mode: 'resample', rate: 30, frameCount: 6 } }));
    const [source, prepared] = [await lumaMeans(join(dir, 'greys60.mp4')), await lumaMeans(file)];
    expect(prepared).toHaveLength(6);
    prepared.forEach((value, j) => expect(Math.abs(value - source[2 * j]!), `slot ${j}`).toBeLessThan(3));
    (await packets(file)).forEach((packet, j) => expect(Number(packet.pts_time)).toBeCloseTo(j / 30, 3));
  });

  it('PG05 a resample grid whose last slot starts on the last frame shows that frame there, not the one before', async () => {
    // 11 frames at 60 fps on a 30 fps grid: slot 5 is at 10/60, the start of frame 10, the range's last frame.
    const file = await produce({ [SOURCE]: join(dir, 'greys60.mp4') }, prepare({ start: 0, end: 11 }, 60, r(11, 60), { grid: { mode: 'resample', rate: 30, frameCount: 6 } }));
    const [source, prepared] = [await lumaMeans(join(dir, 'greys60.mp4')), await lumaMeans(file)];
    expect(prepared).toHaveLength(6);
    prepared.forEach((value, j) => expect(Math.abs(value - source[2 * j]!), `slot ${j}`).toBeLessThan(3));
  });
});

describe('model_window, model_window_mask and frame_at (execution design §10.5 steps row)', () => {
  const FRAME = { width: 64, height: 48 };
  const ROI: Rect = { x: 8, y: 10, width: 48, height: 28 };
  const ROI_IN: Rect = { x: ROI.x + 2, y: ROI.y + 2, width: ROI.width - 4, height: ROI.height - 4 };
  const FILL_IN: Rect = { x: 0, y: 0, width: 64, height: 8 };

  /**
   * A model window over the 25 fps greys.
   * @param start - The span start.
   * @param conversion - The source conversion.
   * @returns The recipe.
   */
  function modelWindow(start: Exact, conversion: Recipe = {}): Recipe {
    return {
      kind: 'model_window', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))],
      target: { ...TARGET, width: ROI.width, height: ROI.height, ...conversion }, grid: { fps: 16, frameCount: 80 }, frame: FRAME, sourceRoi: ROI,
      fill: [127, 127, 127], span: { start, end: r(2, 5) },
    };
  }

  it('MW01 each 16 fps slot shows the covering source frame in the source rectangle over the RGB 127 fill, the last frame repeated to the grid count', async () => {
    const file = await produce({ [SOURCE]: join(dir, 'greys25.mp4') }, modelWindow(r(0)));
    const stream = await video(file);
    expect([stream.width, stream.height]).toEqual([64, 48]);
    const list = await packets(file);
    expect(list).toHaveLength(80);
    list.forEach((packet, j) => expect(Number(packet.pts_time)).toBeCloseTo(j / 16, 3));
    const source = (await rgbMeans(join(dir, 'greys25.mp4'), { width: W, height: H }, { x: 0, y: 0, width: W, height: H })).map(rgb => rgb[0]!);
    const inside = (await rgbMeans(file, FRAME, ROI_IN)).map(rgb => rgb[0]!);
    inside.forEach((value, j) => expect(Math.abs(value - source[Math.min(9, Math.floor((25 * j) / 16))]!), `slot ${j}`).toBeLessThan(3));
    // The fill is the RGB 127 FFmpeg writes for 0x7f7f7f in BT.709 limited range, as the measured VACE input was made.
    const reference = join(dir, 'fill-127.mp4');
    await make('fill-127.mp4', ['-f', 'lavfi', '-i', 'color=c=0x7f7f7f:s=64x48:d=0.0625,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv', '-frames:v', '1', '-c:v', 'libx264', '-crf', '0']);
    const [fillRgb] = await rgbMeans(reference, FRAME, FILL_IN);
    for (const rgb of await rgbMeans(file, FRAME, FILL_IN)) rgb.forEach((channel, at) => expect(Math.abs(channel - fillRgb![at]!)).toBeLessThanOrEqual(1));
  });

  it('MW02 the grid starts at the span start: the first slot of a span at 0.1 s is source frame 2, the next frame 4', async () => {
    const file = await produce({ [SOURCE]: join(dir, 'greys25.mp4') }, modelWindow(r(1, 10)));
    const source = (await rgbMeans(join(dir, 'greys25.mp4'), { width: W, height: H }, { x: 0, y: 0, width: W, height: H })).map(rgb => rgb[0]!);
    const inside = (await rgbMeans(file, FRAME, ROI_IN)).map(rgb => rgb[0]!);
    expect(Math.abs(inside[0]! - source[2]!)).toBeLessThan(3);
    expect(Math.abs(inside[1]! - source[4]!)).toBeLessThan(3);
  });

  it('MW03 an HDR source is tone mapped with its plan matrix: the source rectangle equals the composite\'s source layer', async () => {
    const hdr = join(dir, 'clip-hdr.mp4');
    const file = await produce({ [SOURCE]: hdr }, modelWindow(r(0), HDR));
    expect([(await video(file)).width, (await video(file)).height]).toEqual([64, 48]);
    const chunk = await produce({ [SOURCE]: hdr }, { kind: 'chunk_encode', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))], target: { ...TARGET, width: ROI.width, height: ROI.height, ...HDR } });
    const layer = (await rgbMeans(chunk, { width: ROI.width, height: ROI.height }, { x: 2, y: 2, width: ROI.width - 4, height: ROI.height - 4 }))[0]!;
    const inside = (await rgbMeans(file, FRAME, ROI_IN))[0]!;
    inside.forEach((channel, at) => expect(Math.abs(channel - layer[at]!), `channel ${at}`).toBeLessThan(3));
  });

  it('MM01 the window mask is black inside the source rectangle and white elsewhere, lossless full range, one frame per slot', async () => {
    const file = await produce({}, { kind: 'model_window_mask', grid: { fps: 16, frameCount: 80 }, frame: FRAME, sourceRoi: ROI, span: { start: r(0), end: r(2, 5) } });
    expect((await video(file)).color_range).toBe('pc');
    const outside = (x: number, y: number): boolean => !(x >= ROI.x && x < ROI.x + ROI.width && y >= ROI.y && y < ROI.y + ROI.height);
    await expectBinaryFrames(file, Array.from({ length: 80 }, () => outside));
  });

  it.each([
    ['the closest frame', r(1, 10), 2],
    ['the earlier frame on a tie', r(3, 32), 1],
  ] as const)('FA01 frame_at takes %s by PTS and writes it as a PNG of the target size', async (_case, time, expected) => {
    const file = await produce({ [RESULT]: join(dir, 'vace16.mp4') }, { kind: 'frame_at', inputId: RESULT, time, target: { width: 32, height: 18 } }, 'image/png');
    const stream = await video(file);
    expect([stream.codec_name, stream.width, stream.height]).toEqual(['png', 32, 18]);
    const frames = (await rgbMeans(join(dir, 'vace16.mp4'), { width: W, height: H }, { x: 0, y: 0, width: W, height: H })).map(rgb => rgb[0]!);
    const [picture] = await rgbMeans(file, { width: 32, height: 18 }, { x: 0, y: 0, width: 32, height: 18 });
    expect(Math.abs(picture![0]! - frames[expected]!)).toBeLessThan(3);
  });

  it.each(RESULT_TAGGINGS)('FA02 frame_at decodes a previous window\'s result (%s) with its own matrix: the PNG keeps its RGB', async (_case, tagged) => {
    const previous = await providerVideo(`fa02-${String(tagged)}.mp4`, { width: W, height: H, fps: 16, frames: 8 }, threeBands, tagged);
    const file = await produce({ [RESULT]: previous }, { kind: 'frame_at', inputId: RESULT, time: r(1, 10), target: { width: W, height: H } }, 'image/png');
    for (const { y, height, colour } of BAND_ROWS) expectRgb((await rgbMeans(file, { width: W, height: H }, { x: 4, y, width: 56, height }))[0]!, colour, `band at row ${y}`);
  });
});

describe('model_composite erase (execution design §10.4 model grid and composite rows)', () => {
  // The result fixture the current case composes; expectErased reads it back.
  let resultFile = 'result4.mp4';

  /**
   * An erase composite chunk.
   * @param chunk - Its window, clock and spans.
   * @param chunk.window - Its presentation frames.
   * @param chunk.timescale - Its clock.
   * @param chunk.entries - Its spans.
   * @param erase - Its table, range, grid and matte.
   * @param erase.table - The source's presentation table.
   * @param erase.range - The erase range.
   * @param erase.grid - The model grid.
   * @param erase.matte - The matte, none when absent.
   * @param erase.target - The segment target, {@link TARGET} when absent.
   * @returns The recipe.
   */
  function erase(chunk: { window: { start: number; end: number }; timescale: number; entries: Recipe[] },
    erase: { table: VideoPresentationTable; range: { startFrame: number; frameCount: number }; grid: Recipe; matte?: { dilate: number; feather: number }; target?: Recipe }): Recipe {
    return { kind: 'model_composite', mode: 'erase', inputId: SOURCE, ...chunk, target: erase.target ?? TARGET, result: RESULT, rle: RLE, table: erase.table, range: erase.range, grid: erase.grid,
      matte: erase.matte ?? { dilate: 0, feather: 0 }, rleSize: { width: W, height: H } };
  }

  /**
   * Require each frame's masked half to show its expected result frame and the other half the source, and frames outside the
   * range to be the source throughout.
   * @param file - The composite.
   * @param source - The source file.
   * @param resultFrame - Per output frame, the result frame shown in the mask, or null outside the range.
   * @param sourceFrame - Per output frame, the source frame.
   * @returns Nothing.
   */
  async function expectErased(file: string, source: string, resultFrame: (number | null)[], sourceFrame: number[]): Promise<void> {
    const [left, right, original, result] = [await lumaMeans(file, LEFT_IN), await lumaMeans(file, RIGHT_IN), await lumaMeans(source), await lumaMeans(join(dir, resultFile))];
    expect(left).toHaveLength(resultFrame.length);
    resultFrame.forEach((shown, n) => {
      expect(Math.abs(left[n]! - (shown === null ? original[sourceFrame[n]!]! : result[shown]!)), `masked half, frame ${n}`).toBeLessThan(4);
      expect(Math.abs(right[n]! - original[sourceFrame[n]!]!), `unmasked half, frame ${n}`).toBeLessThan(4);
    });
  }

  it('EC01 24/25 fps frame for frame: range frames 3..6 show result frames 0..3 in the mask, whatever the result\'s own clock', async () => {
    resultFile = 'result4.mp4';
    const source = join(dir, 'greys25.mp4');
    const file = await produce({ [SOURCE]: source, [RESULT]: join(dir, resultFile), [RLE]: await rle('ec-left4.json', Array(4).fill(LEFT)) },
      erase({ window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))] }, { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 } }));
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 10 }, (_unused, n) => n / 25));
    expect(list[0]!.flags).toContain('K');
    await expectErased(file, source, [null, null, null, 0, 1, 2, 3, null, null, null], Array.from({ length: 10 }, (_unused, n) => n));
  });

  it('EC02 a chunk starting inside the range finds its first frame\'s slot from the table: frames 5, 6 show result frames 2, 3', async () => {
    resultFile = 'result4.mp4';
    const source = join(dir, 'greys25.mp4');
    const file = await produce({ [SOURCE]: source, [RESULT]: join(dir, resultFile), [RLE]: await rle('ec-left4b.json', Array(4).fill(LEFT)) },
      erase({ window: { start: 5, end: 10 }, timescale: 25, entries: [span(r(1, 5), r(2, 5))] }, { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 } }));
    expect((await packets(file)).map(packet => Number(packet.pts_time))).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
    await expectErased(file, source, [2, 3, null, null, null], [5, 6, 7, 8, 9]);
  });

  it('EC03 a 60 fps range on the 30 fps grid: presented frame i shows result slot floor(i / 2)', async () => {
    resultFile = 'result6.mp4';
    const source = join(dir, 'greys60.mp4');
    const file = await produce({ [SOURCE]: source, [RESULT]: join(dir, resultFile), [RLE]: await rle('ec-left12.json', Array(12).fill(LEFT)) },
      erase({ window: { start: 0, end: 12 }, timescale: 60, entries: [span(r(0), r(1, 5))] }, { table: cfr(60, 12), range: { startFrame: 0, frameCount: 12 }, grid: { mode: 'resample', rate: 30, frameCount: 6 } }));
    await expectErased(file, source, Array.from({ length: 12 }, (_unused, i) => Math.floor(i / 2)), Array.from({ length: 12 }, (_unused, i) => i));
  });

  it('EC04 a VFR range averaging under 30 fps maps frame for frame', async () => {
    resultFile = 'result8.mp4';
    const source = join(dir, 'vfr.mp4');
    const file = await produce({ [SOURCE]: source, [RESULT]: join(dir, resultFile), [RLE]: await rle('ec-left8.json', Array(8).fill(LEFT)) },
      erase({ window: { start: 0, end: 8 }, timescale: 1000, entries: [span(r(0), r(VFR_END, 1000))] }, { table: VFR, range: { startFrame: 0, frameCount: 8 }, grid: { mode: 'frames', rate: 8000 / VFR_END, frameCount: 8 } }));
    await expectErased(file, source, Array.from({ length: 8 }, (_unused, i) => i), Array.from({ length: 8 }, (_unused, i) => i));
  });

  it('EC05 a result with a frame count other than the grid\'s fails with model_output_mismatch', async () => {
    await fails({ [SOURCE]: join(dir, 'greys25.mp4'), [RESULT]: join(dir, 'result5.mp4'), [RLE]: await rle('ec-left4c.json', Array(4).fill(LEFT)) },
      erase({ window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))] }, { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 } }), 'model_output_mismatch');
  });

  it('EC06 the matte dilates the mask past its edge and feathers it into a gradual edge', async () => {
    const inputs = async (name: string): Promise<Record<string, string>> => ({ [SOURCE]: join(dir, 'greys25.mp4'), [RESULT]: join(dir, 'result4.mp4'), [RLE]: await rle(name, Array(4).fill(LEFT)) });
    const chunk = { window: { start: 3, end: 4 }, timescale: 25, entries: [span(r(3, 25), r(4, 25))] };
    const base = { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 } };
    const column = (x: number): Rect => ({ x, y: 2, width: 1, height: 32 });
    const [source, result] = [(await lumaMeans(join(dir, 'greys25.mp4')))[3]!, (await lumaMeans(join(dir, 'result4.mp4')))[0]!];
    const weight = async (file: string, x: number): Promise<number> => ((await lumaMeans(file, column(x)))[0]! - source) / (result - source);
    const sharp = await produce(await inputs('ec-sharp.json'), erase(chunk, base));
    const dilated = await produce(await inputs('ec-dilate.json'), erase(chunk, { ...base, matte: { dilate: 4, feather: 0 } }));
    const feathered = await produce(await inputs('ec-feather.json'), erase(chunk, { ...base, matte: { dilate: 0, feather: 4 } }));
    expect(await weight(sharp, 34)).toBeLessThan(0.1);
    expect(await weight(dilated, 34)).toBeGreaterThan(0.9);
    const edge = await Promise.all([28, 29, 30, 31, 32, 33, 34, 35].map(x => weight(feathered, x)));
    expect(edge.some(value => value > 0.15 && value < 0.85), JSON.stringify(edge)).toBe(true);
  });

  it('EC07 a stitch over an erase chunk re-attaches the source audio; frames 10..19 show the result', async () => {
    const source = join(dir, 'greys-tone.mp4');
    const chunk = await produce({ [SOURCE]: source, [RESULT]: join(dir, 'result10.mp4'), [RLE]: await rle('ec-all10.json', Array(10).fill(() => true)) },
      erase({ window: { start: 0, end: 50 }, timescale: 25, entries: [span(r(0), r(2))] }, { table: cfr(25, 50), range: { startFrame: 10, frameCount: 10 }, grid: { mode: 'frames', rate: 25, frameCount: 10 } }));
    const CHUNK = '10000000-0000-4000-8000-0000000000c0';
    const file = await produce({ [SOURCE]: source, [CHUNK]: chunk }, { kind: 'stitch', inputId: SOURCE, target: TARGET, chunks: [{ inputId: CHUNK, duration: r(2) }], audio: TONE_AUDIO });
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]);
    expect((JSON.parse(stdout) as { streams: Stream[] }).streams.map(stream => stream.codec_type).sort()).toEqual(['audio', 'video']);
    const composed = await lumaMeans(file);
    expect(composed).toHaveLength(50);
    for (let n = 10; n < 20; n += 1) expect(Math.abs(composed[n]! - 230), `frame ${n}`).toBeLessThan(4);
  });

  it('EC08 a chunk outside the range never decodes the result: frames 7..9 keep the source even when the result is unreadable', async () => {
    const source = join(dir, 'greys25.mp4');
    const unreadable = join(dir, 'unreadable-result.mp4');
    await writeFile(unreadable, Buffer.from('not a video'));
    const file = await produce({ [SOURCE]: source, [RESULT]: unreadable, [RLE]: await rle('ec-left4d.json', Array(4).fill(LEFT)) },
      erase({ window: { start: 7, end: 10 }, timescale: 25, entries: [span(r(7, 25), r(2, 5))] }, { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 } }));
    await expectErased(file, source, [null, null, null], [7, 8, 9]);
  });

  it.each(RESULT_TAGGINGS)('EC09 a model result (%s) keeps its RGB in the erased half, and the untouched half keeps the source\'s', async (_case, tagged) => {
    const result = await providerVideo(`ec09-${String(tagged)}.mp4`, { width: W, height: H, fps: 30, frames: 4 }, threeBands, tagged);
    const source = join(dir, 'greys25.mp4');
    const file = await produce({ [SOURCE]: source, [RESULT]: result, [RLE]: await rle(`ec09-${String(tagged)}.json`, Array(4).fill(LEFT)) },
      erase({ window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))] }, { table: cfr(25, 10), range: { startFrame: 3, frameCount: 4 }, grid: { mode: 'frames', rate: 25, frameCount: 4 }, target: LOSSLESS_TARGET }));
    const size = { width: W, height: H };
    const bands = await Promise.all(BAND_ROWS.map(({ y, height }) => rgbMeans(file, size, { x: 4, y, width: 24, height })));
    const [untouched, original] = await Promise.all([rgbMeans(file, size, RIGHT_IN), rgbMeans(source, size, RIGHT_IN)]);
    for (let n = 3; n <= 6; n += 1) {
      BAND_ROWS.forEach(({ y, colour }, at) => expectRgb(bands[at]![n]!, colour, `frame ${n} erased band at row ${y}`));
      expectRgb(untouched[n]!, original[n]!, `frame ${n} untouched half`);
    }
  });
});

describe('model_composite expand (execution design §10.5 composite row and failure paragraph)', () => {
  it('EX01 a ten-second window whose 16 fps background has 159 frames composes without a frame-count check, the last frame held', async () => {
    const displayRect = { x: 32, y: 18, width: 64, height: 36 };
    const recipe = {
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, window: { start: 0, end: 250 }, timescale: 25, entries: [span(r(0), r(10))],
      target: { ...TARGET, width: 128, height: 72, displayRect },
      backgrounds: [{ inputId: BACKGROUND, window: { start: r(0), end: r(10) } }],
    };
    const file = await produce({ [SOURCE]: join(dir, 'long.mp4'), [BACKGROUND]: join(dir, 'bg159.mp4') }, recipe);
    expect(await packets(file)).toHaveLength(250);
    const strip = { x: 0, y: 0, width: 128, height: 16 };
    const [background, surround] = [await lumaMeans(join(dir, 'bg159.mp4'), strip), await lumaMeans(file, strip)];
    expect(Math.abs(surround.at(-1)! - background.at(-1)!)).toBeLessThan(4);
  });

  it.each(RESULT_TAGGINGS)('EX02 a model background (%s) keeps its RGB in the generated margins around the source', async (_case, tagged) => {
    const displayRect = { x: 32, y: 18, width: 64, height: 36 };
    const colourAt = (x: number, y: number): Rgb => (y < 18 ? (x < 64 ? RED : GREEN) : BLUE);
    const background = await providerVideo(`ex02-${String(tagged)}.mp4`, { width: 128, height: 72, fps: 16, frames: 8 }, colourAt, tagged);
    const recipe = {
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(2, 5))],
      target: { ...LOSSLESS_TARGET, width: 128, height: 72, displayRect }, backgrounds: [{ inputId: BACKGROUND, window: { start: r(0), end: r(2, 5) } }],
    };
    const file = await produce({ [SOURCE]: join(dir, 'greys25.mp4'), [BACKGROUND]: background }, recipe);
    const size = { width: 128, height: 72 };
    // Clear of the chroma resampling across the colour edges at y = 18 and x = 64 and the source's edge at y = 54.
    const [left, right, bottom] = await Promise.all([rgbMeans(file, size, { x: 4, y: 2, width: 52, height: 10 }), rgbMeans(file, size, { x: 68, y: 2, width: 56, height: 10 }),
      rgbMeans(file, size, { x: 4, y: 58, width: 120, height: 12 })]);
    expect(left).toHaveLength(10);
    left.forEach((_unused, n) => {
      expectRgb(left[n]!, RED, `frame ${n} top-left margin`);
      expectRgb(right[n]!, GREEN, `frame ${n} top-right margin`);
      expectRgb(bottom[n]!, BLUE, `frame ${n} bottom margin`);
    });
  });
});

describe('modelResultDecode (the one decode rule for a model\'s video result)', () => {
  it.each([
    ['tagged BT.709 decodes BT.709', { color_space: 'bt709', color_range: 'tv' }, 'in_color_matrix=bt709:in_range=tv'],
    ['tagged smpte170m decodes BT.601', { color_space: 'smpte170m', color_range: 'tv' }, 'in_color_matrix=bt601:in_range=tv'],
    ['tagged bt470bg decodes BT.601', { color_space: 'bt470bg' }, 'in_color_matrix=bt601:in_range=tv'],
    ['tagged bt2020nc decodes BT.2020', { color_space: 'bt2020nc', color_range: 'tv' }, 'in_color_matrix=bt2020:in_range=tv'],
    ['a full-range tag is kept', { color_space: 'bt709', color_range: 'pc' }, 'in_color_matrix=bt709:in_range=pc'],
    ['untagged decodes BT.601 limited range', {}, 'in_color_matrix=bt601:in_range=tv'],
    ['an unknown tag decodes BT.601 limited range', { color_space: 'unknown', color_range: 'unknown' }, 'in_color_matrix=bt601:in_range=tv'],
    // The 1280x720 Bria eraser output is untagged and BT.601: the source rule's BT.709 from 720 lines does not apply.
    ['an untagged 720p result still decodes BT.601', { width: 1280, height: 720 }, 'in_color_matrix=bt601:in_range=tv'],
  ] as const)('%s', (_case, stream, expected) => {
    expect(modelResultDecode(stream)).toBe(expected);
  });

  it('a tag with no decode matrix is refused', () => {
    expect(() => modelResultDecode({ color_space: 'ycgco' })).toThrow(RangeError);
  });
});
