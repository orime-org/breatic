// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6d D4-3: the `frame` recipe on the frame grid (inner#1306 test plan §92 D4-3; frames-split design §4.1, §7.16, §7.17 frame
 * row and 方向与几何 row, §4.3 色彩/HDR/位深 row).
 *
 * The recipe names one grid frame of its tool source: `grid` {fps, gridStart, frameCount, realFrameCount} as ffprobe reads the
 * source (the harness's `gridOf`), `source` the original with its keyframe statistics, and `frameIndex`; plus a target:
 * display geometry, the plan's matrix and tone mapping, the PNG bit depth (16 when the source is deeper than 8 bits) and
 * whether the picture keeps its alpha, and optionally a display crop. Every fixture is 25 fps and generated here; the
 * planned job schema admits each recipe before the container runs it, and assertions are facts FFmpeg and the PNG header
 * read back.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writePixelCropped } from './helpers/matroska-pixel-crop.js';
import { gridOf, produce, run, stubContainerFetch, type GridFacts } from './helpers/frame-grid-harness.js';

const SOURCE = '10000000-0000-4000-8000-000000000001';
const OPAQUE = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };

// The transforms FFmpeg's autorotate can apply, to find the one it applied to a file.
const TRANSFORMS = ['transpose=clock', 'transpose=cclock', 'transpose=clock_flip', 'transpose=cclock_flip', 'hflip', 'vflip', 'hflip,vflip'];
let dir: string;
const grids = new Map<string, GridFacts>();

/**
 * Run one frame recipe on a fixture's 25 fps grid and return the PNG it wrote.
 * @param name - The source fixture.
 * @param frameIndex - The grid frame.
 * @param target - The PNG target.
 * @param extra - Other recipe fields (a crop).
 * @returns The PNG bytes.
 */
