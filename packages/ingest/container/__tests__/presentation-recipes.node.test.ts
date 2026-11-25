// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6d D3: the standard-4 presentation recipes on real media and the frame grid (inner#1306 test plan §91 D3; frames-split
 * design §4.1, §4.3, §5.4, §7.16, §7.17; answers D-1, D-2, D-5, D-7, D-8).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the standard-4 container does: it reads the tool source through
 * the loopback reader (a stitch downloads its chunks), runs the recipe and writes the output, then reports. A window recipe (`chunk_encode`) names its
 * tool source's grid (`grid` {fps, gridStart, frameCount, realFrameCount}, read here from each fixture with the harness's
 * `gridOf`), the tool source (the original with its keyframe statistics), the grid frames [start, end) and the plan's
 * `target`. A chunk is encoded on its own clock from 0 at 1/fps, opens with a keyframe and carries no audio; the stitch
 * concatenates the chunks by stream copy, each for its grid frames, and muxes the original's audio over the same grid
 * frames, encoded once (§5.4). Every fixture is generated here with FFmpeg and every assertion is a fact FFmpeg reads back
 * (D-5). The edge is faked at `fetch`.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { resolveVideoColorMatrix } from '@ingest/container/physical-video-probe.js';
import { packedCarrierWidth } from '@shared/mini-tools/video-encode-plan.js';
import { gridOf, servedObject, type GridFacts } from './helpers/frame-grid-harness.js';
import { coverArgs, coverDecoderArgs, probeArgs, readProbeOutput } from '@ingest/probe-command.js';

const run = promisify(execFile);
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
interface Report { ok: boolean; outputs: { outputIndex: number; packing?: { packedWidth: number; packedHeight: number; colorRect: Rect; alphaRect: Rect } }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; time_base: string; sample_rate?: string; duration?: string; side_data_list?: { side_data_type: string; rotation?: number }[] }
interface Packet { pts_time: string; duration_time: string; flags: string }

const COMMITTED = new URL('./fixtures/presentation/', import.meta.url);
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const CHUNKS = ['10000000-0000-4000-8000-0000000000c0', '10000000-0000-4000-8000-0000000000c1'];

let dir: string;
let served = new Map<string, string>();
const written = new Map<string, Uint8Array>();
let reports: Report[] = [];
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
 * A fixture's 25 fps grid and tool source, read in `beforeAll`.
 * @param name - The fixture.
 * @returns Its grid and source fields.
 */
function gridOfFixture(name: string): Pick<GridFacts, 'grid' | 'source'> {
  const facts = grids.get(name);
  if (facts === undefined) throw new Error(`No grid read for ${name}`);
  return { grid: facts.grid, source: facts.source };
}

/**
 * A chunk_encode recipe over grid frames [start, end) of a fixture.
 * @param name - The fixture.
 * @param start - The first grid frame.
 * @param end - The grid frame the window stops before.
 * @param target - Its target block.
 * @returns The recipe.
 */
