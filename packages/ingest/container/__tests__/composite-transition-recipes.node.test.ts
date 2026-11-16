// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Batch-6 container recipes on real media: the expand `model_composite` (erase is in erase-expand-recipes.node.test.ts), the GL `transition_window` and the transition
 * `stitch` (inner#1306 test plan §97 D15, D16; frames-split design §7.17 rows `model_composite`, `transition_window`,
 * `stitch`, `chunk_encode`, the 转场输出档 row and the `segment` row's output profile; §5.4 切块, 块的时间, 拼接 rows and its
 * last paragraph; execution design §8, §8.1; transitions render DD of 2026-11-05).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the container does, with the edge faked at `fetch`, like
 * `presentation-recipes.node.test.ts`. Every recipe here is one the shared recipe schema (`mini-tool-plan-job.ts`) admits;
 * the schema is not imported, because it pulls the shared HTTP transport into the container's DOM-less typecheck. Every
 * fixture is generated here with FFmpeg and every assertion is a fact FFmpeg reads back.
 *
 * Readings this file makes of the recipes (recorded for review):
 * - expand: each background object is already in the target geometry, on its own clock from 0 at its window's start
 *   (§8.1 "按其实际PTS映射回本窗"); the frozen source position is `target.displayRect`, as a chunk places the picture there
 *   (§3.5); inside an overlap the two backgrounds are blended by presentation time (§8.1 "重叠区域按presentation时间混合").
 *   A background with `crop` (inner#1306 D20-2) is a whole model frame: the container crops it to that rectangle, in the
 *   model output's own pixels, and scales the crop to the target geometry before mapping it by PTS (execution §8: the
 *   worker never decodes pixels). `crop` is not yet in the shared schema, whose strict background object refuses it.
 * - transition_window: each clip's entries cover the chunk's own frames [k0, k1) in that clip's presentation time, and each
 *   clip carries its own `colorMatrix` and `toneMap` (frames-split §4.3 colour/HDR row), so an HDR clip is tone mapped to
 *   SDR BT.709 with its plan matrix before the blend, exactly as its `chunk_encode`/`segment` chunks are.
 *
 * The `transition_window` cases need the headless-gl renderer process, which exists only in the `MiniToolContainerGl` image
 * (frames-split §5.4 派发 and 拼接 rows; the image is built on the `MiniToolContainerStd4` image). They run only when
 * `MINI_TOOL_CONTAINER_GL` is set, inside that image, e.g. once the image exists:
 *   IMAGE=<gl image> BUILD=0 packages/ingest/scripts/test-container-in-image.sh container/__tests__/composite-transition-recipes.node.test.ts
 * once the script passes `MINI_TOOL_CONTAINER_GL=1` into the container (it does not yet: it builds only
 * `packages/ingest/Dockerfile` and forwards no environment). Elsewhere they are skipped. The transition stitch runs in the standard image and is never skipped: its chunks there are `chunk_encode`
 * chunks, because the stitch only stream-copies chunk video. TW07 runs everywhere: it stands a recorder in for the renderer
 * process (the one `node` command the window job runs), so it checks the frames the job decodes for the blend, not the blend.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import type { PlanCommandOptions } from '@ingest/container/plan-command.js';

// The renderer stand-in (TW07): when on, the GL renderer command records both decoded RGBA inputs and writes the first as
// the output, so the window job completes outside the GL image; every other command runs for real.
const renderer = vi.hoisted(() => ({ fake: false, inputs: [] as Buffer[] }));
vi.mock('@ingest/container/plan-command.js', async (original) => {
  const actual = await original<{ runPlanCommand: (program: string, args: readonly string[], options: PlanCommandOptions) => Promise<Buffer> }>();
  const { copyFile, readFile: read } = await import('node:fs/promises');
  return {
    ...actual,
    runPlanCommand: async (program: string, args: readonly string[], options: PlanCommandOptions): Promise<Buffer> => {
      if (!renderer.fake || program !== 'node' || args[0] !== '/app/gl-renderer/render.mjs') return actual.runPlanCommand(program, args, options);
      const request = JSON.parse(await read(args[1]!, 'utf8')) as { from: string; to: string; output: string };
      renderer.inputs = [await read(request.from), await read(request.to)];
      await copyFile(request.from, request.output);
      return Buffer.alloc(0);
    },
  };
});

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
interface Report { ok: boolean; outputs: { outputIndex: number }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; time_base: string; sample_rate?: string; duration?: string }
interface Packet { pts_time: string; duration_time: string; flags: string }

const GL = process.env.MINI_TOOL_CONTAINER_GL !== undefined && process.env.MINI_TOOL_CONTAINER_GL !== '';
const GL_SKIP = 'needs the MiniToolContainerGl image (headless-gl renderer); set MINI_TOOL_CONTAINER_GL inside it';

/**
 * An exact time in lowest terms (the shared exact-time schema compares by value; lowest terms keep it canonical).
 * @param numerator - Its numerator.
 * @param denominator - Its denominator.
 * @returns The exact time.
 */
function r(numerator: number, denominator = 1): Exact {
  let [a, b] = [Math.abs(numerator), denominator];
  while (b !== 0) [a, b] = [b, a % b];
  const g = a === 0 ? denominator : a;
  return { numerator: String(numerator / g), denominator: String(denominator / g) };
}

const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const TARGET = { width: 64, height: 36, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
// Each window clip's source conversion (frames-split §4.3): an SDR BT.709 clip as it is, a PQ BT.2020 clip tone mapped.
const SDR = { colorMatrix: 'bt709', toneMap: 'none' };
const HDR = { colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' };
const PROFILE = { width: 64, height: 36, fps: r(25), timeBase: r(1, 25), pixFmt: 'yuv420p', color: { matrix: 'bt709', range: 'tv', primaries: 'bt709', transfer: 'bt709' }, codec: 'h264', encode: { crf: 18, preset: 'medium' }, alpha: false };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const BACKGROUNDS = ['10000000-0000-4000-8000-0000000000b0', '10000000-0000-4000-8000-0000000000b1'];
const CLIP_A = '10000000-0000-4000-8000-0000000000a1';
const CLIP_B = '10000000-0000-4000-8000-0000000000a2';
const CHUNKS = ['10000000-0000-4000-8000-0000000000c0', '10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c2'];
// The transition timeline on the 25 fps output grid: clip A is 40 frames, clip B 40 frames, the window is A's last 10
// frames over B's first 10, so output frames [0, 30) are A, [30, 40) the window, [40, 70) B's frames 10 to 40.
const WINDOW = { startFrame: 30, frameCount: 10 };
// Each clip's whole audio, ALAC at 48 kHz with one edit from media time 0 (as presentation-recipes CC02 writes it).
const CLIP_AUDIO = { start: r(0), end: r(8, 5), origin: r(0), spans: [{ sourceStart: r(0), sourceEnd: r(8, 5), presentationStart: r(0), rate: r(1) }] };

let dir: string;
let served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
let reports: Report[] = [];
let logged: unknown[][] = [];

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
 * One source clip span (§7.17 `segment` row), every time in presentation time except the two source times.
 * @param decodeStart - The keyframe the decode starts at.
 * @param clipStart - The source time the span starts at.
 * @param displayStart - Its presentation start.
 * @param displayEnd - Its presentation end.
 * @returns The span.
 */
function span(decodeStart: Exact, clipStart: Exact, displayStart: Exact, displayEnd: Exact): Recipe {
  return { kind: 'source', decodeStart, clipStart, displayStart, displayEnd, rate: r(1) };
}

/**
 * A transition `chunk_encode` over one clip's presented frames [start, end) at 25 fps, keyframes every 10 frames.
 * @param inputId - The clip.
 * @param start - Its first presented frame.
 * @param end - The frame after its last.
 * @param conversion - The clip's source conversion.
 * @returns The recipe, carrying the transition output profile.
 */
function clipChunk(inputId: string, start: number, end: number, conversion = SDR): Recipe {
  const from = r(start, 25);
  // The clip and the profile are both 25 fps here, so the chunk's output frames are its presented frames.
  return { kind: 'chunk_encode', inputId, window: { start, end }, timescale: 25, entries: [span(r(Math.floor(start / 10) * 10, 25), from, from, r(end, 25))], target: { ...TARGET, ...conversion }, profile: PROFILE, frames: { start, end } };
}

/**
 * A `transition_window` chunk over output frames [start, end) of the window, each clip's entries covering those frames.
 * @param transition - The transition type.
 * @param start - The chunk's first output frame.
 * @param end - The frame after its last.
 * @param conversions - Clip A's and clip B's source conversions.
 * @returns The recipe.
 */
function windowChunk(transition: 'fade' | 'wipeLeft' | 'wipeRight', start: number, end: number, conversions = [SDR, SDR]): Recipe {
  const offset = start - WINDOW.startFrame;
  const fit = { x: 0, y: 0, width: 64, height: 36 };
  const from = { inputId: CLIP_A, entries: [span(r(30, 25), r(30 + offset, 25), r(30 + offset, 25), r(30 + offset + end - start, 25))], fit, ...conversions[0] };
  const to = { inputId: CLIP_B, entries: [span(r(0), r(offset, 25), r(offset, 25), r(offset + end - start, 25))], fit, ...conversions[1] };
  return { kind: 'transition_window', clips: [from, to], frames: { start, end }, window: WINDOW, transition, profile: PROFILE };
}

/**
 * Run one planned job with one output per recipe and read back what it wrote.
 * @param inputs - Input id to served file path.
 * @param recipes - One recipe per output.
 * @returns The report and the written output paths in output order.
 */
async function runJob(inputs: Record<string, string>, recipes: Recipe[]): Promise<{ report: Report; files: string[] }> {
  const tag = Math.random().toString(36).slice(2);
  const bound = Object.entries(inputs).map(([inputId, path]) => {
    const url = `http://inputs.test/${tag}/${inputId}`;
    served.set(url, path);
    return { inputId, url };
  });
  const outputs = recipes.map((recipe, outputIndex) => ({
    outputIndex, key: `video/source.mp4.job-${tag}-${outputIndex}`, url: `http://outputs.test/${tag}/${outputIndex}`, contentType: 'video/mp4', recipe,
  }));
  reports = [];
  logged = [];
  await runPlanJob({
    schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: bound, outputs, reportUrl: 'http://jobs.test/report',
  } as unknown as PlanRunBody);
  const files = await Promise.all(outputs.map(async ({ url, outputIndex }) => {
    const path = join(dir, `${tag}-${outputIndex}.mp4`);
    const bytes = written.get(url);
    if (bytes !== undefined) await writeFile(path, bytes);
    return path;
  }));
  return { report: reports[0]!, files };
}

/**
 * Run one job and require it to succeed with every output.
 * @param inputs - Input id to served file path.
 * @param recipes - One recipe per output.
 * @returns The written output paths.
 */
async function produce(inputs: Record<string, string>, recipes: Recipe[]): Promise<string[]> {
  const { report, files } = await runJob(inputs, recipes);
  // The container logs why a job failed; the message carries it so a red case names the missing step.
  expect(report.ok, JSON.stringify(logged)).toBe(true);
  expect(report.outputs.map(output => output.outputIndex)).toEqual(recipes.map((_recipe, index) => index));
  return files;
}

/**
 * The streams and format duration of a file.
 * @param path - The file.
 * @returns Its streams and duration.
 */
async function probe(path: string): Promise<{ streams: Stream[]; duration: number }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]);
  const parsed = JSON.parse(stdout) as { streams: Stream[]; format: { duration: string } };
  return { streams: parsed.streams, duration: Number(parsed.format.duration) };
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
 * The stored Y plane of every stored frame (passthrough: exactly the stored frames, no rate conversion).
 * @param path - The file.
 * @returns The picture size and one plane per frame.
 */
