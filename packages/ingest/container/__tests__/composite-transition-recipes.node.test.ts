// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batch-6 container recipes on real media and the frame grid: the expand `model_composite` (erase is in
 * erase-expand-recipes.node.test.ts), the GL `transition_window`, the transition `chunk_encode` and the transition `stitch`
 * (inner#1306 test plan §97 D15, D16; frames-split design §4.1, §7.16, §7.17 rows `model_composite`, `transition_window`,
 * `stitch`, `chunk_encode` and the 转场输出档 row; §5.4 切块, 块的时间, 拼接 rows; execution design §8, §8.1).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the container does, with the edge faked at `fetch`, like
 * `presentation-recipes.node.test.ts`. Every recipe here is one the shared recipe schema (`mini-tool-plan-job.ts`) admits.
 * Every fixture is generated here with FFmpeg, its grid (`grid` {fps, gridStart, frameCount, realFrameCount}) and tool
 * source (the original with its keyframe statistics) read with the harness's `gridOf`; every assertion is a fact FFmpeg
 * reads back.
 *
 * Readings this file makes of the recipes (recorded for review):
 * - expand: the source's grid frames [start, end) are composited over each background, which is already in the target
 *   geometry, on its own clock from 0 at its window's start in grid seconds (§8.1 "按其实际PTS映射回本窗"); the frozen
 *   source position is `target.displayRect` (§3.5); inside an overlap the two backgrounds are blended by grid time. A
 *   background with `crop` (inner#1306 D20-2) is a whole model frame: the container crops it to that rectangle, in the model
 *   output's own pixels, and scales the crop to the target geometry before mapping it by PTS.
 * - transitions: a chunk's and a window's `frames` are output frames; each clip carries its grid and `placement`
 *   {startFrame, inFrame}, and output frame k shows the clip grid frame inFrame + ⌊(k − startFrame) · clip fps / output fps⌋.
 *   A transition chunk's `target` is the clip's display size, which `transitionFitRect` fits into the profile; a window
 *   clip names its `fit` and its own plan's `colorMatrix`. The stitch names each clip's grid, placement and output frame
 *   count and whether it has audio.
 *
 * The `transition_window` cases need the headless-gl renderer process, which exists only in the `MiniToolContainerGl` image
 * (frames-split §5.4 派发 and 拼接 rows; the image is built on the `MiniToolContainerStd4` image). They run only when
 * `MINI_TOOL_CONTAINER_GL` is set, inside that image, e.g. once the image exists:
 *   IMAGE=<gl image> BUILD=0 packages/ingest/scripts/test-container-in-image.sh container/__tests__/composite-transition-recipes.node.test.ts
 * once the script passes `MINI_TOOL_CONTAINER_GL=1` into the container (it does not yet: it builds only
 * `packages/ingest/Dockerfile` and forwards no environment). Elsewhere they are skipped. The transition stitch runs in the standard image and is never skipped: its chunks there are `chunk_encode`
 * chunks, because the stitch only stream-copies chunk video. TW09 and TW10 run everywhere: they stand a recorder in for the
 * renderer process (the one `node` command the window job runs), so they check the frames the job decodes for the blend,
 * not the blend.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import type { PlanCommandOptions } from '@ingest/container/plan-command.js';
import { gridOf, type GridFacts } from './helpers/frame-grid-harness.js';

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
type Exact = { numerator: number; denominator: number };
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
interface Report { ok: boolean; outputs: { outputIndex: number }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; time_base: string; sample_rate?: string; duration?: string }
interface Packet { pts_time: string; duration_time: string; flags: string }

const GL = process.env.MINI_TOOL_CONTAINER_GL !== undefined && process.env.MINI_TOOL_CONTAINER_GL !== '';
const GL_SKIP = 'needs the MiniToolContainerGl image (headless-gl renderer); set MINI_TOOL_CONTAINER_GL inside it';

/**
 * An exact rational in lowest terms (the shared exact-time schema compares by value; lowest terms keep it canonical).
 * @param numerator - Its numerator.
 * @param denominator - Its denominator.
 * @returns The exact rational.
 */
function r(numerator: number, denominator = 1): Exact {
  let [a, b] = [Math.abs(numerator), denominator];
  while (b !== 0) [a, b] = [b, a % b];
  const g = a === 0 ? denominator : a;
  return { numerator: numerator / g, denominator: denominator / g };
}

const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const TARGET = { width: 64, height: 36, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
const PROFILE = { width: 64, height: 36, fps: r(25), timeBase: r(1, 25), pixFmt: 'yuv420p', color: { matrix: 'bt709', range: 'tv', primaries: 'bt709', transfer: 'bt709' }, codec: 'h264', encode: { crf: 18, preset: 'medium' }, alpha: false };
const THIRTY = { ...PROFILE, fps: r(30), timeBase: r(1, 30) };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const BACKGROUNDS = ['10000000-0000-4000-8000-0000000000b0', '10000000-0000-4000-8000-0000000000b1'];
const CLIP_A = '10000000-0000-4000-8000-0000000000a1';
const CLIP_B = '10000000-0000-4000-8000-0000000000a2';
const CHUNKS = ['10000000-0000-4000-8000-0000000000c0', '10000000-0000-4000-8000-0000000000c1', '10000000-0000-4000-8000-0000000000c2'];
// The transition timeline on the 25 fps output grid: clip A is 40 frames, clip B 40 frames, the window is A's last 10
// frames over B's first 10, so output frames [0, 30) are A, [30, 40) the window, [40, 70) B's frames 10 to 40.
const WINDOW = { startFrame: 30, frameCount: 10 };
// Where each clip sits on that output grid: A from output frame 0, B from output frame 30 (a Cut puts B at 40).
const AT_A = { startFrame: 0, inFrame: 0 };
const AT_B = { startFrame: 30, inFrame: 0 };

let dir: string;
let served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
let reports: Report[] = [];
let logged: unknown[][] = [];
const grids = new Map<string, GridFacts>();

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
 * A fixture's grid and tool source, read in `beforeAll`.
 * @param name - The fixture.
 * @returns Its grid and source fields.
 */
function gridOfFixture(name: string): Pick<GridFacts, 'grid' | 'source'> {
  const facts = grids.get(name);
  if (facts === undefined) throw new Error(`No grid read for ${name}`);
  return { grid: facts.grid, source: facts.source };
}

/**
 * A transition `chunk_encode` over output frames [start, end) of one clip placed on the output grid.
 * @param inputId - The clip's input.
 * @param name - The clip's fixture.
 * @param start - The chunk's first output frame.
 * @param end - The output frame after its last.
 * @param options - The clip's placement (A's when absent), the profile (`PROFILE` when absent) and target fields that differ.
 * @param options.placement - Where the clip sits on the output grid.
 * @param options.profile - The transition output profile.
 * @param options.target - Target fields that differ (the clip's display size).
 * @returns The recipe.
 */
function clipChunk(inputId: string, name: string, start: number, end: number, options: { placement?: Recipe; profile?: Recipe; target?: Recipe } = {}): Recipe {
  return { kind: 'chunk_encode', inputId, ...gridOfFixture(name), frames: { start, end }, target: { ...TARGET, ...options.target },
    profile: options.profile ?? PROFILE, placement: options.placement ?? AT_A };
}

/**
 * A `transition_window` chunk over output frames [start, end) of the window: clip A from output frame 0, clip B from 30.
 * @param transition - The transition type.
 * @param start - The chunk's first output frame.
 * @param end - The frame after its last.
 * @param names - Clip A's and clip B's fixtures.
 * @returns The recipe.
 */
function windowChunk(transition: 'fade' | 'wipeLeft' | 'wipeRight', start: number, end: number, names: [string, string] = ['clip-a.mp4', 'clip-b.mp4']): Recipe {
  const fit = { x: 0, y: 0, width: 64, height: 36 };
  const from = { inputId: CLIP_A, ...gridOfFixture(names[0]), placement: AT_A, colorMatrix: 'bt709', toneMap: 'none', fit };
  const to = { inputId: CLIP_B, ...gridOfFixture(names[1]), placement: AT_B, colorMatrix: 'bt709', toneMap: 'none', fit };
  return { kind: 'transition_window', clips: [from, to], frames: { start, end }, window: WINDOW, transition, profile: PROFILE };
}

/**
 * A transition stitch's clip: its original's grid, its placement, its output frame count and whether it has audio.
 * @param inputId - The clip's input.
 * @param name - The clip's fixture.
 * @param placement - Where it sits on the output grid.
 * @param frameCount - Its output frames.
 * @param audio - Whether its audio plays.
 * @returns The stitch clip.
 */
function stitchClip(inputId: string, name: string, placement: Recipe, frameCount: number, audio: boolean): Recipe {
  return { inputId, grid: gridOfFixture(name).grid, placement, frameCount, audio };
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
  // Twenty 30000/1001 fps frames of stored luma 16 + 10n on a 1/30000 clock.
  await make('greys-ntsc.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30000/1001:d=0.7,format=yuv420p,geq=lum='16+10*N':cb=128:cr=128,trim=end_frame=20",
    ...h264, '-g', '30', '-video_track_timescale', '30000']);
  // 25 fps greys of stored luma 16 + 6n as FFmpeg's default x265 MP4 writes them: media pts from 1024/12800, one whole-media edit.
  await make('greys-x265.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=1,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128",
    '-c:v', 'libx265', '-x265-params', 'lossless=1:bframes=2:log-level=error', '-g', '25', '-pix_fmt', 'yuv420p']);
  // Thirty 30 fps frames of stored luma 16 + 6n in a lossless VP9 WebM, whose 1 ms clock stores them at 0, 33, 67, 100 ms...
  await make('greys-30.webm', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30:d=1,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128", '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p']);
  // The same greys at 29.97 fps: stored at 0, 33, 67, 100 ms... while frame n truly starts at n · 1001/30000 s.
  await make('greys-2997.webm', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=30000/1001,format=yuv420p,geq=lum='16+6*N':cb=128:cr=128", '-frames:v', '30', '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuv420p']);
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
  // A narrower clip: 48x36 white for 2 s, contained in the 64x36 profile with 8-pixel bars.
  await make('clip-narrow.mp4', ['-f', 'lavfi', '-i', 'color=c=white:s=48x36:r=25:d=2', ...h264, '-g', '10']);
  // A transparent clip: 2 s of grey at alpha 64 in a VP9 WebM, which stores its alpha in BlockAdditional.
  await make('clip-alpha.webm', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=25:d=2,format=yuva420p,colorchannelmixer=aa=0.25', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p']);
  for (const [name, grey, tone] of [['clip-a.mp4', '0x404040', 500], ['clip-b.mp4', '0xC0C0C0', 1500]] as const) {
    await make(name, ['-f', 'lavfi', '-i', `color=c=${grey}:s=64x36:r=25:d=1.6`, '-f', 'lavfi', '-i', `sine=f=${tone}:r=48000:d=1.6`,
      ...h264, '-g', '10', '-video_track_timescale', '25', '-c:a', 'alac', '-shortest']);
  }
  for (const [name, fps] of [['greys.mp4', [25, 1]], ['greys-ntsc.mp4', [30000, 1001]], ['greys-x265.mp4', [25, 1]], ['greys-30.webm', [30, 1]],
    ['greys-2997.webm', [30000, 1001]], ['clip-a.mp4', [25, 1]], ['clip-b.mp4', [25, 1]], ['clip-b-mono.mp4', [25, 1]], ['clip-b-stereo.mp4', [25, 1]],
    ['clip-narrow.mp4', [25, 1]], ['clip-alpha.webm', [25, 1]]] as const) grids.set(name, await gridOf(join(dir, name), { numerator: fps[0], denominator: fps[1] }));
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
    // Clip A is 25 fps; its 30 grid frames (1.2 s) on a 30 fps profile are 36 output frames.
    const [file] = await produce({ [CLIP_A]: join(dir, 'clip-a.mp4') }, [clipChunk(CLIP_A, 'clip-a.mp4', 0, 36, { profile: THIRTY })]);
    const frames = await packets(file!);
    expect(frames).toHaveLength(36);
    expect(Number(frames.at(-1)!.pts_time) + Number(frames.at(-1)!.duration_time)).toBeCloseTo(1.2, 3);
  });

  it('CR08 a 30 fps chunk of an x265 clip whose media starts at 2/25 s shows at each output frame the clip grid frame covering it', async () => {
    // Output frames 16..23 at k/30 s show clip grid frames ⌊k · 25 / 30⌋; the grid starts at the clip's first frame.
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-x265.mp4') }, [clipChunk(CLIP_A, 'greys-x265.mp4', 16, 24, { profile: THIRTY })]);
    const shown = (await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6));
    expect(shown).toEqual([13, 14, 15, 15, 16, 17, 18, 19]);
  });
});

