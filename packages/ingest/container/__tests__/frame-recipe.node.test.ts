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

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
const q = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const OPAQUE = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };

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
  expect(reports[0]?.ok).toBe(true);
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
  await ff('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'flash.mp4'), '-c', 'copy']);
  // A white 20x12 box at (40, 20) on black, every frame a keyframe: FC07's crops are read against its known edges.
  await ff('box.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=0.2,drawbox=x=40:y=20:w=20:h=12:color=white:t=fill,format=yuv420p",
    '-c:v', 'libx264', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-crf', '0', ...tagged]);
});
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