async function yPlanes(path: string): Promise<{ width: number; height: number; frames: Buffer[] }> {
  const video = (await probe(path)).streams.find(stream => stream.codec_type === 'video')!;
  const [width, height] = [video.width!, video.height!];
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-vf', 'extractplanes=y', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const size = width * height;
  return { width, height, frames: Array.from({ length: bytes.length / size }, (_unused, frame) => bytes.subarray(frame * size, frame * size + size)) };
}

/**
 * The mean stored luma of every stored frame inside a rectangle.
 * @param path - The file.
 * @param crop - The rectangle, the whole picture when absent.
 * @returns One mean per frame.
 */
async function lumaMeans(path: string, crop?: Rect): Promise<number[]> {
  const { width, height, frames } = await yPlanes(path);
  const area = crop ?? { x: 0, y: 0, width, height };
  return frames.map((plane) => {
    let sum = 0;
    for (let y = area.y; y < area.y + area.height; y += 1) for (let x = area.x; x < area.x + area.width; x += 1) sum += plane[y * width + x]!;
    return sum / (area.width * area.height);
  });
}

/**
 * The mean stored luma of each column of every stored frame.
 * @param path - The file.
 * @returns Per frame, one mean per column.
 */
async function columnMeans(path: string): Promise<number[][]> {
  const { width, height, frames } = await yPlanes(path);
  return frames.map(plane => Array.from({ length: width }, (_unused, x) => {
    let sum = 0;
    for (let y = 0; y < height; y += 1) sum += plane[y * width + x]!;
    return sum / height;
  }));
}

/**
 * Every stored frame of a file decoded to RGBA through a filter chain (passthrough: exactly the stored frames).
 * @param path - The file.
 * @param filters - The chain that converts its frames to `rgba`.
 * @returns The raw RGBA frames.
 */
async function rgba(path: string, filters: string): Promise<Buffer> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-vf', filters, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  return stdout;
}

/**
 * The mean red, green and blue of every 64x36 RGBA frame.
 * @param bytes - The raw RGBA frames.
 * @returns Per frame, [R, G, B].
 */
function channelMeans(bytes: Buffer): number[][] {
  const size = 64 * 36 * 4;
  return Array.from({ length: bytes.length / size }, (_unused, frame) => [0, 1, 2].map((channel) => {
    let sum = 0;
    for (let at = frame * size + channel; at < (frame + 1) * size; at += 4) sum += bytes[at]!;
    return sum / (64 * 36);
  }));
}

/**
 * The mean stored Y, U and V of every 64x36 frame, read as 8-bit 4:2:0 after an optional filter chain.
 * @param path - The file.
 * @param filters - A chain run before the read, none when absent.
 * @returns Per frame, [Y, U, V].
 */
async function planeMeans(path: string, filters?: string): Promise<number[][]> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', ...(filters === undefined ? [] : ['-vf', filters]),
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const [luma, chroma] = [64 * 36, 32 * 18];
  const mean = (from: number, length: number): number => bytes.subarray(from, from + length).reduce((sum, value) => sum + value, 0) / length;
  return Array.from({ length: bytes.length / (luma + 2 * chroma) }, (_unused, frame) => {
    const at = frame * (luma + 2 * chroma);
    return [mean(at, luma), mean(at + luma, chroma), mean(at + luma + chroma, chroma)];
  });
}

/**
 * The first audio stream's first channel as 32-bit float samples at 48 kHz: the mono test tones play on both channels of the
 * stitched output at their own level.
 * @param path - The file.
 * @returns Its samples.
 */
async function samples(path: string): Promise<Float32Array> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-map', '0:a:0', '-af', 'pan=mono|c0=c0', '-ar', '48000', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const BLOCK = 960; // 20 ms at 48 kHz: a whole number of cycles of both test tones (500 Hz and 1500 Hz).

/**
 * The amplitude of one tone in each 20 ms block, by correlating the samples with that frequency's sine and cosine.
 * @param signal - Samples at 48 kHz.
 * @param frequency - The tone.
 * @returns One amplitude per whole block.
 */
function toneAmplitudes(signal: Float32Array, frequency: number): number[] {
  return Array.from({ length: Math.floor(signal.length / BLOCK) }, (_unused, block) => {
    let [sine, cosine] = [0, 0];
    for (let n = block * BLOCK; n < (block + 1) * BLOCK; n += 1) {
      const phase = 2 * Math.PI * frequency * n / 48000;
      sine += signal[n]! * Math.sin(phase);
      cosine += signal[n]! * Math.cos(phase);
    }
    return 2 * Math.hypot(sine, cosine) / BLOCK;
  });
}

/**
 * The RMS of each 20 ms block.
 * @param signal - Samples at 48 kHz.
 * @returns One RMS per whole block.
 */
function blockRms(signal: Float32Array): number[] {
  return Array.from({ length: Math.floor(signal.length / BLOCK) }, (_unused, block) => {
    let sum = 0;
    for (let n = block * BLOCK; n < (block + 1) * BLOCK; n += 1) sum += signal[n]! ** 2;
    return Math.sqrt(sum / BLOCK);
  });
}

/**
 * Require the BT.709 limited-range tags every carrier and transition output is written with (§4.3, 转场输出档 row).
 * @param stream - The video stream.
 * @returns Nothing.
 */
function expectBt709(stream: Stream): void {
  expect([stream.color_primaries, stream.color_transfer, stream.color_space, stream.color_range]).toEqual(['bt709', 'bt709', 'bt709', 'tv']);
}

