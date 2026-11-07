// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The four lip-sync container recipes on real media (inner#1306 test plan §97; frames-split design §7.17 rows
 * `lipsync_faces`, `lipsync_clip`, `lipsync_stem`, `lipsync_composite` and the paragraph after the table, §5.4; execution
 * design §9.2–§9.4; multi-person lip-sync DD §7.2).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the standard-4 container does, with every fixture generated here by
 * FFmpeg and every assertion a fact FFmpeg reads back (pixel means of the stored planes, packets, decoded PCM). The edge is
 * faked at `fetch`. Recipe shapes (none is in `miniToolPlanRecipeSchema` yet; they reuse the conventions of
 * `mini-tool-plan-job.ts`: bound inputs by `inputId`, exact times `{ numerator, denominator }`, `windowRecipe`, `target`):
 *
 * - `lipsync_faces`: `{ kind, inputId (prepared video), track (RLE JSON), profile (the people detector profile) }` writes
 *   `{ frames: [{ frameIndex, faceRect: { x, y, width, height } | null }] }` in prepared-video pixels, one entry per frame,
 *   searching faces only inside the person's tracked foreground; all null fails with `no_face`, no foreground on any frame
 *   with `empty_foreground`.
 * - `lipsync_clip`: `{ kind, inputId (prepared video), faces (transform table JSON), track, cropSize, timeline, table }`
 *   writes a `cropSize`² H.264 MP4 of `timeline.duration` on the prepared video's frame rate; result frame t shows the source
 *   frame `lipsyncSourceFrameAt(timeline, table, t)` cropped to its faceRect, scaled to fit and padded, black outside the mask.
 * - `lipsync_stem`: `{ kind, rows: [{ inputId, startTime }], duration }` writes AAC 48 kHz of exactly `duration`, each row
 *   placed at its start and summed, silence elsewhere, a row past the end truncated.
 * - `lipsync_composite`: `{ kind, ...windowRecipe, timeline, table, persons: [{ result, faces, track, cropSize }] }`, where
 *   `window` is the chunk's result-frame ordinals on `timescale`, and `entries` are the original's spans over [0, V): one
 *   chunk on the result clock from 0 opening with a keyframe; each person's result inverse-transformed onto its faceRect and
 *   blended with feather(face) ∩ tracked foreground; no face gives alpha 0; outside every mask the source; opaque H.264,
 *   transparent VP9 keeping the source alpha.
 *
 * A SAM3 track is a JSON array of COCO compressed counts, one per prepared-video frame in order (§97 D18-3); `cocoCounts`
 * below encodes a known mask the way the COCO reference does (checked against the decoder's golden counts).
 *
 * The face detector: no OpenCV or `/app/analysis-runtime.py` exists outside the container image, so `runAnalysisPipeline`
 * (the `people` recipe's detector path) is replaced by a stand-in that really runs the decoder command it is handed and
 * reports the bright squares in the pixels it receives as YuNet rows. Faces are therefore found in whatever frames the
 * recipe feeds the detector: a recipe that masks the frames first, or one that filters the detections by the mask after,
 * both pass. One detector call over N > 1 frames is answered `{ frames: [rows | null per frame] }`, a one-frame call
 * `{ faces: rows | null }` (the `people` answer).
 */
import { execFile, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysisPipeline, type AnalysisPipelineRequest } from '@ingest/container/analysis-pipeline.js';
import { decodeCocoRleMask } from '@ingest/container/coco-rle.js';
import { cocoCounts } from './helpers/coco-counts.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { lipsyncSourceFrameAt, type LipsyncTimeline } from '@shared/mini-tools/lipsync-plan.js';
import { canonicalMediaType } from '@shared/upload/media-type.js';
import { sniffMimeType } from '@shared/upload/sniff-mime.js';
import type { VideoPresentationTable } from '@shared/mini-tools/video-presentation-table.js';

vi.mock('@ingest/container/analysis-pipeline.js', () => ({ runAnalysisPipeline: vi.fn() }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
type Plane = 'y' | 'u' | 'v' | 'a';
interface Report { ok: boolean; reason?: string; outputs: { outputIndex: number }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string; time_base: string; duration_ts?: number }
interface Packet { pts_time: string; duration_time: string; flags: string }

const r = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const PEOPLE = { id: 'opencv-yunet-2023mar', version: '2023mar', weightsHash: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } };
const W = 160;
const H = 96;
const FPS = 25;
// Every video fixture: ten 25 fps frames, so V = 0.4 s; the presentation table of the prepared video and the original.
const TABLE: VideoPresentationTable = { schemaVersion: 1, timescale: FPS, runs: [{ start: 0, count: 10, step: 1, duration: 1 }] };
const V = 0.4;
const ID = {
  video: '10000000-0000-4000-8000-000000000001', track: '10000000-0000-4000-8000-000000000002', faces: '10000000-0000-4000-8000-000000000003',
  audioA: '10000000-0000-4000-8000-0000000000a1', audioB: '10000000-0000-4000-8000-0000000000a2',
  result1: '10000000-0000-4000-8000-0000000000e1', faces1: '10000000-0000-4000-8000-0000000000f1', track1: '10000000-0000-4000-8000-0000000000d1',
  result2: '10000000-0000-4000-8000-0000000000e2', faces2: '10000000-0000-4000-8000-0000000000f2', track2: '10000000-0000-4000-8000-0000000000d2',
};
const OPAQUE = { width: W, height: H, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium', format: 'mp4-h264' };
const STRAIGHT = { ...OPAQUE, alpha: 'straight', format: 'webm-vp9' };
// The real YuNet path exists only in the media container image (packages/ingest/Dockerfile: /app/analysis-runtime.py, the
// weights under /app/models, OpenCV on PYTHONPATH); packages/ingest/scripts/test-container-in-image.sh runs this file there.
const REAL_YUNET = existsSync('/app/analysis-runtime.py') && spawnSync('python3', ['-c', 'import cv2'], { stdio: 'ignore' }).status === 0;
// A real frontal portrait the repository already ships (web's mini-tool real-run media), 1024x1024; the image test script
// copies every tracked file into its workspace, so the same relative path holds there.
const PORTRAIT = fileURLToPath(new URL('../../../web/tests/fixtures/mini-tools/portrait.jpg', import.meta.url));

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
 * Generate a lossless 160x96 25 fps H.264 video of ten frames whose luma is a geq expression of X, Y and the frame N.
 * @param name - Its file name.
 * @param luma - The luma expression.
 * @param size - Its size and frame count, the 160x96 ten-frame default when absent.
 * @param chroma - The constant Cb and Cr.
 * @returns Nothing.
 */
async function lossless(name: string, luma: string, size = { width: W, height: H, frames: 10 }, chroma = { cb: 128, cr: 128 }): Promise<void> {
  await make(name, ['-f', 'lavfi', '-i', `color=c=black:s=${size.width}x${size.height}:r=${FPS}:d=${size.frames / FPS},format=yuv420p,geq=lum='${luma}':cb=${chroma.cb}:cr=${chroma.cr}`,
    '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-video_track_timescale', String(FPS)]);
}

/**
 * Write a SAM3 track file: one compressed counts string per prepared-video frame, in order.
 * @param name - Its file name.
 * @param foreground - Whether a pixel of a frame is the person's foreground.
 * @param frames - The frame count.
 * @param size - The prepared video's size, 160x96 when absent.
 * @returns Its path.
 */
async function track(name: string, foreground: (frame: number, x: number, y: number) => boolean, frames = 10, size = { width: W, height: H }): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(Array.from({ length: frames }, (_unused, frame) => cocoCounts(size.width, size.height, (x, y) => foreground(frame, x, y)))));
  return path;
}

/**
 * Write a transform table (the `lipsync_faces` output shape).
 * @param name - Its file name.
 * @param faceRect - Each frame's face rectangle or null.
 * @param frames - The frame count.
 * @returns Its path.
 */
async function facesTable(name: string, faceRect: (frame: number) => Rect | null, frames = 10): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ frames: Array.from({ length: frames }, (_unused, frameIndex) => ({ frameIndex, faceRect: faceRect(frameIndex) })) }));
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
 * Run one job with one output and require it to succeed.
 * @param inputs - Input id to served file path.
 * @param recipe - The recipe.
 * @param contentType - The output's content type.
 * @returns The written output path.
 */