function chunk(name: string, start: number, end: number, target: Recipe = TARGET): Recipe {
  return { kind: 'chunk_encode', inputId: SOURCE, ...gridOfFixture(name), frames: { start, end }, target };
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
 * Run one job and require it to succeed.
 * @param inputs - Input id to served file path.
 * @param recipes - One recipe per output.
 * @returns The written output paths.
 */
async function produce(inputs: Record<string, string>, recipes: Recipe[]): Promise<string[]> {
  const { report, files } = await runJob(inputs, recipes);
  expect(report.ok).toBe(true);
  expect(report.outputs.map(output => output.outputIndex)).toEqual(recipes.map((_recipe, index) => index));
  return files;
}

/**
 * The streams and format of a file.
 * @param path - The file.
 * @returns Its streams and format duration.
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
 * The mean stored luma (the Y plane's own limited-range values) of every stored frame inside a rectangle.
 * @param path - The file.
 * @param crop - The rectangle, the whole picture when absent.
 * @returns One mean per frame.
 */
async function lumaMeans(path: string, crop?: { x: number; y: number; width: number; height: number }): Promise<number[]> {
  const video = (await probe(path)).streams.find(stream => stream.codec_type === 'video')!;
  const area = crop ?? { x: 0, y: 0, width: video.width!, height: video.height! };
  // The Y plane as it is stored: a grey conversion or scale may also convert its range, differently by picture size
  // (FFmpeg 7.1), and the crop runs on the plane so a 1-pixel column is not rounded to the 4:2:0 chroma step.
  // passthrough reads exactly the stored frames: the default constant rate (r_frame_rate) duplicates frames of a variable clock.
  const filter = `extractplanes=y,crop=${area.width}:${area.height}:${area.x}:${area.y}`;
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-vf', filter, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const size = area.width * area.height;
  return Array.from({ length: bytes.length / size }, (_unused, frame) => bytes.subarray(frame * size, frame * size + size).reduce((sum, value) => sum + value, 0) / size);
}

/**
 * The 32x16 grey thumbnails of every frame, for content comparison.
 * @param path - The file.
 * @returns One thumbnail per frame.
 */
async function thumbs(path: string): Promise<Buffer[]> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-fps_mode', 'passthrough', '-vf', 'scale=32:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = stdout as unknown as Buffer;
  return Array.from({ length: bytes.length / 512 }, (_unused, frame) => bytes.subarray(frame * 512, frame * 512 + 512));
}

/**
 * The mean stored Y, U and V of a file's first frame, optionally after a filter chain run on its decoded frames.
 * @param path - The file.
 * @param chain - A filter chain ending on 4:2:0 frames, none to read the stored planes.
 * @returns The three plane means.
 */
async function planes(path: string, chain?: string): Promise<{ y: number; u: number; v: number }> {
  const mean = async (plane: string): Promise<number> => {
    const filter = `${chain === undefined ? '' : `${chain},`}extractplanes=${plane}`;
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
    const bytes = stdout as unknown as Buffer;
    return bytes.reduce((sum, value) => sum + value, 0) / bytes.length;
  };
  return { y: await mean('y'), u: await mean('u'), v: await mean('v') };
}

/**
 * One 8-bit plane of a picture's first frame.
 * @param path - The image or video.
 * @param chain - The filter chain ending on the plane.
 * @returns The plane's bytes.
 */
async function plane8(path: string, chain: string): Promise<Buffer> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-vf', chain, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  return stdout;
}

/**
 * The largest per-plane difference of two plane means.
 * @param a - One.
 * @param b - The other.
 * @returns The difference.
 */
function planeGap(a: { y: number; u: number; v: number }, b: { y: number; u: number; v: number }): number {
  return Math.max(Math.abs(a.y - b.y), Math.abs(a.u - b.u), Math.abs(a.v - b.v));
}

/**
 * Mean absolute difference of two thumbnails.
 * @param a - One.
 * @param b - The other.
 * @returns The difference.
 */
function diff(a: Buffer, b: Buffer): number {
  return a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
}

/**
 * Require the BT.709 limited-range tags the carrier is written with (§4.3: tags written on frames with `setparams`).
 * @param stream - The video stream.
 * @returns Nothing.
 */