describe('frame times a source stores rounded to its clock (§4.1 源帧落位 row: fps round=near)', () => {
  it('CR09 a 30 fps WebM on its own 30 fps grid shows every frame once: a frame stored at 67 ms takes the slot at 66.67 ms', async () => {
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-30.webm') }, [clipChunk(CLIP_A, 'greys-30.webm', 0, 30, { profile: THIRTY })]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6))).toEqual(Array.from({ length: 30 }, (_unused, n) => n));
  });

  it('CR10 a 29.97 fps WebM on a 30 fps profile shows at each output frame the grid frame covering it', async () => {
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys-2997.webm') }, [clipChunk(CLIP_A, 'greys-2997.webm', 0, 30, { profile: THIRTY })]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 6))).toEqual(Array.from({ length: 30 }, (_unused, k) => Math.floor((k * 1000) / 1001)));
  });
});

describe('the last frame of a transition chunk (§7.17 chunk_encode row: every grid frame is kept)', () => {
  // greys.mp4: ten 25 fps frames of stored luma 16 + 20n, so frame 9 is 196 and frame 8 is 176.
  it.each([
    ['on its own rate', PROFILE, 10],
    ['on a faster profile', THIRTY, 12],
  ])('CR02 a chunk %s ends on the clip\'s last frame, not a repeat of the one before', async (_name, profile, frames) => {
    const [file] = await produce({ [CLIP_A]: join(dir, 'greys.mp4') }, [clipChunk(CLIP_A, 'greys.mp4', 0, frames, { profile })]);
    const means = await lumaMeans(file!);
    expect(means).toHaveLength(frames);
    expect(Math.abs(means.at(-1)! - 196)).toBeLessThan(4);
  });
});