/**
 * The first video stream's codec headers as the stitch compares them (§5.4 拼接 row: codec, profile, size, pixel format, extradata).
 * @param path - The file.
 * @returns Them as ffprobe prints them.
 */
async function codecHeaders(path: string): Promise<unknown> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt,extradata', '-show_data', '-of', 'json', path]);
  return (JSON.parse(stdout) as { streams: unknown[] }).streams;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'composite-transition-recipes-'));
  const tagged = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  const h264 = ['-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged];
  // Ten frames at 25 fps, each a different grey (stored luma 16 + 20n), keyframes at frames 0 and 5.
  await make('greys.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=0.4,format=yuv420p,geq=lum='16+20*N':cb=128:cr=128", ...h264, '-g', '5', '-video_track_timescale', '25']);
  await make('greys-ntsc.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30000/1001:d=0.7,format=yuv420p,geq=lum='16+10*N':cb=128:cr=128,trim=end_frame=20",
    ...h264, '-g', '30', '-video_track_timescale', '30000']);
  // 30000/1001 fps greys of stored luma 16 + 6n on a 1/90000 clock from pts 0, B-frames on (a late picture's media).
  await make('greys-90k.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30000/1001:d=1,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128",
    '-c:v', 'libx264', '-qp', '0', '-bf', '2', '-g', '30', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', '-use_editlist', '0']);
  // 25 fps greys of stored luma 16 + 6n as FFmpeg's default x265 MP4 writes them: media pts from 1024/12800, one whole-media edit.
  await make('greys-x265.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=1,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128",
    '-c:v', 'libx265', '-x265-params', 'lossless=1:bframes=2:log-level=error', '-g', '25', '-pix_fmt', 'yuv420p']);
  // Thirty 30 fps frames of stored luma 16 + 6n in a lossless VP9 WebM, whose 1 ms clock stores them at 0, 33, 67, 100 ms...
  await make('greys-30.webm', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30:d=1,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128", '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p']);
  // The same greys at 29.97 fps: stored at 0, 33, 67, 100 ms... while frame n truly starts at n · 1001/30000 s.
  await make('greys-2997.webm', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30000/1001,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128", '-frames:v', '30', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p']);
  // The greys of greys.mp4 on a 1/15360 clock, FFmpeg's default MP4 video timescale for 25 fps.
  await make('greys-15360.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=0.4,format=yuv420p,geq=lum='16+20*N':cb=128:cr=128", ...h264, '-g', '10', '-video_track_timescale', '15360']);
  await make('late-edge.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=0.16,format=yuv420p,geq=lum='16+40*N':cb=128:cr=128,settb=1/90000,setpts='if(eq(N,2),3601,N*1800)'",
    ...h264, '-g', '4', '-fps_mode', 'passthrough', '-enc_time_base', '1/90000', '-video_track_timescale', '90000']);
  // Expand backgrounds in the 128x72 target geometry at 50 fps (twice the source rate, so a frame-index mapping shows):
  // window 0 is 16 frames of luma 40 + 8n, window 1 is 12 frames of luma 150 + 6n.
  await make('bg0.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=128x72:r=50:d=0.32,format=yuv420p,geq=lum='40+8*N':cb=128:cr=128", ...h264, '-g', '16', '-video_track_timescale', '50']);
  await make('bg1.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=128x72:r=50:d=0.24,format=yuv420p,geq=lum='150+6*N':cb=128:cr=128", ...h264, '-g', '12', '-video_track_timescale', '50']);
  // A whole model frame for expand (832x480 scaled down to 416x240) at 50 fps: inside the product ROI x 96-351, y 40-183
  // (256x144, twice the 128x72 target) luma 60 + 6n, outside it white (luma 235), so any pixel from outside the crop shows.
  await make('bg-frame.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=416x240:r=50:d=0.4,format=yuv420p,geq=lum='if(between(X,96,351)*between(Y,40,183),60+6*N,235)':cb=128:cr=128",
    ...h264, '-g', '20', '-video_track_timescale', '50']);
  // The two transition clips: 1.6 s at 25 fps, flat greys 0x404040 and 0xC0C0C0, with 500 Hz and 1500 Hz ALAC tones at 48 kHz.
  // Clip B with stereo sound: the 1500 Hz tone in the left channel only, silence on the right.
  // Clip B's grey with a mono tone, as a meeting recording or a voice-over carries.
  await make('clip-b-mono.mp4', ['-f', 'lavfi', '-i', 'color=c=0xC0C0C0:s=64x36:r=25:d=1.6', '-f', 'lavfi', '-i', 'sine=f=1500:r=48000:d=1.6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', '-shortest']);
  await make('clip-b-stereo.mp4', ['-f', 'lavfi', '-i', 'color=c=0xC0C0C0:s=64x36:r=25:d=1.6', '-f', 'lavfi', '-i', 'sine=f=1500:r=48000:d=1.6',
    '-filter_complex', '[1:a]pan=stereo|c0=c0|c1=0*c0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-g', '10', '-video_track_timescale', '25', '-c:a', 'alac', '-shortest']);
  // A transparent HDR clip: 10-bit 4:4:4 at alpha 64, tagged PQ BT.2020 limited range, as a motion-graphics HDR delivery.
  await make('clip-hdr-alpha.mkv', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=25:d=2,format=yuva444p10le,colorchannelmixer=aa=0.25,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v', 'ffv1', '-pix_fmt', 'yuva444p10le', '-color_range', 'tv', '-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084']);
  // A narrower clip: 48x36 white for 2 s, contained in the 64x36 profile with 8-pixel bars.
  await make('clip-narrow.mp4', ['-f', 'lavfi', '-i', 'color=c=white:s=48x36:r=25:d=2', ...h264, '-g', '10']);
  // A transparent clip: 2 s of grey at alpha 64 in a VP9 WebM, which stores its alpha in BlockAdditional.
  await make('clip-alpha.webm', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=25:d=2,format=yuva420p,colorchannelmixer=aa=0.25', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p']);
  for (const [name, grey, tone] of [['clip-a.mp4', '0x404040', 500], ['clip-b.mp4', '0xC0C0C0', 1500]] as const) {
    await make(name, ['-f', 'lavfi', '-i', `color=c=${grey}:s=64x36:r=25:d=1.6`, '-f', 'lavfi', '-i', `sine=f=${tone}:r=48000:d=1.6`,
      ...h264, '-g', '10', '-video_track_timescale', '25', '-c:a', 'alac', '-shortest']);
  }
  // An HDR clip A: 1.6 s at 25 fps, a flat colour stored as 10-bit PQ BT.2020 (the PQ fixture of frame-recipe and
  // presentation-recipes, here at the transition clips' size and keyframe interval).
  await make('clip-hdr.mp4', ['-f', 'lavfi', '-i', 'color=c=0xB08060:s=64x36:r=25:d=1.6', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p10le',
    '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', '-g', '10', '-video_track_timescale', '25']);
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  renderer.fake = false;
  renderer.inputs = [];
  served = new Map();
  written.clear();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args); });
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

describe('chunk_encode on the transition profile (§7.17 chunk_encode row; 转场输出档 row: the first clip sets the rate)', () => {
  it('CR01 a clip at a lower rate than the profile gives one frame per output frame of its chunk, none cut off', async () => {
    // Clip A is 25 fps; 30 presented frames (1.2 s) on a 30 fps profile are 36 output frames.
    const thirty = { ...PROFILE, fps: r(30), timeBase: r(1, 30) };
    const [file] = await produce({ [CLIP_A]: join(dir, 'clip-a.mp4') }, [{ ...clipChunk(CLIP_A, 0, 30), profile: thirty, frames: { start: 0, end: 36 } }]);
    const frames = await packets(file!);
    expect(frames).toHaveLength(36);
    expect(Number(frames.at(-1)!.pts_time) + Number(frames.at(-1)!.duration_time)).toBeCloseTo(1.2, 3);
  });
});

describe('the entries the worker writes for late pictures and media that start after the origin (§7.17 timeline row)', () => {
  // A 0.3 s lead on greys-90k.mp4: frame 0 held over [0, 10001/30000) at rate 1/10 from its own pts, then frame 1 on.
  it('CR07 a 25 fps chunk starting inside a 29.97 fps lead on 1/90000 encodes the held frame, then each slot\'s covering frame', async () => {
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 0, end: 7 }, timescale: 30000, target: TARGET, profile: PROFILE, frames: { start: 3, end: 12 },
      entries: [{ ...span(r(0), r(0), r(3, 25), r(10001, 30000)), rate: r(1, 10) }, span(r(0), r(1001, 30000), r(10001, 30000), r(16007, 30000))] };
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-90k.mp4') }, [recipe]);
    // Slots 3..8 (0.12 to 0.32 s) lie in the lead; slot 9 (0.36 s) in frame 1; slot 10 (0.40 s) in frame 2; slot 11 (0.44 s) in frame 4.
    const shown = (await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6));
    expect(shown).toEqual([0, 0, 0, 0, 0, 0, 1, 2, 4]);
  });

  it('CR08 a 30 fps chunk starting inside a frame of an x265 clip whose media starts at 2/25 s shows the frame covering each slot', async () => {
    // Output frames 16..23 at k/30 s show clip frames floor(k · 25 / 30); frame 13 starts at 13/25 s, media pts 3/5.
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 13, end: 20 }, timescale: 25, target: TARGET, profile: { ...PROFILE, fps: r(30), timeBase: r(1, 30) },
      frames: { start: 16, end: 24 }, entries: [span(r(2, 25), r(46, 75), r(8, 15), r(4, 5))] };
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-x265.mp4') }, [recipe]);
    const shown = (await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6));
    expect(shown).toEqual([13, 14, 15, 15, 16, 17, 18, 19]);
  });
});

