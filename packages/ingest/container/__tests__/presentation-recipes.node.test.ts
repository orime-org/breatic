// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D3: the standard-4 presentation recipes on real media (inner#1306 test plan §91 D3; frames-split design §4.3, §5.3
 * model-input row, §5.4, §7.17; answers D-1, D-2, D-5, D-7, D-8).
 *
 * Each case runs the planned job owner (`runPlanJob`) as the standard-4 container does: it downloads the bound inputs,
 * runs the recipe and writes the output, then reports. The recipe carries what the worker wrote from the full ledger
 * (§7.17: clip spans in presentation order and `{ kind: 'empty', fill, window }` entries, all in presentation time) and
 * the plan's `target` block; the container never reads the ledger. A chunk is encoded on its own clock starting at 0,
 * opens with a keyframe and carries no audio; the stitch concatenates the chunks by stream copy with each chunk's plan
 * `duration` and muxes the interval's audio, encoded once (§5.4). Every fixture is generated here with FFmpeg and every
 * assertion is a fact FFmpeg reads back (D-5). The edge is faked at `fetch`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
type Recipe = Record<string, unknown>;
type Rect = { x: number; y: number; width: number; height: number };
interface Report { ok: boolean; outputs: { outputIndex: number; packing?: { packedWidth: number; packedHeight: number; colorRect: Rect; alphaRect: Rect } }[] }
interface Stream { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; color_primaries?: string; color_transfer?: string; color_space?: string; color_range?: string; time_base: string; sample_rate?: string; duration?: string; side_data_list?: { side_data_type: string; rotation?: number }[] }
interface Packet { pts_time: string; duration_time: string; flags: string }

const r = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const TARGET = { width: 320, height: 180, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 18, preset: 'medium' };
const SOURCE = '10000000-0000-4000-8000-000000000001';
const CHUNKS = ['10000000-0000-4000-8000-0000000000c0', '10000000-0000-4000-8000-0000000000c1'];

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
 * One source clip span of the recipe (§7.17 `segment` row), every time in presentation time except the two source times.
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
 * A chunk_encode recipe on the source.
 * @param window - Its presentation ordinals.
 * @param entries - Its spans.
 * @param target - Its target block.
 * @returns The recipe.
 */
function chunk(window: { start: number; end: number }, entries: Recipe[], target: Recipe = TARGET): Recipe {
  return { kind: 'chunk_encode', inputId: SOURCE, window, timescale: 25, entries, target };
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
 * The mean luma of every decoded frame inside a rectangle.
 * @param path - The file.
 * @param crop - The rectangle, the whole picture when absent.
 * @returns One mean per frame.
 */
async function lumaMeans(path: string, crop?: { x: number; y: number; width: number; height: number }): Promise<number[]> {
  const filter = `${crop === undefined ? '' : `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},`}scale=32:16:flags=area,format=gray`;
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vf', filter, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = stdout as unknown as Buffer;
  return Array.from({ length: bytes.length / 512 }, (_unused, frame) => bytes.subarray(frame * 512, frame * 512 + 512).reduce((sum, value) => sum + value, 0) / 512);
}

/**
 * The 32x16 grey thumbnails of every frame, for content comparison.
 * @param path - The file.
 * @returns One thumbnail per frame.
 */
async function thumbs(path: string): Promise<Buffer[]> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vf', 'scale=32:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = stdout as unknown as Buffer;
  return Array.from({ length: bytes.length / 512 }, (_unused, frame) => bytes.subarray(frame * 512, frame * 512 + 512));
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
  // 2 s at 25 fps, keyframe every 10 frames, BT.709-tagged, with a 44.1 kHz tone so the stitch's audio is resampled to 48 kHz (§4.2).
  await make('cfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=2',
    '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25', '-c:a', 'aac', '-shortest']);
  await make('untagged.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '5', '-pix_fmt', 'yuv420p']);
  await make('pq10.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '10', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  // Odd display size: H.264 High 4:4:4 holds 161x97 natively (§4.3 奇数宽高); the picture is white so the padding stands apart.
  await make('odd.mp4', ['-f', 'lavfi', '-i', 'color=c=white:s=161x97:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', ...tagged]);
  await make('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'cfr.mp4'), '-c', 'copy']);
  // Straight alpha of 64 over the whole picture, lossless PNG in QuickTime.
  await make('alpha.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=rgba,colorchannelmixer=aa=0.25', '-c:v', 'png']);
});
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
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

