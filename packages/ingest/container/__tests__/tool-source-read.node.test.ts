// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * N2: a planned job's disk (frames-split design §4.2 size cap row, §7.17).
 *
 * The tool source (up to the edit file cap) is read through the loopback reader (`readServedObject`), the way long-media
 * segments read theirs, so it never lands in the run directory; each output is a complete regular file that is uploaded
 * and removed before the next is encoded, so the run directory holds one output at a time. The job runs through
 * `runPlanJob` with real FFmpeg; the run directory is the only one under a temporary root this file's `tmpdir` names.
 */
import type * as os from 'node:os';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gridOf, run, runJob, stubContainerFetch, type GridFacts } from './helpers/frame-grid-harness.js';

const box = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof os>();
  return { ...actual, tmpdir: () => box.root ?? actual.tmpdir() };
});

const SOURCE = '10000000-0000-4000-8000-000000000001';

let dir: string;
let source: string;
let sourceBytes: number;
let facts: GridFacts;

beforeAll(async () => {
  dir = await mkdtemp(join((await vi.importActual<typeof os>('node:os')).tmpdir(), 'tool-source-read-'));
  source = join(dir, 'source.mp4');
  // Noisy all-intra frames make the source far larger than any short segment of it.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6,noise=alls=60:allf=t',
    '-c:v', 'libx264', '-g', '1', '-crf', '8', '-pix_fmt', 'yuv420p', source]);
  sourceBytes = (await stat(source)).size;
  facts = await gridOf(source, { numerator: 30, denominator: 1 });
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

/**
 * A short opaque split segment over [start, end).
 * @param start - First grid frame.
 * @param end - The frame it stops before.
 * @returns The recipe.
 */
function segment(start: number, end: number): Record<string, unknown> {
  return { kind: 'segment', inputId: SOURCE, grid: facts.grid, source: facts.source, frames: { start, end },
    target: { width: 640, height: 360, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 40, preset: 'ultrafast', format: 'mp4-h264' }, audio: false };
}

/**
 * Run a job with the run directory measured at every upload, and the upload count per URL.
 * @param outputs - The recipes.
 * @returns The report, each output's bytes, the run directory's size at each upload and how often each URL was written.
 */
async function measured(outputs: Record<string, unknown>[]): Promise<{ report: Awaited<ReturnType<typeof runJob>>['report']; bytes: (Uint8Array | undefined)[]; sizes: number[]; writes: Map<string, number> }> {
  const root = await mkdtemp(join(dir, 'run-root-'));
  const sizes: number[] = [];
  const writes = new Map<string, number>();
  const store = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (init?.method === 'PUT') {
      const url = String(input);
      writes.set(url, (writes.get(url) ?? 0) + 1);
      sizes.push(await sizeOf(root));
    }
    return store(input, init);
  });
  box.root = root;
  try {
    const { report, bytes } = await runJob({ [SOURCE]: source }, outputs.map((recipe) => ({ recipe, contentType: 'video/mp4' })));
    return { report, bytes, sizes, writes };
  } finally { box.root = undefined; }
}

/**
 * The top-level box types of an MP4, in order.
 * @param bytes - The file.
 * @returns The four-letter types.
 */
function boxes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  for (let at = 0; at + 8 <= bytes.byteLength;) {
    const size = view.getUint32(at);
    types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    if (size < 8) break;
    at += size;
  }
  return types;
}