async function produce(inputs: Record<string, string>, recipe: Recipe, contentType = 'video/mp4'): Promise<string> {
  const { report, files } = await runJob(inputs, [recipe], contentType);
  expect(report.ok, `the job reports ok (${JSON.stringify(vi.mocked(console.error).mock.calls)})`).toBe(true);
  expect(report.outputs.map(output => output.outputIndex)).toEqual([0]);
  // The Worker names each written output by its bytes and refuses one whose type differs from the planned one
  // (src/jobs/job-objects.ts, job-write.ts), so the bytes must read as the type the worker plans.
  expect(canonicalMediaType(await sniffMimeType(new Uint8Array(await readFile(files[0]!)))), 'the output reads as its planned type').toBe(contentType);
  return files[0]!;
}

/**
 * The streams of a file.
 * @param path - The file.
 * @returns Its streams.
 */
async function streams(path: string): Promise<Stream[]> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
  return (JSON.parse(stdout) as { streams: Stream[] }).streams;
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
 * Every stored frame's plane as stored (no range or matrix conversion), read with passthrough timing.
 * @param path - The file.
 * @param plane - The plane.
 * @param decoder - Decoder options before the input (libvpx-vp9 to read a VP9 alpha plane).
 * @returns The plane width and one buffer per frame.
 */
async function planeFrames(path: string, plane: Plane, decoder: string[] = []): Promise<{ width: number; frames: Buffer[] }> {
  const video = (await streams(path)).find(stream => stream.codec_type === 'video')!;
  const chroma = plane === 'u' || plane === 'v';
  const [width, height] = chroma ? [Math.ceil(video.width! / 2), Math.ceil(video.height! / 2)] : [video.width!, video.height!];
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...decoder, '-i', path, '-fps_mode', 'passthrough', '-vf', `extractplanes=${plane}`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const size = width * height;
  return { width, frames: Array.from({ length: bytes.length / size }, (_unused, frame) => bytes.subarray(frame * size, frame * size + size)) };
}

/**
 * The mean of a rectangle of one plane frame.
 * @param frame - The plane bytes.
 * @param width - The plane width.
 * @param rect - The rectangle, in that plane's own pixels.
 * @returns The mean.
 */
function mean(frame: Buffer, width: number, rect: Rect): number {
  let sum = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) sum += frame[y * width + x]!;
  return sum / (rect.width * rect.height);
}

/**
 * The mean absolute difference of two plane frames over a rectangle.
 * @param a - One frame.
 * @param b - The other, of the same plane width.
 * @param width - The plane width.
 * @param rect - The rectangle.
 * @returns The difference.
 */
function mad(a: Buffer, b: Buffer, width: number, rect: Rect): number {
  let sum = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) for (let x = rect.x; x < rect.x + rect.width; x += 1) sum += Math.abs(a[y * width + x]! - b[y * width + x]!);
  return sum / (rect.width * rect.height);
}

/**
 * A luma rectangle's chroma counterpart in a 4:2:0 picture (every rectangle here sits on even coordinates).
 * @param rect - The luma rectangle.
 * @returns The chroma rectangle.
 */
function half(rect: Rect): Rect {
  return { x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 };
}

/**
 * The detector stand-in: it runs the decoder command it is handed, reads the BGR24 frames it writes, and reports every
 * connected region of near-white pixels (all channels above 200) of each frame as one YuNet row with score 0.9.
 * @param request - The pipeline request the recipe built.
 * @returns The detector's JSON answer.
 */