describe('frame times a source stores rounded to its clock (§7.17 rounding clock row)', () => {
  it('CR09 a 30 fps WebM on its own 30 fps grid shows every frame once: a frame stored at 67 ms takes the slot at 66.67 ms', async () => {
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 0, end: 30 }, timescale: 1000, target: TARGET, profile: { ...PROFILE, fps: r(30), timeBase: r(1, 30) },
      frames: { start: 0, end: 30 }, entries: [{ ...span(r(0), r(0), r(0), r(1)), conform: { origin: r(1, 30), period: r(1, 30) } }] };
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-30.webm') }, [recipe]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6))).toEqual(Array.from({ length: 30 }, (_unused, n) => n));
  });

  it('CR10 a 29.97 fps WebM on a 30 fps grid shows at each slot the frame truly covering it, as the admission window takes it', async () => {
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 0, end: 30 }, timescale: 1000, target: TARGET, profile: { ...PROFILE, fps: r(30), timeBase: r(1, 30) },
      frames: { start: 0, end: 30 }, entries: [{ ...span(r(0), r(0), r(0), r(1001, 1000)), conform: { origin: r(1001, 30000), period: r(1001, 30000) } }] };
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-2997.webm') }, [recipe]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6))).toEqual(Array.from({ length: 30 }, (_unused, k) => Math.floor((k * 1000) / 1001)));
  });
});

describe('a chunk that starts between a rounded frame\'s stored start and its grid point (§7.17 rounding clock row)', () => {
  it('CR11 a 29.97 fps WebM from In 1 on a 30 fps grid starts on frame 0, which still covers 1/30 s', async () => {
    // Frame 1 is stored at 33 ms, at or before 1/30 s, but truly starts at 1001/30000 s, after it.
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 0, end: 7 }, timescale: 1000, target: TARGET, profile: { ...PROFILE, fps: r(30), timeBase: r(1, 30) },
      frames: { start: 0, end: 7 }, entries: [{ ...span(r(0), r(1, 30), r(1, 30), r(7007, 30000)), conform: { origin: r(1001, 30000), period: r(1001, 30000) } }] };
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-2997.webm') }, [recipe]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6))).toEqual(Array.from({ length: 7 }, (_unused, k) => Math.floor(((k + 1) * 1000) / 1001)));
  });
});

describe('a frame grid FFmpeg cannot carry (FFmpeg filter time bases are int rationals)', () => {
  // On a 34650000/1154957 fps grid (an exact VFR average) a 1/15360 clip needs a 1/2217600000 clock, past 2^31 − 1, which
  // settb would clamp to 1/2147483647 and so move frames to the wrong slots.
  it('CR06 a chunk whose exact clock exceeds 2^31 − 1 fails with that reason instead of encoding moved frames', async () => {
    const profile = { ...PROFILE, fps: r(34650000, 1154957), timeBase: r(1154957, 34650000) };
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(2, 5))], target: TARGET, profile, frames: { start: 0, end: 12 } };
    const { report } = await runJob({ [CLIP_A]: join(dir, 'greys-15360.mp4') }, [recipe]);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(logged)).toContain('time base range');
  });
});

describe('the last frame of a transition chunk (§7.17 chunk_encode row: every presented frame is kept)', () => {
  // greys.mp4: ten 25 fps frames of stored luma 16 + 20n, so frame 9 is 196 and frame 8 is 176.
  it.each([
    ['on its own rate', PROFILE, 10],
    ['on a faster profile', { ...PROFILE, fps: r(30), timeBase: r(1, 30) }, 12],
  ])('CR02 a chunk %s ends on the window\'s last frame, not a repeat of the one before', async (_name, profile, frames) => {
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys.mp4') }, [{ ...clipChunk(CLIP_A, 0, 10), profile, frames: { start: 0, end: frames } }]);
    const means = await lumaMeans(file!);
    expect(means).toHaveLength(frames);
    expect(Math.abs(means.at(-1)! - 196)).toBeLessThan(4);
  });
});

describe('a chunk that starts inside a source frame (§7.17 transition output profile row: output frame k shows the source frame covering k / fps)', () => {
  // greys.mp4: ten 25 fps frames of stored luma 16 + 20n. On a 30 fps profile, output frame k shows frame ⌊k · 25 / 30⌋.
  it('CR03 a 25 fps clip split at output frame 5 of a 30 fps profile shows, chunk after chunk, the frames one window would', async () => {
    const thirty = { ...PROFILE, fps: r(30), timeBase: r(1, 30) };
    const chunk = (frames: { start: number; end: number }, window: { start: number; end: number }, from: Exact): Recipe => ({
      kind: 'chunk_encode', inputId: CLIP_A, window, timescale: 25, entries: [span(r(0), from, from, r(window.end, 25))], target: TARGET, profile: thirty, frames });
    // Output frame 5 is at 1/6 s, inside frame 4 (0.16 to 0.2 s): the second chunk starts there, not at frame 4's start.
    const [first, second] = await produce({ [CLIP_A]: join(dir, 'greys.mp4') }, [chunk({ start: 0, end: 5 }, { start: 0, end: 4 }, r(0)), chunk({ start: 5, end: 12 }, { start: 4, end: 10 }, r(1, 6))]);
    const shown = [...await lumaMeans(first!), ...await lumaMeans(second!)];
    expect(shown).toHaveLength(12);
    shown.forEach((value, k) => expect(Math.abs(value - (16 + 20 * Math.floor((k * 25) / 30))), `output frame ${k}`).toBeLessThan(4));
  });

  // greys-ntsc.mp4: twenty 30000/1001 fps frames of stored luma 16 + 10n on a 1/30000 clock; frame n starts at n · 1001 ticks.
  it('CR04 a 29.97 fps clip split at output frame 7 of its own 29.97 fps profile shows every frame once, none repeated', async () => {
    const ntsc = { ...PROFILE, fps: r(30000, 1001), timeBase: r(1001, 30000) };
    const chunk = (frames: { start: number; end: number }, from: Exact): Recipe => ({
      kind: 'chunk_encode', inputId: CLIP_A, window: frames, timescale: 30000, entries: [span(r(0), from, from, r(frames.end * 1001, 30000))], target: TARGET, profile: ntsc, frames });
    const [first, second] = await produce({ [CLIP_A]: join(dir, 'greys-ntsc.mp4') }, [chunk({ start: 0, end: 7 }, r(0)), chunk({ start: 7, end: 20 }, r(7 * 1001, 30000))]);
    const shown = [...await lumaMeans(first!), ...await lumaMeans(second!)];
    expect(shown).toHaveLength(20);
    shown.forEach((value, k) => expect(Math.abs(value - (16 + 10 * k)), `output frame ${k}`).toBeLessThan(4));
  });

  // late-edge.mp4: four frames on a 1/90000 clock at 0, 1800, 3601 and 5400 ticks, stored luma 16, 56, 96, 136. Frame 1
  // ends 1 tick after output slot 2 of a 25 fps profile (3600 ticks), so it is the frame shown at slot 1 and only there.
  it.each([
    ['two frames from slot 0', { start: 0, end: 2 }, r(0), [16, 56]],
    ['one frame at slot 1', { start: 1, end: 2 }, r(1, 25), [56]],
  ])('CR05 a chunk of %s whose last frame ends just after the next slot keeps that frame', async (_name, frames, from, expected) => {
    const recipe = { kind: 'chunk_encode', inputId: CLIP_A, window: frames, timescale: 90000, entries: [span(r(0), from, from, r(3601, 90000))], target: TARGET, profile: PROFILE, frames };
    const [file] = await produce({ [CLIP_A]: join(dir, 'late-edge.mp4') }, [recipe]);
    const means = await lumaMeans(file!);
    expect(means).toHaveLength(expected.length);
    means.forEach((value, k) => expect(Math.abs(value - expected[k]!), `output frame ${k}`).toBeLessThan(4));
  });
});

