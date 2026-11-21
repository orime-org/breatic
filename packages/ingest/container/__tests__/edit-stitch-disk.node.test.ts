// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ING-3: the edit stitch's disk (frames-split design §4.2 size cap row, §5.4 stitching row, §7.17 stitch row).
 *
 * The edit stitch runs on standard-4, whose 20 GB disk also holds the downloaded edit chunks; a stitched copy written beside
 * them would double what the disk must hold. The stitched edit file goes to its upload while FFmpeg writes it, so the run
 * directory never holds more than the chunks and small records. The job runs through `runPlanJob` with real FFmpeg; the run
 * directory is the only one under a temporary root this file's `tmpdir` names.
 */
import type * as os from 'node:os';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gridOf, produce, run, runJob, stubContainerFetch, type GridFacts } from './helpers/frame-grid-harness.js';

const box = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof os>();
  return { ...actual, tmpdir: () => box.root ?? actual.tmpdir() };
});

const SOURCE = '10000000-0000-4000-8000-000000000001';
const CHUNK_A = '10000000-0000-4000-8000-000000000002';
const CHUNK_B = '10000000-0000-4000-8000-000000000003';
const COLOR = { matrix: 'bt709', transfer: null, primaries: null, range: 'tv', chromaLocation: 'left' };
const TIERS = [
  { profile: 'edit_h264_intra_8bit_420', contentType: 'video/mp4', encode: ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'], ext: 'mp4' },
  { profile: 'edit_prores', contentType: 'video/quicktime', encode: ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-colorspace', 'bt709'], ext: 'mov' },
] as const;

let dir: string;
const sources = new Map<string, { path: string; facts: GridFacts }>();

beforeAll(async () => {
  dir = await mkdtemp(join((await vi.importActual<typeof os>('node:os')).tmpdir(), 'edit-stitch-disk-'));
  for (const tier of TIERS) {
    const path = join(dir, `source-${tier.profile}.${tier.ext}`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', ...tier.encode, path]);
    sources.set(tier.profile, { path, facts: await gridOf(path, { numerator: 30, denominator: 1 }) });
  }
}, 120_000);
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => { stubContainerFetch(); });

/**
 * The bytes of every file under a directory.
 * @param root - The directory.
 * @returns Their sum.
 */
async function sizeOf(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    total += entry.isDirectory() ? await sizeOf(path) : (await stat(path)).size;
  }
  return total;
}

describe('the edit stitch holds no second copy of the edit file (ING-3; §4.2, §5.4)', () => {
  it.each(TIERS)('ES01 $profile: the stitched edit file is uploaded while it is written, beside only its chunks', async (tier) => {
    const { path, facts } = sources.get(tier.profile)!;
    const end = facts.grid.frameCount;
    const edit = (start: number, stop: number): Record<string, unknown> => ({
      kind: 'edit_encode', inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start, end: stop },
      edit: { profile: tier.profile, crf: 15, preset: 'ultrafast' }, color: COLOR, toneMap: 'none',
    });
    const [a, b] = await produce({ [SOURCE]: path }, [{ recipe: edit(0, 90), contentType: tier.contentType }, { recipe: edit(90, end), contentType: tier.contentType }]);
    const parts = [join(dir, `${tier.profile}-a.${tier.ext}`), join(dir, `${tier.profile}-b.${tier.ext}`)];
    await writeFile(parts[0]!, a!);
    await writeFile(parts[1]!, b!);
    const chunkBytes = a!.byteLength + b!.byteLength;

    const root = await mkdtemp(join(dir, 'run-root-'));
    let peak = 0;
    const store = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (init?.method !== 'PUT' || !(init.body instanceof ReadableStream)) return store(input, init);
      // Measure the run directory while each written byte is still on its way to the upload.
      const watched = (init.body as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) { peak = Math.max(peak, await sizeOf(root)); controller.enqueue(chunk); },
      }));
      return store(input, { ...init, body: watched });
    });
    box.root = root;
    let stitched: Uint8Array | undefined;
    try {
      [stitched] = await produce({ [CHUNK_A]: parts[0]!, [CHUNK_B]: parts[1]! }, [{
        recipe: { kind: 'stitch', chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: 90 } }, { inputId: CHUNK_B, frames: { start: 90, end } }], grid: facts.grid,
          edit: { profile: tier.profile } },
        contentType: tier.contentType,
      }]);
    } finally { box.root = undefined; }

    expect(peak, 'the upload was measured while it ran').toBeGreaterThan(0);
    expect(peak, 'the run directory held the chunks and small records only').toBeLessThan(chunkBytes + 512 * 1024);
    const file = join(dir, `${tier.profile}-edit.${tier.ext}`);
    await writeFile(file, stitched!);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file]);
    const packets = stdout.trim().split('\n').map((line) => line.split(','));
    expect(packets, 'every grid frame').toHaveLength(end);
    expect(Number(packets[0]![0]), 'the first frame is at 0').toBe(0);
    expect(packets.every(([, flags]) => flags!.startsWith('K')), 'every frame is a keyframe').toBe(true);
  }, 180_000);

  // The frame count is FFmpeg's count of what it muxed, checked before the upload ends, so a wrong file is never stored.
  it('ES02 a stitch whose frames are not the window fails grid_mismatch and leaves no stored edit file', async () => {
    const tier = TIERS[0];
    const { path, facts } = sources.get(tier.profile)!;
    const [a] = await produce({ [SOURCE]: path }, [{ recipe: { kind: 'edit_encode', inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start: 0, end: 90 },
      edit: { profile: tier.profile, crf: 15, preset: 'ultrafast' }, color: COLOR, toneMap: 'none' }, contentType: tier.contentType }]);
    const part = join(dir, 'short-a.mp4');
    await writeFile(part, a!);
    const { report, bytes } = await runJob({ [CHUNK_A]: part }, [{
      recipe: { kind: 'stitch', chunks: [{ inputId: CHUNK_A, frames: { start: 0, end: facts.grid.frameCount } }], grid: facts.grid, edit: { profile: tier.profile } },
      contentType: tier.contentType,
    }]);
    expect(report, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ ok: false, reason: 'tool_failed' });
    expect(bytes[0], 'no edit file was stored').toBeUndefined();
  }, 60_000);
});