async function fakeYuNet(request: AnalysisPipelineRequest): Promise<string> {
  const { stdout } = await run(request.decoder.program, [...request.decoder.args], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const { width, height } = request;
  const size = width * height * 3;
  const perFrame = Array.from({ length: bytes.length / size }, (_unused, frame) => {
    const pixels = bytes.subarray(frame * size, frame * size + size);
    const seen = new Uint8Array(width * height);
    const bright = (at: number): boolean => pixels[at * 3]! > 200 && pixels[at * 3 + 1]! > 200 && pixels[at * 3 + 2]! > 200;
    const rows: number[][] = [];
    for (let start = 0; start < width * height; start += 1) {
      if (seen[start] === 1 || !bright(start)) continue;
      const box = { left: width, top: height, right: -1, bottom: -1 };
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const at = stack.pop()!;
        const [x, y] = [at % width, Math.floor(at / width)];
        Object.assign(box, { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) });
        for (const next of [x > 0 ? at - 1 : -1, x < width - 1 ? at + 1 : -1, y > 0 ? at - width : -1, y < height - 1 ? at + width : -1]) {
          if (next >= 0 && seen[next] === 0 && bright(next)) { seen[next] = 1; stack.push(next); }
        }
      }
      const [w, h] = [box.right - box.left + 1, box.bottom - box.top + 1];
      const [cx, cy] = [box.left + w / 2, box.top + h / 2];
      rows.push([box.left, box.top, w, h, cx - w / 4, cy - h / 4, cx + w / 4, cy - h / 4, cx, cy, cx - w / 5, cy + h / 4, cx + w / 5, cy + h / 4, 0.9]);
    }
    return rows.length === 0 ? null : rows;
  });
  expect(perFrame).toHaveLength(request.expectedFrameCount);
  return JSON.stringify(request.expectedFrameCount === 1 ? { faces: perFrame[0] } : { frames: perFrame });
}

/**
 * A source span of the 25 fps original over its whole [0, V) (§7.17 entries).
 * @returns The span.
 */
function wholeSource(): Recipe {
  return { kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(2, 5), rate: r(1) };
}

/**
 * The first sample whose magnitude passes a threshold, from a sample on.
 * @param pcm - Mono float samples.
 * @param from - The first sample searched.
 * @param threshold - The magnitude.
 * @returns Its index, or -1.
 */
function onset(pcm: Float32Array, from: number, threshold = 0.1): number {
  for (let at = from; at < pcm.length; at += 1) if (Math.abs(pcm[at]!) > threshold) return at;
  return -1;
}

/**
 * The RMS of samples [start, end).
 * @param pcm - Mono float samples.
 * @param start - The first sample.
 * @param end - The end sample.
 * @returns The RMS.
 */
function rms(pcm: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let at = start; at < end; at += 1) sum += pcm[at]! ** 2;
  return Math.sqrt(sum / (end - start));
}

/**
 * Decode a file's first audio stream to mono 48 kHz float PCM.
 * @param path - The file.
 * @returns The samples.
 */
async function pcm(path: string): Promise<Float32Array> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lipsync-recipes-'));
  // lipsync_faces: a dark picture with two white 24x24 squares; face A at x = 16 + 4n (absent on frame 3), face B fixed at x = 112.
  await lossless('faces.mp4', 'if(between(X,16+4*N,39+4*N)*between(Y,16,39)*not(eq(N,3))+between(X,112,135)*between(Y,16,39),235,40)');
  // lipsync_clip: frame n is grey 40 + 18n with a white 8x8 marker at the top-left corner of that frame's faceRect (x = 8 + 8n, y = 16).
  await lossless('clip-source.mp4', 'if(between(X,8+8*N,15+8*N)*between(Y,16,23),235,40+18*N)');
  // lipsync_composite: the original, frame n grey 40 + 18n; two 64x64 person results of 18 frames (the 0.72 s result timeline)
  // in distinct colours whose luma carries the result frame k: person 1 Y = 50 + 7k with Cb 150, person 2 Y = 160 - 5k with Cr 150.
  await lossless('comp-source.mp4', '40+18*N');
  await lossless('person-1.mp4', '50+7*N', { width: 64, height: 64, frames: 18 }, { cb: 150, cr: 128 });
  await lossless('person-2.mp4', '160-5*N', { width: 64, height: 64, frames: 18 }, { cb: 128, cr: 150 });
  // The transparent original: grey with straight alpha 64 over the whole picture, lossless PNG in QuickTime.
  await make('comp-alpha.mov', ['-f', 'lavfi', '-i', `color=c=0x606060:s=${W}x${H}:r=${FPS}:d=${V},format=rgba,colorchannelmixer=aa=0.25`, '-c:v', 'png']);
  // lipsync_stem: row A, 0.3 s of 440 Hz at amplitude 0.5 in 48 kHz PCM; row B, 0.3 s of 660 Hz at amplitude 0.5 in 44.1 kHz AAC.
  await make('row-a.wav', ['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=0.3,volume=4', '-c:a', 'pcm_s16le']);
  await make('row-b.m4a', ['-f', 'lavfi', '-i', 'sine=f=660:r=44100:d=0.3,volume=4', '-c:a', 'aac', '-b:a', '192k']);
  // D20-4 clip padding: a uniformly white picture, so the crop is white and the padding is black.
  await lossless('white.mp4', '235', { width: W, height: H, frames: 2 });
  // D20-4 face choice, foreground x < 80 on both. winner.mp4: S, 20x20 at (16, 16), wholly inside (400 px); L, 40x40 at
  // (72, 16), 8 columns inside (320 px). tie.mp4: A, 16x16 at (16, 16), wholly inside (256 px); B, 32x32 at (72, 40),
  // 8 columns inside (256 px).
  await lossless('winner.mp4', 'if(between(X,16,35)*between(Y,16,35)+between(X,72,111)*between(Y,16,55),235,40)', { width: W, height: H, frames: 2 });
  await lossless('tie.mp4', 'if(between(X,16,31)*between(Y,16,31)+between(X,72,103)*between(Y,40,71),235,40)', { width: W, height: H, frames: 2 });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  served = new Map();
  written.clear();
  vi.resetAllMocks();
  vi.mocked(runAnalysisPipeline).mockImplementation(fakeYuNet);
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