describe('model_composite (§7.17 model_composite and segment rows; execution design §8, §8.1)', () => {
  // The erase shape (mask, grid and matte) is pinned in erase-expand-recipes.node.test.ts EC01–EC07.
  it('MC03 expand: each background mapped back by PTS, the source over it at the frozen position, the overlap blended by presentation time', async () => {
    const displayRect = { x: 16, y: 20, width: 64, height: 36 };
    // Window 0 covers presentation [0, 8/25), window 1 [4/25, 2/5): an overlap of frames 4 to 7.
    const recipe = {
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(2, 5))],
      target: { ...TARGET, width: 128, height: 72, displayRect },
      backgrounds: [{ inputId: BACKGROUNDS[0], window: { start: r(0), end: r(8, 25) } }, { inputId: BACKGROUNDS[1], window: { start: r(4, 25), end: r(2, 5) } }],
    };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4'), [BACKGROUNDS[0]!]: join(dir, 'bg0.mp4'), [BACKGROUNDS[1]!]: join(dir, 'bg1.mp4') }, [recipe]);
    const video = (await probe(file!)).streams.find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 128, 72]);
    const list = await packets(file!);
    expect(list).toHaveLength(10);
    expect(list[0]!.flags).toContain('K');
    // The source rectangle (inset 2 px from its edges) is the source frame of the same presentation time.
    const source = await lumaMeans(join(dir, 'greys.mp4'));
    const inside = await lumaMeans(file!, { x: displayRect.x + 2, y: displayRect.y + 2, width: displayRect.width - 4, height: displayRect.height - 4 });
    inside.forEach((mean, n) => expect(Math.abs(mean - source[n]!), `source rect, frame ${n}`).toBeLessThan(4));
    // The surround (the strip above the source) is the background frame at the same presentation time: background i's
    // frame at local time n/25 - window.start, i.e. frame 2n (window 0) or 2(n - 4) (window 1) at 50 fps.
    const strip = { x: 0, y: 0, width: 128, height: 16 };
    const [bg0, bg1, surround] = [await lumaMeans(join(dir, 'bg0.mp4'), strip), await lumaMeans(join(dir, 'bg1.mp4'), strip), await lumaMeans(file!, strip)];
    for (const n of [0, 1, 2, 3]) expect(Math.abs(surround[n]! - bg0[2 * n]!), `window 0 only, frame ${n}`).toBeLessThan(4);
    for (const n of [8, 9]) expect(Math.abs(surround[n]! - bg1[2 * (n - 4)]!), `window 1 only, frame ${n}`).toBeLessThan(4);
    // Inside the overlap each frame lies between the two backgrounds, moving from window 0 to window 1 with presentation time.
    const weights = [4, 5, 6, 7].map(n => (surround[n]! - bg0[2 * n]!) / (bg1[2 * (n - 4)]! - bg0[2 * n]!));
    for (const weight of weights) {
      expect(weight).toBeGreaterThan(-0.06);
      expect(weight).toBeLessThan(1.06);
    }
    weights.slice(1).forEach((weight, at) => expect(weight).toBeGreaterThanOrEqual(weights[at]! - 0.03));
    expect(weights.some(weight => weight > 0.1 && weight < 0.9)).toBe(true);
  });

  it('MC06 expand chunk starting inside an overlap: the later background fades in on its own timeline, matching the unchunked composite', async () => {
    const displayRect = { x: 16, y: 20, width: 64, height: 36 };
    const target = { ...TARGET, width: 128, height: 72, displayRect };
    const backgrounds = [{ inputId: BACKGROUNDS[0], window: { start: r(0), end: r(8, 25) } }, { inputId: BACKGROUNDS[1], window: { start: r(4, 25), end: r(2, 5) } }];
    const inputs = { [SOURCE]: join(dir, 'greys.mp4'), [BACKGROUNDS[0]!]: join(dir, 'bg0.mp4'), [BACKGROUNDS[1]!]: join(dir, 'bg1.mp4') };
    const whole = { kind: 'model_composite', mode: 'expand', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(2, 5))], target, backgrounds };
    // Frames 6 to 9: the chunk opens two frames into window 1's overlap with window 0 (frames 4 to 7), decoding from keyframe 5.
    const chunk = { ...whole, window: { start: 6, end: 10 }, entries: [span(r(5, 25), r(6, 25), r(6, 25), r(2, 5))] };
    const [unchunked] = await produce(inputs, [whole]);
    const [chunked] = await produce(inputs, [chunk]);
    expect(await packets(chunked!)).toHaveLength(4);
    const strip = { x: 0, y: 0, width: 128, height: 16 };
    const [expected, actual] = [await lumaMeans(unchunked!, strip), await lumaMeans(chunked!, strip)];
    actual.forEach((mean, n) => expect(Math.abs(mean - expected[n + 6]!), `chunk frame ${n}`).toBeLessThan(4));
  });

  // inner#1306 D20-2 (execution §8 "模型整框输出经已核坐标映射裁出产品ROI，缩回目标尺寸，最后在冻结源位置叠回原片"): the
  // background is the model's whole frame and `crop` names the product ROI in its pixels.
  it('MC05 expand from a whole model frame: the surround is the cropped ROI scaled to the target, by PTS, with nothing from outside the crop', async () => {
    const displayRect = { x: 16, y: 20, width: 64, height: 36 };
    const roi = { x: 96, y: 40, width: 256, height: 144 };
    const recipe = {
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, window: { start: 0, end: 10 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(2, 5))],
      target: { ...TARGET, width: 128, height: 72, displayRect },
      backgrounds: [{ inputId: BACKGROUNDS[0], window: { start: r(0), end: r(2, 5) }, crop: roi }],
    };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4'), [BACKGROUNDS[0]!]: join(dir, 'bg-frame.mp4') }, [recipe]);
    const video = (await probe(file!)).streams.find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 128, 72]);
    const list = await packets(file!);
    expect(list).toHaveLength(10);
    expect(list[0]!.flags).toContain('K');
    const source = await lumaMeans(join(dir, 'greys.mp4'));
    const inside = await lumaMeans(file!, { x: displayRect.x + 2, y: displayRect.y + 2, width: displayRect.width - 4, height: displayRect.height - 4 });
    inside.forEach((mean, n) => expect(Math.abs(mean - source[n]!), `source rect, frame ${n}`).toBeLessThan(4));
    // The ROI's own grey per background frame (read inside it, clear of its edge); output frame n is background frame 2n.
    const roiLuma = await lumaMeans(join(dir, 'bg-frame.mp4'), { x: roi.x + 8, y: roi.y + 8, width: roi.width - 16, height: roi.height - 16 });
    // The four 4-pixel borders of the output are the crop's edges: a crop off by 2 model pixels brings white into them.
    const borders = { top: { x: 0, y: 0, width: 128, height: 4 }, bottom: { x: 0, y: 68, width: 128, height: 4 }, left: { x: 0, y: 0, width: 4, height: 72 }, right: { x: 124, y: 0, width: 4, height: 72 } };
    for (const [side, rect] of Object.entries(borders)) {
      (await lumaMeans(file!, rect)).forEach((mean, n) => expect(Math.abs(mean - roiLuma[2 * n]!), `${side} border, frame ${n}`).toBeLessThan(4));
    }
  });

});