function expectBt709(stream: Stream): void {
  expect([stream.color_primaries, stream.color_transfer, stream.color_space, stream.color_range]).toEqual(['bt709', 'bt709', 'bt709', 'tv']);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'presentation-recipes-'));
  const tagged = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  // 50 greys (16 + 3n) at 25 fps with B-frames and a keyframe every 25 frames in Matroska, which stores no dts.
  await make('greys-bframes.mkv', ['-f', 'lavfi', '-i', "color=c=black:s=320x180:r=25:d=2,format=yuv420p,geq=lum='16+3*N':cb=128:cr=128", '-c:v', 'libx264', '-qp', '0',
    '-g', '25', '-bf', '3', '-pix_fmt', 'yuv420p', ...tagged]);
  // 2 s at 25 fps, keyframe every 10 frames, BT.709-tagged, with a 44.1 kHz tone so the stitch's audio is resampled to 48 kHz (§4.2).
  await make('cfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=2',
    '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25', '-c:a', 'aac', '-shortest']);
  // No B-frames, no audio.
  await make('untagged.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p']);
  // Odd display size: H.264 High 4:4:4 holds 161x97 natively (§4.3 奇数宽高); the picture is white so the padding stands apart.
  await make('odd.mp4', ['-f', 'lavfi', '-i', 'color=c=white:s=161x97:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', ...tagged]);
  await make('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'cfr.mp4'), '-c', 'copy']);
  // A palette PNG in MOV, transparent on its left half and opaque on its right (CE26).
  await make('palette.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4', '-filter_complex',
    "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,32),0,255)',split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=single[p];[s1][p]paletteuse=alpha_threshold=128:new=1", '-c:v', 'png']);
  // Opaque everywhere, saturated green on its last eight columns: the packed planes' seam shows any chroma bleeding (CE24).
  await make('banner.mov', ['-f', 'lavfi', '-i', "color=c=white:s=64x36:r=25:d=0.4,format=rgba,geq=r='if(gte(X\\,56)\\,0\\,255)':g='255':b='if(gte(X\\,56)\\,0\\,255)':a='255'", '-c:v', 'png']);
  // BT.601 (smpte170m) primaries, transfer and matrix: the carrier's tags must be rewritten, not inherited.
  await make('tagged601.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p',
    '-x264-params', 'colorprim=smpte170m:transfer=smpte170m:colormatrix=smpte170m']);
  // Pure red written with the BT.709 matrix and then stripped of every colour tag: only the plan's matrix decodes it right.
  await make('red-untagged.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=25:d=0.4',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  await make('alpha.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=rgba,colorchannelmixer=aa=0.25', '-c:v', 'png']);
  // The same alpha in a VP9 WebM, whose alpha plane only the libvpx decoder reads.
  await make('alpha.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=yuva420p,colorchannelmixer=aa=0.25', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p']);
  // SDR 4:2:0 twins (CE20).
  for (const format of ['yuv420p']) {
    await make(`sdr-${format}-even.mkv`, ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-vf', `format=${format},setparams=colorspace=bt709:range=tv`, '-c:v', 'ffv1']);
    await make(`sdr-${format}-odd.mkv`, ['-i', join(dir, `sdr-${format}-even.mkv`), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  }
  // HEVC with an alpha layer only VideoToolbox encodes, so the clip is committed (its provenance file says how it was made).
  await copyFile(new URL('hevc-alpha.mov', COMMITTED), join(dir, 'hevc-alpha.mov'));
  for (const name of ['hevc-alpha.mov', 'cfr.mp4', 'untagged.mp4', 'odd.mp4', 'rot90.mp4', 'palette.mov',
    'banner.mov', 'greys-bframes.mkv', 'tagged601.mp4', 'red-untagged.mp4', 'alpha.mov', 'alpha.webm', 'sdr-yuv420p-even.mkv',
    'sdr-yuv420p-odd.mkv']) grids.set(name, await gridOf(join(dir, name), { numerator: 25, denominator: 1 }));
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  served = new Map();
  written.clear();
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
    return servedObject(await readFile(path), init);
  }));
});

/**
 * The first chunk of cfr.mp4: grid frames [0, 20).
 * @returns The recipe.
 */
function first(): Recipe { return chunk('cfr.mp4', 0, 20); }
/**
 * The second chunk of cfr.mp4: grid frames [20, 50).
 * @returns The recipe.
 */
function second(): Recipe { return chunk('cfr.mp4', 20, 50); }