describe('the COCO counts encoder this file writes tracks with (guard)', () => {
  // The decoder's golden counts were produced by the official COCO C reference (coco-rle.node.test.ts).
  it.each([
    { height: 2, width: 3, counts: '6' }, { height: 2, width: 3, counts: '06' }, { height: 2, width: 3, counts: '213' },
    { height: 2, width: 3, counts: '01200' }, { height: 3, width: 4, counts: '142M2' }, { height: 1, width: 40, counts: '0d01]Oa0' },
  ])('LR01 re-encodes the $height by $width golden $counts from its own decoded mask', ({ height, width, counts }) => {
    const mask = decodeCocoRleMask({ size: [height, width], counts }, { width, height });
    expect(cocoCounts(width, height, (x, y) => mask[y * width + x] === 0)).toBe(counts);
  });
});

describe('lipsync_faces (§7.17 lipsync_faces row; execution design §9.4 no_face row; DD §7.2 step 3)', () => {
  /**
   * A lipsync_faces recipe on the prepared video.
   * @returns The recipe.
   */
  const recipe = (): Recipe => ({ kind: 'lipsync_faces', inputId: ID.video, track: ID.track, profile: PEOPLE });

  it('LF00 (guard) the detector stand-in finds both squares of the unmasked fixture, face A absent on frame 3', async () => {
    const answer = JSON.parse(await fakeYuNet({
      decoder: { program: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', join(dir, 'faces.mp4'), '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'] },
      processor: { program: 'python3', args: [] }, width: W, height: H, expectedFrameCount: 10, signal: new AbortController().signal,
      limits: { stdoutBytes: LIMITS.analysisStdoutBytes, stderrTailBytes: LIMITS.stderrTailBytes },
    })) as { frames: number[][][] };
    expect(answer.frames.map(rows => rows.map(row => row.slice(0, 4)))).toEqual(Array.from({ length: 10 }, (_unused, n) =>
      [...(n === 3 ? [] : [[16 + 4 * n, 16, 24, 24]]), [112, 16, 24, 24]].sort((a, b) => a[1]! - b[1]! || a[0]! - b[0]!)));
  });

  it('LF01 writes one { frameIndex, faceRect } per prepared frame, searched only inside the tracked foreground', async () => {
    // The person's foreground is the left half: face A is inside it, face B (always present) is not.
    const path = await track('track-left.json', (_frame, x) => x < 80);
    const file = await produce({ [ID.video]: join(dir, 'faces.mp4'), [ID.track]: path }, recipe(), 'text/plain');
    const json = JSON.parse(await readFile(file, 'utf8')) as { frames: { frameIndex: number; faceRect: Rect | null }[] };
    expect(json.frames.map(frame => frame.frameIndex)).toEqual(Array.from({ length: 10 }, (_unused, n) => n));
    json.frames.forEach(({ frameIndex, faceRect }) => {
      if (frameIndex === 3) { expect(faceRect).toBeNull(); return; }
      // The detector's own box in prepared-video pixels, within a pixel of rounding.
      const expected = { x: 16 + 4 * frameIndex, y: 16, width: 24, height: 24 };
      expect(faceRect, `frame ${frameIndex}`).not.toBeNull();
      for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(faceRect![side] - expected[side]), `frame ${frameIndex} ${side}`).toBeLessThanOrEqual(1);
    });
  });

  it('LF02 fails with no_face when the foreground holds no face on any frame, even though faces lie outside it', async () => {
    // Foreground only on the bottom band, below both faces.
    const path = await track('track-band.json', (_frame, _x, y) => y >= 60);
    const { report } = await runJob({ [ID.video]: join(dir, 'faces.mp4'), [ID.track]: path }, [recipe()], 'text/plain');
    expect([report.ok, report.reason, report.outputs]).toEqual([false, 'no_face', []]);
  });

  it('LF03 fails with empty_foreground when no frame of the track has foreground', async () => {
    const path = await track('track-empty.json', () => false);
    const { report } = await runJob({ [ID.video]: join(dir, 'faces.mp4'), [ID.track]: path }, [recipe()], 'text/plain');
    expect([report.ok, report.reason, report.outputs]).toEqual([false, 'empty_foreground', []]);
  });

  it.each([
    ['winner.mp4', [[16, 16, 20, 20], [72, 16, 40, 40]]],
    ['tie.mp4', [[16, 16, 16, 16], [72, 40, 32, 32]]],
  ] as const)('LF00 (guard) the detector stand-in sees the whole faces of %s', async (video, boxes) => {
    const answer = JSON.parse(await fakeYuNet({
      decoder: { program: 'ffmpeg', args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', join(dir, video), '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'] },
      processor: { program: 'python3', args: [] }, width: W, height: H, expectedFrameCount: 2, signal: new AbortController().signal,
      limits: { stdoutBytes: LIMITS.analysisStdoutBytes, stderrTailBytes: LIMITS.stderrTailBytes },
    })) as { frames: number[][][] };
    expect(answer.frames.map(rows => rows.map(row => row.slice(0, 4)))).toEqual([boxes, boxes]);
  });

  // §97 D20-4: of several faces, the one with the largest intersection with the person's foreground mask is chosen; on a tie
  // the larger face wins. Faces are measured as detected on the frame (the detector sees whole faces), then intersected.
  it.each([
    ['the largest intersection wins over a larger face that intersects less', 'winner.mp4', { x: 16, y: 16, width: 20, height: 20 }],
    ['on equal intersections the larger face wins', 'tie.mp4', { x: 72, y: 40, width: 32, height: 32 }],
  ] as const)('LF04 several faces inside the foreground: %s', async (_name, video, expected) => {
    const path = await track(`track-${video}.json`, (_frame, x) => x < 80, 2);
    const file = await produce({ [ID.video]: join(dir, video), [ID.track]: path }, recipe(), 'text/plain');
    const json = JSON.parse(await readFile(file, 'utf8')) as { frames: { frameIndex: number; faceRect: Rect | null }[] };
    expect(json.frames.map(frame => frame.frameIndex)).toEqual([0, 1]);
    for (const { frameIndex, faceRect } of json.frames) {
      expect(faceRect, `frame ${frameIndex}`).not.toBeNull();
      for (const side of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(faceRect![side] - expected[side]), `frame ${frameIndex} ${side}`).toBeLessThanOrEqual(1);
    }
  });

  // §97 D20-4, real faces: the detector is the image's own YuNet (`runAnalysisPipeline` unmocked). The prepared video is the
  // shipped portrait scaled to 256x256 beside its mirror (512x256, ten frames); the person's foreground is the right half,
  // so the face found on every frame is the mirrored one. Bounds are loose: YuNet's box covers the face without the hair,
  // roughly x 300..730 and y 250..800 of the 1024 original.
  it.skipIf(!REAL_YUNET)('LF05 a real face is found on every frame inside the tracked foreground (skipped outside the media image: needs /app/analysis-runtime.py and OpenCV)', async () => {
    const actual = await vi.importActual<{ runAnalysisPipeline: typeof runAnalysisPipeline }>('@ingest/container/analysis-pipeline.js');
    vi.mocked(runAnalysisPipeline).mockImplementation(actual.runAnalysisPipeline);
    await make('portraits.mp4', ['-loop', '1', '-framerate', String(FPS), '-i', PORTRAIT, '-filter_complex', '[0:v]scale=256:256,split[a][b];[b]hflip[m];[a][m]hstack,format=yuv420p[v]',
      '-map', '[v]', '-frames:v', '10', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(FPS)]);
    const path = await track('track-portrait.json', (_frame, x) => x >= 256, 10, { width: 512, height: 256 });
    const file = await produce({ [ID.video]: join(dir, 'portraits.mp4'), [ID.track]: path }, recipe(), 'text/plain');
    const json = JSON.parse(await readFile(file, 'utf8')) as { frames: { frameIndex: number; faceRect: Rect | null }[] };
    expect(json.frames.map(frame => frame.frameIndex)).toEqual(Array.from({ length: 10 }, (_unused, n) => n));
    for (const { frameIndex, faceRect } of json.frames) {
      expect(faceRect, `frame ${frameIndex}`).not.toBeNull();
      const [cx, cy] = [faceRect!.x + faceRect!.width / 2, faceRect!.y + faceRect!.height / 2];
      expect(faceRect!.x, `frame ${frameIndex} lies in the right half`).toBeGreaterThanOrEqual(256);
      expect([cx > 256 + 64 && cx < 256 + 192, cy > 48 && cy < 208, faceRect!.width > 48 && faceRect!.width < 160], `frame ${frameIndex} ${JSON.stringify(faceRect)}`).toEqual([true, true, true]);
    }
  });
});

describe('lipsync_clip (§7.17 lipsync_clip row; execution design §9.2 timing table; DD §7.2 step 4)', () => {
  const CROP = 64;

  it.each([
    ['cut_off', 0.32], ['silence', 0.6], ['loop', 0.72], ['bounce', 0.72], ['remap', 0.8],
  ] as const)('LC01 %s over %s s: every result frame is the mapped source frame cropped to its faceRect, black outside the mask, H.264', async (syncMode, duration) => {
    const timeline: LipsyncTimeline = { duration, videoDuration: V, syncMode };
    // faceRect of frame n: 32x32 at (8 + 8n, 16), scaled by 2 to the 64x64 crop with no padding; the person's foreground
    // covers the rect's left 24 columns (crop columns 0..48), so crop columns 48..64 are masked out.
    const faces = await facesTable(`clip-faces-${syncMode}.json`, n => ({ x: 8 + 8 * n, y: 16, width: 32, height: 32 }));
    const mask = await track(`clip-track-${syncMode}.json`, (n, x) => x >= 8 + 8 * n && x < 32 + 8 * n);
    const file = await produce({ [ID.video]: join(dir, 'clip-source.mp4'), [ID.faces]: faces, [ID.track]: mask },
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table: TABLE });
    const video = (await streams(file)).find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', CROP, CROP]);
    const count = Math.round(duration * FPS);
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: count }, (_unused, k) => k / FPS));
    expect(Number(list.at(-1)!.pts_time) + Number(list.at(-1)!.duration_time)).toBeCloseTo(duration, 6);
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(count);
    frames.forEach((frame, k) => {
      const s = lipsyncSourceFrameAt(timeline, TABLE, k / FPS);
      expect(Math.abs(mean(frame, width, { x: 20, y: 20, width: 20, height: 36 }) - (40 + 18 * s)), `frame ${k} shows source ${s}`).toBeLessThan(4);
      expect(mean(frame, width, { x: 2, y: 2, width: 10, height: 10 }), `frame ${k} marker at the crop's corner`).toBeGreaterThan(200);
      expect(mean(frame, width, { x: 52, y: 4, width: 10, height: 56 }), `frame ${k} masked out`).toBeLessThan(24);
    });
  });

  // §97 D20-4: a non-square faceRect is scaled to fit the crop, centred, and the padding is split equally, the odd pixel
  // going to the bottom (wide) or the right (tall). The picture is white and wholly foreground, so the crop is white and the
  // padding black; every row (wide) or column (tall) is classified by its mean against the midpoint 125.
  it.each([
    ['wide, odd split: 64x33 at scale 1 pads 15 rows above, 16 below', { x: 8, y: 8, width: 64, height: 33 }, 'rows', 15, 16],
    ['tall, odd split: 31x64 at scale 1 pads 16 columns left, 17 right', { x: 8, y: 8, width: 31, height: 64 }, 'columns', 16, 17],
    ['wide, even split: 32x16 at scale 2 pads 16 rows above and below', { x: 8, y: 8, width: 32, height: 16 }, 'rows', 16, 16],
  ] as const)('LC02 %s', async (_name, rect, axis, before, after) => {
    const timeline: LipsyncTimeline = { duration: 0.08, videoDuration: 0.08, syncMode: 'cut_off' };
    const faces = await facesTable(`pad-faces-${axis}-${before}-${after}.json`, () => rect, 2);
    const mask = await track(`pad-track-${axis}-${before}-${after}.json`, () => true, 2);
    const table: VideoPresentationTable = { schemaVersion: 1, timescale: FPS, runs: [{ start: 0, count: 2, step: 1, duration: 1 }] };
    const file = await produce({ [ID.video]: join(dir, 'white.mp4'), [ID.faces]: faces, [ID.track]: mask },
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table });
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(2);
    const expected = Array.from({ length: CROP }, (_unused, at) => (at < before || at >= CROP - after ? 'pad' : 'crop'));
    frames.forEach((frame, k) => {
      const lines = Array.from({ length: CROP }, (_unused, at) => mean(frame, width, axis === 'rows' ? { x: 0, y: at, width: CROP, height: 1 } : { x: at, y: 0, width: 1, height: CROP }));
      expect(lines.map(value => (value > 125 ? 'crop' : 'pad')), `frame ${k} ${axis}`).toEqual(expected);
    });
  });
});

