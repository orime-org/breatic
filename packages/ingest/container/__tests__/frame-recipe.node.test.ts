// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D4-3: the `frame` recipe on the full ledger (inner#1306 test plan §92 D4-3; frames-split design §7.17 frame row and
 * 方向与几何 row, §4.3 色彩/HDR/位深 row; W7).
 *
 * The recipe carries one D3-style entry the worker wrote from the full ledger (a source span whose clipStart is the
 * frame's own source time, decodeStart its first frame, §91 W7; or a derived-empty `{ kind: 'empty', fill, window }`) and a
 * target: display geometry, the plan's matrix and tone mapping, the PNG bit depth (16 when the source is deeper than 8 bits)
 * and whether the picture keeps its alpha. The container never reads a frame table and never uses a presentation ordinal
 * as a decode index. Every fixture is generated here; assertions are facts FFmpeg and the PNG header read back.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { writePixelCropped } from './helpers/matroska-pixel-crop.js';

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
const q = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const OPAQUE = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };

// Display transforms of the odd SDR source (FC14).
const TURNS: readonly (readonly [string, string[]])[] = [['r90', ['-display_rotation', '90']], ['r270', ['-display_rotation', '-90']], ['r180', ['-display_rotation', '180']],
  ['hflip', ['-display_hflip']], ['vflip', ['-display_vflip']], ['r90h', ['-display_rotation', '90', '-display_hflip']], ['r270h', ['-display_rotation', '-90', '-display_hflip']]];
// The transforms FFmpeg's autorotate can apply, to find the one it applied to a file.
const TRANSFORMS = ['transpose=clock', 'transpose=cclock', 'transpose=clock_flip', 'transpose=cclock_flip', 'hflip', 'vflip', 'hflip,vflip'];
let dir: string;
const served = new Map<string, string>();
let written: Uint8Array | null = null;
let reports: { ok: boolean }[] = [];

/**
 * A source entry presenting the frame whose own source time is `at` for one 1/25 s window from `at` (§7.17, W7).
 * @param at - The frame's source time as numerator and denominator.
 * @returns The entry.
 */
function frameAt(at: [number, number], decodeAt: [number, number] = at): Record<string, unknown> {
  const start = q(...at);
  const end = q(at[0] * 25 + at[1], at[1] * 25);
  return { kind: 'source', decodeStart: q(...decodeAt), clipStart: start, displayStart: start, displayEnd: end, rate: q(1) };
}

/**
 * Run one frame recipe and return the PNG it wrote.
 * @param name - The source fixture.
 * @param recipe - The recipe fields besides kind and inputId.
 * @returns The PNG bytes.
 */
async function frame(name: string, recipe: Record<string, unknown>): Promise<Uint8Array> {
  served.set('http://inputs.test/source', join(dir, name));
  written = null;
  reports = [];
  await runPlanJob({ schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: [{ inputId: SOURCE, url: 'http://inputs.test/source' }],
    outputs: [{ outputIndex: 0, key: 'results/T/o00.png', url: 'http://outputs.test/o00', contentType: 'image/png', recipe: { kind: 'frame', inputId: SOURCE, ...recipe } }],
    reportUrl: 'http://jobs.test/report' } as unknown as PlanRunBody);
  expect(reports[0], JSON.stringify(reports[0])).toMatchObject({ ok: true });
  return written!;
}

/**
 * The PNG header: size, bit depth and colour type (2 RGB, 6 RGBA).
 * @param png - The bytes.
 * @returns The header facts.
 */
function header(png: Uint8Array): { width: number; height: number; bitDepth: number; colorType: number } {
  const view = new DataView(png.buffer, png.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: png[24]!, colorType: png[25]! };
}

/**
 * The mean of each RGBA channel of a picture, 8-bit.
 * @param path - The image or video (first frame).
 * @param filter - An optional filter chain before the RGBA conversion.
 * @returns The four means.
 */
