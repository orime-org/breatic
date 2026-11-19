// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * decodeStart on real uploadable MP4s (inner#1306 test plan §93 D6, W7 withdrawn; frames-split design §7.17 时间线 row and
 * 抽帧解码 row, §3.2 item 7; evidence engineering/demo/2026-11-05-1306-decode-start-overshoot/overshoot.sh).
 *
 * The keyframe is the latest source keyframe whose pts is not after the span's first frame (presented or not), and
 * decodeStart = that keyframe's dts − min(0, the stream's first packet dts). The container seeks each video span's input
 * with `-seek_timestamp 1 -noaccurate_seek -ss decodeStart`, so decoding starts at that keyframe and the frame or span is
 * exactly the target. Seeking to the first frame's own time, to the keyframe's pts or to the raw dts lands after the target
 * on these samples. The three samples are the evidence script's: g=10 with B-frames (targets at the end of a GOP), adjacent
 * IDRs, and negative CTS offsets (the first packet's dts is negative). The oracle reads the packets with the edit list
 * ignored, as the container does, and compares pixels with a full decode of the same file.
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
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const W = 320;
const H = 180;
const PNG = { width: W, height: H, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };
const VIDEO = { width: W, height: H, displayRect: null, colorMatrix: 'bt709', toneMap: 'none', alpha: 'none', crf: 0, preset: 'ultrafast', format: 'mp4-h264' };
const SAMPLES = {
  'bf2.mp4': ['-g', '10', '-bf', '2'],
  'idr.mp4': ['-g', '50', '-bf', '2', '-force_key_frames', 'expr:eq(n,10)+eq(n,11)'],
  'neg.mp4': ['-g', '10', '-bf', '2', '-movflags', 'negative_cts_offsets'],
} as const;
type Sample = keyof typeof SAMPLES;
interface Packet { pts: number; dts: number; key: boolean }

let dir: string;
let written: Uint8Array | null = null;
let reports: { ok: boolean }[] = [];
const packets = new Map<Sample, Packet[]>();
const frames = new Map<Sample, Map<number, Buffer>>();

/**
 * A time on the 1/25 s grid of the samples as an exact rational.
 * @param seconds - The time.
 * @returns It, reduced.
 */
function q(seconds: number): Exact {
  let [a, b] = [Math.round(seconds * 25), 25];
  const [n, d] = [a, b];
  if (a < 0) a = -a;
  while (b !== 0) [a, b] = [b, a % b];
  const g = a === 0 ? 25 : a;
  return { numerator: String(n / g), denominator: String(d / g) };
}

/**
 * The decodeStart of a target frame by the design's rule.
 * @param sample - The sample.
 * @param target - The target frame's source pts.
 * @returns The keyframe's pts and the decodeStart.
 */
function decodeStartOf(sample: Sample, target: number): { keyframe: number; decodeStart: number } {
  const list = packets.get(sample)!;
  const keyframe = list.filter((packet) => packet.key && packet.pts <= target + 1e-9).at(-1)!;
  return { keyframe: keyframe.pts, decodeStart: keyframe.dts - Math.min(0, list[0]!.dts) };
}

/**
 * A source entry presenting the target frame for `count` frames from presentation time 0.
 * @param sample - The sample.
 * @param target - The first frame's source pts.
 * @param count - Frames.
 * @returns The entry.
 */
function entryAt(sample: Sample, target: number, count = 1): Record<string, unknown> {
  return { kind: 'source', decodeStart: q(decodeStartOf(sample, target).decodeStart), clipStart: q(target), displayStart: q(0), displayEnd: q(count / 25), rate: q(1) };
}

/**
 * Run one recipe through the container job and return the bytes it wrote.
 * @param sample - The source.
 * @param recipe - The recipe besides inputId.
 * @param contentType - The output type.
 * @returns The bytes.
 */
async function produce(sample: Sample, recipe: Record<string, unknown>, contentType: string): Promise<Uint8Array> {
  written = null;
  reports = [];
  await runPlanJob({ schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: [{ inputId: SOURCE, url: `http://inputs.test/${sample}` }],
    outputs: [{ outputIndex: 0, key: 'results/T/o00', url: 'http://outputs.test/o00', contentType, recipe: { inputId: SOURCE, ...recipe } }],
    reportUrl: 'http://jobs.test/report' } as unknown as PlanRunBody);
  expect(reports[0]?.ok, `the job reports ok (${JSON.stringify(vi.mocked(console.error).mock.calls)})`).toBe(true);
  return written!;
}

/**
 * Decode a picture or video to 8-bit RGB frames at the sample size.
 * @param path - The file.
 * @param input - Input options.
 * @returns The frames.
 */
async function rgbFrames(path: string, input: string[] = []): Promise<Buffer[]> {
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...input, '-i', path, '-vf', `scale=${W}:${H}:in_color_matrix=bt709,format=rgb24`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 28 });
  const bytes = stdout as unknown as Buffer;
  const size = W * H * 3;
  return Array.from({ length: bytes.length / size }, (_, index) => bytes.subarray(index * size, (index + 1) * size));
}

