// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

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
 * - `lipsync_clip`: `{ kind, inputId (prepared video), faces (transform table JSON), track, cropSize, timeline, table, encode }`
 *   writes a `cropSize`² H.264 MP4 of `timeline.duration` on the prepared video's frame rate; result frame t shows the source
 *   frame `lipsyncSourceFrameAt(timeline, table, k)` cropped to its faceRect, scaled to fit and padded, black outside the mask.
 * - `lipsync_stem`: `{ kind, rows: [{ inputId, startTime }], duration }` writes AAC 48 kHz of exactly `duration`, each row
 *   placed at its start and summed, silence elsewhere, a row past the end truncated.
 * - `lipsync_composite`: `{ kind, ...windowRecipe, timeline, table, persons: [{ result, faces, track, cropSize }], rawDiskBytes,
 *   feather }`, where
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
import { decodeCocoRleMask } from '@shared/mini-tools/coco-rle.js';
import { cocoCounts } from './helpers/coco-counts.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { runPlanCommand, startPlanCommand } from '@ingest/container/plan-command.js';
import type * as PlanCommand from '@ingest/container/plan-command.js';
import { lipsyncSourceFrameAt, type LipsyncTimeline } from '@shared/mini-tools/lipsync-plan.js';
import { canonicalMediaType } from '@shared/upload/media-type.js';
import { sniffMimeType } from '@shared/upload/sniff-mime.js';
import type { VideoPresentationTable } from '@shared/mini-tools/video-presentation-table.js';

vi.mock('@ingest/container/analysis-pipeline.js', () => ({ runAnalysisPipeline: vi.fn() }));
// The real command runners, spied on so a test can read which programs run over which inputs and what files they write.
vi.mock('@ingest/container/plan-command.js', async (original) => {
  const actual = await original<typeof PlanCommand>();
  return { ...actual, runPlanCommand: vi.fn(actual.runPlanCommand), startPlanCommand: vi.fn(actual.startPlanCommand) };
});
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
// The plan's frozen container encode a clip carries, and the face feather a composite carries (config/mini-tools.yaml).
const CLIP_ENCODE = { crf: 18, preset: 'medium' };
const FEATHER = 0.1;
// A frozen raw disk budget no composite fixture comes near.
const AMPLE_RAW_DISK_BYTES = 1_000_000_000;
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
 * The error message the job logged for its failed output.
 * @returns The message, or undefined.
 */