async function rgbaMeans(path: string, filter?: string): Promise<number[]> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', `${filter === undefined ? '' : `${filter},`}format=rgba`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  const bytes = stdout as unknown as Buffer;
  return [0, 1, 2, 3].map(channel => bytes.filter((_value, index) => index % 4 === channel).reduce((sum, value) => sum + value, 0) / (bytes.length / 4));
}

// The D05 tone-map chain (§4.3 colour/HDR row) as a reference, on frames whose tags are all set.
const D05 = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/**
 * The first frame of a picture as raw bytes.
 * @param path - The image or video.
 * @param format - The raw pixel format.
 * @param filter - An optional filter chain before the conversion.
 * @returns The bytes.
 */
async function pixels(path: string, format: 'rgb24' | 'rgba', filter?: string): Promise<Buffer> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', `${filter === undefined ? '' : `${filter},`}format=${format}`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  return stdout;
}

/**
 * The largest difference between two equally sized pictures' bytes.
 * @param a - One.
 * @param b - The other.
 * @returns The difference, or Infinity when the sizes differ.
 */
function gap(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let most = 0;
  for (let index = 0; index < a.length; index += 1) most = Math.max(most, Math.abs(a[index]! - b[index]!));
  return most;
}

/**
 * The display transform FFmpeg's autorotate applies to a file: the one whose luma turns the unturned file's luma into it.
 * @param turned - The file with the display matrix.
 * @param flat - The same frames without it.
 * @returns The filter chain.
 */
