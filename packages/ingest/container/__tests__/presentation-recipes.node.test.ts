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
import { resolveVideoColorMatrix } from '@ingest/container/physical-video-probe.js';
import { packedCarrierWidth } from '@shared/mini-tools/video-encode-plan.js';
import { coverArgs, coverDecoderArgs, probeArgs, readProbeOutput } from '@ingest/probe-command.js';

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
 * The BT.709 limited-range Y, U and V of a file's first frame after a filter chain, from its mean RGB by the BT.709 formula
 * (the chain's own RGB to 4:2:0 conversion is not used: FFmpeg 7.1 converts it with an ambiguous range).
 * @param path - The file.
 * @param chain - A filter chain whose output is RGB.
 * @returns The three plane values.
 */
async function bt709Of(path: string, chain: string): Promise<{ y: number; u: number; v: number }> {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-vf', `${chain},format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = stdout as unknown as Buffer;
  const [red, green, blue] = [0, 1, 2].map(channel => bytes.filter((_value, index) => index % 3 === channel).reduce((sum, value) => sum + value, 0) / (bytes.length / 3) / 255) as [number, number, number];
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return { y: 16 + 219 * luma, u: 128 + 224 * (blue - luma) / 1.8556, v: 128 + 224 * (red - luma) / 1.5748 };
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
  // No B-frames (here and in pq10.mp4): with them libx264's edit list skips the composition delay and media time starts at
  // 0.08 s, which these cases (copy tags, tone mapping, an audio-less stitch) are not about.
  await make('untagged.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p']);
  await make('pq10.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  // Odd display size: H.264 High 4:4:4 holds 161x97 natively (§4.3 奇数宽高); the picture is white so the padding stands apart.
  await make('odd.mp4', ['-f', 'lavfi', '-i', 'color=c=white:s=161x97:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', ...tagged]);
  await make('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'cfr.mp4'), '-c', 'copy']);
  // The dispatched copy's source (§93 D8): cfr.mp4's picture with ALAC audio, which the MP4 entry's audio_codecs does not
  // list. 2 s of 44.1 kHz audio (88200 samples), one edit from media time 0 on both tracks.
  // Opaque everywhere, saturated green on its last eight columns: the packed planes' seam shows any chroma bleeding (CE24).
  await make('banner.mov', ['-f', 'lavfi', '-i', "color=c=white:s=64x36:r=25:d=0.4,format=rgba,geq=r='if(gte(X\\,56)\\,0\\,255)':g='255':b='if(gte(X\\,56)\\,0\\,255)':a='255'", '-c:v', 'png']);
  await make('alac.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-f', 'lavfi', '-i', 'sine=f=1000:r=44100:d=2',
    '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25', '-c:a', 'alac', '-shortest']);
  // Straight alpha of 64 over the whole picture, lossless PNG in QuickTime.
  // Ten frames at 25 fps, each a different grey (limited-range luma 16 + 20n), keyframes at frames 0 and 5.
  await make('greys.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x36:r=25:d=0.4,format=yuv420p,geq=lum='16+20*N':cb=128:cr=128",
    '-c:v', 'libx264', '-g', '5', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25']);
  // A flat grey patch in PQ BT.2020 10-bit: tone mapping gives RGB 152 (stored Y about 146), a plain matrix conversion Y about 123.
  await make('pq-patch.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=64x36:r=25:d=0.4', '-vf', 'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
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
  // HDR whose stream leaves the matrix unspecified (only primaries and transfer set), and one with the transfer alone.
  const patch = ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4', '-vf',
    'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le,setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le'];
  await make('pq-nomatrix.mp4', [...patch, '-x264-params', 'colorprim=bt2020:transfer=smpte2084']);
  await make('hlg-trconly.mp4', [...patch, '-x264-params', 'transfer=arib-std-b67']);
  // Lossless PQ twins: the odd source is the even one's decoded frames cropped exactly, so their samples are the same.
  await make('pq-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-vf',
    'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'ffv1']);
  await make('pq-odd.mkv', ['-i', join(dir, 'pq-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  // SDR twins in 4:2:0 and 4:4:4 (CE20, CE21).
  for (const format of ['yuv420p', 'yuv444p']) {
    await make(`sdr-${format}-even.mkv`, ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-vf', `format=${format},setparams=colorspace=bt709:range=tv`, '-c:v', 'ffv1']);
    await make(`sdr-${format}-odd.mkv`, ['-i', join(dir, `sdr-${format}-even.mkv`), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  }
  // 60 fps H.264 with a white frame 60 (1 s) and 1.9 s of sound encoded straight into Matroska: its priming lies before 0.
  const primed = (codec: string): string[] => ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=60:d=2,format=yuv420p,geq=lum='if(eq(N\\,60)\\,235\\,16)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=d=1.9', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-c:a', codec];
  // Sources whose clock starts after 0: video-only VP9 from 0.5 s, and VP9 with 1.5 s of Opus from 10 s (CC05).
  await make('late-video.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-c:v', 'libvpx-vp9', '-output_ts_offset', '0.5']);
  await make('late-opus.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=1.5', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-output_ts_offset', '10']);
  await make('primed-aac60.mkv', primed('aac'));
  await make('primed-mp3-60.mkv', primed('libmp3lame'));
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
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

// §91 D3b-11: the audio of cfr.mp4 (and rot90.mp4, its stream copy) as the probe's plan records it: one edit skipping the
// AAC priming, 2000 of movie timescale 1000 from media time 1024 of 44100.
const CFR_AUDIO = { origin: r(0), spans: [{ sourceStart: r(256, 11025), sourceEnd: r(22306, 11025), presentationStart: r(0), rate: r(1) }] };

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

  it.each(['alpha.mov', 'alpha.webm'])('CE08 packs an alpha source premultiplied colour left and alpha right on even planes (§3.5 alpha-packed; alpha-presentation.ts packing): %s', async (name) => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' });
    const [file] = await produce({ [SOURCE]: join(dir, name) }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.pix_fmt, video.width, video.height]).toEqual(['h264', 'yuv420p', 132, 36]);
    // The right plane, after the 4-column gap, is the alpha as grey: 64 stored as limited-range luma 16 + 64 * 219 / 255 ≈ 71.
    for (const mean of await lumaMeans(file!, { x: 68, y: 0, width: 64, height: 36 })) expect(Math.abs(mean - 71)).toBeLessThan(6);
  });

  // An RGB-coded source (PNG in MOV) packs with the matrix its own plan resolves; the scaler converts RGB frames with no
  // input matrix, so the packed picture is the same whatever that matrix is.
  it('CE22 an RGB-coded alpha source packs with its plan matrix, its picture independent of it', async () => {
    const source = join(dir, 'alpha.mov');
    const planMatrix = resolveVideoColorMatrix((await probe(source)).streams[0] as unknown as Record<string, unknown>);
    const packed = async (colorMatrix: string): Promise<number[]> =>
      lumaMeans((await produce({ [SOURCE]: source }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, colorMatrix, width: packedCarrierWidth(64), height: 36, alpha: 'packed' })]))[0]!);
    const [own, bt709, bt601] = [await packed(planMatrix), await packed('bt709'), await packed('bt601')];
    expect(own).toEqual(bt709);
    expect(bt601).toEqual(bt709);
  });

  // A browser upsamples 4:2:0 chroma across neighbouring samples (Chrome 157 read up to 20% wrong alpha in the alpha plane's
  // first column and a washed-out last colour column when the planes touched). The chroma sample before the alpha plane is
  // neutral and the one after the colour plane's edge repeats that edge, whatever two samples the upsampler mixes.
  it('CE24 the packed planes are kept apart: neutral chroma before the alpha plane, the colour edge repeated after its plane', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'banner.mov') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' })]);
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

  // SMPTE 240M and FCC sources decode with their own matrix.
  it.each(['smpte240m', 'fcc'])('CE23 a %s plan decodes', async (colorMatrix) => {
    await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, colorMatrix })]);
  });

  // An edit that starts inside a source frame keeps that frame, shown from clipStart (design §7.17 时间线「被剪辑起点截去一部分的帧保留」;
  // D1 CT04 「the first kept partially」). §5.4 cuts chunks only at presented-frame boundaries, so a chunk window never starts
  // mid-frame; a partial frame exists only where a span starts mid-frame, as the first entry (CE09) or a later one (CE10).
  it('CE09 a span whose clipStart is inside a source frame shows that frame from pts 0 until its source end', async () => {
    const recipe = { ...chunk({ start: 0, end: 4 }, [span(r(1, 5), r(13, 50), r(0), r(7, 50))]), timescale: 50 };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4') }, [recipe]);
    const list = await packets(file!);
    expect(list.map(packet => [Number(packet.pts_time), Number(packet.duration_time)])).toEqual([[0, 0.02], [0.02, 0.04], [0.06, 0.04], [0.1, 0.04]]);
    const [source, encoded] = [await lumaMeans(join(dir, 'greys.mp4')), await lumaMeans(file!)];
    expect(encoded).toHaveLength(4);
    encoded.forEach((mean, n) => expect(Math.abs(mean - source[6 + n]!)).toBeLessThan(5));
  });

  it('CE10 a later span starting inside a source frame keeps that frame from its clipStart', async () => {
    const recipe = { ...chunk({ start: 0, end: 6 }, [span(r(0), r(0), r(0), r(2, 25)), span(r(1, 5), r(13, 50), r(2, 25), r(11, 50))]), timescale: 50 };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4') }, [recipe]);
    const list = await packets(file!);
    expect(list.map(packet => [Number(packet.pts_time), Number(packet.duration_time)])).toEqual([[0, 0.04], [0.04, 0.04], [0.08, 0.02], [0.1, 0.04], [0.14, 0.04], [0.18, 0.04]]);
    const [source, encoded] = [await lumaMeans(join(dir, 'greys.mp4')), await lumaMeans(file!)];
    expect(encoded).toHaveLength(6);
    [0, 1, 6, 7, 8, 9].forEach((frame, n) => expect(Math.abs(encoded[n]! - source[frame]!)).toBeLessThan(5));
  });

  it('CE16 a Matroska span decoding from its keyframe\'s block time starts on that keyframe\'s frame', async () => {
    // Frame 25 is the second keyframe, at 1 s: the probe gives its block time as its decode position.
    const recipe = { ...chunk({ start: 25, end: 30 }, [span(r(1), r(1), r(1), r(6, 5))]), timescale: 25 };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys-bframes.mkv') }, [recipe]);
    expect((await lumaMeans(file!)).map((mean) => Math.round((mean - 16) / 3))).toEqual([25, 26, 27, 28, 29]);
  });

  // A picture that starts 0.3 s late holds its first frame from 0 as derived-lead (§7.17 timeline row): the worker gives that
  // frame its own entry at rate 1/9 (0.34 s of display over at most 0.04 s of source), which keeps the next frames out of it.
  it('CE14 a derived-lead first frame at rate 1/9 fills the lead alone, and the frames after it follow at their own times', async () => {
    const recipe = { ...chunk({ start: 0, end: 4 }, [{ ...span(r(0), r(0), r(0), r(17, 50)), rate: r(1, 9) }, span(r(0), r(1, 25), r(17, 50), r(23, 50))]), timescale: 50 };
    const [file] = await produce({ [SOURCE]: join(dir, 'greys.mp4') }, [recipe]);
    const list = await packets(file!);
    expect(list.map(packet => [Number(packet.pts_time), Number(packet.duration_time)])).toEqual([[0, 0.34], [0.34, 0.04], [0.38, 0.04], [0.42, 0.04]]);
    const [source, encoded] = [await lumaMeans(join(dir, 'greys.mp4')), await lumaMeans(file!)];
    expect(encoded).toHaveLength(4);
    [0, 1, 2, 3].forEach((frame, n) => expect(Math.abs(encoded[n]! - source[frame]!)).toBeLessThan(5));
  });

  // FFmpeg filter time bases are int rationals: settb would clamp a 1/2^31 clock to 1/(2^31 − 1) and move every frame.
  it('CE15 a chunk on a clock past 2^31 − 1 ticks per second fails with that reason instead of encoding moved frames', async () => {
    const recipe = { ...chunk({ start: 0, end: 2 }, [span(r(0), r(0), r(0), r(2, 25))]), timescale: 2 ** 31 };
    const { report } = await runJob({ [SOURCE]: join(dir, 'greys.mp4') }, [recipe]);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).toContain('time base range');
  });

  // §4.3 HDR row: the carrier is the D05 chain's picture with BT.709 tags; the reference is that chain run here on the same source.
  it('CE11 the tone-mapped picture is the §4.3 chain\'s picture, not a plain matrix conversion', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 64, height: 36, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' });
    const [file] = await produce({ [SOURCE]: join(dir, 'pq-patch.mp4') }, [recipe]);
    const source = join(dir, 'pq-patch.mp4');
    const chained = await bt709Of(source, 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    const plain = await planes(source, 'scale=in_color_matrix=bt2020:out_color_matrix=bt709:out_range=tv,format=yuv420p');
    expect(planeGap(chained, plain)).toBeGreaterThan(15);
    expect(planeGap(await planes(file!), chained)).toBeLessThan(3);
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

  // §4.3 odd-size row: an odd VP9 output is subsampled where its even twin is, so its chroma planes match the twin's.
  it.each(['yuv420p', 'yuv444p'])('CE20 an odd-sized %s source gives an odd VP9 output whose chroma lies where the even twin\'s does', async (format) => {
    const vp9 = (width: number, height: number): Recipe => chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width, height, format: 'webm-vp9' });
    const [odd] = await produce({ [SOURCE]: join(dir, `sdr-${format}-odd.mkv`) }, [vp9(159, 95)]);
    const [even] = await produce({ [SOURCE]: join(dir, `sdr-${format}-even.mkv`) }, [vp9(160, 96)]);
    for (const plane of ['u', 'v'] as const) {
      const gap = await chromaGap(odd!, even!, plane);
      expect(gap, plane).toBeLessThan(1);
    }
  });

  it('CE12 rewrites a BT.601-tagged source\'s tags to BT.709 (§4.3 载体与输出一律显式写标签)', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, colorMatrix: 'bt601' });
    const [file] = await produce({ [SOURCE]: join(dir, 'tagged601.mp4') }, [recipe]);
    expectBt709((await probe(file!)).streams[0]!);
  });

  it('CE13 decodes an untagged source with the plan\'s matrix, not the decoder default (§4.3 工具解码显式传 in_color_matrix)', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 64, height: 36, colorMatrix: 'bt709' });
    const [file] = await produce({ [SOURCE]: join(dir, 'red-untagged.mp4') }, [recipe]);
    const source = join(dir, 'red-untagged.mp4');
    const stored = await planes(source);
    const byDefault = await planes(source, 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p');
    expect(planeGap(stored, byDefault)).toBeGreaterThan(5);
    // BT.709 in and BT.709 out keeps the stored planes.
    expect(planeGap(await planes(file!), stored)).toBeLessThan(3);
  });

  // §4.3 colour/HDR row: an untagged matrix decodes with the plan's matrix, through the tone map as everywhere else.
  it('CE17 tone maps an HDR source whose matrix is untagged with the plan\'s matrix', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 64, height: 36, colorMatrix: 'bt601', toneMap: 'sdr-bt709' });
    expect((await probe(join(dir, 'pq-nomatrix.mp4'))).streams[0]).toMatchObject({ color_transfer: 'smpte2084', color_primaries: 'bt2020' });
    expect((await probe(join(dir, 'pq-nomatrix.mp4'))).streams[0]!.color_space ?? 'unknown').toBe('unknown');
    const [file] = await produce({ [SOURCE]: join(dir, 'pq-nomatrix.mp4') }, [recipe]);
    const chained = await bt709Of(join(dir, 'pq-nomatrix.mp4'), 'zscale=min=170m:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    expect(planeGap(await planes(file!), chained)).toBeLessThan(3);
  });

  // §4.3 colour/HDR row: untagged primaries are BT.709, as Chromium reads them.
  it('CE18 tone maps an HDR source tagged with its transfer alone, its primaries read as BT.709', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, width: 64, height: 36, colorMatrix: 'bt601', toneMap: 'sdr-bt709' });
    const stream = (await probe(join(dir, 'hlg-trconly.mp4'))).streams[0]!;
    expect([stream.color_transfer, stream.color_primaries ?? 'unknown', stream.color_space ?? 'unknown']).toEqual(['arib-std-b67', 'unknown', 'unknown']);
    const [file] = await produce({ [SOURCE]: join(dir, 'hlg-trconly.mp4') }, [recipe]);
    const chained = await bt709Of(join(dir, 'hlg-trconly.mp4'), 'zscale=min=170m:pin=709:p=709:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    expect(planeGap(await planes(file!), chained)).toBeLessThan(3);
  });

  // §4.3 odd-size and colour/HDR rows: an odd 4:2:0 HDR source keeps its size, its picture that of the even twin.
  it('CE19 tone maps an odd-sized 4:2:0 HDR source into an odd-sized VP9 output, each pixel as the even twin\'s D05 picture', async () => {
    const recipe = chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))],
      { ...TARGET, width: 159, height: 95, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709', format: 'webm-vp9' });
    expect((await probe(join(dir, 'pq-odd.mkv'))).streams[0]).toMatchObject({ width: 159, height: 95, pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' });
    const [file] = await produce({ [SOURCE]: join(dir, 'pq-odd.mkv') }, [recipe]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.width, video.height]).toEqual([159, 95]);
    // The output's luma plane holds the same samples as the even twin's, so it is compared sample by sample with the twin's
    // D05 picture in the output's BT.709; lossy VP9 keeps the mean near its coding error.
    const reference = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p';
    const twin = await plane8(join(dir, 'pq-even.mkv'), `${reference},extractplanes=y,crop=159:95:0:0`);
    const encoded = await plane8(file!, 'extractplanes=y');
    expect(encoded.length).toBe(twin.length);
    expect(encoded.reduce((sum, value, index) => sum + Math.abs(value - twin[index]!), 0) / twin.length).toBeLessThan(1);
    const [even] = await produce({ [SOURCE]: join(dir, 'pq-even.mkv') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))],
      { ...TARGET, width: 160, height: 96, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709', format: 'webm-vp9' })]);
    for (const plane of ['u', 'v'] as const) expect(await chromaGap(file!, even!, plane), plane).toBeLessThan(1);
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
    const file = await chunkAndStitch(SECOND, { chunks: [{ inputId: CHUNKS[0], duration: r(4, 5) }, { inputId: CHUNKS[1], duration: r(6, 5) }], audio: { start: r(0), end: r(2), ...CFR_AUDIO } });
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
  it('ST05 places each chunk for its plan duration even when the chunk file\'s own duration differs (§5.4 concat duration)', async () => {
    // The first chunk file lasts 0.8 s; its plan duration is 0.84 s, so the second chunk starts at 0.84.
    const file = await chunkAndStitch(SECOND, { chunks: [{ inputId: CHUNKS[0], duration: r(21, 25) }, { inputId: CHUNKS[1], duration: r(6, 5) }], audio: null });
    const list = await packets(file);
    expect(list.map(packet => Number(packet.pts_time))).toEqual(Array.from({ length: 50 }, (_unused, n) => (n < 20 ? n : n + 1) / 25));
  });

  // §91 D3b-2: the plan does not record whether the source has audio, so the worker always names the interval and the
  // container muxes the source's first audio stream only when there is one.
  it('ST06 a source without audio stitches the interval into a video-only carrier and does not fail', async () => {
    const [a] = await produce({ [SOURCE]: join(dir, 'untagged.mp4') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], { ...TARGET, colorMatrix: 'bt601' })]);
    const [file] = await produce({ [SOURCE]: join(dir, 'untagged.mp4'), [CHUNKS[0]!]: a! },
      [{ kind: 'stitch', inputId: SOURCE, target: { ...TARGET, colorMatrix: 'bt601' }, chunks: [{ inputId: CHUNKS[0], duration: r(2, 5) }], audio: { start: r(0), end: r(2, 5), origin: r(0), spans: null } }]);
    expect((await probe(file!)).streams.map(stream => stream.codec_type)).toEqual(['video']);
    expect(await packets(file!)).toHaveLength(10);
  });

  // inner#1306 test plan §97 D15 (frames-split §5.4 拼接 row): before joining, the stitch compares every chunk's codec
  // headers (H.264 avcC/SPS/PPS) and fails that output when they differ. A second chunk encoded with another preset has
  // other SPS/PPS (reference frames, entropy coding), so stream copy would join two incompatible streams.
  it('ST07 refuses to stitch chunks whose codec headers differ', async () => {
    const [a, b] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [FIRST, { ...SECOND, target: { ...TARGET, preset: 'ultrafast' } }]);
    const { report } = await runJob({ [SOURCE]: join(dir, 'cfr.mp4'), [CHUNKS[0]!]: a!, [CHUNKS[1]!]: b! },
      [{ kind: 'stitch', inputId: SOURCE, target: TARGET, chunks: [{ inputId: CHUNKS[0], duration: r(4, 5) }, { inputId: CHUNKS[1], duration: r(6, 5) }], audio: null }]);
    expect(report.ok).toBe(false);
    expect(report.outputs).toEqual([]);
  });

  it('ST04 a packed chunk stitches into a packed carrier of the same geometry and reports that geometry', async () => {
    const packed = { ...TARGET, width: packedCarrierWidth(64), height: 36, alpha: 'packed' };
    const [a] = await produce({ [SOURCE]: join(dir, 'alpha.mov') }, [chunk({ start: 0, end: 10 }, [span(r(0), r(0), r(0), r(2, 5))], packed)]);
    const [file] = await produce({ [SOURCE]: join(dir, 'alpha.mov'), [CHUNKS[0]!]: a! },
      [{ kind: 'stitch', inputId: SOURCE, target: packed, chunks: [{ inputId: CHUNKS[0], duration: r(2, 5) }], audio: null }]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.width, video.height]).toEqual(['h264', 132, 36]);
    expect(await packets(file!)).toHaveLength(10);
    expect(reports[0]!.outputs).toHaveLength(1);
    expect(reports[0]!.outputs[0]!.packing).toEqual({ packedWidth: 132, packedHeight: 36, colorRect: { x: 0, y: 0, width: 64, height: 36 }, alphaRect: { x: 68, y: 0, width: 64, height: 36 } });
  });
});