describe('a chunk that starts inside a clip frame (§7.17 transition output profile row: output frame k shows the clip frame covering k / fps)', () => {
  // greys.mp4: ten 25 fps frames of stored luma 16 + 20n. On a 30 fps profile, output frame k shows frame ⌊k · 25 / 30⌋.
  it('CR03 a 25 fps clip split at output frame 5 of a 30 fps profile shows, chunk after chunk, the frames one window would', async () => {
    // Output frame 5 is at 1/6 s, inside frame 4 (0.16 to 0.2 s): the second chunk starts there, not at frame 4's start.
    const [first, second] = await produce({ [CLIP_A]: join(dir, 'greys.mp4') },
      [clipChunk(CLIP_A, 'greys.mp4', 0, 5, { profile: THIRTY }), clipChunk(CLIP_A, 'greys.mp4', 5, 12, { profile: THIRTY })]);
    const shown = [...await lumaMeans(first!), ...await lumaMeans(second!)];
    expect(shown).toHaveLength(12);
    shown.forEach((value, k) => expect(Math.abs(value - (16 + 20 * Math.floor((k * 25) / 30))), `output frame ${k}`).toBeLessThan(4));
  });

  // greys-ntsc.mp4: twenty 30000/1001 fps frames of stored luma 16 + 10n on a 1/30000 clock; frame n starts at n · 1001 ticks.
  it('CR04 a 29.97 fps clip split at output frame 7 of its own 29.97 fps profile shows every frame once, none repeated', async () => {
    const ntsc = { ...PROFILE, fps: r(30000, 1001), timeBase: r(1001, 30000) };
    const [first, second] = await produce({ [CLIP_A]: join(dir, 'greys-ntsc.mp4') },
      [clipChunk(CLIP_A, 'greys-ntsc.mp4', 0, 7, { profile: ntsc }), clipChunk(CLIP_A, 'greys-ntsc.mp4', 7, 20, { profile: ntsc })]);
    const shown = [...await lumaMeans(first!), ...await lumaMeans(second!)];
    expect(shown).toHaveLength(20);
    shown.forEach((value, k) => expect(Math.abs(value - (16 + 10 * k)), `output frame ${k}`).toBeLessThan(4));
  });
});