describe('a planned job reads its tool source in place and holds one output at a time (N2; §4.2, §7.17)', () => {
  it('TS01 the tool source is read through the loopback reader and never written to the run directory', async () => {
    const { report, sizes } = await measured([segment(30, 45)]);
    expect(report, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ ok: true });
    expect(sizes.length, 'the upload was measured').toBeGreaterThan(0);
    expect(Math.max(...sizes), `the run directory never held the ${sourceBytes}-byte source`).toBeLessThan(sourceBytes / 4);
  }, 120_000);

  it('TS02 a split with several outputs holds one output at a time and uploads each once, as a complete regular MP4', async () => {
    const windows = [[0, 40], [40, 100], [100, 180]] as const;
    const { report, bytes, sizes, writes } = await measured(windows.map(([start, end]) => segment(start, end)));
    expect(report, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ ok: true });
    expect([...writes.values()], 'each output is written once').toEqual([1, 1, 1]);
    for (const [at, [start, end]] of windows.entries()) {
      const out = bytes[at]!;
      // At its upload the run directory holds this output and small records, never an earlier output.
      expect(sizes[at], `output ${at} is alone on disk at its upload`).toBeLessThan(out.byteLength + 256 * 1024);
      expect(boxes(out), `output ${at} is a regular MP4 with its index first`).toEqual(expect.arrayContaining(['moov', 'mdat']));
      expect(boxes(out).indexOf('moov'), `output ${at} keeps moov before mdat`).toBeLessThan(boxes(out).indexOf('mdat'));
      expect(boxes(out), `output ${at} is not fragmented`).not.toContain('moof');
      const file = join(dir, `split-${at}.mp4`);
      await writeFile(file, out);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
      expect(Number(stdout.trim()), `output ${at} has its window's frames`).toBe(end - start);
    }
  }, 180_000);

  it('TS03 a source connection that drops once resumes from where it stopped', async () => {
    const store = vi.mocked(fetch).getMockImplementation()!;
    let dropped = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const answer = await store(input, init);
      if (dropped || !String(input).endsWith(`/${SOURCE}`) || answer.body === null) return answer;
      dropped = true;
      // The first answer stops a third of the way in; the reader asks again from there.
      const cut = Math.floor(sourceBytes / 3);
      const reader = answer.body.getReader();
      let sent = 0;
      // The bytes before the cut reach the reader; the reset comes on the next read, as a dropped connection delivers them.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= cut) { controller.error(new Error('connection reset')); await reader.cancel(); return; }
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          const part = value.subarray(0, Math.min(value.byteLength, cut - sent));
          sent += part.byteLength;
          controller.enqueue(part);
        },
      });
      return new Response(body, { status: answer.status, headers: answer.headers });
    });
    const { report, bytes } = await runJob({ [SOURCE]: source }, [{ recipe: segment(150, 180), contentType: 'video/mp4' }]);
    expect(dropped, 'the drop happened').toBe(true);
    expect(report, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ ok: true });
    expect(bytes[0]).toBeDefined();
  }, 120_000);

  it('TS04 a source that keeps dropping fails the output as internal and stores nothing', async () => {
    const store = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const answer = await store(input, init);
      if (!String(input).endsWith(`/${SOURCE}`) || answer.body === null) return answer;
      const reader = answer.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) { controller.close(); return; }
          controller.enqueue(value.subarray(0, 1));
          controller.error(new Error('connection reset'));
        },
      });
      return new Response(body, { status: answer.status, headers: answer.headers });
    });
    const { report, bytes } = await runJob({ [SOURCE]: source }, [{ recipe: segment(150, 180), contentType: 'video/mp4' }]);
    expect(report).toMatchObject({ ok: false, reason: 'internal' });
    expect(bytes[0], 'no output was stored').toBeUndefined();
  }, 120_000);

  it('TS05 a fragmented all-intra edit file is opened and seeked without reading it whole', async () => {
    // The edit stitch streams a fragmented file (one fragment per all-intra frame) to its upload. Without its trailing
    // mfra index the mov demuxer walks every top-level moof on open, which over HTTP reads the whole file, as one long
    // read or one Range request per fragment, on every probe and every decode.
    const edit = join(dir, 'edit.mp4');
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=10,noise=alls=60:allf=t',
      '-c:v', 'libx264', '-g', '1', '-crf', '8', '-pix_fmt', 'yuv420p', '-movflags', '+frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 28 });
    await writeFile(edit, stdout);
    expect(boxes(new Uint8Array(stdout)).filter((type) => type === 'moof').length, 'every frame is its own fragment').toBe(300);
    const grid = { fps: { numerator: 30, denominator: 1 }, gridStart: { numerator: 0, denominator: 1 }, frameCount: 300, realFrameCount: 300 };
    const store = vi.mocked(fetch).getMockImplementation()!;
    let [requests, read] = [0, 0];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const answer = await store(input, init);
      if (!String(input).endsWith(`/${SOURCE}`) || answer.body === null) return answer;
      requests += 1;
      // Hand the body out in 64 KiB pieces as it is pulled, so the count is what the reader took, not the whole answer.
      const whole = new Uint8Array(await answer.arrayBuffer());
      let at = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= whole.byteLength) { controller.close(); return; }
          const part = whole.subarray(at, at + 65_536);
          at += part.byteLength;
          read += part.byteLength;
          controller.enqueue(part);
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: answer.status, headers: answer.headers });
    });
    const { report, bytes } = await runJob({ [SOURCE]: edit }, [{ recipe: { ...segment(210, 225), grid, source: { kind: 'edit' } }, contentType: 'video/mp4' }]);
    expect(report, JSON.stringify(vi.mocked(console.error).mock.calls)).toMatchObject({ ok: true });
    expect(bytes[0]).toBeDefined();
    // A probe and one decode from frame 210 read the index, the moov and the frames from 7 s: a small part of the file.
    expect(requests, 'source requests for the probe and one seek').toBeLessThan(20);
    expect(read, `bytes read of the ${stdout.byteLength}-byte edit file`).toBeLessThan(stdout.byteLength / 2);
  }, 120_000);
});