describe('copy_carrier and prepare_model_input', () => {
  it('CC01 copies the stream and tags the plan matrix (§4.1 简单稳定输入, §91 D2 copy rule on standard-4)', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'untagged.mp4') }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt601', origin: r(0), audio: null }]);
    const video = (await probe(file!)).streams[0]!;
    expect([video.codec_name, video.width, video.height, video.color_space]).toEqual(['h264', 320, 180, 'smpte170m']);
    expect((await packets(file!)).map(packet => packet.pts_time)).toEqual((await packets(join(dir, 'untagged.mp4'))).map(packet => packet.pts_time));
  });

  /**
   * Every packet of one stream in stored order: its times, size, flags and payload MD5, as ffprobe reads them.
   * @param path - The file.
   * @param stream - The stream specifier.
   * @returns One line per packet.
   */
  async function packetList(path: string, stream: string): Promise<string[]> {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_packets', '-show_data_hash', 'md5',
      '-show_entries', 'packet=pts_time,dts_time,duration_time,size,flags,data_hash', '-of', 'csv=p=0', path]);
    return stdout.trim().split('\n');
  }

  /**
   * One stream's sample rate, start, duration in its own ticks and time base.
   * @param path - The file.
   * @param stream - The stream specifier.
   * @returns Its fields as ffprobe prints them.
   */
  async function streamClock(path: string, stream: string): Promise<{ codec_name: string; sample_rate?: string; start_time: string; duration_ts: number; time_base: string }> {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=codec_name,sample_rate,start_time,duration_ts,time_base', '-of', 'json', path]);
    return (JSON.parse(stdout) as { streams: { codec_name: string; sample_rate?: string; start_time: string; duration_ts: number; time_base: string }[] }).streams[0]!;
  }

  // §93 D8 (frames-split design §4.1 row 2, §4.2 sample grid, §4.3 audio row, §5.1 step 2; round 2, user 2026-11-04): the
  // dispatched copy keeps every video packet as it is and encodes the selected audio, over the plan's audio window, to AAC
  // at 48 kHz in the same MP4. The audio's declared support lies on the 48 kHz grid, at most half a sample from the
  // source's exact end (§4.2: av_rescale rounding), and both streams keep the source's start. §94 D8 (design §7.17
  // copy_carrier row): audio outside identity_formats is `{ kind: 'encode', ...audioOf entries }`, the stitch's interval
  // with the plan's origin and audio spans.
  it('CC02 an ALAC source: every video packet kept byte for byte, the audio encoded to AAC 48 kHz over the same timeline', async () => {
    const source = join(dir, 'alac.mp4');
    const audio = { start: r(0), end: r(2), origin: r(0), spans: [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(0), rate: r(1) }] };
    const [file] = await produce({ [SOURCE]: source }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt709', origin: r(0), audio: { kind: 'encode', ...audio } }]);
    expect((await probe(file!)).streams.map(stream => stream.codec_type)).toEqual(['video', 'audio']);
    expect(await packetList(file!, 'v:0')).toEqual(await packetList(source, 'v:0'));
    const [sourceVideo, sourceAudio, video, carried] = await Promise.all([streamClock(source, 'v:0'), streamClock(source, 'a:0'), streamClock(file!, 'v:0'), streamClock(file!, 'a:0')]);
    expect([carried.codec_name, carried.sample_rate, carried.time_base]).toEqual(['aac', '48000', '1/48000']);
    expect([video.start_time, carried.start_time]).toEqual([sourceVideo.start_time, sourceAudio.start_time]);
    const sourceSeconds = sourceAudio.duration_ts / Number(sourceAudio.sample_rate);
    expect(Math.abs(carried.duration_ts / 48000 - sourceSeconds)).toBeLessThanOrEqual(1 / 96000);
  });

  // The copy writes the plan's matrix as the stream's tag (H.264 matrix_coefficients 7 and 4).
  it.each(['smpte240m', 'fcc'])('CC06 a %s plan is tagged on the copy', async (colorMatrix) => {
    const [file] = await produce({ [SOURCE]: join(dir, 'cfr.mp4') }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix, origin: r(0), audio: null }]);
    expect((await probe(file!)).streams.find((stream) => stream.codec_type === 'video')?.color_space).toBe(colorMatrix);
  });

  // §4.2 effective audio, §4.1 row 2: FFmpeg's Matroska muxer puts AAC and MP3 priming before time 0; the copies keep every
  // packet time, so the picture starts where the plan starts it (the white frame 60 at 1 s at 60 fps) and the priming stays
  // unpresented, both for the copy audio and the encoded audio.
  it.each([['primed-aac60.mkv', 'copy'], ['primed-mp3-60.mkv', 'encode']] as const)('CC04 %s with %s audio: the copy keeps packet times, its white frame at 1 s', async (name, kind) => {
    const source = join(dir, name);
    const audio = kind === 'copy' ? { kind } : { kind, start: r(0), end: r(19, 10), origin: r(0), spans: null };
    const [file] = await produce({ [SOURCE]: source }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt709', origin: r(0), audio }]);
    const video = await streamClock(file!, 'v:0');
    expect(Number(video.start_time)).toBe(0);
    const { stdout: times } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file!]);
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file!, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', 'extractplanes=y,scale=1:1:flags=area', '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
    const white = [...(stdout as unknown as Buffer)].findIndex(level => level > 128);
    expect(Number(times.trim().split('\n')[white])).toBeCloseTo(1, 6);
  });

  // §7.16 start row, §4.2.1 leading row: the plan's 0 is the source's origin, so the copies start there for picture and sound.
  it.each([['late-video.webm', r(1, 2), null], ['late-opus.webm', r(10), 'encode']] as const)('CC05 %s: the copy starts at the plan origin, picture and sound at 0', async (name, origin, kind) => {
    const audio = kind === null ? null : { kind, start: r(0), end: r(3, 2), origin, spans: null };
    const [file] = await produce({ [SOURCE]: join(dir, name) }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt709', origin, audio }]);
    expect(Math.abs(Number((await streamClock(file!, 'v:0')).start_time))).toBeLessThan(0.001);
    if (kind !== null) expect(Math.abs(Number((await streamClock(file!, 'a:0')).start_time))).toBeLessThan(0.03);
  });

  // §94 D8 (design §7.17 copy_carrier row, §4.3 audio row): audio inside identity_formats, here an AAC source dispatched
  // only because twice its size outgrows the basic disk, is `{ kind: 'copy' }`: every packet of both streams kept.
  it('CC03 an AAC source dispatched for its size: every video and audio packet kept byte for byte', async () => {
    const source = join(dir, 'cfr.mp4');
    const [file] = await produce({ [SOURCE]: source }, [{ kind: 'copy_carrier', inputId: SOURCE, colorMatrix: 'bt709', origin: r(0), audio: { kind: 'copy' } }]);
    expect((await probe(file!)).streams.map(stream => stream.codec_type)).toEqual(['video', 'audio']);
    expect(await packetList(file!, 'v:0')).toEqual(await packetList(source, 'v:0'));
    expect(await packetList(file!, 'a:0')).toEqual(await packetList(source, 'a:0'));
    const [sourceVideo, sourceAudio, video, carried] = await Promise.all([streamClock(source, 'v:0'), streamClock(source, 'a:0'), streamClock(file!, 'v:0'), streamClock(file!, 'a:0')]);
    expect([carried.codec_name, carried.sample_rate]).toEqual(['aac', '44100']);
    expect([video.start_time, carried.start_time]).toEqual([sourceVideo.start_time, sourceAudio.start_time]);
  });

  /**
   * A prepare_model_input recipe over the source's first 20 frames.
   * @param target - Its target block.
   * @param audio - Its audio interval.
   * @returns The recipe.
   */
  function modelInput(target: Recipe, audio: Recipe | null): Recipe {
    return { kind: 'prepare_model_input', inputId: SOURCE, window: { start: 0, end: 20 }, timescale: 25, entries: [span(r(0), r(0), r(0), r(4, 5))], target, audio };
  }

  it('PM01 renders the selected interval upright in the display geometry with the plan matrix and the interval audio (§5.3 模型输入准备)', async () => {
    const [file] = await produce({ [SOURCE]: join(dir, 'rot90.mp4') }, [modelInput({ ...TARGET, width: 180, height: 320 }, { start: r(0), end: r(4, 5), ...CFR_AUDIO })]);
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

  // §91 D3b mutation C6 (D3b-2): the model input's counterpart of ST06.
  it('PM03 a source without audio and an audio interval prepares a video-only model input and does not fail', async () => {
    const recipe = { ...modelInput({ ...TARGET, colorMatrix: 'bt601' }, { start: r(0), end: r(2, 5), origin: r(0), spans: null }), window: { start: 0, end: 10 }, entries: [span(r(0), r(0), r(0), r(2, 5))] };
    const [file] = await produce({ [SOURCE]: join(dir, 'untagged.mp4') }, [recipe]);
    expect((await probe(file!)).streams.map(stream => stream.codec_type)).toEqual(['video']);
    expect(await packets(file!)).toHaveLength(10);
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