describe('lipsync_stem (§7.17 lipsync_stem row; execution design §9.2 声音时序)', () => {
  // Tolerance of an onset: 128 samples (2.7 ms). FFmpeg 7.1.1's AAC in MP4 compensates the 1024-sample priming through the
  // edit list, and a tone onset re-decoded from it was measured within 17 samples; an output whose priming is not removed
  // is 1024 samples late, a row placed on a 44.1 kHz grid or at the wrong start is off by thousands.
  const ONSET = 128;

  it('LS01 places each row at its startTime, keeps silence between, truncates a row at duration and lasts exactly duration', async () => {
    const recipe = { kind: 'lipsync_stem', duration: r(6, 5), rows: [
      { inputId: ID.audioA, startTime: r(0) }, { inputId: ID.audioB, startTime: r(1, 2) }, { inputId: ID.audioA, startTime: r(1) },
    ] };
    const file = await produce({ [ID.audioA]: join(dir, 'row-a.wav'), [ID.audioB]: join(dir, 'row-b.m4a') }, recipe, 'audio/mp4');
    const audio = (await streams(file)).filter(stream => stream.codec_type === 'audio');
    expect(audio.map(stream => [stream.codec_name, stream.sample_rate, stream.time_base])).toEqual([['aac', '48000', '1/48000']]);
    expect((await streams(file)).map(stream => stream.codec_type)).toEqual(['audio']);
    expect(Math.abs(audio[0]!.duration_ts! - 57600)).toBeLessThanOrEqual(1);
    const samples = await pcm(file);
    expect(onset(samples, 0)).toBeLessThanOrEqual(ONSET);
    expect(Math.abs(onset(samples, 16000) - 24000)).toBeLessThanOrEqual(ONSET);
    expect(Math.abs(onset(samples, 40000) - 48000)).toBeLessThanOrEqual(ONSET);
    expect(rms(samples, 16000, 23000)).toBeLessThan(0.003);
    expect(rms(samples, 40000, 47000)).toBeLessThan(0.003);
    // The third row (1.0 s to 1.3 s) still sounds in the last stored samples before 1.2 s.
    expect(rms(samples, 55000, 57500)).toBeGreaterThan(0.25);
  });

  it('LS02 overlapping rows are summed, not normalised or replaced', async () => {
    const recipe = { kind: 'lipsync_stem', duration: r(1, 2), rows: [{ inputId: ID.audioA, startTime: r(0) }, { inputId: ID.audioB, startTime: r(1, 10) }] };
    const file = await produce({ [ID.audioA]: join(dir, 'row-a.wav'), [ID.audioB]: join(dir, 'row-b.m4a') }, recipe, 'audio/mp4');
    const samples = await pcm(file);
    // One tone of amplitude 0.5 has RMS 0.354; two uncorrelated tones summed have RMS 0.5.
    expect(Math.abs(rms(samples, 1000, 4000) - 0.354)).toBeLessThan(0.04);
    expect(Math.abs(rms(samples, 6000, 13000) - 0.5)).toBeLessThan(0.05);
  });
});