const FIRST = chunk({ start: 0, end: 20 }, [span(r(0), r(0), r(0), r(4, 5))]);
const SECOND = chunk({ start: 20, end: 50 }, [span(r(4, 5), r(4, 5), r(4, 5), r(2))]);

describe('chunk_encode (§5.4 切块、块的时间; §7.17)', () => {
  it('CE01 encodes its window on its own clock from 0, opening with a keyframe, BT.709-tagged and without audio', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [FIRST]);
    const { streams } = await probe(file!);
    expect(streams.map(stream => stream.codec_type)).toEqual(['video']);
    const video = streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height, video.time_base]).toEqual(['h264', 'yuv420p', 320, 180, '1/25']);
    expectBt709(video);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 20 }, (_unused, n) => n / 25));
    expect(list.map(packet => Number(packet.duration_time))).toEqual(Array.from({ length: 20 }, () => 0.04));
    expect(list[0]!.flags).toContain('K');
  });

  it('CE02 a later window starts on its own source frame, decoded from its keyframe', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [SECOND]);
    const list = await packets(file!);
    expect(list).toHaveLength(30);
    expect([Number(list[0]!.pts_time), list[0]!.flags.includes('K')]).toEqual([0, true]);
    const [source, encoded] = [await thumbs(join(dir, 'cfr.mp4')), await thumbs(file!)];
    expect(diff(encoded[0]!, source[20]!)).toBeLessThan(diff(encoded[0]!, source[19]!));
    expect(diff(encoded[29]!, source[49]!)).toBeLessThan(diff(encoded[29]!, source[48]!));
  });

  it('CE03 tone maps a PQ 10-bit source to 8-bit SDR BT.709 (§4.3 HDR 行, D-7)', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, toneMap: 'sdr-bt709' });
    const [file] = await produce({ [SOURCE]: join(dir, 'pq10.mp4') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt]).toEqual(['h264', 'yuv420p']);
    expectBt709(video);
    expect(await packets(file!)).toHaveLength(10);
  });

  it('CE04 pads an odd display size to the even coded size with the picture at displayRect (§4.3 奇数宽高, §3.5 displayRect)', async () => {
    const displayRect = { x: 0, y: 0, width: 161, height: 97 };
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 162, height: 98, displayRect });
    const [file] = await produce({ [SOURCE]: join(dir, 'odd.mp4') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 162, 98]);
    expect(Math.min(...await lumaMeans(file!, { x: 0, y: 0, width: 160, height: 96 }))).toBeGreaterThan(200);
  });

  it('CE05 scales the display picture to the target size (§8.2 短边封顶 is the worker\'s geometry; the container follows target)', async () => {
    const recipe = chunk({ start: 0, end: 20 }, [span(r(0), r(0), r(0), r(4, 5))], { ...TARGET, width: 160, height: 90 });
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.width, video.height]).toEqual([160, 90]);
  });

  it('CE06 composes a derived-empty entry as black over its window (§7.17 empty 条目; plan policy emptyFill black)', async () => {
    const recipe = chunk({ start: 48, end: 50 }, [span(r(8, 5), r(48, 25), r(48, 25), r(49, 25)), { kind: 'empty', fill: 'black', window: { start: r(49, 25), end: r(2) } }]);
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [recipe]);
    const list = await packets(file!);
    expect(list.map(packet => [Number(packet.pts_time), Number(packet.duration_time)])).toEqual([[0, 0.04], [0.04, 0.04]]);
    const [real, empty] = await lumaMeans(file!);
    expect(empty).toBeLessThan(20);
    expect(real).toBeGreaterThan(40);
  });

  it('CE07 holds the last real frame to its span end (§7.17 hold 落在末个真实帧上)', async () => {
    const recipe = chunk({ start: 45, end: 50 }, [span(r(8, 5), r(9, 5), r(9, 5), r(3))]);
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [recipe]);
    const list = await packets(file!);
    expect(list.map(packet => Number(packet.pts_time))).toEqual([0, 0.04, 0.08, 0.12, 0.16]);
    expect(Number(list[4]!.duration_time)).toBeCloseTo(1.04, 6);
  });

  it('CE08 packs an alpha source premultiplied colour left and alpha right on even planes (§3.5 alpha-packed; alpha-presentation.ts packing)', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 128, height: 36, alpha: 'packed' });
    const [file] = await produce({ [SOURCE]: join(dir, 'alpha.mov') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 128, 36]);
    // The right plane is the alpha as grey: 64, read back through a full-range grey conversion.
    for (const mean of await lumaMeans(file!, { x: 64, y: 0, width: 64, height: 36 })) expect(Math.abs(mean - 64)).toBeLessThan(6);
  });
});