describe('chunk_encode (§5.4 切块、块的时间; §7.17)', () => {
  it('CE01 encodes its window on its own clock from 0, opening with a keyframe, BT.709-tagged and without audio', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [first()]);
    const { streams } = await probe(file!);
    expect(streams.map(stream => stream.codec_type)).toEqual(['video']);
    const video = streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 320, 180]);
    // The muxer's track clock (1/12800 for MP4) holds every 1/25 s grid time exactly.
    expect(Number(video.time_base.split('/')[1]) % 25).toBe(0);
    expectBt709(video);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 20 }, (_unused, n) => n / 25));
    expect(list.map(packet => Number(packet.duration_time))).toEqual(Array.from({ length: 20 }, () => 0.04));
    expect(list[0]!.flags).toContain('K');
  });

  it('CE02 a later window starts on its own source frame, decoded from its keyframe', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [second()]);
    const list = await packets(file!);
    expect(list).toHaveLength(30);
    expect([Number(list[0]!.pts_time), list[0]!.flags.includes('K')]).toEqual([0, true]);
    const [source, encoded] = [await thumbs(join(dir, 'cfr.mp4')), await thumbs(file!)];
    expect(diff(encoded[0]!, source[20]!)).toBeLessThan(diff(encoded[0]!, source[19]!));
    expect(diff(encoded[29]!, source[49]!)).toBeLessThan(diff(encoded[29]!, source[48]!));
  });

  it('CE04 pads an odd display size to the even coded size with the picture at displayRect (§4.3 奇数宽高, §3.5 displayRect)', async () => {
    const displayRect = { x: 0, y: 0, width: 161, height: 97 };
    const recipe = chunk('odd.mp4', 0, 10, { ...TARGET, width: 162, height: 98, displayRect });
    const [file] = await produce({ [SOURCE]: join(dir, 'odd.mp4') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 162, 98]);
    expect(Math.min(...await lumaMeans(file!, { x: 0, y: 0, width: 160, height: 96 }))).toBeGreaterThan(200);
  });

  it('CE05 scales the display picture to the target size (§8.2 短边封顶 is the worker\'s geometry; the container follows target)', async () => {
    const recipe = chunk('cfr.mp4', 0, 20, { ...TARGET, width: 160, height: 90 });
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.width, video.height]).toEqual([160, 90]);
  });

  it.each(['alpha.mov', 'alpha.webm'])('CE08 packs an alpha source premultiplied colour left and alpha right on even planes (§3.5 alpha-packed): %s', async (name) => {
    const recipe = chunk(name, 0, 10, { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' });
    const [file] = await produce({ [SOURCE]: join(dir, name) }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 132, 36]);
    // The right plane, after the 4-column gap, is the alpha as grey: 64 stored as limited-range luma 16 + 64 * 219 / 255 ≈ 71.
    for (const mean of await lumaMeans(file!, { x: 68, y: 0, width: 64, height: 36 })) expect(Math.abs(mean - 71)).toBeLessThan(6);
  });

  // The alpha layer of an HEVC source is a second layer the decoder must be asked for: a pack that read only the base
  // layer, or a source whose alpha layer cannot be decoded, comes out with a black (fully transparent) alpha plane.
  it('CE08b packs the alpha layer of an HEVC source: its opaque alpha plane stays opaque', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'hevc-alpha.mov') }, [chunk('hevc-alpha.mov', 0, 10, { ...TARGET, width: packedCarrierWidth(160), height: 96, alpha: 'packed' })]);
    // Opaque is 255, stored as limited-range luma 235.
    const means = await lumaMeans(file!, { x: packedCarrierWidth(160) - 160, y: 0, width: 160, height: 96 });
    expect(means).toHaveLength(10);
    for (const mean of means) expect(mean).toBeGreaterThan(225);
  });

  // An RGB-coded source (PNG in MOV) packs with the matrix its own plan resolves; the scaler converts RGB frames with no
  // input matrix, so the packed picture is the same whatever that matrix is.
  it('CE22 an RGB-coded alpha source packs with its plan matrix, its picture independent of it', async () => {
    const source = join(dir, 'alpha.mov');
    const planMatrix = resolveVideoColorMatrix((await probe(source)).streams[0] as unknown as Record<string, unknown>);
    const packed = async (colorMatrix: string): Promise<number[]> =>
      lumaMeans((await produce({ [SOURCE]: source }, [chunk('alpha.mov', 0, 10, { ...TARGET, colorMatrix, width: packedCarrierWidth(64), height: 36, alpha: 'packed' })]))[0]!);
    const [own, bt709, bt601] = [await packed(planMatrix), await packed('bt709'), await packed('bt601')];
    expect(own).toEqual(bt709);
    expect(bt601).toEqual(bt709);
  });

  // A browser upsamples 4:2:0 chroma across neighbouring samples (Chrome 157 read up to 20% wrong alpha in the alpha plane's
  // first column and a washed-out last colour column when the planes touched). The chroma sample before the alpha plane is
  // neutral and the one after the colour plane's edge repeats that edge, whatever two samples the upsampler mixes.
  it('CE24 the packed planes are kept apart: neutral chroma before the alpha plane, the colour edge repeated after its plane', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'banner.mov') }, [chunk('banner.mov', 0, 10, { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' })]);
    const raw = (await run('ffmpeg', ['-v', 'error', '-i', file!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 })).stdout;
    const [luma, chromaWidth] = [132 * 36, 66];
    // Chroma samples on row 8 of the 18: U then V.
    const chroma = (column: number): [number, number] => [raw[luma + 8 * chromaWidth + column]!, raw[luma + 66 * 18 + 8 * chromaWidth + column]!];
    // x264 at crf 18 moves chroma by a few levels; a bleed moves it by tens.
    for (const value of chroma(68 / 2 - 1)) expect(Math.abs(value - 128)).toBeLessThanOrEqual(6);
    const [edge, after] = [chroma(64 / 2 - 1), chroma(64 / 2)];
    for (const index of [0, 1]) expect(Math.abs(after[index]! - edge[index]!)).toBeLessThanOrEqual(6);
    expect(Math.abs(edge[0] - 128)).toBeGreaterThan(20);
  });

  // A palette (pal8) frame becomes planar RGBA before the packing splits it: its transparent half packs clear, its opaque
  // half solid.
  it('CE26 a palette source packs its alpha', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'palette.mov') }, [chunk('palette.mov', 0, 10, { ...TARGET, colorMatrix: 'bt601', width: packedCarrierWidth(64), height: 36, alpha: 'packed' })]);
    const [clear] = await lumaMeans(file!, { x: 68, y: 0, width: 32, height: 36 });
    const [solid] = await lumaMeans(file!, { x: 100, y: 0, width: 32, height: 36 });
    expect(clear!).toBeLessThan(24);
    expect(solid!).toBeGreaterThan(228);
  });

  // SMPTE 240M and FCC sources decode with their own matrix.
  it.each(['smpte240m', 'fcc'])('CE23 a %s plan decodes', async (colorMatrix) => {
    await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [chunk('cfr.mp4', 0, 10, { ...TARGET, colorMatrix })]);
  });

  it('CE16 a Matroska chunk with B-frames from grid frame 25 starts on that source frame', async () => {
    // Frame 25 is the second keyframe, at 1 s; the seek lands before it and the grid chain cuts to it (§7.16).
    const recipe = chunk('greys-bframes.mkv', 25, 30);
    const [file] = await produce({ [SOURCE]: join(dir, 'greys-bframes.mkv') }, [recipe]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 3))).toEqual([25, 26, 27, 28, 29]);
  });

  /**
   * The mean per-sample gap of a chroma plane between an odd-sized VP9 output and its even twin's, over the samples both
   * pictures hold the same source pixels for (the last chroma column and row of the odd picture cover one pixel less).
   * @param odd - The odd output.
   * @param even - The even output.
   * @param plane - The chroma plane.
   * @returns The mean gap.
   */
  async function chromaGap(odd: string, even: string, plane: 'u' | 'v'): Promise<number> {
    const [a, b] = [await plane8(odd, `extractplanes=${plane}`), await plane8(even, `extractplanes=${plane}`)];
    let sum = 0;
    let count = 0;
    for (let y = 0; y < 47; y += 1) for (let x = 0; x < 79; x += 1) { sum += Math.abs(a[y * 80 + x]! - b[y * 80 + x]!); count += 1; }
    return sum / count;
  }

  // §4.3 odd-size row: an odd 4:2:0 source's VP9 output keeps its subsampled chroma where its even twin's lies, so its chroma
  // planes match the twin's.
  it.each(['yuv420p'])('CE20 an odd-sized %s source gives an odd VP9 output whose chroma lies where the even twin\'s does', async (format) => {
    const vp9 = (name: string, width: number, height: number): Recipe => chunk(name, 0, 10, { ...TARGET, width, height, format: 'webm-vp9' });
    const [odd] = await produce({ [SOURCE]: join(dir, `sdr-${format}-odd.mkv`) }, [vp9(`sdr-${format}-odd.mkv`, 159, 95)]);
    const [even] = await produce({ [SOURCE]: join(dir, `sdr-${format}-even.mkv`) }, [vp9(`sdr-${format}-even.mkv`, 160, 96)]);
    for (const plane of ['u', 'v'] as const) {
      const gap = await chromaGap(odd!, even!, plane);
      expect(gap, plane).toBeLessThan(1);
    }
  });

  it('CE12 rewrites a BT.601-tagged source\'s tags to BT.709 (§4.3 载体与输出一律显式写标签)', async () => {
    const recipe = chunk('tagged601.mp4', 0, 10, { ...TARGET, colorMatrix: 'bt601' });
    const [file] = await produce({ [SOURCE]: join(dir, 'tagged601.mp4') }, [recipe]);
    expectBt709((await probe(file!)).streams[0]!);
  });

  it('CE13 decodes an untagged source with the plan\'s matrix, not the decoder default (§4.3 工具解码显式传 in_color_matrix)', async () => {
    const recipe = chunk('red-untagged.mp4', 0, 10, { ...TARGET, width: 64, height: 36, colorMatrix: 'bt709' });
    const [file] = await produce({ [SOURCE]: join(dir, 'red-untagged.mp4') }, [recipe]);
    const source = join(dir, 'red-untagged.mp4');
    const stored = await planes(source);
    const byDefault = await planes(source, 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p');
    expect(planeGap(stored, byDefault)).toBeGreaterThan(5);
    // BT.709 in and BT.709 out keeps the stored planes.
    expect(planeGap(await planes(file!), stored)).toBeLessThan(3);
  });

});