function failure(): string | undefined {
  const call = vi.mocked(console.error).mock.calls.find(([event]) => event === 'mini_tool_plan_run_failed');
  return (call?.[1] as { err?: string } | undefined)?.err;
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
  // The odd-size originals of LM09: a 161x97 opaque one (FFV1, lossless at odd sides) and a transparent one.
  await make('comp-odd.mkv', ['-f', 'lavfi', '-i', `color=c=black:s=161x97:r=${FPS}:d=${V},format=yuv444p,geq=lum='40+18*N':cb=128:cr=128`, '-c:v', 'ffv1']);
  await make('comp-odd-alpha.mov', ['-f', 'lavfi', '-i', `color=c=0x606060:s=161x97:r=${FPS}:d=${V},format=rgba,colorchannelmixer=aa=0.25`, '-c:v', 'png']);
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
  // The decoder's golden counts were produced by the official COCO C reference (shared coco-rle.test.ts).
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

  // The track is read as the tracking recipes read it: a file that is no per-frame counts array, or counts that do not cover
  // the frame, fails as the tracking output not matching (execution design §10.2).
  it.each([
    ['is not an array of counts', '{"frames":[]}'], ['has counts that do not cover the frame', JSON.stringify(Array.from({ length: 10 }, () => '6'))],
  ] as const)('LF06 fails with tracking_output_mismatch when the track %s', async (_name, content) => {
    const path = join(dir, 'track-bad.json');
    await writeFile(path, content);
    const { report } = await runJob({ [ID.video]: join(dir, 'faces.mp4'), [ID.track]: path }, [recipe()], 'text/plain');
    expect([report.ok, report.reason, report.outputs]).toEqual([false, 'tracking_output_mismatch', []]);
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
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table: TABLE, encode: CLIP_ENCODE });
    const video = (await streams(file)).find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', CROP, CROP]);
    const count = Math.round(duration * FPS);
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: count }, (_unused, k) => k / FPS));
    expect(Number(list.at(-1)!.pts_time) + Number(list.at(-1)!.duration_time)).toBeCloseTo(duration, 6);
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(count);
    frames.forEach((frame, k) => {
      const s = lipsyncSourceFrameAt(timeline, TABLE, k);
      expect(Math.abs(mean(frame, width, { x: 20, y: 20, width: 20, height: 36 }) - (40 + 18 * s)), `frame ${k} shows source ${s}`).toBeLessThan(4);
      expect(mean(frame, width, { x: 2, y: 2, width: 10, height: 10 }), `frame ${k} marker at the crop's corner`).toBeGreaterThan(200);
      expect(mean(frame, width, { x: 52, y: 4, width: 10, height: 56 }), `frame ${k} masked out`).toBeLessThan(24);
    });
  });

  // Execution design paragraph before §9.4: the clip decodes the prepared video once, forward, as raw frames on FFmpeg's
  // stdout, crops each frame as it arrives into the encoder's stdin, and reads a reused frame's crop back from its crop file.
  // The loop, bounce and silence results reuse frames; every mode still shows its mapped source frames.
  it.each([
    ['cut_off', 0.32], ['silence', 0.6], ['loop', 0.72], ['bounce', 0.72], ['remap', 0.8],
  ] as const)('LC03 %s over %s s decodes the prepared video once through a pipe and shows the same mapped source frames', async (syncMode, duration) => {
    const timeline: LipsyncTimeline = { duration, videoDuration: V, syncMode };
    const faces = await facesTable(`seg-faces-${syncMode}.json`, n => ({ x: 8 + 8 * n, y: 16, width: 32, height: 32 }));
    const mask = await track(`seg-track-${syncMode}.json`, (n, x) => x >= 8 + 8 * n && x < 32 + 8 * n);
    const count = Math.round(duration * FPS);
    const file = await produce({ [ID.video]: join(dir, 'clip-source.mp4'), [ID.faces]: faces, [ID.track]: mask },
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table: TABLE, encode: CLIP_ENCODE });
    // The prepared video is the job's first downloaded input; every FFmpeg run that reads it decodes it.
    const reads = (calls: unknown[][]): unknown[][] => calls.filter(([program, args]) => program === 'ffmpeg' && (args as string[]).some((arg, at, all) => all[at - 1] === '-i' && arg.endsWith('source-0')));
    expect(reads(vi.mocked(runPlanCommand).mock.calls), 'no run decodes the prepared video into a file').toEqual([]);
    const piped = reads(vi.mocked(startPlanCommand).mock.calls);
    expect(piped, 'one decode of the prepared video').toHaveLength(1);
    expect((piped[0]![1] as string[]).at(-1), 'the decode writes raw frames to its stdout').toBe('pipe:1');
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(count);
    frames.forEach((frame, k) => {
      const s = lipsyncSourceFrameAt(timeline, TABLE, k);
      expect(Math.abs(mean(frame, width, { x: 20, y: 20, width: 20, height: 36 }) - (40 + 18 * s)), `frame ${k} shows source ${s}`).toBeLessThan(4);
      expect(mean(frame, width, { x: 2, y: 2, width: 10, height: 10 }), `frame ${k} marker at the crop's corner`).toBeGreaterThan(200);
    });
  });

  // Execution design paragraph before §9.4: on a variable-frame-rate source the result grid (the first run's rate) skips
  // frames of a faster run in the first cycle and shows them first in a later one, after the decode has passed them; the
  // clip crops them into its crop file as the decode passes and still decodes once. The fixture's ten frames are declared
  // as five 25 fps frames, then five 37.5 fps frames: V = 25 ticks of a 75 tick clock, the result grid every 3 ticks.
  it.each([['loop', 0.72], ['bounce', 0.72]] as const)('LC04 %s over %s s of a variable-frame-rate source shows every mapped source frame from one decode', async (syncMode, duration) => {
    const table: VideoPresentationTable = { schemaVersion: 1, timescale: 75, runs: [{ start: 0, count: 5, step: 3, duration: 3 }, { start: 15, count: 5, step: 2, duration: 2 }] };
    const timeline: LipsyncTimeline = { duration, videoDuration: 1 / 3, syncMode };
    const faces = await facesTable(`vfr-faces-${syncMode}.json`, n => ({ x: 8 + 8 * n, y: 16, width: 32, height: 32 }));
    const mask = await track(`vfr-track-${syncMode}.json`, (n, x) => x >= 8 + 8 * n && x < 32 + 8 * n);
    const file = await produce({ [ID.video]: join(dir, 'clip-source.mp4'), [ID.faces]: faces, [ID.track]: mask },
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table, encode: CLIP_ENCODE });
    const reads = vi.mocked(startPlanCommand).mock.calls.filter(([program, args]) => program === 'ffmpeg' && (args as string[]).some((arg, at, all) => all[at - 1] === '-i' && arg.endsWith('source-0')));
    expect(reads, 'one decode of the prepared video').toHaveLength(1);
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(Math.round(duration * FPS));
    const shown = frames.map((_frame, k) => lipsyncSourceFrameAt(timeline, table, k));
    expect(shown.some((s, k) => shown.slice(0, k).some(earlier => earlier > s) && !shown.slice(0, k).includes(s)), 'some frame is first shown after a later one').toBe(true);
    frames.forEach((frame, k) => {
      expect(Math.abs(mean(frame, width, { x: 20, y: 20, width: 20, height: 36 }) - (40 + 18 * shown[k]!)), `frame ${k} shows source ${shown[k]}`).toBeLessThan(4);
    });
  });

  // The clip is encoded at the plan's frozen container encode the recipe carries, as the composite's target is.
  it('LC05 encodes the clip at the recipe\'s frozen crf and preset', async () => {
    const timeline: LipsyncTimeline = { duration: 0.32, videoDuration: V, syncMode: 'cut_off' };
    const faces = await facesTable('enc-faces.json', n => ({ x: 8 + 8 * n, y: 16, width: 32, height: 32 }));
    const mask = await track('enc-track.json', (n, x) => x >= 8 + 8 * n && x < 32 + 8 * n);
    await produce({ [ID.video]: join(dir, 'clip-source.mp4'), [ID.faces]: faces, [ID.track]: mask },
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table: TABLE, encode: { crf: 31, preset: 'veryfast' } });
    const encodes = vi.mocked(startPlanCommand).mock.calls.map(([, args]) => args as string[]).filter(args => args.includes('pipe:0'));
    expect(encodes).toHaveLength(1);
    const args = encodes[0]!;
    expect([args[args.indexOf('-crf') + 1], args[args.indexOf('-preset') + 1]]).toEqual(['31', 'veryfast']);
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
      { kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: CROP, timeline, table, encode: CLIP_ENCODE });
    const { width, frames } = await planeFrames(file, 'y');
    expect(frames).toHaveLength(2);
    const expected = Array.from({ length: CROP }, (_unused, at) => (at < before || at >= CROP - after ? 'pad' : 'crop'));
    frames.forEach((frame, k) => {
      const lines = Array.from({ length: CROP }, (_unused, at) => mean(frame, width, axis === 'rows' ? { x: 0, y: at, width: CROP, height: 1 } : { x: at, y: 0, width: 1, height: CROP }));
      expect(lines.map(value => (value > 125 ? 'crop' : 'pad')), `frame ${k} ${axis}`).toEqual(expected);
    });
  });
});