async function frame(name: string, frameIndex: number, target: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<Uint8Array> {
  const path = join(dir, name);
  let facts = grids.get(name);
  if (facts === undefined) {
    facts = await gridOf(path, { numerator: 25, denominator: 1 });
    grids.set(name, facts);
  }
  const [png] = await produce({ [SOURCE]: path }, [{ recipe: { kind: 'frame', inputId: SOURCE, grid: facts.grid, source: facts.source, frameIndex, target, ...extra }, contentType: 'image/png' }]);
  return png!;
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
  await ff('alpha.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=rgba,colorchannelmixer=aa=0.25', '-c:v', 'png']);
  // The same alpha in a VP9 WebM: the alpha plane is a BlockAdditional, which only the libvpx decoder reads.
  await ff('alpha.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=64x36:r=25:d=0.4,format=yuva420p,colorchannelmixer=aa=0.25', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p']);
  // The lossless RGB picture the 4:2:2 source is made from (FC15).
  await ff('rgb-even.png', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-frames:v', '1', '-vf', 'format=rgb24']);
  // An odd 4:2:2 source turned a quarter (FC15).
  await ff('sdr422-even.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-vf', 'format=yuv422p,setparams=colorspace=bt709:range=tv', '-c:v', 'ffv1']);
  await ff('sdr422-odd.mkv', ['-i', join(dir, 'sdr422-even.mkv'), '-vf', 'crop=159:95:0:0:exact=1', '-c:v', 'ffv1']);
  await ff('turn422.mov', ['-display_rotation', '90', '-i', join(dir, 'sdr422-odd.mkv'), '-c', 'copy']);
  // A WebM whose frames change size mid-stream, as MediaRecorder writes when a captured window is resized (FC17).
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
  await ff('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'flash.mp4'), '-c', 'copy']);
  // A white 20x12 box at (40, 20) on black, every frame a keyframe: FC07's crops are read against its known edges.
  await ff('box.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=160x96:r=25:d=0.2,drawbox=x=40:y=20:w=20:h=12:color=white:t=fill,format=yuv420p",
    '-c:v', 'libx264', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-crf', '0', ...tagged]);
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => { stubContainerFetch(); });

describe('frame on a grid frame of the original (§92 D4-3; design §7.17 frame row)', () => {
  it('FC01 the grid frame is the source frame at that slot, mid-GOP included: frame 25 is the white one, frame 24 is not', async () => {
    // flash.mp4 has keyframes every 10 frames, so frame 25 is read by a seek that lands before it (§7.16).
    const white = await frame('flash.mp4', 25, OPAQUE);
    expect(header(white)).toEqual({ width: 160, height: 96, bitDepth: 8, colorType: 2 });
    expect((await rgbaMeans(await saved(white)))[0]).toBeGreaterThan(200);
    const before = await frame('flash.mp4', 24, OPAQUE);
    expect((await rgbaMeans(await saved(before)))[0]).toBeLessThan(30);
  });

  it('FC02 a source deeper than 8 bits gives a 16-bit PNG (§4.3: 抽帧PNG位深跟源走)', async () => {
    const png = await frame('sdr10.mp4', 0, { ...OPAQUE, pngBitDepth: 16 });
    expect(header(png)).toMatchObject({ width: 160, height: 96, bitDepth: 16, colorType: 2 });
  });

  it.each(['alpha.mov', 'alpha.webm'])('FC05 a transparent source keeps its alpha in an RGBA PNG: %s', async (name) => {
    const png = await frame(name, 0, { ...OPAQUE, width: 64, height: 36, alpha: 'straight' });
    expect(header(png)).toMatchObject({ width: 64, height: 36, colorType: 6 });
    expect(Math.abs((await rgbaMeans(await saved(png)))[3]! - 64)).toBeLessThan(2);
  });

  // FFmpeg's autorotate turns the decoded 4:2:2 frame before the conversion (§4.3 odd-size row: FFmpeg's default handling):
  // against the lossless RGB picture turned, it errs about as much as the unturned frame; chroma off its pixels would add
  // several levels.
  it('FC15 an odd-sized 4:2:2 frame turned a quarter comes out upright, as close to the picture as the unturned frame', async () => {
    const png = await frame('turn422.mov', 0, { ...OPAQUE, width: 95, height: 159 });
    expect(header(png)).toMatchObject({ width: 95, height: 159 });
    const flat = await frame('sdr422-odd.mkv', 0, { ...OPAQUE, width: 159, height: 95 });
    const turn = await turnOf(join(dir, 'turn422.mov'), join(dir, 'sdr422-odd.mkv'));
    const mean = (a: Buffer, b: Buffer): number => a.reduce((sum, value, index) => sum + Math.abs(value - b[index]!), 0) / a.length;
    const turned = mean(await pixels(await saved(png), 'rgb24'), await pixels(join(dir, 'rgb-even.png'), 'rgb24', `crop=159:95:0:0,${turn}`));
    const unturned = mean(await pixels(await saved(flat), 'rgb24'), await pixels(join(dir, 'rgb-even.png'), 'rgb24', 'crop=159:95:0:0'));
    expect(turned).toBeLessThan(unturned + 2);
  });

  // Frames after a size change are scaled to the planned size.
  it('FC17 a frame after a mid-stream size change comes out at the planned odd size', async () => {
    const png = await frame('sizes.webm', 15, { ...OPAQUE, width: 159, height: 95 });
    expect(header(png)).toMatchObject({ width: 159, height: 95 });
  });

  // A cropped stream whose frames shrink mid-stream is planned at its coded size; the later frames reach that size.
  it('FC21 a frame after a cropped stream shrinks mid-stream comes out at the planned size', async () => {
    const png = await frame('shrink.webm', 15, { ...OPAQUE, width: 160, height: 96 });
    expect(header(png)).toMatchObject({ width: 160, height: 96 });
  });

  it('FC06 the frame is upright in the display geometry (§7.17 方向与几何): a 90° source gives 96x160', async () => {
    const png = await frame('rot90.mp4', 25, { ...OPAQUE, width: 96, height: 160 });
    expect(header(png)).toMatchObject({ width: 96, height: 160 });
  });

  // §93 D5 (frames-split design §7.17 frame row; people candidate crops): the display crop rides on the frame recipe, so the
  // pixel-exact crop facts (odd origin and size, one pixel, the whole frame) are read on the grid frame recipe.
  it.each([
    ['the whole box', { x: 40, y: 20, width: 20, height: 12 }, (x: number, y: number): boolean => x >= 0 && y >= 0],
    ['an odd origin and size inside it', { x: 41, y: 21, width: 5, height: 3 }, (): boolean => true],
    ['one pixel at its corner', { x: 59, y: 31, width: 1, height: 1 }, (): boolean => true],
    ['a crop across its left edge', { x: 37, y: 20, width: 5, height: 1 }, (x: number): boolean => x >= 3],
    ['the whole frame', { x: 0, y: 0, width: 160, height: 96 }, (x: number, y: number): boolean => x >= 40 && x < 60 && y >= 20 && y < 32],
  ])('FC07 a display crop of %s keeps exactly the selected pixels', async (_name, rect, white) => {
    const png = await frame('box.mp4', 0, OPAQUE, { crop: { sourceWidth: 160, sourceHeight: 96, rect } });
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