describe('model_composite (§7.17 model_composite and segment rows; execution design §8, §8.1)', () => {
  // The erase shape (mask, grid and matte) is pinned in erase-expand-recipes.node.test.ts EC01–EC07.
  it('MC03 expand: each background mapped back by PTS, the source over it at the frozen position, the overlap blended by grid time', async () => {
    const displayRect = { x: 16, y: 20, width: 64, height: 36 };
    // Window 0 covers grid time [0, 8/25), window 1 [4/25, 2/5): an overlap of frames 4 to 7.
    const recipe = {
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, ...gridOfFixture('greys.mp4'), frames: { start: 0, end: 10 },
      target: { ...TARGET, width: 128, height: 72, displayRect },
      backgrounds: [{ inputId: BACKGROUNDS[0], window: { start: r(0), end: r(8, 25) } }, { inputId: BACKGROUNDS[1], window: { start: r(4, 25), end: r(2, 5) } }],
    };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4'), [BACKGROUNDS[0]!]: join(dir, 'bg0.mp4'), [BACKGROUNDS[1]!]: join(dir, 'bg1.mp4') }, [recipe]);
    const video = (await probe(file!)).streams.find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 128, 72]);
    const list = await packets(file!);
    expect(list).toHaveLength(10);
    expect(list[0]!.flags).toContain('K');
    // The source rectangle (inset 2 px from its edges) is the source frame of the same grid time.
    const source = await lumaMeans(join(dir, 'greys.mp4'));
    const inside = await lumaMeans(file!, { x: displayRect.x + 2, y: displayRect.y + 2, width: displayRect.width - 4, height: displayRect.height - 4 });
    inside.forEach((mean, n) => expect(Math.abs(mean - source[n]!), `source rect, frame ${n}`).toBeLessThan(4));
    // The surround (the strip above the source) is the background frame at the same grid time: background i's
    // frame at local time n/25 - window.start, i.e. frame 2n (window 0) or 2(n - 4) (window 1) at 50 fps.
    const strip = { x: 0, y: 0, width: 128, height: 16 };
    const [bg0, bg1, surround] = [await lumaMeans(join(dir, 'bg0.mp4'), strip), await lumaMeans(join(dir, 'bg1.mp4'), strip), await lumaMeans(file!, strip)];
    for (const n of [0, 1, 2, 3]) expect(Math.abs(surround[n]! - bg0[2 * n]!), `window 0 only, frame ${n}`).toBeLessThan(4);
    for (const n of [8, 9]) expect(Math.abs(surround[n]! - bg1[2 * (n - 4)]!), `window 1 only, frame ${n}`).toBeLessThan(4);
    // Inside the overlap each frame lies between the two backgrounds, moving from window 0 to window 1 with grid time.
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
    const whole = { kind: 'model_composite', mode: 'expand', inputId: SOURCE, ...gridOfFixture('greys.mp4'), frames: { start: 0, end: 10 }, target, backgrounds };
    // Grid frames 6 to 9: the chunk opens two frames into window 1's overlap with window 0 (frames 4 to 7).
    const chunk = { ...whole, frames: { start: 6, end: 10 } };
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
      kind: 'model_composite', mode: 'expand', inputId: SOURCE, ...gridOfFixture('greys.mp4'), frames: { start: 0, end: 10 },
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
    const [before, after] = await produce(inputs(), [clipChunk(CLIP_A, 'clip-a.mp4', 0, 30), clipChunk(CLIP_B, 'clip-b.mp4', 40, 70, { placement: AT_B })]);
    const [window] = await produce(inputs(), [windowChunk('fade', 30, 40)]);
    expect(await codecHeaders(window!)).toEqual(await codecHeaders(before!));
    expect(await codecHeaders(after!)).toEqual(await codecHeaders(before!));
    const [file] = await produce({ ...inputs(), [CHUNKS[0]!]: before!, [CHUNKS[1]!]: window!, [CHUNKS[2]!]: after! }, [{
      kind: 'stitch', chunks: [{ inputId: CHUNKS[0], frames: { start: 0, end: 30 } }, { inputId: CHUNKS[1], frames: { start: 30, end: 40 } }, { inputId: CHUNKS[2], frames: { start: 40, end: 70 } }],
      clips: [stitchClip(CLIP_A, 'clip-a.mp4', AT_A, 40, true), stitchClip(CLIP_B, 'clip-b.mp4', AT_B, 40, true)], crossfade: WINDOW, profile: PROFILE,
    }]);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 70 }, (_unused, n) => n / 25));
    expect([0, 30, 40].map(n => list[n]!.flags.includes('K'))).toEqual([true, true, true]);
    const [a, b] = await greys();
    const means = await lumaMeans(file!);
    for (let i = 0; i < 10; i += 1) expect(Math.abs(means[30 + i]! - (a + (b - a) * i / 10)), `frame ${30 + i}`).toBeLessThan(3);
  });

  it(`TW09 a transparent clip reaches the blend with its alpha on a transparent profile (§7.17 alpha row; renderer stand-in)`, async () => {
    renderer.fake = true;
    const recipe = { ...windowChunk('fade', 30, 34, ['clip-alpha.webm', 'clip-b.mp4']), profile: { ...PROFILE, codec: 'vp9', pixFmt: 'yuva420p', alpha: true } };
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
    const recipe = windowChunk('fade', 30, 32, ['clip-narrow.mp4', 'clip-b.mp4']);
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
      // The chunk's target is the clip's 48x36 display, which transitionFitRect fits at (8, 0) in the 64x36 profile.
      const chunk = clipChunk(CLIP_A, 'clip-narrow.mp4', 30, 32, { profile, target: { width: 48, height: 36 } });
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
    // The clip's 48x36 display fits at x = ⌊(63 − 48) / 2⌋ = 7 in the 63x36 profile, where a window's fit { x: 7, width: 48 } puts it.
    const [file] = await produce({ [CLIP_A]: join(dir, 'clip-narrow.mp4') }, [clipChunk(CLIP_A, 'clip-narrow.mp4', 30, 32, { profile: transparent, target: { width: 48, height: 36 } })]);
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', file!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
    const pixels = stdout as unknown as Buffer;
    expect(pixels.length).toBe(63 * 36 * 4);
    const alpha = (x: number): number => pixels[(18 * 63 + x) * 4 + 3]!;
    expect([alpha(6), alpha(7), alpha(54), alpha(55)]).toEqual([0, 255, 255, 0]);
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
   * Encode the clips' chunks with the profile and run the transition stitch over them: clip A from output frame 0, clip B
   * from 30 under a transition or from 40 after a Cut, each 40 output frames.
   * @param chunks - Per chunk: its clip and its first and end output frame.
   * @param audio - Whether clip A's and clip B's audio plays.
   * @param crossfade - The crossfade window, null for a Cut.
   * @param names - Clip A's and clip B's fixtures.
   * @returns The stitched file.
   */
  async function transitionStitch(chunks: [string, number, number][], audio: [boolean, boolean], crossfade: typeof WINDOW | null,
    names: [string, string] = ['clip-a.mp4', 'clip-b.mp4']): Promise<string> {
    const inputs = { [CLIP_A]: join(dir, names[0]), [CLIP_B]: join(dir, names[1]) };
    const atB = crossfade === null ? { startFrame: 40, inFrame: 0 } : AT_B;
    const files = await produce(inputs, chunks.map(([clip, start, end]) => (clip === CLIP_A ? clipChunk(CLIP_A, names[0], start, end)
      : clipChunk(CLIP_B, names[1], start, end, { placement: atB }))));
    const [file] = await produce({ ...inputs, ...Object.fromEntries(files.map((path, at) => [CHUNKS[at]!, path])) }, [{
      kind: 'stitch', chunks: chunks.map(([_clip, start, end], at) => ({ inputId: CHUNKS[at], frames: { start, end } })),
      clips: [stitchClip(CLIP_A, names[0], AT_A, 40, audio[0]), stitchClip(CLIP_B, names[1], atB, 40, audio[1])], crossfade, profile: PROFILE,
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
  // The junction keeps one stereo layout, as the preview plays it: a first clip that is silent or mono does not fold the
  // second clip's stereo into mono (concat and acrossfade take the first input's layout).
  it('TS05 Cut after a silent clip: the output is stereo and clip B\'s left-only tone stays on the left', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 40], [CLIP_B, 40, 80]], [false, true], null, ['clip-a.mp4', 'clip-b-stereo.mp4']);
    const audio = (await probe(file)).streams.filter(stream => stream.codec_type === 'audio') as unknown as { channels: number }[];
    expect(audio.map(stream => stream.channels)).toEqual([2]);
    const level = async (path: string, from: number, channel: string): Promise<number> => {
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', '1', '-i', path, '-af', `pan=mono|c0=${channel},astats=metadata=0:reset=0`, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
      return Number(/RMS level dB: (-?[\d.]+|-inf)/u.exec(String(stderr))?.[1]?.replace('-inf', '-200') ?? '0');
    };
    // Clip B plays from 1.6 s; its left channel keeps the source's level, unboosted, and its right stays silent.
    expect(Math.abs(await level(file, 2, 'c0') - await level(join(dir, 'clip-b-stereo.mp4'), 0.4, 'c0'))).toBeLessThan(1);
    expect(await level(file, 2, 'c1')).toBeLessThan(-60);
  });

  it('TS06 a mono clip plays at its own level on both channels, as the preview plays it', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 40], [CLIP_B, 40, 80]], [true, true], null, ['clip-a.mp4', 'clip-b-mono.mp4']);
    const level = async (path: string, from: number, channel: string): Promise<number> => {
      const { stderr } = await run('ffmpeg', ['-v', 'info', '-ss', String(from), '-t', '1', '-i', path, '-af', `pan=mono|c0=${channel},astats=metadata=0:reset=0`, '-f', 'null', '-'], { maxBuffer: 1 << 24 });
      return Number(/RMS level dB: (-?[\d.]+|-inf)/u.exec(String(stderr))?.[1]?.replace('-inf', '-200') ?? '0');
    };
    const source = await level(join(dir, 'clip-b-mono.mp4'), 0.4, 'c0');
    expect(Math.abs(await level(file, 2, 'c0') - source)).toBeLessThan(1);
    expect(Math.abs(await level(file, 2, 'c1') - source)).toBeLessThan(1);
  });

  it('TS01 Cut (crossfade null): clip A\'s audio then clip B\'s, joined directly with no fade', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 40], [CLIP_B, 40, 80]], [true, true], null);
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
    const file = await transitionStitch([[CLIP_A, 0, 30], [CLIP_A, 30, 40], [CLIP_B, 40, 70]], [true, true], WINDOW);
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

  it('TS03 a clip without audio (audio false) contributes silence over its span', async () => {
    const file = await transitionStitch([[CLIP_A, 0, 30], [CLIP_A, 30, 40], [CLIP_B, 40, 70]], [true, false], WINDOW);
    await expectAudio(file, 2.8);
    const [a] = await sourceAmplitudes();
    const signal = await samples(file);
    const [ampA, rms] = [toneAmplitudes(signal, 500), blockRms(signal)];
    for (let block = 2; block <= 58; block += 1) expect(Math.abs(ampA[block]! / a - 1), `A at block ${block}`).toBeLessThan(0.08);
    for (let block = 81; block <= 137; block += 1) expect(rms[block]!, `silence at block ${block}`).toBeLessThan(1e-3);
  });
});