// A streamed decode that fails part-way reports its own exit (code and stderr tail), never the range error a clean early
// end gives. The failing decode stands in for FFmpeg: it writes `bytes` of raw frames, a stderr line and exits 3.
describe('a streamed lip-sync decode that fails mid-stream', () => {
  /**
   * Make the next decode whose input path matches `input` write `bytes` and fail.
   * @param input - The decoded input's local path pattern.
   * @param bytes - The raw bytes it writes first.
   * @returns Nothing.
   */
  async function failDecode(input: RegExp, bytes: number): Promise<void> {
    const actual = await vi.importActual<typeof PlanCommand>('@ingest/container/plan-command.js');
    vi.mocked(startPlanCommand).mockImplementation((program, args, options, pipes) => {
      const decodes = program === 'ffmpeg' && args.at(-1) === 'pipe:1' && args.some((arg, at) => args[at - 1] === '-i' && input.test(arg));
      return decodes ? actual.startPlanCommand('sh', ['-c', `head -c ${bytes} /dev/zero; echo decode-broke >&2; exit 3`], options, pipes)
        : actual.startPlanCommand(program, args, options, pipes);
    });
  }

  it.each([
    ['ends on a frame boundary', 2], ['ends inside a frame', 1.5],
  ] as const)('LE01 the clip\'s prepared-video decode %s and the job carries its exit', async (_name, frames) => {
    await failDecode(/source-0$/, Math.round(frames * W * H * 1.5));
    const faces = await facesTable('fail-faces.json', n => ({ x: 8 + 8 * n, y: 16, width: 32, height: 32 }));
    const mask = await track('fail-track.json', (n, x) => x >= 8 + 8 * n && x < 32 + 8 * n);
    const { report } = await runJob({ [ID.video]: join(dir, 'clip-source.mp4'), [ID.faces]: faces, [ID.track]: mask },
      [{ kind: 'lipsync_clip', inputId: ID.video, faces: ID.faces, track: ID.track, cropSize: 64, timeline: { duration: 0.32, videoDuration: V, syncMode: 'cut_off' }, table: TABLE, encode: CLIP_ENCODE }]);
    expect([report.ok, report.outputs]).toEqual([false, []]);
    expect(failure()).toMatch(/^sh exited 3: decode-broke/);
  });

  it.each([
    ['the streamed source', /source-0$/, 2 * W * H * 1.5], ['a person\'s result', /source-1$/, 2 * 64 * 64 * 1.5],
  ] as const)('LE02 the composite\'s decode of %s fails and the job carries its exit', async (_name, input, bytes) => {
    await failDecode(input, bytes);
    const timeline: LipsyncTimeline = { duration: V, videoDuration: V, syncMode: 'cut_off' };
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(2, 25), displayStart: r(2, 25), displayEnd: r(9, 25), rate: r(1) }];
    const recipe = { kind: 'lipsync_composite', inputId: ID.video, window: { start: 2, end: 9 }, timescale: FPS, entries, target: OPAQUE, timeline, table: TABLE,
      rawDiskBytes: AMPLE_RAW_DISK_BYTES, feather: FEATHER, prepared: { width: W, height: H, displayRect: null }, persons: [{ result: ID.result1, faces: ID.faces1, track: ID.track1, cropSize: 64 }] };
    const { report } = await runJob({ [ID.video]: join(dir, 'comp-source.mp4'), [ID.result1]: join(dir, 'person-1.mp4'),
      [ID.faces1]: await facesTable('fail-comp-faces.json', () => ({ x: 16, y: 8, width: 48, height: 48 })),
      [ID.track1]: await track('fail-comp-track.json', () => true) }, [recipe]);
    expect([report.ok, report.outputs]).toEqual([false, []]);
    expect(failure()).toMatch(/^sh exited 3: decode-broke/);
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
    return { kind: 'lipsync_composite', inputId: ID.video, window: WINDOW, timescale: FPS, entries: [wholeSource()], target, timeline: TIMELINE, table: TABLE, rawDiskBytes: AMPLE_RAW_DISK_BYTES, feather: FEATHER,
      prepared: { width: W, height: H, displayRect: null },
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
      const s = lipsyncSourceFrameAt(TIMELINE, TABLE, k);
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

  // A model result's colour comes from its own tags, BT.601 when untagged (modelResultDecode): person 1's result is one
  // saturated colour, untagged as swscale encodes RGB by default, or converted and tagged BT.709 as the provider returns it.
  it.each([['untagged BT.601', false], ['tagged BT.709', true]] as const)('LM12 a person result (%s) keeps its RGB on the face', async (_case, tagged) => {
    const colour = [200, 40, 60];
    const raw = join(dir, `lm09-${String(tagged)}.rgb`);
    await writeFile(raw, Buffer.alloc(64 * 64 * 3 * 18).map((_unused, at) => colour[at % 3]!));
    const name = `lm09-${String(tagged)}.mp4`;
    await make(name, ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x64', '-framerate', String(FPS), '-i', raw,
      ...(tagged ? ['-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_range', 'tv'] : []),
      '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(FPS)]);
    const color = (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space', '-of', 'csv=p=0', join(dir, name)])).stdout.trim();
    expect(color, 'the fixture carries the provider\'s tags').toBe(tagged ? 'bt709' : 'unknown');
    const file = await produce({ ...await inputs('comp-source.mp4'), [ID.result1]: join(dir, name) }, recipe({ ...OPAQUE, crf: 0 }));
    // Decoded from the chunk's own tags with accurate rounding (swscale's fast YUV-to-RGB path is off by up to three).
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-fps_mode', 'passthrough', '-sws_flags', 'accurate_rnd+full_chroma_int',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    const bytes = stdout as unknown as Buffer;
    const frames = bytes.length / (W * H * 3);
    expect(frames).toBe(WINDOW.end - WINDOW.start);
    for (let j = 0; j < frames; j += 1) {
      const rect = face1(lipsyncSourceFrameAt(TIMELINE, TABLE, WINDOW.start + j));
      if (rect === null) continue;
      const sums = [0, 0, 0];
      for (let y = rect.y + 16; y < rect.y + 32; y += 1) for (let x = rect.x + 12; x < rect.x + 28; x += 1) for (let c = 0; c < 3; c += 1) sums[c]! += bytes[(j * W * H + y * W + x) * 3 + c]!;
      const rgb = sums.map(sum => sum / 256);
      // Within swscale's default BT.601-to-BT.709 rounding of a 4:2:0 picture (up to 5 on a saturated channel in the amd64
      // media image); decoding with the wrong matrix is off by 11 or more.
      rgb.forEach((channel, at) => expect(Math.abs(channel - colour[at]!), `frame ${j} face ${'RGB'[at]} (${rgb.map(Math.round).join(',')})`).toBeLessThan(6));
    }
  });

  // DD §7.2 step 6: the face's edge is feathered over the recipe's frozen fraction of its shorter side. Person 2's 48x48 face
  // starts at x = 104 inside its foreground; columns 106 and 107 lie 2.5 and 3.5 pixels in from that edge, so their weight is
  // min(1, distance / max(1, 48 × feather)).
  it.each([0, 0.5])('LM08 feathers each face\'s edge over the recipe\'s fraction %s of its shorter side', async (feather) => {
    const file = await produce(await inputs('comp-source.mp4'), { ...recipe(OPAQUE), feather });
    const [y, source] = await Promise.all([planeFrames(file, 'y'), planeFrames(join(dir, 'comp-source.mp4'), 'y')]);
    expect(y.frames).toHaveLength(8);
    y.frames.forEach((frame, j) => {
      const k = WINDOW.start + j;
      const strip = { x: 106, y: 56, width: 2, height: 16 };
      const original = mean(source.frames[lipsyncSourceFrameAt(TIMELINE, TABLE, k)]!, W, strip);
      const blended = [2.5, 3.5].map((edge) => { const weight = Math.min(1, edge / Math.max(1, 48 * feather)); return original * (1 - weight) + (160 - 5 * k) * weight; });
      expect(Math.abs(mean(frame, W, strip) - (blended[0]! + blended[1]!) / 2), `frame ${j}`).toBeLessThan(4);
    });
  });

  // §97 D20-4: a chunk crossing the bounce reversal has no rule of its own; each result frame maps through lipsyncSourceFrameAt.
  // Result frames [6, 14) of the 0.72 s bounce timeline show source frames 6, 7, 8, 9, 9, 9, 8, 7 (t = 0.4 is s = V, the last
  // frame) and person-result frames 6..13.
  it('LM03 a chunk across the bounce reversal shows each result frame\'s mapped source frame and person frame', async () => {
    const bounce: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'bounce' };
    const window = { start: 6, end: 14 };
    const sources = Array.from({ length: 8 }, (_unused, j) => lipsyncSourceFrameAt(bounce, TABLE, window.start + j));
    expect(sources).toEqual([6, 7, 8, 9, 9, 9, 8, 7]);
    // The chunk's entries cover only the source frames it shows, [6, 10) (execution design paragraph before §9.4).
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(6, 25), displayStart: r(6, 25), displayEnd: r(10, 25), rate: r(1) }];
    const file = await produce(await inputs('comp-source.mp4'), { ...recipe(OPAQUE), timeline: bounce, window, entries });
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
    // The chunk goes back through the source, so only its union window [6, 10) is decoded to a raw file.
    const outputs = [...vi.mocked(runPlanCommand).mock.calls, ...vi.mocked(startPlanCommand).mock.calls].map(([, args]) => (args as string[]).at(-1)!);
    expect(outputs.filter(output => output.endsWith('.yuv'))).toEqual([expect.stringMatching(/composite-source\.yuv$/)]);
  });

  // Execution design paragraph before §9.4: the raw source window of a chunk that goes back fits the plan's frozen disk budget;
  // the container refuses one that does not rather than fill its disk.
  it('LM05 refuses a chunk that goes back when its raw source window is over the frozen disk budget', async () => {
    const bounce: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'bounce' };
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(6, 25), displayStart: r(6, 25), displayEnd: r(10, 25), rate: r(1) }];
    const job = { ...recipe(OPAQUE), timeline: bounce, window: { start: 6, end: 14 }, entries };
    // Source frames [6, 10) are four 160x96 pictures.
    expect((await runJob(await inputs('comp-source.mp4'), [{ ...job, rawDiskBytes: 4 * W * H * 1.5 }])).report.ok).toBe(true);
    const { report } = await runJob(await inputs('comp-source.mp4'), [{ ...job, rawDiskBytes: 4 * W * H * 1.5 - 1 }]);
    expect([report.ok, report.outputs]).toEqual([false, []]);
  });

  // A chunk that goes back reads its source window from a raw file; a source that decodes fewer frames than the window
  // fails as the streamed source does, never repeating its last frame in place of the missing ones.
  it('LM07 a chunk that goes back fails when its source decodes fewer frames than the window it shows', async () => {
    await lossless('comp-source-short.mp4', '40+18*N', { width: W, height: H, frames: 8 });
    const bounce: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'bounce' };
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(6, 25), displayStart: r(6, 25), displayEnd: r(10, 25), rate: r(1) }];
    const { report } = await runJob(await inputs('comp-source-short.mp4'), [{ ...recipe(OPAQUE), timeline: bounce, window: { start: 6, end: 14 }, entries }]);
    expect([report.ok, report.outputs]).toEqual([false, []]);
    expect(failure()).toBe("The lip-sync composite's source ends before a frame it shows");
  });

  // Execution design paragraph before §9.4: a chunk whose source frames never go back streams the source, every person's
  // result (seeked to the window, never decoded from frame 0) and the output through pipes, writing no raw file.
  it.each([
    ['cut_off', 0.4, { start: 2, end: 9 }], ['silence', 0.72, { start: 6, end: 16 }], ['remap', 0.72, { start: 3, end: 15 }],
  ] as const)('LM04 a forward %s chunk streams its frames and writes no raw file', async (syncMode, duration, window) => {
    const timeline: LipsyncTimeline = { duration, videoDuration: V, syncMode };
    const sources = Array.from({ length: window.end - window.start }, (_unused, j) => lipsyncSourceFrameAt(timeline, TABLE, window.start + j));
    const shown = { start: Math.min(...sources), end: Math.max(...sources) + 1 };
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(shown.start, 25), displayStart: r(shown.start, 25), displayEnd: r(shown.end, 25), rate: r(1) }];
    const file = await produce(await inputs('comp-source.mp4'), { ...recipe(OPAQUE), timeline, window, entries });
    const calls = [...vi.mocked(runPlanCommand).mock.calls, ...vi.mocked(startPlanCommand).mock.calls].map(([program, args]) => ({ program, args: args as string[] }));
    expect(calls.filter(({ args }) => args.at(-1)!.endsWith('.yuv')), 'no raw file').toEqual([]);
    // Person results are the job's inputs after the source: each is opened at the window, not trimmed from frame 0.
    const persons = calls.filter(({ program, args }) => program === 'ffmpeg' && args.some((arg, at) => args[at - 1] === '-i' && /source-[1-9]$/.test(arg)) && args.at(-1) === 'pipe:1');
    expect(persons).toHaveLength(2);
    for (const { args } of persons) {
      expect(args.join(' ')).not.toContain('trim=start_frame');
      expect(args.indexOf('-ss'), 'seeks before opening the result').toBeLessThan(args.indexOf('-i'));
      expect(args.indexOf('-ss')).toBeGreaterThanOrEqual(0);
    }
    const [y, source] = await Promise.all([planeFrames(file, 'y'), planeFrames(join(dir, 'comp-source.mp4'), 'y')]);
    expect(y.frames).toHaveLength(window.end - window.start);
    y.frames.forEach((frame, j) => {
      const [k, s] = [window.start + j, sources[j]!];
      expect(mad(frame, source.frames[s]!, W, OUTSIDE), `frame ${j} outside every mask is source ${s}`).toBeLessThan(2.5);
      const rect = face1(s);
      if (rect !== null) expect(Math.abs(mean(frame, W, { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 }) - (50 + 7 * k)), `frame ${j} person 1 shows result frame ${k}`).toBeLessThan(3.5);
      expect(Math.abs(mean(frame, W, { x: 120, y: 56, width: 16, height: 16 }) - (160 - 5 * k)), `frame ${j} person 2 shows result frame ${k}`).toBeLessThan(3.5);
    });
  });

  // A person's result is opened at the window by its own packet times: an MP4 with B-frames and no edit list starts at a
  // non-zero time, which an input seek must not add on top (the `-seek_timestamp` the window graph also uses), and its
  // demuxer searches the seek time on the decode clock, which runs behind the presentation clock, so a plain seek lands on a
  // later keyframe. The fixture is lossless enough and tagged BT.709, so the face's luma measures the frame shown and nothing
  // else.
  const BFRAMES = 'person-1-bframes.mp4';
  const BFRAMES_TIMELINE: LipsyncTimeline = { duration: 0.72, videoDuration: V, syncMode: 'cut_off' };

  /**
   * Write the B-frame person result: frame n has luma 50 + 7n, two B-frames per keyframe interval of five, no edit list.
   * @returns Nothing.
   */
  async function makeBframes(): Promise<void> {
    await make(BFRAMES, ['-f', 'lavfi', '-i', `color=c=black:s=64x64:r=${FPS}:d=0.72,format=yuv420p,geq=lum='50+7*N':cb=150:cr=128`,
      '-c:v', 'libx264', '-qp', '1', '-bf', '2', '-x264-params', 'b-adapt=0:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-g', '5', '-pix_fmt', 'yuv420p', '-video_track_timescale', String(FPS), '-use_editlist', '0']);
  }

  /**
   * Produce one cut_off chunk over the B-frame person result and read person 1's face luma on every frame.
   * @param window - The chunk's result frames, inside the original's frames.
   * @returns For each frame with a face, the result frame it shows (by luma) against the one it should.
   */
  async function bframesShown(window: { start: number; end: number }): Promise<{ k: number; shown: number }[]> {
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(window.start, 25), displayStart: r(window.start, 25), displayEnd: r(window.end, 25), rate: r(1) }];
    const file = await produce({ ...await inputs('comp-source.mp4'), [ID.result1]: join(dir, BFRAMES) }, { ...recipe(OPAQUE), timeline: BFRAMES_TIMELINE, window, entries });
    const y = await planeFrames(file, 'y');
    expect(y.frames).toHaveLength(window.end - window.start);
    return y.frames.flatMap((frame, j) => {
      const k = window.start + j;
      const rect = face1(lipsyncSourceFrameAt(BFRAMES_TIMELINE, TABLE, k));
      return rect === null ? [] : [{ k, shown: (mean(frame, W, { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 }) - 50) / 7 }];
    });
  }

  it('LM06 a person result whose start time is not 0 still shows its result frame k on result frame k', async () => {
    await makeBframes();
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', join(dir, BFRAMES)]);
    expect(Number(stdout), 'the fixture starts about two frames late').toBeGreaterThan(0.05);
    for (const { k, shown } of await bframesShown({ start: 3, end: 9 })) expect(Math.abs(shown - k) * 7, `person 1 shows result frame ${k}`).toBeLessThan(3.5);
  });

  // The same result opened at every start point a chunk can take inside it: a seek that lands late does so only where the
  // decode clock reaches the next keyframe, so one window can pass by luck.
  it('LM06 a person result with B-frames and no edit list shows result frame k on result frame k from every window start', async () => {
    await makeBframes();
    const wrong: string[] = [];
    for (let start = 1; start <= 8; start += 1) {
      for (const { k, shown } of await bframesShown({ start, end: start + 2 })) if (Math.abs(shown - k) * 7 >= 3.5) wrong.push(`start ${start}: frame ${k} shows ${shown.toFixed(2)}`);
    }
    expect(wrong).toEqual([]);
  });

  // DD §7.2 step 6 and row R4: a person's result is mapped onto the result grid by its presentation time, never by its frame
  // number. A 50 fps result whose frame n has luma 30 + 5n: result-grid frame k at k / 25 s shows its frame 2k, and once the
  // grid passes the result's end (0.32 s for the 16-frame one) the source shows through.
  it.each([
    ['as long as the timeline', 36, 18], ['ending inside the chunk', 16, 8],
  ] as const)('LM10 a 50 fps person result %s is laid by the frame each result-grid time falls in', async (_name, frames, ends) => {
    const name = `person-1-50fps-${frames}.mp4`;
    await make(name, ['-f', 'lavfi', '-i', `color=c=black:s=64x64:r=50:d=${frames / 50},format=yuv420p,geq=lum='30+5*N':cb=150:cr=128`,
      '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-video_track_timescale', '50']);
    const file = await produce({ ...await inputs('comp-source.mp4'), [ID.result1]: join(dir, name) }, recipe(OPAQUE));
    const [y, source] = await Promise.all([planeFrames(file, 'y'), planeFrames(join(dir, 'comp-source.mp4'), 'y')]);
    expect(y.frames).toHaveLength(8);
    y.frames.forEach((frame, j) => {
      const k = WINDOW.start + j;
      const s = lipsyncSourceFrameAt(TIMELINE, TABLE, k);
      const rect = face1(s);
      if (rect === null) return;
      const centre = { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 };
      if (k < ends) expect(Math.abs(mean(frame, W, centre) - (30 + 10 * k)), `frame ${j} shows person 1's result frame ${2 * k}`).toBeLessThan(3.5);
      else expect(mad(frame, source.frames[s]!, W, centre), `frame ${j} is past person 1's result and shows source ${s}`).toBeLessThan(2.5);
    });
  });

  // DD row R4: a model that keeps the frame count but rewrites the timestamps onto its own clock rounds frame starts up by
  // under one tick. On a 30000/1001 grid, `-r 29.97` stores frame n at 400n / 11988 s and an MP4 timescale of 15360 at
  // round(512.512n) / 15360 s, each a hair after n · 1001 / 30000; grid frame k still shows the result frame nearest its time,
  // never repeating one frame and dropping the next. Frame n of the result has luma 50 + 7n.
  it.each([
    ['at -r 29.97 on a 1/11988 clock', ['-r', '29.97']], ['on an MP4 timescale of 15360', ['-video_track_timescale', '15360']],
  ] as const)('LM11 a 29.97 fps person result %s shows result frame k on grid frame k', async (_name, clock) => {
    const table: VideoPresentationTable = { schemaVersion: 1, timescale: 30000, runs: [{ start: 0, count: 10, step: 1001, duration: 1001 }] };
    const [source, result] = ['comp-source-2997.mp4', `person-1-2997-${clock[1]}.mp4`];
    await make(source, ['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=30000/1001,format=yuv420p,geq=lum='40+18*N':cb=128:cr=128`, '-frames:v', '10',
      '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', '-video_track_timescale', '30000']);
    await make(result, ['-f', 'lavfi', '-i', `color=c=black:s=64x64:r=30000/1001,format=yuv420p,geq=lum='50+7*N':cb=150:cr=128`, '-frames:v', '10',
      '-c:v', 'libx264', '-qp', '0', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', ...clock]);
    const timeline: LipsyncTimeline = { duration: 10010 / 30000, videoDuration: 10010 / 30000, syncMode: 'cut_off' };
    const window = { start: 0, end: 10 };
    const entries = [{ kind: 'source', decodeStart: r(0), clipStart: r(0), displayStart: r(0), displayEnd: r(10010, 30000), rate: r(1) }];
    const file = await produce({ ...await inputs(source), [ID.result1]: join(dir, result) },
      { ...recipe(OPAQUE), timescale: 30000, table, timeline, window, entries, persons: [{ result: ID.result1, faces: ID.faces1, track: ID.track1, cropSize: 64 }] });
    const y = await planeFrames(file, 'y');
    expect(y.frames).toHaveLength(10);
    y.frames.forEach((frame, k) => {
      const rect = face1(k);
      if (rect !== null) expect(Math.abs(mean(frame, W, { x: rect.x + 12, y: rect.y + 16, width: 16, height: 16 }) - (50 + 7 * k)), `frame ${k} shows person 1's result frame ${k}`).toBeLessThan(3.5);
    });
  });

  // §5.3 model-input row, §4.3 odd-size row: the prepared video pads an odd 161x97 picture to 162x98 and keeps the picture
  // rectangle, so the track and the faces are in its pixels; the output rounds an opaque odd side down to 160x96 and keeps a
  // transparent one at 161x97. Person 1's 48x48 face at (104, 40) of the prepared picture, foreground x >= 100, y >= 32.
  it.each([
    // The opaque original's frame n is grey 40 + 18n; the transparent one is 0x606060, BT.709 limited-range luma 16 + 219 × 96 / 255.
    ['opaque', 'comp-odd.mkv', { ...OPAQUE, width: 160, height: 96 }, 'video/mp4', [], (s: number): number => 40 + 18 * s],
    ['transparent', 'comp-odd-alpha.mov', { ...STRAIGHT, width: 161, height: 97 }, 'video/webm', ['-c:v', 'libvpx-vp9'], (): number => 16 + 219 * 96 / 255],
  ] as const)('LM09 an odd %s original: each mask and face read at the prepared size is laid onto the output picture', async (_alpha, source, target, contentType, decoder, sourceLuma) => {
    const prepared = { width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } };
    const files = {
      [ID.video]: join(dir, source), [ID.result1]: join(dir, 'person-1.mp4'),
      [ID.faces1]: await facesTable('odd-faces.json', () => ({ x: 104, y: 40, width: 48, height: 48 })),
      [ID.track1]: await track('odd-track.json', (_n, x, y) => x >= 100 && y >= 32, 10, prepared),
    };
    const file = await produce(files, { ...recipe(target), prepared, persons: [{ result: ID.result1, faces: ID.faces1, track: ID.track1, cropSize: 64 }] }, contentType);
    expect((await streams(file)).map(stream => [stream.width, stream.height])).toEqual([[target.width, target.height]]);
    const y = await planeFrames(file, 'y', [...decoder]);
    expect(y.frames).toHaveLength(8);
    // The face's centre (128, 64) of the prepared picture lies there scaled by the output over the picture rectangle.
    const centre = { x: Math.round(128 * target.width / 161) - 8, y: Math.round(64 * target.height / 97) - 8, width: 16, height: 16 };
    const outside = { x: 0, y: 0, width: 64, height: 24 };
    y.frames.forEach((frame, j) => {
      const k = WINDOW.start + j;
      expect(Math.abs(mean(frame, y.width, centre) - (50 + 7 * k)), `frame ${j} shows person 1's result frame ${k}`).toBeLessThan(4);
      expect(Math.abs(mean(frame, y.width, outside) - sourceLuma(lipsyncSourceFrameAt(TIMELINE, TABLE, k))), `frame ${j} outside the foreground is the source`).toBeLessThan(3);
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
      const s = lipsyncSourceFrameAt(TIMELINE, TABLE, WINDOW.start + j);
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