async function turnOf(turned: string, flat: string): Promise<string> {
  const luma = async (path: string, filter?: string): Promise<Buffer> =>
    (await run('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', `${filter === undefined ? '' : `${filter},`}format=yuv444p16le,extractplanes=y`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout;
  const upright = await luma(turned);
  for (const turn of TRANSFORMS) if (gap(upright, await luma(flat, turn)) === 0) return turn;
  throw new Error(`No transform turns ${flat} into ${turned}`);
}

/**
 * Write PNG bytes to a file for FFmpeg to read.
 * @param png - The bytes.
 * @returns The path.
 */
async function saved(png: Uint8Array): Promise<string> {
  const path = join(dir, `out-${Math.random().toString(36).slice(2)}.png`);
  await writeFile(path, png);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'frame-recipe-'));
  const ff = async (name: string, args: string[]): Promise<void> => { await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, join(dir, name)]); };
  const tagged = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  // One white frame (25, 1.0 s) on black, keyframes every 10 frames: frame 25 is mid-GOP.
  await ff('flash.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=2,format=yuv420p,geq=lum='if(eq(N\\,25)\\,235\\,16)':cb=128:cr=128",
    '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged]);
  await ff('sdr10.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p10le', ...tagged]);
  await ff('pq10.mp4', ['-f', 'lavfi', '-i', 'color=c=0x808080:s=160x96:r=25:d=0.4', '-vf', 'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le',
    '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  await ff('alpha.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=rgba,colorchannelmixer=aa=0.25', '-c:v', 'png']);
  // The same alpha in a VP9 WebM: the alpha plane is a BlockAdditional, which only the libvpx decoder reads.
  await ff('alpha.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=yuva420p,colorchannelmixer=aa=0.25', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p']);
  // Lossless PQ twins: the odd source is the even one's decoded frame cropped exactly, so their samples are the same and the
  // odd tool output must equal the even frame's D05 picture cropped (FC08-FC10).
  const pq = 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc';
  await ff('pq-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', `format=yuv420p10le,${pq}`, '-c:v', 'ffv1']);
  await ff('pq-odd.mkv', ['-i', join(dir, 'pq-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  await ff('pqa-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', `format=rgba,colorchannelmixer=aa=0.25,format=yuva420p10le,${pq}`, '-c:v', 'ffv1']);
  await ff('pqa-odd.mkv', ['-i', join(dir, 'pqa-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  await ff('pq-odd-rot.mov', ['-display_rotation', '90', '-i', join(dir, 'pq-odd.mkv'), '-c', 'copy']);
  // The lossless RGB picture the SDR twins are made from (FC12).
  await ff('rgb-even.png', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-frames:v', '1', '-vf', 'format=rgb24']);
  // The same twins in SDR BT.709, opaque and with alpha (FC11, FC12).
  await ff('sdr-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=yuv420p,setparams=colorspace=bt709:range=tv', '-c:v', 'ffv1']);
  await ff('sdr-odd.mkv', ['-i', join(dir, 'sdr-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  await ff('sdra-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=rgba,colorchannelmixer=aa=0.25,format=yuva420p,setparams=colorspace=bt709:range=tv', '-c:v', 'ffv1']);
  await ff('sdra-odd.mkv', ['-i', join(dir, 'sdra-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  // The alpha twins as lossless VP9, whose alpha only the libvpx decoder reads (FC13).
  for (const side of ['even', 'odd']) await ff(`va-${side}.webm`, ['-i', join(dir, `sdra-${side}.mkv`), '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p']);
  // The odd SDR source under each display transform FFmpeg's autorotate undoes (FC14), and 4:2:2 turned a quarter (FC15).
  for (const [name, args] of TURNS) await ff(`turn-${name}.mov`, [...args, '-i', join(dir, 'sdr-odd.mkv'), '-c', 'copy']);
  await ff('sdr422-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=yuv422p,setparams=colorspace=bt709:range=tv', '-c:v', 'ffv1']);
  await ff('sdr422-odd.mkv', ['-i', join(dir, 'sdr422-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  await ff('turn422.mov', ['-display_rotation', '90', '-i', join(dir, 'sdr422-odd.mkv'), '-c', 'copy']);
  // Full-range JPEG 4:2:2 twins, stored raw so the decoder hands out yuvj422p (FC16), and 4:4:0 odd in width only (FC17).
  await ff('j-even.avi', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=yuvj422p', '-c:v', 'mjpeg', '-q:v', '1']);
  await ff('j-odd.avi', ['-i', join(dir, 'j-even.avi'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'mjpeg', '-q:v', '1']);
  await ff('s440-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=yuv440p,setparams=colorspace=bt709:range=tv', '-c:v', 'ffv1']);
  await ff('s440-odd.mkv', ['-i', join(dir, 's440-even.mkv'), '-vf', 'crop=159:96:0:0:exact=1', '-c:v', 'ffv1']);
  // A WebM whose frames change size mid-stream, as MediaRecorder writes when a captured window is resized (FC18).
  await ff('size-a.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'libvpx', '-b:v', '1M']);
  await ff('size-b.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libvpx', '-b:v', '1M']);
  await writeFile(join(dir, 'sizes.txt'), `file '${join(dir, 'size-a.webm')}'\nfile '${join(dir, 'size-b.webm')}'\n`);
  await ff('sizes.webm', ['-f', 'concat', '-safe', '0', '-i', join(dir, 'sizes.txt'), '-c', 'copy']);
  // A cropped WebM whose frames shrink mid-stream (FC21): 160x96, then 120x72, with a PixelCrop of two columns on the left.
  await ff('size-c.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-c:v', 'libvpx', '-b:v', '1M']);
  await ff('size-d.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=120x72:r=25:d=0.4', '-c:v', 'libvpx', '-b:v', '1M']);
  await writeFile(join(dir, 'shrink.txt'), `file '${join(dir, 'size-c.webm')}'\nfile '${join(dir, 'size-d.webm')}'\n`);
  await ff('shrink-whole.webm', ['-f', 'concat', '-safe', '0', '-i', join(dir, 'shrink.txt'), '-c', 'copy']);
  await writePixelCropped(join(dir, 'shrink-whole.webm'), join(dir, 'shrink.webm'), { left: 2 });
  // The even SDR twin with Matroska PixelCrop: right and bottom (even offsets), and left and top (odd offsets) (FC19).
  await writePixelCropped(join(dir, 'sdr-even.mkv'), join(dir, 'crop-rb.mkv'), { right: 1, bottom: 1 });
  await writePixelCropped(join(dir, 'sdr-even.mkv'), join(dir, 'crop-lt.mkv'), { left: 3, top: 1 });
  // The same crop on a stream turned a quarter (FC20): the crop is in stored coordinates, before the turn.
  await ff('turn-even.mkv', ['-display_rotation', '90', '-i', join(dir, 'sdr-even.mkv'), '-c', 'copy']);
  await writePixelCropped(join(dir, 'turn-even.mkv'), join(dir, 'crop-turn.mkv'), { left: 3, top: 1 });
  await ff('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'flash.mp4'), '-c', 'copy']);
  // A white 20x12 box at (40, 20) on black, every frame a keyframe: FC07's crops are read against its known edges.
  await ff('box.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=0.2,drawbox=x=40:y=20:w=20:h=12:color=white:t=fill,format=yuv420p",
    '-c:v', 'libx264', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-crf', '0', ...tagged]);
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') { written = new Uint8Array(await new Response(init.body).arrayBuffer()); return new Response(null, { status: 200 }); }
    if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body)) as { ok: boolean }); return new Response(null, { status: 200 }); }
    const path = served.get(url);
    if (path === undefined) return new Response(null, { status: 404 });
    const bytes = await readFile(path);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

describe('frame from a full-ledger entry (§92 D4-3; design §7.17 frame row)', () => {
  it('FC01 the source span names the frame by its own source time, mid-GOP included: frame 25 is the white one, frame 24 is not', async () => {
    // §93 D6 (design §7.17 时间线 row, W7 withdrawn): decodeStart is the latest source keyframe not after the frame, frame 20
    // at 4/5 s (flash.mp4 has no B-frames and starts at 0, so its dts is its pts and nothing is shifted).
    const white = await frame('flash.mp4', { entry: frameAt([1, 1], [4, 5]), target: OPAQUE });
    expect(header(white)).toEqual({ width: 160, height: 96, bitDepth: 8, colorType: 2 });
    expect((await rgbaMeans(await saved(white)))[0]).toBeGreaterThan(200);
    const before = await frame('flash.mp4', { entry: frameAt([24, 25], [4, 5]), target: OPAQUE });
    expect((await rgbaMeans(await saved(before)))[0]).toBeLessThan(30);
  });

  it('FC02 a source deeper than 8 bits gives a 16-bit PNG (§4.3: 抽帧PNG位深跟源走)', async () => {
    const png = await frame('sdr10.mp4', { entry: frameAt([0, 1]), target: { ...OPAQUE, pngBitDepth: 16 } });
    expect(header(png)).toMatchObject({ width: 160, height: 96, bitDepth: 16, colorType: 2 });
  });

  it('FC03 an HDR source is tone mapped to SDR BT.709 by the §4.3 chain', async () => {
    const png = await frame('pq10.mp4', { entry: frameAt([0, 1]), target: { ...OPAQUE, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' } });
    expect(header(png)).toMatchObject({ bitDepth: 8, colorType: 2 });
    const chained = await rgbaMeans(join(dir, 'pq10.mp4'), 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv');
    const plain = await rgbaMeans(join(dir, 'pq10.mp4'), 'scale=in_color_matrix=bt2020');
    expect(Math.abs(chained[0]! - plain[0]!)).toBeGreaterThan(15);
    expect(Math.abs((await rgbaMeans(await saved(png)))[0]! - chained[0]!)).toBeLessThan(3);
  });

  it('FC04 a derived-empty entry is composed in its fill: black opaque, or fully transparent with alpha kept', async () => {
    const window = { start: q(2), end: q(51, 25) };
    const black = await frame('flash.mp4', { entry: { kind: 'empty', fill: 'black', window }, target: OPAQUE });
    expect(header(black)).toMatchObject({ width: 160, height: 96, colorType: 2 });
    expect((await rgbaMeans(await saved(black))).slice(0, 3)).toEqual([0, 0, 0]);
    const clear = await frame('flash.mp4', { entry: { kind: 'empty', fill: 'transparent', window }, target: { ...OPAQUE, alpha: 'straight' } });
    expect(header(clear)).toMatchObject({ colorType: 6 });
    expect((await rgbaMeans(await saved(clear)))[3]).toBe(0);
  });

  it.each(['alpha.mov', 'alpha.webm'])('FC05 a transparent source keeps its alpha in an RGBA PNG: %s', async (name) => {
    const png = await frame(name, { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 64, height: 36, alpha: 'straight' } });
    expect(header(png)).toMatchObject({ width: 64, height: 36, colorType: 6 });
    expect(Math.abs((await rgbaMeans(await saved(png)))[3]! - 64)).toBeLessThan(2);
  });

  // §4.3 odd-size and colour/HDR rows: an odd 4:2:0 HDR source is tone mapped at its own size, each pixel as the D05 chain
  // maps the same samples in its even twin.
  it('FC08 an odd-sized HDR frame is the even twin\'s D05 picture, pixel for pixel', async () => {
    expect(String((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height,color_transfer', '-of', 'csv=p=0', join(dir, 'pq-odd.mkv')])).stdout).trim()).toBe('159,95,smpte2084');
    const png = await frame('pq-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' } });
    expect(header(png)).toMatchObject({ width: 159, height: 95, colorType: 2 });
    expect(gap(await pixels(await saved(png), 'rgb24'), await pixels(join(dir, 'pq-even.mkv'), 'rgb24', `${D05},crop=159:95:0:0:exact=1`))).toBeLessThanOrEqual(2);
  });

  it('FC09 an odd-sized transparent HDR frame keeps its alpha and the even twin\'s D05 colour, pixel for pixel', async () => {
    const png = await frame('pqa-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709', alpha: 'straight' } });
    expect(header(png)).toMatchObject({ width: 159, height: 95, colorType: 6 });
    const rgba = await pixels(await saved(png), 'rgba');
    const twin = await pixels(join(dir, 'pqa-even.mkv'), 'rgb24', `${D05},crop=159:95:0:0:exact=1`);
    expect(gap(Buffer.from(rgba.filter((_value, index) => index % 4 !== 3)), twin)).toBeLessThanOrEqual(2);
    expect(Math.abs((await rgbaMeans(await saved(png)))[3]! - 64)).toBeLessThan(2);
  });

  // The decoder turns the frame before the graph, so the odd side the tone map crops back to is the turned one.
  it('FC10 a rotated odd-sized HDR frame is the unrotated one turned, pixel for pixel', async () => {
    const png = await frame('pq-odd-rot.mov', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 95, height: 159, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' } });
    expect(header(png)).toMatchObject({ width: 95, height: 159 });
    const flat = await frame('pq-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95, colorMatrix: 'bt2020nc', toneMap: 'sdr-bt709' } });
    const turn = await turnOf(join(dir, 'pq-odd-rot.mov'), join(dir, 'pq-odd.mkv'));
    expect(gap(await pixels(await saved(png), 'rgb24'), await pixels(await saved(flat), 'rgb24', turn))).toBeLessThanOrEqual(1);
  });

  // §4.3 odd-size row: an odd 4:2:0 SDR source is converted as its even twin is, so each pixel equals the twin's.
  it.each([['sdr-odd.mkv', 'sdr-even.mkv', 'none'], ['sdra-odd.mkv', 'sdra-even.mkv', 'straight']] as const)('FC11 an odd-sized SDR frame (%s) is the even twin\'s frame, pixel for pixel', async (odd, even, alpha) => {
    const png = await frame(odd, { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95, alpha } });
    expect(header(png)).toMatchObject({ width: 159, height: 95, colorType: alpha === 'none' ? 2 : 6 });
    const twin = await frame(even, { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 160, height: 96, alpha } });
    const format = alpha === 'none' ? 'rgb24' : 'rgba';
    expect(gap(await pixels(await saved(png), format), await pixels(await saved(twin), format, 'crop=159:95:0:0'))).toBeLessThanOrEqual(1);
  });

  // An odd-sized subsampled source scaled to another size becomes full chroma on its even frame first, then is scaled, so its
  // chroma stays on its luma: the frame stays near the lossless RGB picture scaled the same way (only 4:2:0's own loss).
  it('FC12 an odd-sized SDR frame scaled to 80x48 keeps its chroma on its luma', async () => {
    const png = await frame('sdr-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 80, height: 48 } });
    expect(header(png)).toMatchObject({ width: 80, height: 48, colorType: 2 });
    const ideal = await pixels(join(dir, 'rgb-even.png'), 'rgb24', 'crop=159:95:0:0,scale=80:48');
    expect(gap(await pixels(await saved(png), 'rgb24'), ideal)).toBeLessThanOrEqual(60);
  });

  // §4.3 odd-size row: the alpha of an odd VP9 WebM, which only the libvpx decoder reads, is kept.
  it('FC13 an odd-sized transparent VP9 frame is the even twin\'s frame, alpha included', async () => {
    const target = { ...OPAQUE, width: 159, height: 95, alpha: 'straight' };
    const png = await frame('va-odd.webm', { entry: frameAt([0, 1]), target });
    const twin = await frame('va-even.webm', { entry: frameAt([0, 1]), target: { ...target, width: 160, height: 96 } });
    expect(gap(await pixels(await saved(png), 'rgba'), await pixels(await saved(twin), 'rgba', 'crop=159:95:0:0'))).toBeLessThanOrEqual(1);
  });

  // §4.3 odd-size row with §7.17 方向与几何: a turned odd source is the unturned one turned the way FFmpeg turns it.
  it.each(TURNS.map(([name]) => name))('FC14 an odd-sized SDR frame under display transform %s is the untransformed frame transformed', async (name) => {
    const flat = await frame('sdr-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95 } });
    const turn = await turnOf(join(dir, `turn-${name}.mov`), join(dir, 'sdr-odd.mkv'));
    const sideways = turn.startsWith('transpose');
    const png = await frame(`turn-${name}.mov`, { entry: frameAt([0, 1]), target: { ...OPAQUE, width: sideways ? 95 : 159, height: sideways ? 159 : 95 } });
    expect(gap(await pixels(await saved(png), 'rgb24'), await pixels(await saved(flat), 'rgb24', turn))).toBeLessThanOrEqual(1);
  });

  // A quarter turn of 4:2:2 cannot stay 4:2:2, so the frame is turned in 4:4:4 after its even-frame conversion: against the
  // lossless RGB picture turned, it errs about as much as the unturned frame (swscale's 4:4:4 route interpolates chroma a
  // little differently from its direct one); chroma off its pixels would add several levels.
  it('FC15 an odd-sized 4:2:2 frame turned a quarter comes out upright, as close to the picture as the unturned frame', async () => {
    const png = await frame('turn422.mov', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 95, height: 159 } });
    expect(header(png)).toMatchObject({ width: 95, height: 159 });
    const flat = await frame('sdr422-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95 } });
    const turn = await turnOf(join(dir, 'turn422.mov'), join(dir, 'sdr422-odd.mkv'));
    const mean = (a: Buffer, b: Buffer): number => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
    const turned = mean(await pixels(await saved(png), 'rgb24'), await pixels(join(dir, 'rgb-even.png'), 'rgb24', `crop=159:95:0:0,${turn}`));
    const unturned = mean(await pixels(await saved(flat), 'rgb24'), await pixels(join(dir, 'rgb-even.png'), 'rgb24', 'crop=159:95:0:0'));
    expect(turned).toBeLessThan(unturned + 2);
  });

  // swscale's chroma filter on 4:4:0 reaches across columns, so the three columns next to the missing one may differ a little.
  it('FC16 an odd-sized 4:4:0 frame (odd in width only) is the even twin\'s frame away from its last columns', async () => {
    const png = await frame('s440-odd.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 96 } });
    const twin = await frame('s440-even.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 160, height: 96 } });
    const [a, b] = [await pixels(await saved(png), 'rgb24'), await pixels(await saved(twin), 'rgb24', 'crop=159:96:0:0')];
    expect(gap(await pixels(await saved(png), 'rgb24', 'crop=156:96:0:0'), await pixels(await saved(twin), 'rgb24', 'crop=156:96:0:0'))).toBeLessThanOrEqual(1);
    expect(gap(a, b)).toBeLessThanOrEqual(8);
  });

  // MJPEG decodes as full-range yuvj422p; the twins are separate lossy encodes, so the mean stays at their coding gap while
  // chroma off its pixels raises it.
  it('FC18 an odd-sized MJPEG (yuvj422p) frame stays near the even twin\'s frame', async () => {
    expect(String((await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', join(dir, 'j-odd.avi')])).stdout).trim()).toBe('yuvj422p');
    const png = await frame('j-odd.avi', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 159, height: 95, colorMatrix: 'bt601' } });
    const twin = await frame('j-even.avi', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 160, height: 96, colorMatrix: 'bt601' } });
    const [a, b] = [await pixels(await saved(png), 'rgb24'), await pixels(await saved(twin), 'rgb24', 'crop=159:95:0:0')];
    const mean = a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
    expect(mean).toBeLessThan(1);
  });

  // Frames after a size change are taken to the planned size before the even-frame conversion.
  it('FC17 a frame after a mid-stream size change comes out at the planned odd size', async () => {
    const png = await frame('sizes.webm', { entry: frameAt([3, 5], [2, 5]), target: { ...OPAQUE, width: 159, height: 95 } });
    expect(header(png)).toMatchObject({ width: 159, height: 95 });
  });

  // §7.17 方向与几何: a Matroska PixelCrop is part of the display geometry, cropped exactly (FFmpeg's decoders round an odd crop
  // to the chroma grid). The crop is made on full-chroma frames, so the frame is the uncropped picture taken to full chroma
  // and cut there (swscale's direct route to RGB interpolates chroma differently; a cut one pixel off is 5 levels off on average).
  it.each([['crop-rb.mkv', 0, 0, 159, 95], ['crop-lt.mkv', 3, 1, 157, 95]] as const)('FC19 a frame of %s is the picture cropped exactly as the container says', async (name, x, y, width, height) => {
    const png = await frame(name, { entry: frameAt([0, 1]), target: { ...OPAQUE, width, height } });
    expect(header(png)).toMatchObject({ width, height });
    const read = 'in_color_matrix=bt709:in_range=tv';
    const cut = await pixels(join(dir, 'sdr-even.mkv'), 'rgb24', `scale=w=iw:h=ih:${read}:out_color_matrix=bt709:out_range=tv,format=yuv444p16le,crop=${width}:${height}:${x}:${y}:exact=1,scale=${read}`);
    const got = await pixels(await saved(png), 'rgb24');
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - cut[index]!), 0) / got.length).toBeLessThan(0.5);
  });

  // The crop file is read through its Cues: a frame after a seek is the same picture cropped the same way.
  it('FC19 a later frame of crop-lt.mkv, read after a seek, is the picture cropped exactly as the container says', async () => {
    const png = await frame('crop-lt.mkv', { entry: frameAt([3, 25], [2, 25]), target: { ...OPAQUE, width: 157, height: 95 } });
    const read = 'in_color_matrix=bt709:in_range=tv';
    const cut = await pixels(join(dir, 'sdr-even.mkv'), 'rgb24', `select=eq(n\\,3),scale=w=iw:h=ih:${read}:out_color_matrix=bt709:out_range=tv,format=yuv444p16le,crop=157:95:3:1:exact=1,scale=${read}`);
    const got = await pixels(await saved(png), 'rgb24');
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - cut[index]!), 0) / got.length).toBeLessThan(0.5);
  });

  // The crop is relative to each frame, so frames that change size mid-stream are cropped as the container says and taken to
  // the planned picture.
  it('FC21 a frame after a cropped stream shrinks mid-stream comes out at the planned size', async () => {
    const png = await frame('shrink.webm', { entry: frameAt([3, 5], [2, 5]), target: { ...OPAQUE, width: 158, height: 96 } });
    expect(header(png)).toMatchObject({ width: 158, height: 96 });
  });

  it('FC20 a cropped stream turned a quarter is cropped where it is stored, then turned upright', async () => {
    const png = await frame('crop-turn.mkv', { entry: frameAt([0, 1]), target: { ...OPAQUE, width: 95, height: 157 } });
    expect(header(png)).toMatchObject({ width: 95, height: 157 });
    const read = 'in_color_matrix=bt709:in_range=tv';
    const cut = await pixels(join(dir, 'sdr-even.mkv'), 'rgb24', `scale=w=iw:h=ih:${read}:out_color_matrix=bt709:out_range=tv,format=yuv444p16le,crop=157:95:3:1:exact=1,transpose=cclock,scale=${read}`);
    const got = await pixels(await saved(png), 'rgb24');
    expect(got.reduce((sum, value, index) => sum + Math.abs(value - cut[index]!), 0) / got.length).toBeLessThan(0.5);
  });

  it('FC06 the frame is upright in the display geometry (§7.17 方向与几何): a 90° source gives 96x160', async () => {
    const png = await frame('rot90.mp4', { entry: frameAt([1, 1]), target: { ...OPAQUE, width: 96, height: 160 } });
    expect(header(png)).toMatchObject({ width: 96, height: 160 });
  });

  // §93 D5 (frames-split design §7.17 frame row; people candidate crops): the display crop rides on the entry recipe, so the
  // pixel-exact crop facts of the removed display-crop executor test (odd origin and size, one pixel, the whole frame) are
  // re-expressed here on the full-ledger frame recipe.
  it.each([
    ['the whole box', { x: 40, y: 20, width: 20, height: 12 }, (x: number, y: number): boolean => x >= 0 && y >= 0],
    ['an odd origin and size inside it', { x: 41, y: 21, width: 5, height: 3 }, (): boolean => true],
    ['one pixel at its corner', { x: 59, y: 31, width: 1, height: 1 }, (): boolean => true],
    ['a crop across its left edge', { x: 37, y: 20, width: 5, height: 1 }, (x: number): boolean => x >= 3],
    ['the whole frame', { x: 0, y: 0, width: 160, height: 96 }, (x: number, y: number): boolean => x >= 40 && x < 60 && y >= 20 && y < 32],
  ])('FC07 a display crop of %s keeps exactly the selected pixels', async (_name, rect, white) => {
    const png = await frame('box.mp4', { entry: frameAt([0, 1]), target: OPAQUE, crop: { sourceWidth: 160, sourceHeight: 96, rect } });
    expect(header(png)).toMatchObject({ width: rect.width, height: rect.height, colorType: 2 });
    const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', await saved(png), '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
    const gray = stdout as unknown as Buffer;
    for (let y = 0; y < rect.height; y += 1) {
      for (let x = 0; x < rect.width; x += 1) {
        const value = gray[y * rect.width + x]!;
        expect(white(x, y) ? value > 200 : value < 40, `pixel (${x}, ${y}) = ${value}`).toBe(true);
      }
    }
  });
});