describe('transition_window (§7.17 transition_window and 转场输出档 rows; §5.4 切块, 拼接 and last paragraph) — MiniToolContainerGl only', () => {
  // These cases need the headless-gl renderer of the MiniToolContainerGl image (frames-split §5.4 派发 row; transitions render DD §6).
  const inputs = (): Record<string, string> => ({ [CLIP_A]: join(dir, 'clip-a.mp4'), [CLIP_B]: join(dir, 'clip-b.mp4') });

  /**
   * The two clips' flat greys as stored.
   * @returns Clip A's and clip B's first-frame luma.
   */
  async function greys(): Promise<[number, number]> {
    return [(await lumaMeans(join(dir, 'clip-a.mp4')))[0]!, (await lumaMeans(join(dir, 'clip-b.mp4')))[0]!];
  }

  it.skipIf(!GL)(`TW01 fade: output frame k is A mixed into B at progress (k - startFrame) / frameCount [${GL_SKIP}]`, async () => {
    const [file] = await produce(inputs(), [windowChunk('fade', 30, 40)]);
    const [a, b] = await greys();
    const means = await lumaMeans(file!);
    expect(means).toHaveLength(10);
    means.forEach((mean, i) => expect(Math.abs(mean - (a + (b - a) * i / 10)), `frame ${30 + i}`).toBeLessThan(3));
  });

  /**
   * Require each column away from the wipe edge to be clip A's or clip B's grey, as the gl-transitions shader decides per pixel centre.
   * @param file - The window chunk.
   * @param isB - Whether a column centre (x + 0.5) / width shows B at a progress.
   * @returns Nothing.
   */
  async function expectWipe(file: string, isB: (centre: number, progress: number) => boolean): Promise<void> {
    const [a, b] = await greys();
    const frames = await columnMeans(file);
    expect(frames).toHaveLength(10);
    frames.forEach((columns, i) => {
      const progress = i / 10;
      const sides = columns.map((_mean, x) => isB((x + 0.5) / columns.length, progress));
      columns.forEach((mean, x) => {
        const nearEdge = sides.slice(Math.max(0, x - 2), x + 3).some(side => side !== sides[x]);
        if (!nearEdge) expect(Math.abs(mean - (sides[x] ? b : a)), `frame ${30 + i} column ${x}`).toBeLessThan(6);
      });
    });
  }

  it.skipIf(!GL)(`TW02 wipeLeft: B shows where 1 - x <= progress, entering from the right [${GL_SKIP}]`, async () => {
    const [file] = await produce(inputs(), [windowChunk('wipeLeft', 30, 40)]);
    await expectWipe(file!, (centre, progress) => progress >= 1 - centre);
  });

  it.skipIf(!GL)(`TW03 wipeRight: B shows where x <= progress, entering from the left [${GL_SKIP}]`, async () => {
    const [file] = await produce(inputs(), [windowChunk('wipeRight', 30, 40)]);
    await expectWipe(file!, (centre, progress) => progress >= centre);
  });

  it.skipIf(!GL)(`TW04 a window chunk opens with an IDR and is written with the profile: H.264 yuv420p 64x36, time base 1/25, BT.709 tags [${GL_SKIP}]`, async () => {
    const [file] = await produce(inputs(), [windowChunk('fade', 30, 40)]);
    const { streams } = await probe(file!);
    expect(streams.map(stream => stream.codec_type)).toEqual(['video']);
    const video = streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height, video.time_base]).toEqual(['h264', 'yuv420p', 64, 36, '1/25']);
    expectBt709(video);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 10 }, (_unused, n) => n / 25));
    expect(list[0]!.flags).toContain('K');
  });

  it.skipIf(!GL)(`TW05 a window chunk has the codec headers of the profile's chunk_encode chunks, and the transition stitch joins [encode, window, encode] [${GL_SKIP}]`, async () => {
    const [before, after] = await produce(inputs(), [clipChunk(CLIP_A, 0, 30), clipChunk(CLIP_B, 10, 40)]);
    const [window] = await produce(inputs(), [windowChunk('fade', 30, 40)]);
    expect(await codecHeaders(window!)).toEqual(await codecHeaders(before!));
    expect(await codecHeaders(after!)).toEqual(await codecHeaders(before!));
    const [file] = await produce({ ...inputs(), [CHUNKS[0]!]: before!, [CHUNKS[1]!]: window!, [CHUNKS[2]!]: after! }, [{
      kind: 'stitch', chunks: [{ inputId: CHUNKS[0], duration: r(6, 5) }, { inputId: CHUNKS[1], duration: r(2, 5) }, { inputId: CHUNKS[2], duration: r(6, 5) }],
      clips: [{ inputId: CLIP_A, audio: CLIP_AUDIO }, { inputId: CLIP_B, audio: CLIP_AUDIO }], crossfade: WINDOW, profile: PROFILE,
    }]);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 70 }, (_unused, n) => n / 25));
    expect([0, 30, 40].map(n => list[n]!.flags.includes('K'))).toEqual([true, true, true]);
    const [a, b] = await greys();
    const means = await lumaMeans(file!);
    for (let i = 0; i < 10; i += 1) expect(Math.abs(means[30 + i]! - (a + (b - a) * i / 10)), `frame ${30 + i}`).toBeLessThan(3);
  });

  // TW07 reads the window chunk the job encodes from the frames it decoded for the blend (the renderer stand-in passes clip
  // A's frames through), against clip A's own chunk_encode chunk over the same frames: the segment row's picture chain,
  // which tone maps, on the same profile. Equal there means no colour jump where a chunk_encode chunk meets the window.
  // Tolerance 2 stored levels per plane: measured with FFmpeg 8 on three PQ colours (0xB08060, 0x9070A0, 0x806040), a
  // window decode that tone maps with the plan matrix and keeps the range through RGBA is within 1 of the chunk; the
  // same chain read to RGBA without minding the limited range it ends on is up to 9 off, and no tone mapping 18 to 61.
  const TOLERANCE = 2;

  it(`TW07 an HDR clip is tone mapped with its plan matrix before the blend; the SDR clip beside it is decoded as it is (§4.3; renderer stand-in)`, async () => {
    renderer.fake = true;
    const [hdr, sdr] = [join(dir, 'clip-hdr.mp4'), join(dir, 'clip-b.mp4')];
    const [window] = await produce({ [CLIP_A]: hdr, [CLIP_B]: sdr }, [windowChunk('fade', 30, 40, [HDR, SDR])]);
    const [, to] = renderer.inputs;
    renderer.fake = false;
    expect(to, 'the window job ran the renderer').toBeDefined();
    const [reference] = await produce({ [CLIP_A]: hdr }, [clipChunk(CLIP_A, 30, 40, HDR)]);
    const expected = await planeMeans(reference!);
    const plain = (await planeMeans(hdr, 'scale=in_color_matrix=bt2020:out_color_matrix=bt709:out_range=tv'))[0]!;
    expect(expected).toHaveLength(10);
    expect(Math.max(...expected[0]!.map((mean, plane) => Math.abs(mean - plain[plane]!))), 'tone mapping moves this colour').toBeGreaterThan(15);
    const got = await planeMeans(window!);
    expect(got).toHaveLength(10);
    got.forEach((means, i) => means.forEach((mean, plane) => expect(Math.abs(mean - expected[i]![plane]!),
      `frame ${30 + i} ${'YUV'[plane]}: window ${mean.toFixed(2)}, tone-mapped chunk ${expected[i]![plane]!.toFixed(2)}, plain matrix conversion ${plain[plane]!.toFixed(2)}`).toBeLessThan(TOLERANCE)));
    // Clip B is SDR: its blend input is its own decode, not clip A's conversion.
    const grey = channelMeans(await rgba(sdr, 'scale=in_color_matrix=bt709:in_range=tv,format=rgba'))[0]!;
    channelMeans(to!).forEach((means, i) => means.forEach((mean, channel) => expect(Math.abs(mean - grey[channel]!), `clip B frame ${i} ${'RGB'[channel]}`).toBeLessThan(TOLERANCE)));
  });

  it(`TW09 a transparent clip reaches the blend with its alpha on a transparent profile (§7.17 alpha row; renderer stand-in)`, async () => {
    renderer.fake = true;
    const recipe = { ...windowChunk('fade', 30, 34), profile: { ...PROFILE, codec: 'vp9', pixFmt: 'yuva420p', alpha: true } };
    await produce({ [CLIP_A]: join(dir, 'clip-alpha.webm'), [CLIP_B]: join(dir, 'clip-b.mp4') }, [recipe]);
    const [from] = renderer.inputs;
    renderer.fake = false;
    expect(from, 'the window job ran the renderer').toBeDefined();
    const size = 64 * 36 * 4;
    for (let frame = 0; frame < from!.length / size; frame += 1) {
      let sum = 0;
      for (let at = frame * size + 3; at < (frame + 1) * size; at += 4) sum += from![at]!;
      expect(Math.abs(sum / (64 * 36) - 64), `frame ${frame} alpha`).toBeLessThan(3);
    }
  });

  it(`TW10 a narrower clip reaches the blend in its fitted rectangle, and its encode chunk puts it in the same place (§7.17; renderer stand-in)`, async () => {
    renderer.fake = true;
    const fit = { x: 8, y: 0, width: 48, height: 36 };
    const recipe = windowChunk('fade', 30, 32);
    (recipe.clips as Recipe[])[0] = { ...(recipe.clips as Recipe[])[0]!, fit };
    await produce({ [CLIP_A]: join(dir, 'clip-narrow.mp4'), [CLIP_B]: join(dir, 'clip-b.mp4') }, [recipe]);
    const [from] = renderer.inputs;
    renderer.fake = false;
    // The middle row's red channel: black bars at columns 0-7 and 56-63, white between.
    const row = Array.from({ length: 64 }, (_unused, x) => from![(18 * 64 + x) * 4]!);
    expect(row.slice(0, 8).every((value) => value < 20), JSON.stringify(row)).toBe(true);
    expect(row.slice(8, 56).every((value) => value > 235), JSON.stringify(row)).toBe(true);
    expect(row.slice(56).every((value) => value < 20), JSON.stringify(row)).toBe(true);
    for (const profile of [PROFILE, { ...PROFILE, codec: 'vp9', pixFmt: 'yuva420p', alpha: true }]) {
      const chunk = { ...clipChunk(CLIP_A, 30, 32), profile, target: { ...TARGET, displayRect: fit } };
      const [file] = await produce({ [CLIP_A]: join(dir, 'clip-narrow.mp4') }, [chunk]);
      const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...(profile.alpha ? ['-c:v', 'libvpx-vp9'] : []), '-i', file!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
      const pixels = stdout as unknown as Buffer;
      const column = (x: number): number[] => pixels.subarray((18 * 64 + x) * 4, (18 * 64 + x) * 4 + 4) as unknown as number[];
      expect(column(32)[0], `${profile.codec} middle`).toBeGreaterThan(235);
      expect(profile.alpha ? column(2)[3] : column(2)[0], `${profile.codec} bar`).toBeLessThan(20);
    }
  });

  it(`TW12 on an odd transparent frame with an odd offset the encode chunk places the clip exactly where the window does`, async () => {
    const transparent = { ...PROFILE, width: 63, height: 36, codec: 'vp9', pixFmt: 'yuva420p', alpha: true };
    const fit = { x: 7, y: 0, width: 48, height: 36 };
    const [file] = await produce({ [CLIP_A]: join(dir, 'clip-narrow.mp4') }, [{ ...clipChunk(CLIP_A, 30, 32), profile: transparent, target: { ...TARGET, width: 63, height: 36, displayRect: fit } }]);
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', file!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
    const pixels = stdout as unknown as Buffer;
    expect(pixels.length).toBe(63 * 36 * 4);
    const alpha = (x: number): number => pixels[(18 * 63 + x) * 4 + 3]!;
    expect([alpha(6), alpha(7), alpha(54), alpha(55)]).toEqual([0, 255, 255, 0]);
  });

  it(`TW13 an HDR clip's encode chunk carries the D05 tone map's colours: zscale converts it from YUV, as the chain was measured`, async () => {
    const hdr = join(dir, 'clip-hdr.mp4');
    const [chunk] = await produce({ [CLIP_A]: hdr }, [clipChunk(CLIP_A, 30, 32, HDR)]);
    const d05 = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';
    const reference = (await planeMeans(hdr, `${d05},scale=64:36:in_color_matrix=bt2020:out_color_matrix=bt709:out_range=tv`))[30]!;
    const got = (await planeMeans(chunk!))[0]!;
    got.forEach((mean, plane) => expect(Math.abs(mean - reference[plane]!), `${'YUV'[plane]}: chunk ${mean.toFixed(2)}, D05 ${reference[plane]!.toFixed(2)}`).toBeLessThan(0.6));
  });

  it(`TW11 a transparent HDR clip keeps its alpha through the tone map, in the window and in its encode chunk (§4.3; renderer stand-in)`, async () => {
    renderer.fake = true;
    const transparent = { ...PROFILE, codec: 'vp9', pixFmt: 'yuva420p', alpha: true };
    const recipe = { ...windowChunk('fade', 30, 32, [HDR, SDR]), profile: transparent };
    await produce({ [CLIP_A]: join(dir, 'clip-hdr-alpha.mkv'), [CLIP_B]: join(dir, 'clip-b.mp4') }, [recipe]);
    const [from] = renderer.inputs;
    renderer.fake = false;
    let sum = 0;
    for (let at = 3; at < 64 * 36 * 4; at += 4) sum += from![at]!;
    expect(Math.abs(sum / (64 * 36) - 64), 'window alpha').toBeLessThan(3);
    const [file] = await produce({ [CLIP_A]: join(dir, 'clip-hdr-alpha.mkv') }, [{ ...clipChunk(CLIP_A, 30, 32, HDR), profile: transparent }]);
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', file!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
    const pixels = stdout as unknown as Buffer;
    let chunk = 0;
    for (let at = 3; at < 64 * 36 * 4; at += 4) chunk += pixels[at]!;
    expect(Math.abs(chunk / (64 * 36) - 64), 'chunk alpha').toBeLessThan(3);
  });

  it.skipIf(!GL)(`TW08 fade from an HDR clip: frame k mixes the tone-mapped clip A into clip B, so progress 0 matches A's tone-mapped chunk [${GL_SKIP}]`, async () => {
    const hdr = join(dir, 'clip-hdr.mp4');
    const [file] = await produce({ [CLIP_A]: hdr, [CLIP_B]: join(dir, 'clip-b.mp4') }, [windowChunk('fade', 30, 40, [HDR, SDR])]);
    const [reference] = await produce({ [CLIP_A]: hdr }, [clipChunk(CLIP_A, 30, 40, HDR)]);
    const a = (await lumaMeans(reference!))[0]!;
    const b = (await lumaMeans(join(dir, 'clip-b.mp4')))[0]!;
    const means = await lumaMeans(file!);
    expect(means).toHaveLength(10);
    means.forEach((mean, i) => expect(Math.abs(mean - (a + (b - a) * i / 10)), `frame ${30 + i}`).toBeLessThan(3));
  });

  it.skipIf(!GL)(`TW06 progress is continuous across two window chunks: the second starts at progress 0.5, not 0 [${GL_SKIP}]`, async () => {
    const [first, second] = await produce(inputs(), [windowChunk('fade', 30, 35), windowChunk('fade', 35, 40)]);
    const [a, b] = await greys();
    const means = [...await lumaMeans(first!), ...await lumaMeans(second!)];
    expect(means).toHaveLength(10);
    means.forEach((mean, i) => expect(Math.abs(mean - (a + (b - a) * i / 10)), `frame ${30 + i}`).toBeLessThan(3));
    expect((await packets(second!))[0]!.flags).toContain('K');
  });
});

