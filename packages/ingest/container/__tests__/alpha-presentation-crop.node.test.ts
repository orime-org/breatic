// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The packed display carrier of a transparent WebM with a Matroska PixelCrop: the picture Chromium shows, cropped exactly
 * and packed colour left and alpha right. Run on the real ffprobe and ffmpeg 8.0.1; only the transfers are stood in for.
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
 * @returns The bytes.
 */
async function luma(path: string, filter: string): Promise<Buffer> {
  return (await run('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', `${filter},format=gray`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 })).stdout;
}

describe('a transparent source its container crops', () => {
  // The WebM shows its PixelCrop; the MOV's clean aperture is not shown, so its picture is the coded one.
  it.each([
    ['crop.webm', 157, 95, 3, 1, 2, 0],
    ['clap.mov', 160, 96, 0, 0, 0, 0],
  ] as const)('%s is filed and packed at the picture Chromium shows', async (name, width, height, x, y, roundedX, roundedY) => {
    source = name;
    expect(await runAlphaPresentation(job)).toEqual({ ok: true });
    const [plane, packedHeight] = [Math.ceil(width / 2) * 2, Math.ceil(height / 2) * 2];
    expect(reports[0]).toMatchObject({ kind: 'probe', classification: 'confirmed_alpha', original: { width, height } });
    expect(reports[1]).toMatchObject({ kind: 'encoded', packedWidth: plane * 2, packedHeight, colorRect: { x: 0, y: 0, width, height },
      alphaRect: { x: plane, y: 0, width, height } });
    // The alpha is half everywhere: the packed alpha rectangle has no transparent column or row.
    expect(Math.min(...await luma(packed, `format=gray,crop=${width}:${height}:${plane}:0`))).toBeGreaterThan(100);
    // The colour rectangle is the uncropped picture cut where the source shows it, not where FFmpeg's own crop rounds to.
    const colour = await luma(packed, `format=gray,crop=${width}:${height}:0:0`);
    const cut = async (left: number, top: number): Promise<number> => {
      const want = await luma(join(dir, 'whole.webm'), `format=gbrap,premultiply=inplace=1,crop=${width}:${height}:${left}:${top}`);
      return colour.reduce((sum, value, index) => sum + Math.abs(value - want[index]!), 0) / colour.length;
    };
    if (x !== roundedX || y !== roundedY) expect(await cut(x, y)).toBeLessThan(await cut(roundedX, roundedY));
  }, 120_000);
});