describe('stitch (§5.4 块的时间、拼接)', () => {
  /**
   * Encode the two chunks of the 2 s source and stitch them.
   * @param second - The second chunk recipe.
   * @param stitchOf - Extra stitch fields.
   * @returns The stitched file.
   */
  async function chunkAndStitch(second: Recipe, stitchOf: Recipe): Promise<string> {
    const [a, b] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [FIRST, second]);
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4'), [CHUNKS[0]!]: a!, [CHUNKS[1]!]: b! },
      [{ kind: 'stitch', inputId: SOURCE, target: TARGET, ...stitchOf }]);
    return file!;
  }

  it('ST01 concatenates the chunks without re-encoding: every frame on the plan clock, keyframes at the chunk starts, tags kept, audio merged at 48 kHz', async () => {
    const file = await chunkAndStitch(SECOND, { chunks: [{ inputId: CHUNKS[0], duration: r(4, 5) }, { inputId: CHUNKS[1], duration: r(6, 5) }], audio: { start: r(0), end: r(2) } });
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

  it('ST02 carries no audio when the recipe has none', async () => {
    const file = await chunkAndStitch(SECOND, { chunks: [{ inputId: CHUNKS[0], duration: r(4, 5) }, { inputId: CHUNKS[1], duration: r(6, 5) }], audio: null });
    expect((await probe(file)).streams.map(stream => stream.codec_type)).toEqual(['video']);
  });

  it('ST03 writes each chunk for its plan duration, so a held last frame keeps its window', async () => {
    const held = chunk({ start: 20, end: 50 }, [span(r(4, 5), r(4, 5), r(4, 5), r(3))]);
    const file = await chunkAndStitch(held, { chunks: [{ inputId: CHUNKS[0], duration: r(4, 5) }, { inputId: CHUNKS[1], duration: r(11, 5) }], audio: null });
    const list = await packets(file);
    expect(list).toHaveLength(50);
    expect(Number(list[49]!.pts_time)).toBeCloseTo(1.96, 6);
    expect(Number(list[49]!.pts_time) + Number(list[49]!.duration_time)).toBeCloseTo(3, 6);
  });

  // §91 D3-3: the stitch reports the packed carrier and its packed geometry; the presentation DO writes the manifest after
  // measuring the carrier (design §3.5 bundle assembly) and records it as `role: 'manifest'`, so the container writes no manifest.
  it('ST04 a packed chunk stitches into a packed carrier of the same geometry and reports that geometry', async () => {
    const packed = { ...TARGET, width: 128, height: 36, alpha: 'packed' };
    const [a] = await produce({ [SOURCE]: join(dir, 'alpha.mov') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], packed)]);
    const [file] = await produce({ [SOURCE]: join(dir, 'alpha.mov'), [CHUNKS[0]!]: a! },
      [{ kind: 'stitch', inputId: SOURCE, target: packed, chunks: [{ inputId: CHUNKS[0], duration: r(2, 5) }], audio: null }]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 128, 36]);
    expect(await packets(file!)).toHaveLength(10);
    expect(reports[0]!.outputs).toHaveLength(1);
    expect(reports[0]!.outputs[0]!.packing).toEqual({ packedWidth: 128, packedHeight: 36, colorRect: { x: 0, y: 0, width: 64, height: 36 }, alphaRect: { x: 64, y: 0, width: 64, height: 36 } });
  });
});