describe('stitch (§5.4 块的时间、拼接)', () => {
  const TWO_CHUNKS = [{ inputId: CHUNKS[0], frames: { start: 0, end: 20 } }, { inputId: CHUNKS[1], frames: { start: 20, end: 50 } }];

  /**
   * Encode the two chunks of the 2 s source (grid frames [0, 20) and [20, 50)) and stitch them.
   * @param second - The second chunk recipe.
   * @param stitchOf - Extra stitch fields.
   * @returns The stitched file.
   */
  async function chunkAndStitch(second: Recipe, stitchOf: Recipe): Promise<string> {
    const [a, b] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [first(), second]);
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4'), [CHUNKS[0]!]: a!, [CHUNKS[1]!]: b! },
      [{ kind: 'stitch', inputId: SOURCE, ...gridOfFixture('cfr.mp4'), target: TARGET, ...stitchOf }]);
    return file!;
  }

  it('ST01 concatenates the chunks without re-encoding: every frame on the grid clock, keyframes at the chunk starts, tags kept, the original\'s audio merged at 48 kHz', async () => {
    const file = await chunkAndStitch(second(), { chunks: TWO_CHUNKS, audio: true });
    const { streams, duration } = await probe(file);
    expect(streams.map(stream => stream.codec_type).sort()).toEqual(['audio', 'video']);
    const video = streams.find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 320, 180]);
    expectBt709(video);
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 50 }, (_unused, n) => n / 25));
    expect(list[0]!.flags).toContain('K');
    expect(list[20]!.flags).toContain('K');
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    expect(audio.map(stream => [stream.codec_name, stream.sample_rate])).toEqual([['aac', '48000']]);
    expect(Math.abs(Number(audio[0]!.duration) - 2)).toBeLessThanOrEqual(1024 / 48000);
    expect(duration).toBeCloseTo(2, 1);
  });

  it('ST02 carries no audio when the recipe asks for none', async () => {
    const file = await chunkAndStitch(second(), { chunks: TWO_CHUNKS, audio: false });
    expect((await probe(file)).streams.map(stream => stream.codec_type)).toEqual(['video']);
  });

  // §91 D3b-2: the plan does not record whether the source has audio, so the worker asks for the original's audio and the
  // container muxes the source's first audio stream only when there is one.
  it('ST06 a source without audio stitches into a video-only carrier and does not fail', async () => {
    const [a] = await produce({ [SOURCE]: join(dir, 'untagged.mp4') }, [chunk('untagged.mp4', 0, 10, { ...TARGET, colorMatrix: 'bt601' })]);
    const [file] = await produce({ [SOURCE]: join(dir, 'untagged.mp4'), [CHUNKS[0]!]: a! },
      [{ kind: 'stitch', inputId: SOURCE, ...gridOfFixture('untagged.mp4'), target: { ...TARGET, colorMatrix: 'bt601' }, chunks: [{ inputId: CHUNKS[0], frames: { start: 0, end: 10 } }], audio: true }]);
    expect((await probe(file!)).streams.map(stream => stream.codec_type)).toEqual(['video']);
    expect(await packets(file!)).toHaveLength(10);
  });

  // inner#1306 test plan §97 D15 (frames-split §5.4 拼接 row): before joining, the stitch compares every chunk's codec
  // headers (H.264 avcC/SPS/PPS) and fails that output when they differ. A second chunk encoded with another preset has
  // other SPS/PPS (reference frames, entropy coding), so stream copy would join two incompatible streams.
  it('ST07 refuses to stitch chunks whose codec headers differ', async () => {
    const [a, b] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [first(), { ...second(), target: { ...TARGET, preset: 'ultrafast' } }]);
    const { report } = await runJob({ [SOURCE]: join(dir, 'cfr.mp4'), [CHUNKS[0]!]: a!, [CHUNKS[1]!]: b! },
      [{ kind: 'stitch', inputId: SOURCE, ...gridOfFixture('cfr.mp4'), target: TARGET, chunks: TWO_CHUNKS, audio: false }]);
    expect(report.ok).toBe(false);
    expect(report.outputs).toEqual([]);
  });

  it('ST04 a packed chunk stitches into a packed carrier of the same geometry and reports that geometry', async () => {
    const packed = { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' };
    const [a] = await produce({ [SOURCE]: join(dir, 'alpha.mov') }, [chunk('alpha.mov', 0, 10, packed)]);
    const [file] = await produce({ [SOURCE]: join(dir, 'alpha.mov'), [CHUNKS[0]!]: a! },
      [{ kind: 'stitch', inputId: SOURCE, ...gridOfFixture('alpha.mov'), target: packed, chunks: [{ inputId: CHUNKS[0], frames: { start: 0, end: 10 } }], audio: false }]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 132, 36]);
    expect(await packets(file!)).toHaveLength(10);
    expect(reports[0]!.outputs).toHaveLength(1);
    expect(reports[0]!.outputs[0]!.packing).toEqual({ packedWidth: 132, packedHeight: 36, colorRect: { x: 0, y: 0, width: 64, height: 36 }, alphaRect: { x: 68, y: 0, width: 64, height: 36 } });
  });
});

describe('the cover of a transparent video (§3.5; storage cover row)', () => {
  it.each([['alpha.webm', ['-apply_cropping', 'codec', '-c:v', 'libvpx-vp9']], ['alpha.mov', ['-apply_cropping', 'codec']]] as const)('CV01 the cover cut from %s keeps its alpha', async (name, decoder) => {
    const path = join(dir, name);
    const report = readProbeOutput((await run('ffprobe', probeArgs(path, 'own-file'), { maxBuffer: 1 << 24 })).stdout);
    expect(coverDecoderArgs(report)).toEqual(decoder);
    const { stdout } = await run('ffmpeg', coverArgs(path, 'own-file', report), { encoding: 'buffer', maxBuffer: 1 << 24 });
    // PNG IHDR colour type, byte 25: 6 is RGBA.
    expect((stdout as unknown as Buffer)[25]).toBe(6);
  });
});