describe('transition stitch audio (§7.17 stitch and 转场输出档 rows: acrossfade c1=tri:c2=tri, Cut joins directly, no audio is silence)', () => {
  /**
   * Encode the clips' chunks with the profile and run the transition stitch over them.
   * @param chunks - Per chunk: its clip, first and end presented frame of that clip.
   * @param clips - The stitch's two clip audio entries.
   * @param crossfade - The crossfade window, null for a Cut.
   * @returns The stitched file.
   */
  async function transitionStitch(chunks: [string, number, number][], clips: [Recipe | null, Recipe | null], crossfade: typeof WINDOW | null): Promise<string> {
    const inputs = { [CLIP_A]: join(dir, 'clip-a.mp4'), [CLIP_B]: join(dir, 'clip-b.mp4') };
    const files = await produce(inputs, chunks.map(([clip, start, end]) => clipChunk(clip, start, end)));
    const [file] = await produce({ ...inputs, ...Object.fromEntries(files.map((path, at) => [CHUNKS[at]!, path])) }, [{
      kind: 'stitch', chunks: chunks.map(([_clip, start, end], at) => ({ inputId: CHUNKS[at], duration: r(end - start, 25) })),
      clips: [{ inputId: CLIP_A, audio: clips[0] }, { inputId: CLIP_B, audio: clips[1] }], crossfade, profile: PROFILE,
    }]);
    return file!;
  }

  /**
   * The source tones' amplitudes, read from the clips themselves.
   * @returns Clip A's 500 Hz and clip B's 1500 Hz amplitude.
   */
  async function sourceAmplitudes(): Promise<[number, number]> {
    const mean = (list: number[]): number => list.reduce((sum, value) => sum + value, 0) / list.length;
    return [mean(toneAmplitudes(await samples(join(dir, 'clip-a.mp4')), 500)), mean(toneAmplitudes(await samples(join(dir, 'clip-b.mp4')), 1500))];
  }

  /**
   * Require the stitched audio to be one AAC 48 kHz stream of the expected length.
   * @param file - The stitched file.
   * @param seconds - The expected duration.
   * @returns Nothing.
   */
  async function expectAudio(file: string, seconds: number): Promise<void> {
    const audio = (await probe(file)).streams.filter(stream => stream.codec_type === 'audio');
    expect(audio.map(stream => [stream.codec_name, stream.sample_rate])).toEqual([['aac', '48000']]);
    expect(Math.abs(Number(audio[0]!.duration) - seconds)).toBeLessThanOrEqual(1024 / 48000);
  }

  // Blocks are 20 ms; the first two and last two are skipped for the encoder's onset and tail, and blocks next to a junction for its
  // spread. AAC moves a steady tone's block amplitude by up to about 4 % (FFmpeg 7.1 reference run), hence 8 % for an unchanged
  // clip; a quarter-sine crossfade (qsin) is off the linear gain by over 20 % mid-window, against the 6 % allowed.
  // A clip whose audio has no edit list (spans null) and does not reach its chosen range yields no samples: its padding must
  // still advance on the sample clock, or the junction collapses clip B's audio into a few milliseconds.
  it('TS04 Cut after a clip with no audio over its range: clip A is silence, clip B\'s audio stays whole and in place', async () => {
    const past = { start: r(5), end: r(33, 5), origin: r(0), spans: null };
    const file = await transitionStitch([[CLIP_A, 0, 40], [CLIP_B, 0, 40]], [past, CLIP_AUDIO], null);
    await expectAudio(file, 3.2);
    const [, b] = await sourceAmplitudes();
    const ampB = toneAmplitudes(await samples(file), 1500);
    for (let block = 2; block <= 78; block += 1) expect(ampB[block]! / b, `no B at block ${block}`).toBeLessThan(0.03);
    for (let block = 81; block <= 157; block += 1) expect(Math.abs(ampB[block]! / b - 1), `B at block ${block}`).toBeLessThan(0.08);
  });

  // The junction keeps one stereo layout, as the preview plays it: a first clip that is silent or mono does not fold the
  // second clip's stereo into mono (concat and acrossfade take the first input's layout).
  it('TS05 Cut after a silent clip: the output is stereo and clip B\'s left-only tone stays on the left', async () => {
    const inputs = { [CLIP_A]: join(dir, 'clip-a.mp4'), [CLIP_B]: join(dir, 'clip-b-stereo.mp4') };
    const files = await produce(inputs, [clipChunk(CLIP_A, 0, 40), clipChunk(CLIP_B, 0, 40)]);
    const [file] = await produce({ ...inputs, [CHUNKS[0]!]: files[0]!, [CHUNKS[1]!]: files[1]! }, [{
      kind: 'stitch', chunks: [{ inputId: CHUNKS[0], duration: r(40, 25) }, { inputId: CHUNKS[1], duration: r(40, 25) }],
      clips: [{ inputId: CLIP_A, audio: null }, { inputId: CLIP_B, audio: CLIP_AUDIO }], crossfade: null, profile: PROFILE,
    }]);
    const audio = (await probe(file!)).streams.filter(stream => stream.codec_type === 'audio') as unknown as { channels: number }[];
    expect(audio.map(stream => stream.channels)).toEqual([2]);
    const level = async (path: string, from: number, channel: string): Promise<number> => {
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', '1', '-i', path, '-af', `pan=mono|c0=${channel},astats=metadata=0:reset=0`, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
      return Number(/RMS level dB: (-?[\d.]+|-inf)/u.exec(String(stderr))?.[1]?.replace('-inf', '-200') ?? '0');
    };
    // Clip B plays from 1.6 s; its left channel keeps the source's level, unboosted, and its right stays silent.
    expect(Math.abs(await level(file!, 2, 'c0') - await level(join(dir, 'clip-b-stereo.mp4'), 0.4, 'c0'))).toBeLessThan(1);
    expect(await level(file!, 2, 'c1')).toBeLessThan(-60);
  });

  it('TS06 a mono clip plays at its own level on both channels, as the preview plays it', async () => {
    const inputs = { [CLIP_A]: join(dir, 'clip-a.mp4'), [CLIP_B]: join(dir, 'clip-b-mono.mp4') };
    const files = await produce(inputs, [clipChunk(CLIP_A, 0, 40), clipChunk(CLIP_B, 0, 40)]);
    const [file] = await produce({ ...inputs, [CHUNKS[0]!]: files[0]!, [CHUNKS[1]!]: files[1]! }, [{
      kind: 'stitch', chunks: [{ inputId: CHUNKS[0], duration: r(40, 25) }, { inputId: CHUNKS[1], duration: r(40, 25) }],
      clips: [{ inputId: CLIP_A, audio: CLIP_AUDIO }, { inputId: CLIP_B, audio: CLIP_AUDIO }], crossfade: null, profile: PROFILE,
    }]);
    const level = async (path: string, from: number, channel: string): Promise<number> => {
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', '1', '-i', path, '-af', `pan=mono|c0=${channel},astats=metadata=0:reset=0`, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
      return Number(/RMS level dB: (-?[\d.]+|-inf)/u.exec(String(stderr))?.[1]?.replace('-inf', '-200') ?? '0');
    };
    const source = await level(join(dir, 'clip-b-mono.mp4'), 0.4, 'c0');
    expect(Math.abs(await level(file!, 2, 'c0') - source)).toBeLessThan(1);
    expect(Math.abs(await level(file!, 2, 'c1') - source)).toBeLessThan(1);
  });

  it('TS01 Cut (crossfade null): clip A\'s audio then clip B\'s, joined directly with no fade', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 40], [CLIP_B, 0, 40]], [CLIP_AUDIO, CLIP_AUDIO], null);
    expect(await packets(file)).toHaveLength(80);
    await expectAudio(file, 3.2);
    const [a, b] = await sourceAmplitudes();
    const signal = await samples(file);
    const [ampA, ampB] = [toneAmplitudes(signal, 500), toneAmplitudes(signal, 1500)];
    for (let block = 2; block <= 78; block += 1) {
      expect(Math.abs(ampA[block]! / a - 1), `A at block ${block}`).toBeLessThan(0.08);
      expect(ampB[block]! / b, `no B at block ${block}`).toBeLessThan(0.03);
    }
    for (let block = 81; block <= 157; block += 1) {
      expect(Math.abs(ampB[block]! / b - 1), `B at block ${block}`).toBeLessThan(0.08);
      expect(ampA[block]! / a, `no A at block ${block}`).toBeLessThan(0.03);
    }
  });

  it('TS02 a transition crossfades the window\'s audio with linear (tri) gains and leaves each clip unchanged outside it', async () => {
    // The window's video chunk here is clip A's frames 30 to 40 encoded with the profile: the stitch only stream-copies chunk video.
    const file = await transitionStitch([[CLIP_A, 0, 30], [CLIP_A, 30, 40], [CLIP_B, 10, 40]], [CLIP_AUDIO, CLIP_AUDIO], WINDOW);
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 70 }, (_unused, n) => n / 25));
    await expectAudio(file, 2.8);
    const [a, b] = await sourceAmplitudes();
    const signal = await samples(file);
    const [ampA, ampB] = [toneAmplitudes(signal, 500), toneAmplitudes(signal, 1500)];
    // Output [0, 1.2) is A alone, [1.2, 1.6) the crossfade (blocks 60 to 79), [1.6, 2.8) B alone.
    for (let block = 2; block <= 58; block += 1) {
      expect(Math.abs(ampA[block]! / a - 1), `A at block ${block}`).toBeLessThan(0.08);
      expect(ampB[block]! / b, `no B at block ${block}`).toBeLessThan(0.03);
    }
    for (let block = 61; block <= 78; block += 1) {
      const progress = ((block + 0.5) * 0.02 - 1.2) / 0.4;
      expect(Math.abs(ampA[block]! / a - (1 - progress)), `A gain at block ${block}`).toBeLessThan(0.06);
      expect(Math.abs(ampB[block]! / b - progress), `B gain at block ${block}`).toBeLessThan(0.06);
    }
    for (let block = 81; block <= 137; block += 1) {
      expect(Math.abs(ampB[block]! / b - 1), `B at block ${block}`).toBeLessThan(0.08);
      expect(ampA[block]! / a, `no A at block ${block}`).toBeLessThan(0.03);
    }
  });

  it('TS03 a clip without audio (audio null) contributes silence over its span', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 30], [CLIP_A, 30, 40], [CLIP_B, 10, 40]], [CLIP_AUDIO, null], WINDOW);
    await expectAudio(file, 2.8);
    const [a] = await sourceAmplitudes();
    const signal = await samples(file);
    const [ampA, rms] = [toneAmplitudes(signal, 500), blockRms(signal)];
    for (let block = 2; block <= 58; block += 1) expect(Math.abs(ampA[block]! / a - 1), `A at block ${block}`).toBeLessThan(0.08);
    for (let block = 81; block <= 137; block += 1) expect(rms[block]!, `silence at block ${block}`).toBeLessThan(1e-3);
  });
});