/**
 * The mean absolute difference of two RGB frames.
 * @param left - One.
 * @param right - The other.
 * @returns The difference per channel value.
 */
function mad(left: Buffer, right: Buffer): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index]! - right[index]!);
  return total / left.length;
}

/**
 * Expect a produced frame to be exactly the source frame at a pts: nearest to it and far from its neighbours.
 * @param sample - The source.
 * @param pts - The expected frame's pts.
 * @param actual - The produced RGB frame.
 */
function expectFrame(sample: Sample, pts: number, actual: Buffer): void {
  const table = frames.get(sample)!;
  const key = Math.round(pts * 25);
  const distances = [...table.entries()].map(([at, frame]) => ({ at, distance: mad(actual, frame) })).sort((a, b) => a.distance - b.distance);
  expect(distances[0]!.at, `nearest source frame to the output (${JSON.stringify(distances.slice(0, 3))})`).toBe(key);
  expect(distances[0]!.distance).toBeLessThan(3);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'decode-start-'));
  for (const [name, options] of Object.entries(SAMPLES) as [Sample, readonly string[]][]) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${W}x${H}:r=25:d=2`,
      '-c:v', 'libx264', ...options, '-pix_fmt', 'yuv420p', '-video_track_timescale', '25', join(dir, name)]);
    const { stdout } = await run('ffprobe', ['-v', 'error', '-ignore_editlist', '1', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', join(dir, name)]);
    const list = stdout.trim().split('\n').map((line) => line.split(',')).map(([pts, dts, flags]) => ({ pts: Number(pts), dts: Number(dts), key: flags!.includes('K') }));
    packets.set(name, list);
    // Frames come out in pts order; pair them with the sorted packet pts.
    const decoded = await rgbFrames(join(dir, name), ['-ignore_editlist', '1']);
    const order = list.map((packet) => packet.pts).sort((a, b) => a - b);
    frames.set(name, new Map(decoded.map((frame, index) => [Math.round(order[index]! * 25), frame])));
  }
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') { written = new Uint8Array(await new Response(init.body).arrayBuffer()); return new Response(null, { status: 200 }); }
    if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body)) as { ok: boolean }); return new Response(null, { status: 200 }); }
    const name = url.replace('http://inputs.test/', '');
    if (!(name in SAMPLES)) return new Response(null, { status: 404 });
    const bytes = await readFile(join(dir, name));
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

const TARGETS: [Sample, number][] = [
  ...[0.40, 0.44, 0.48, 0.68, 0.72, 0.76, 0.84, 0.88].map((t): [Sample, number] => ['bf2.mp4', t]),
  ...[0.40, 0.48, 0.52, 0.56].map((t): [Sample, number] => ['idr.mp4', t]),
  ...[0.00, 0.20, 0.36, 0.40, 0.68, 0.80, 0.96].map((t): [Sample, number] => ['neg.mp4', t]),
];

describe('a frame decoded from decodeStart is exactly its target (§93 D6; design §7.17 抽帧解码 row)', () => {
  it('DS10 the oracle reproduces the evidence: the keyframe and decodeStart of the GOP-end, adjacent-IDR and negative-CTS targets', () => {
    expect(decodeStartOf('bf2.mp4', 0.72)).toEqual({ keyframe: 0.48, decodeStart: expect.closeTo(0.40, 6) });
    expect(decodeStartOf('idr.mp4', 0.48)).toEqual({ keyframe: 0.48, decodeStart: expect.closeTo(0.40, 6) });
    expect(decodeStartOf('neg.mp4', 0.36)).toEqual({ keyframe: 0, decodeStart: expect.closeTo(0, 6) });
  });

  it.each(TARGETS)('DS11 %s at %s s: the frame recipe yields that frame', async (sample, target) => {
    const png = await produce(sample, { kind: 'frame', entry: entryAt(sample, target), target: PNG }, 'image/png');
    const path = join(dir, `out-${sample}-${target}.png`);
    await writeFile(path, png);
    expectFrame(sample, target, (await rgbFrames(path))[0]!);
  });
});

describe('a span decoded from decodeStart starts exactly at its first frame (§93 D6; design §7.17 时间线 row)', () => {
  it.each([['bf2.mp4', 0.72], ['idr.mp4', 0.48], ['neg.mp4', 0.36]] as [Sample, number][])('DS12 %s from %s s: a three-frame segment is those three source frames', async (sample, target) => {
    const mp4 = await produce(sample, { kind: 'segment', window: { start: 0, end: 3 }, timescale: 25, entries: [entryAt(sample, target, 3)], target: VIDEO, audio: null }, 'video/mp4');
    const path = join(dir, `seg-${sample}-${target}.mp4`);
    await writeFile(path, mp4);
    const output = await rgbFrames(path);
    expect(output).toHaveLength(3);
    output.forEach((frame, index) => expectFrame(sample, target + index / 25, frame));
  });
});