describe('lipsync_composite (§7.17 lipsync_composite row, §5.4 chunks; execution design §9.3; DD §7.2 step 6 and its output guarantee)', () => {
  // The loop timeline of 18 result frames over the 10-frame original; this chunk is result frames [4, 12), so its frames show
  // source frames 4..9, 0, 1 and person-result frames 4..11.
  const TIMELINE: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'loop' };
  const WINDOW = { start: 4, end: 12 };
  // Person 1: a 48x48 face at (8 + 4n, 8), none on source frame 4; foreground [x - 8, x + 32) x [0, 64), so the face's right
  // 16 columns lie outside it. Person 2: a fixed 48x48 face at (104, 40), foreground [100, 160) x [32, 96).
  const face1 = (n: number): Rect | null => (n === 4 ? null : { x: 8 + 4 * n, y: 8, width: 48, height: 48 });
  const OUTSIDE: Rect = { x: 0, y: 64, width: 96, height: 32 };

  /**
   * The composite job's bound inputs on an original.
   * @param source - The original's file name.
   * @returns Input id to path.
   */
  async function inputs(source: string): Promise<Record<string, string>> {
    return {
      [ID.video]: join(dir, source),
      [ID.result1]: join(dir, 'person-1.mp4'), [ID.faces1]: await facesTable('comp-faces-1.json', face1),
      [ID.track1]: await track('comp-track-1.json', (n, x, y) => x >= 8 + 4 * n - 8 && x < 8 + 4 * n + 32 && y < 64),
      [ID.result2]: join(dir, 'person-2.mp4'), [ID.faces2]: await facesTable('comp-faces-2.json', () => ({ x: 104, y: 40, width: 48, height: 48 })),
      [ID.track2]: await track('comp-track-2.json', (_n, x, y) => x >= 100 && y >= 32),
    };
  }

  /**
   * The composite recipe for one chunk.
   * @param target - Its segment target.
   * @returns The recipe.
   */
  function recipe(target: Recipe): Recipe {
    return { kind: 'lipsync_composite', inputId: ID.video, window: WINDOW, timescale: FPS, entries: [wholeSource()], target, timeline: TIMELINE, table: TABLE,
      persons: [{ result: ID.result1, faces: ID.faces1, track: ID.track1, cropSize: 64 }, { result: ID.result2, faces: ID.faces2, track: ID.track2, cropSize: 64 }] };
  }

  /**
   * Require the chunk's clock: one packet per result frame of the window from pts 0, opening with a keyframe.
   * @param file - The chunk.
   * @returns Nothing.
   */
  async function expectResultClock(file: string): Promise<void> {
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: WINDOW.end - WINDOW.start }, (_unused, j) => j / FPS));
    expect(list[0]!.flags).toContain('K');
  }

  it('LM01 opaque: each person inverse-transformed onto its face, cut by its foreground, no face on a frame leaves the source, the rest equals the source', async () => {
    const file = await produce(await inputs('comp-source.mp4'), recipe(OPAQUE));
    const all = await streams(file);
    expect(all.map(stream => [stream.codec_type, stream.codec_name, stream.width, stream.height])).toEqual([['video', 'h264', W, H]]);
    await expectResultClock(file);
    const [y, u, v, source] = await Promise.all([planeFrames(file, 'y'), planeFrames(file, 'u'), planeFrames(file, 'v'), planeFrames(join(dir, 'comp-source.mp4'), 'y')]);
    expect(y.frames).toHaveLength(8);
    y.frames.forEach((frame, j) => {
      const k = WINDOW.start + j;
      const s = lipsyncSourceFrameAt(TIMELINE, TABLE, k / FPS);
      const original = source.frames[s]!;
      // Outside every person's foreground: the source frame s, against its lossless reference within the encode's error.
      expect(mad(frame, original, W, OUTSIDE), `frame ${j} outside every mask is source ${s}`).toBeLessThan(2.5);
      const rect = face1(s);
      if (rect === null) {
        // No face on this source frame: person 1 has alpha 0 everywhere.
        const area = { x: 8 + 4 * s, y: 8, width: 48, height: 48 };
        expect(mad(frame, original, W, area), `frame ${j} has no face`).toBeLessThan(2.5);
        expect(Math.abs(mean(u.frames[j]!, u.width, half(area)) - 128)).toBeLessThan(3);
      } else {
        // The face's centre is person 1's result frame k; its columns outside the foreground are the source.
        const centre = { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 };
        expect(Math.abs(mean(frame, W, centre) - (50 + 7 * k)), `frame ${j} person 1 shows its result frame ${k}`).toBeLessThan(3.5);
        expect(Math.abs(mean(u.frames[j]!, u.width, half(centre)) - 150)).toBeLessThan(4);
        const cut = { x: rect.x + 36, y: rect.y + 16, width: 8, height: 16 };
        expect(mad(frame, original, W, cut), `frame ${j} outside person 1's foreground is the source`).toBeLessThan(2.5);
        expect(Math.abs(mean(u.frames[j]!, u.width, half(cut)) - 128)).toBeLessThan(3);
      }
      const centre2 = { x: 120, y: 56, width: 16, height: 16 };
      expect(Math.abs(mean(frame, W, centre2) - (160 - 5 * k)), `frame ${j} person 2 shows its result frame ${k}`).toBeLessThan(3.5);
      expect(Math.abs(mean(v.frames[j]!, v.width, half(centre2)) - 150)).toBeLessThan(4);
    });
  });

  // §97 D20-4: a chunk crossing the bounce reversal has no rule of its own; each result frame maps through lipsyncSourceFrameAt.
  // Result frames [6, 14) of the 0.72 s bounce timeline show source frames 6, 7, 8, 9, 9, 9, 8, 7 (t = 0.4 is s = V, the last
  // frame) and person-result frames 6..13.
  it('LM03 a chunk across the bounce reversal shows each result frame\'s mapped source frame and person frame', async () => {
    const bounce: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'bounce' };
    const window = { start: 6, end: 14 };
    const sources = Array.from({ length: 8 }, (_unused, j) => lipsyncSourceFrameAt(bounce, TABLE, (window.start + j) / FPS));
    expect(sources).toEqual([6, 7, 8, 9, 9, 9, 8, 7]);
    const file = await produce(await inputs('comp-source.mp4'), { ...recipe(OPAQUE), timeline: bounce, window });
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 8 }, (_unused, j) => j / FPS));
    expect(list[0]!.flags).toContain('K');
    const [y, source] = await Promise.all([planeFrames(file, 'y'), planeFrames(join(dir, 'comp-source.mp4'), 'y')]);
    expect(y.frames).toHaveLength(8);
    y.frames.forEach((frame, j) => {
      const [k, s] = [window.start + j, sources[j]!];
      expect(mad(frame, source.frames[s]!, W, OUTSIDE), `frame ${j} outside every mask is source ${s}`).toBeLessThan(2.5);
      const rect = face1(s)!;
      expect(Math.abs(mean(frame, W, { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 }) - (50 + 7 * k)), `frame ${j} person 1 at source ${s}'s face shows result frame ${k}`).toBeLessThan(3.5);
    });
  });

  it('LM02 transparent: VP9 with alpha on the result clock, the source alpha kept everywhere including the faces', async () => {
    const file = await produce(await inputs('comp-alpha.mov'), recipe(STRAIGHT), 'video/webm');
    const all = await streams(file);
    expect(all.map(stream => [stream.codec_type, stream.codec_name, stream.width, stream.height])).toEqual([['video', 'vp9', W, H]]);
    await expectResultClock(file);
    const vp9 = ['-c:v', 'libvpx-vp9'];
    const [alpha, u] = await Promise.all([planeFrames(file, 'a', vp9), planeFrames(file, 'u', vp9)]);
    expect(alpha.frames).toHaveLength(8);
    alpha.frames.forEach((frame, j) => {
      const s = lipsyncSourceFrameAt(TIMELINE, TABLE, (WINDOW.start + j) / FPS);
      // Straight alpha 0.25 of the source is 64 of 255, over the whole picture and over person 2's face.
      expect(Math.abs(mean(frame, W, { x: 0, y: 0, width: W, height: H }) - 64), `frame ${j} alpha`).toBeLessThan(3);
      expect(Math.abs(mean(frame, W, { x: 120, y: 56, width: 16, height: 16 }) - 64)).toBeLessThan(3);
      const rect = face1(s);
      if (rect !== null) expect(Math.abs(mean(u.frames[j]!, u.width, half({ x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 })) - 150), `frame ${j} face colour`).toBeLessThan(5);
    });
  });
});

