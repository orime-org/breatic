// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The packed display carrier of real transparent sources, colour left and alpha right: one with a container crop (a
 * Matroska PixelCrop, an MP4 clean aperture), packed at the picture Chromium shows, uncropped; and a palette (pal8) one. Run
 * on the real ffprobe and ffmpeg 8.0.1; only the transfers are stood in for.
 */

import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAlphaPresentation } from '@ingest/container/alpha-presentation.js';
import type { AlphaRunBody } from '@ingest/alpha-run-contract.js';
import { writePixelCropped } from './helpers/matroska-pixel-crop.js';

const { download, put, cpuUsec } = vi.hoisted(() => ({ download: vi.fn(), put: vi.fn(), cpuUsec: vi.fn() }));
vi.mock('@ingest/container/mini-tool-run.js', async (original) => ({ ...await original<Record<string, unknown>>(), download, put, cpuUsec }));

const run = promisify(execFile);
let dir = '';
let reports: Record<string, unknown>[] = [];
let packed = '';

const job: AlphaRunBody = { jobId: 'alpha-crop', sourceFingerprint: 'a'.repeat(64), deadlineAt: Date.now() + 2 * 60 * 60 * 1000,
  token: 'accepted-capability', sourceURL: 'http://media-object.local/canonical', outputURL: 'http://alpha-packed.local/packed', reportURL: 'http://alpha-report.local/canonical', vcpu: 1,
  limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 0, preset: 'medium', probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 65536 } };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alpha-crop-'));
  const ff = async (name: string, args: string[]): Promise<void> => {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, join(dir, name)]);
  };
  await ff('whole.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-vf', 'format=rgba,colorchannelmixer=aa=0.5,format=yuva420p', '-c:v', 'libvpx-vp9', '-lossless', '1']);
  // Three columns on the left and one row at the top.
  await writePixelCropped(join(dir, 'whole.webm'), join(dir, 'crop.webm'), { left: 3, top: 1 });
  // ProRes 4444 with the same PixelCrop, then copied into MOV, where FFmpeg writes it as a clean aperture Chromium ignores.
  await ff('whole-prores.mkv', ['-i', join(dir, 'whole.webm'), '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']);
  await writePixelCropped(join(dir, 'whole-prores.mkv'), join(dir, 'crop-prores.mkv'), { left: 3, top: 1 });
  await ff('clap.mov', ['-i', join(dir, 'crop-prores.mkv'), '-c', 'copy']);
  // A palette PNG in MOV, transparent on the left half and opaque on the right (a palette with a reserved transparent entry).
  await ff('palette.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=10:d=0.3', '-filter_complex',
    "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,32),0,255)',split[s0][s1];[s0]palettegen=reserve_transparent=1:stats_mode=single[p];[s1][p]paletteuse=alpha_threshold=128:new=1",
    '-c:v', 'png']);
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let source = '';

beforeEach(() => {
  reports = [];
  download.mockImplementation(async (_url: string, file: string) => { await copyFile(join(dir, source), file); });
  put.mockImplementation(async (_url: string, file: string) => { packed = join(dir, 'packed.mp4'); await copyFile(file, packed); });
  cpuUsec.mockResolvedValue(null);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

/**
 * One frame's luma as bytes.
 * @param path - The file.
 * @param filter - The filters before the luma is read.
 * @param decoder - The decoder options (libvpx reads a WebM's alpha).
 * @returns The bytes.
 */
async function luma(path: string, filter: string, decoder: string[] = []): Promise<Buffer> {
  return (await run('ffmpeg', ['-v', 'error', ...decoder, '-i', path, '-frames:v', '1', '-vf', `${filter},format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 })).stdout;
}

describe('a transparent source its container crops', () => {
  // Neither the WebM's PixelCrop nor the MOV's clean aperture is shown, so each picture is the coded one.
  it.each([
    ['crop.webm', 160, 96, ['-c:v', 'libvpx-vp9']],
    ['clap.mov', 160, 96, []],
  ] as const)('%s is filed and packed at the picture Chromium shows, uncropped', async (name, width, height, decoder) => {
    source = name;
    expect(await runAlphaPresentation(job)).toEqual({ ok: true });
    const [plane, packedHeight] = [Math.ceil(width / 2) * 2, Math.ceil(height / 2) * 2];
    expect(reports[0]).toMatchObject({ kind: 'probe', classification: 'confirmed_alpha', original: { width, height } });
    expect(reports[1]).toMatchObject({ kind: 'encoded', packedWidth: plane * 2, packedHeight, colorRect: { x: 0, y: 0, width, height },
      alphaRect: { x: plane, y: 0, width, height } });
    // The alpha is half everywhere: the packed alpha rectangle has no transparent column or row.
    expect(Math.min(...await luma(packed, `format=gray,crop=${width}:${height}:${plane}:0`))).toBeGreaterThan(100);
    // The colour rectangle is the source's whole coded picture, premultiplied.
    const colour = await luma(packed, `format=gray,crop=${width}:${height}:0:0`);
    const want = await luma(join(dir, name), 'format=gbrap,premultiply=inplace=1', ['-apply_cropping', 'codec', ...decoder]);
    expect(colour.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / colour.length).toBeLessThan(2);
  }, 120_000);
});

// FFmpeg 8.0.1's split hands a palette frame to alphaextract, which then crashes (exit 139): the frames become planar RGBA
// first.
describe('a palette source', () => {
  it('palette.mov is packed with its transparent half clear and its opaque half solid', async () => {
    source = 'palette.mov';
    expect(await runAlphaPresentation(job)).toEqual({ ok: true });
    expect(reports[0]).toMatchObject({ kind: 'probe', classification: 'confirmed_alpha', original: { width: 64, height: 48 } });
    const alpha = await luma(packed, 'format=gray,crop=64:48:64:0');
    const half = (from: number): number => alpha.filter((_value, index) => index % 64 >= from && index % 64 < from + 32).reduce((sum, value) => sum + value, 0) / (32 * 48);
    expect(half(0)).toBeLessThan(20);
    expect(half(32)).toBeGreaterThan(235);
  }, 120_000);
});