describe('copy_carrier and prepare_model_input', () => {
  it('CC01 copies the stream and tags the plan matrix (§4.1 简单稳定输入, §91 D2 copy rule on standard-4)', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'untagged.mp4') }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt601' }]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.width, video.height, video.color_space]).toEqual(['h264', 320, 180, 'smpte170m']);
    expect((await packets(file!)).map(packet => packet.pts_time)).toEqual((await packets(join(dir, 'untagged.mp4'))).map(packet => packet.pts_time));
  });

  /**
   * A prepare_model_input recipe over the source's first 20 frames.
   * @param target - Its target block.
   * @param audio - Its audio interval.
   * @returns The recipe.
   */
  function modelInput(target: Recipe, audio: { start: Exact; end: Exact } | null): Recipe {
    return { kind: 'prepare_model_input', inputId: SOURCE, window: { start: 0, end: 20 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(4, 5))], target, audio };
  }

  it('PM01 renders the selected interval upright in the display geometry with the plan matrix and the interval audio (§5.3 模型输入准备)', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'rot90.mp4') }, [modelInput({ ...TARGET, width: 180, height: 320 }, { start: r(0), end: r(4, 5) })]);
    const { streams } = await probe(file!);
    const video = streams.find(stream => stream.codec_type === 'video')!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 180, 320]);
    expect((video.side_data_list ?? []).filter(side => side.side_data_type === 'Display Matrix' && (side.rotation ?? 0) !== 0)).toEqual([]);
    expectBt709(video);
    expect(await packets(file!)).toHaveLength(20);
    // §91 D3-4: a source with audio carries the selected interval's audio, AAC at 48 kHz.
    const audio = streams.filter(stream => stream.codec_type === 'audio');
    expect(audio.map(stream => [stream.codec_name, stream.sample_rate])).toEqual([['aac', '48000']]);
    expect(Math.abs(Number(audio[0]!.duration) - 0.8)).toBeLessThanOrEqual(1024 / 48000);
  });

  it('PM02 pads an odd display size to even with the picture at displayRect, never cropping it (§5.3 保留映射及所有真实内容; §91 D3-4)', async () => {
    const recipe = modelInput({ ...TARGET, width: 162, height: 98, displayRect: { x: 0, y: 0, width: 161, height: 97 } }, null);
    const [file] = await produce({ [SOURCE]: join(dir, 'odd.mp4') }, [{ ...recipe, window: { start: 0, end: 10 }, entries: [span(r(0), r(0), r(0), r(2, 5))] }]);
    const { streams } = await probe(file!);
    expect(streams.map(stream => [stream.codec_type, stream.codec_name, stream.width, stream.height])).toEqual([['video', 'h264', 162, 98]]);
    // The whole 161x97 picture is kept: its last column and row are still white.
    expect(Math.min(...await lumaMeans(file!, { x: 0, y: 0, width: 161, height: 97 }))).toBeGreaterThan(200);
    expect(Math.min(...await lumaMeans(file!, { x: 160, y: 0, width: 1, height: 96 }))).toBeGreaterThan(200);
  });
});