// §97 D22-3 (frames-split §7.17 stitch row, 对口型时为各人stem之和的音频条目; execution design §9.2 last paragraph; DD §7.2
// output guarantee): the lip-sync stitch's audio is `{ kind: 'mix', inputs: [each person's stem] }`, the stems summed sample
// by sample over the result. The rest of the recipe is the single-source stitch's (`inputId`, `chunks`, `target`).
//
// The coordinator asked for samples equal to the sum within ±1 LSB; the stitched output is AAC (the opaque target is MP4
// H.264 + AAC, execution design §9.3), which no lossy decode reproduces to 1 LSB, so the sum is read per tone instead: each
// stem is a tone at its own frequency, and over 50 ms blocks (a whole number of cycles of both, so neither leaks into the
// other) the output's amplitude at each frequency equals that stem's own amplitude, read back from the stem, within 8 % (AAC
// moves a steady tone's block amplitude by up to about 4 %, composite-transition-recipes TS cases). Averaging would halve
// both, replacing would drop one, normalising would scale both.
describe('lip-sync stitch audio mix (§97 D22-3; §7.17 stitch row; execution design §9.2)', () => {
  const STEM = { a: '10000000-0000-4000-8000-0000000000b1', b: '10000000-0000-4000-8000-0000000000b2' };
  const CHUNK = '10000000-0000-4000-8000-0000000000c1';
  const BLOCK = 2400;

  /**
   * The amplitude of one frequency over a block of mono 48 kHz samples.
   * @param samples - The samples.
   * @param frequency - The frequency in Hz.
   * @param start - The block's first sample.
   * @returns The amplitude.
   */
  function amplitude(samples: Float32Array, frequency: number, start: number): number {
    let re = 0;
    let im = 0;
    for (let n = 0; n < BLOCK; n += 1) {
      const phase = (2 * Math.PI * frequency * n) / 48000;
      re += samples[start + n]! * Math.cos(phase);
      im -= samples[start + n]! * Math.sin(phase);
    }
    return (2 * Math.hypot(re, im)) / BLOCK;
  }

  /**
   * A tone's mean amplitude over the inner blocks of a file's audio (the first and last block are skipped for the encoder's
   * onset and tail).
   * @param samples - The decoded samples.
   * @param frequency - The tone.
   * @returns The mean amplitude.
   */
  function tone(samples: Float32Array, frequency: number): number {
    const blocks = Math.floor(samples.length / BLOCK);
    const values = Array.from({ length: blocks - 2 }, (_unused, at) => amplitude(samples, frequency, (at + 1) * BLOCK));
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  it('LT01 sums every person\'s stem over the result: each tone at its own amplitude, no clipping, lasting timeline.duration', async () => {
    // Two stems as lipsync_stem writes them: 0.4 s AAC 48 kHz, 440 Hz and 1000 Hz, each at amplitude 0.25 (peak sum 0.5).
    await make('stem-a.m4a', ['-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=0.4,volume=2', '-c:a', 'aac', '-b:a', '192k']);
    await make('stem-b.m4a', ['-f', 'lavfi', '-i', 'sine=f=1000:r=48000:d=0.4,volume=2', '-c:a', 'aac', '-b:a', '192k']);
    const recipe = { kind: 'stitch', inputId: ID.video, target: OPAQUE, chunks: [{ inputId: CHUNK, duration: r(2, 5) }], audio: { kind: 'mix', inputs: [STEM.a, STEM.b] } };
    const file = await produce({ [ID.video]: join(dir, 'comp-source.mp4'), [CHUNK]: join(dir, 'comp-source.mp4'),
      [STEM.a]: join(dir, 'stem-a.m4a'), [STEM.b]: join(dir, 'stem-b.m4a') }, recipe, 'video/mp4');
    const audio = (await streams(file)).filter(stream => stream.codec_type === 'audio');
    expect(audio.map(stream => [stream.codec_name, stream.sample_rate])).toEqual([['aac', '48000']]);
    // timeline.duration = 0.4 s (the one chunk), within one AAC frame.
    expect(Math.abs(audio[0]!.duration_ts! / 48000 - V)).toBeLessThanOrEqual(1024 / 48000);
    expect(await packets(file)).toHaveLength(10);
    const [mixed, a, b] = await Promise.all([pcm(file), pcm(join(dir, 'stem-a.m4a')), pcm(join(dir, 'stem-b.m4a'))]);
    for (const [frequency, stem] of [[440, a], [1000, b]] as const) {
      const expected = tone(stem, frequency);
      expect(Math.abs(tone(mixed, frequency) - expected) / expected, `${frequency} Hz keeps its stem's amplitude`).toBeLessThan(0.08);
    }
    expect(Math.max(...mixed.map(Math.abs))).toBeLessThan(0.6);
  });
});
