// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6d D5-8: the scene_cuts recipe on the frame grid (inner#1306 test plan §93 D5-8; frames-split design §7.16, §7.17
 * scene_cuts row).
 *
 * The worker writes the window's grid frames (`grid`, `source`, `frames` [start, end)) and the display target; the container
 * decodes those grid frames from the tool source and runs the detector on them. Scene JSON records each
 * cut by its grid frame number: `{ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ frameIndex, detectionScore }] }`. The
 * detector process is mocked (its rows are inputs here); the job runs through `runPlanJob` with real FFmpeg for the frame
 * preparation. The source is 25 fps with keyframes at frames 0 and 25; its grid is read with the harness's `gridOf`.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysisPipeline } from '@ingest/container/analysis-pipeline.js';
import type * as frameGrid from '@shared/upload/frame-grid.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { resolveVideoColorMatrix } from '@ingest/container/physical-video-probe.js';
import { FIXTURES, expectSlot, gridOf, oracleFrames, type GridFacts } from './helpers/frame-grid-harness.js';

vi.mock('@ingest/container/analysis-pipeline.js', () => ({ runAnalysisPipeline: vi.fn() }));
// CS04 makes the first seek land late, as a container whose CLI seek overshoots does, so the back-off must run.
const seeks = vi.hoisted(() => ({ lateFirst: false }));
vi.mock('@shared/upload/frame-grid.js', async (original) => {
  const actual = await original<typeof frameGrid>();
  return { ...actual, gridSeekPosition: (input: Parameters<typeof actual.gridSeekPosition>[0], attempt: number) => {
    const position = actual.gridSeekPosition(input, attempt);
    return seeks.lateFirst && attempt === 0 && position !== null ? position + 2 : position;
  } };
});

const run = promisify(execFile);
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const SCENE_TARGET = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none' };
const SCENE = { id: 'pyscenedetect-content', version: '0.7.2', weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };

let dir: string;
let written: Uint8Array | null = null;
let reports: { ok: boolean }[] = [];
let facts: GridFacts;
let served: string;

/**
 * Run one analysis recipe and return the JSON it wrote.
 * @param recipe - The recipe fields besides inputId, grid and source.
 * @returns The JSON.
 */
async function analyse(recipe: Record<string, unknown>): Promise<unknown> {
  written = null;
  reports = [];
  await runPlanJob({ schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: [{ inputId: SOURCE, url: 'http://inputs.test/source' }],
    outputs: [{ outputIndex: 0, key: 'results/T/o00.txt', url: 'http://outputs.test/o00', contentType: 'text/plain',
      recipe: { inputId: SOURCE, grid: facts.grid, source: facts.source, ...recipe } }],
    reportUrl: 'http://jobs.test/report' } as unknown as PlanRunBody);
  expect(reports[0]?.ok, `the job reports ok (${JSON.stringify(vi.mocked(console.error).mock.calls)})`).toBe(true);
  return JSON.parse(new TextDecoder().decode(written ?? new Uint8Array()));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'analysis-entry-'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2',
    '-c:v', 'libx264', '-g', '25', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', join(dir, 'gop25.mp4')]);
  served = join(dir, 'gop25.mp4');
  facts = await gridOf(served, { numerator: 25, denominator: 1 });
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') { written = new Uint8Array(await new Response(init.body).arrayBuffer()); return new Response(null, { status: 200 }); }
    if (init?.method === 'POST') { reports.push(JSON.parse(String(init.body)) as { ok: boolean }); return new Response(null, { status: 200 }); }
    if (url !== 'http://inputs.test/source') return new Response(null, { status: 404 });
    const bytes = await readFile(served);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

describe('scene cuts over the window grid frames (§93 D5-8; design §7.17 scene_cuts row)', () => {
  it('CS01 detects over the window and records each cut by its grid frame number (window start + local index)', async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ cuts: [{ detectorFrameIndex: 5, detectionScore: 85 }] }));
    const json = await analyse({ kind: 'scene_cuts', frames: { start: 25, end: 50 }, profile: SCENE, target: SCENE_TARGET });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ width: 160, height: 96, expectedFrameCount: 25 });
    expect(json).toEqual({ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ frameIndex: 30, detectionScore: 85 }] });
  });

  // ING-1: the scene_cuts class has an 8 GB disk, and a minute of 1080p frames as raw BGR is about 11 GB; the decoded frames
  // go to the detector through a pipe and never land in the run directory.
  it('CS02 pipes the decoded frames to the detector without writing them to the run directory', async () => {
    const long = join(dir, 'long.mp4');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=12',
      '-c:v', 'libx264', '-g', '25', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', long]);
    const longFacts = await gridOf(long, { numerator: 25, denominator: 1 });
    const sourceBytes = (await stat(long)).size;
    const frames = { start: 50, end: 300 };
    const detector = pipeToDetector();
    const json = await analyseFrom(long, longFacts, { kind: 'scene_cuts', frames, profile: SCENE, target: SCENE_TARGET });
    expect(json, 'the same cuts as the file route').toEqual({ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ frameIndex: 55, detectionScore: 85 }] });
    const oracle = await oracleFrames(long, longFacts.grid);
    const piped = detector.frames(160, 96);
    expect(piped, 'every window frame reaches the detector').toHaveLength(frames.end - frames.start);
    for (let at = 0; at < piped.length; at += 25) expectSlot(piped[at]!, oracle, frames.start + at, `detector frame ${at}`);
    expect(detector.rawSeen(), 'no raw frame file is written').toBe(false);
    expect(detector.peak(), 'the run directory holds the source and small records only').toBeLessThan(sourceBytes + 64 * 1024);
  }, 60_000);

  // ING-1: a late landing is found by the settling pass and seeks again before the one streamed decode (§7.16).
  it('CS04 a first seek that lands late backs off before the frames are streamed', async () => {
    const long = join(dir, 'long.mp4');
    const longFacts = await gridOf(long, { numerator: 25, denominator: 1 });
    const frames = { start: 50, end: 80 };
    const detector = pipeToDetector();
    seeks.lateFirst = true;
    try { await analyseFrom(long, longFacts, { kind: 'scene_cuts', frames, profile: SCENE, target: SCENE_TARGET }); }
    finally { seeks.lateFirst = false; }
    const oracle = await oracleFrames(long, longFacts.grid);
    const piped = detector.frames(160, 96);
    expect(piped).toHaveLength(frames.end - frames.start);
    piped.forEach((frame, at) => expectSlot(frame, oracle, frames.start + at, `detector frame ${at}`));
  }, 60_000);

  // ING-1: the seek is settled before the one streamed decode, on the samples whose CLI seek lands late (§7.16).
  it.each([['x50g5.avi', 50, 1], ['avi_xvid_bf.avi', 25, 1], ['elst.mp4', 25, 1]] as const)('CS03 %s: windows from every GOP phase reach the detector as the grid frames', async (name, numerator, denominator) => {
    const path = join(FIXTURES, name);
    const read = await gridOf(path, { numerator, denominator }, false);
    const streams = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', path])).stdout) as { streams: Record<string, unknown>[] };
    const target = { width: read.width, height: read.height, colorMatrix: resolveVideoColorMatrix(streams.streams[0]!), toneMap: 'none' };
    const oracle = await oracleFrames(path, read.grid);
    for (let start = 1; start + 7 <= read.grid.frameCount; start += 11) {
      const frames = { start, end: start + 7 };
      const detector = pipeToDetector();
      await analyseFrom(path, read, { kind: 'scene_cuts', frames, profile: SCENE, target });
      const piped = detector.frames(read.width, read.height);
      expect(piped, `${name} window from ${start}`).toHaveLength(frames.end - frames.start);
      piped.forEach((frame, at) => expectSlot(frame, oracle, start + at, `${name} window from ${start}, slot ${start + at}`));
    }
  }, 180_000);
});

/** What the mocked detector saw: the frames the decoder piped and the run directory beside them. */
interface DetectorWatch { frames(width: number, height: number): Buffer[]; rawSeen(): boolean; peak(): number }

/**
 * Run the decoder the recipe hands the detector for real, keep what it pipes, and watch the run directory while it runs.
 * @returns What was seen.
 */
function pipeToDetector(): DetectorWatch {
  const chunks: Buffer[] = [];
  let peak = 0;
  let raw = false;
  vi.mocked(runAnalysisPipeline).mockImplementation(async (request) => {
    const runDirectory = dirname(request.processor.args.at(-1)!);
    /** Record the run directory's size and whether a raw frame file sits in it. */
    const sample = async (): Promise<void> => {
      const names = await readdir(runDirectory);
      raw ||= names.some((name) => name.endsWith('.bgr'));
      const sizes = await Promise.all(names.map(async (name) => (await stat(join(runDirectory, name))).size));
      peak = Math.max(peak, sizes.reduce((sum, size) => sum + size, 0));
    };
    await sample();
    const decoder = spawn(request.decoder.program, [...request.decoder.args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const closed = new Promise((resolve) => decoder.once('close', resolve));
    for await (const chunk of decoder.stdout) { chunks.push(chunk as Buffer); await sample(); }
    await closed;
    return JSON.stringify({ cuts: [{ detectorFrameIndex: 5, detectionScore: 85 }] });
  });
  return {
    frames: (width, height) => {
      const bytes = Buffer.concat(chunks);
      const size = width * height * 3;
      return Array.from({ length: bytes.length / size }, (_unused, at) => {
        const bgr = bytes.subarray(at * size, (at + 1) * size);
        const rgb = Buffer.alloc(size);
        for (let i = 0; i < size; i += 3) { rgb[i] = bgr[i + 2]!; rgb[i + 1] = bgr[i + 1]!; rgb[i + 2] = bgr[i]!; }
        return rgb;
      });
    },
    rawSeen: () => raw,
    peak: () => peak,
  };
}

/**
 * Run one analysis recipe over another source.
 * @param path - The source served as the input.
 * @param sourceFacts - Its grid and tool source.
 * @param recipe - The recipe fields besides inputId, grid and source.
 * @returns The JSON it wrote.
 */
async function analyseFrom(path: string, sourceFacts: GridFacts, recipe: Record<string, unknown>): Promise<unknown> {
  const [kept, keptFacts] = [served, facts];
  [served, facts] = [path, sourceFacts];
  try { return await analyse(recipe); }
  finally { [served, facts] = [kept, keptFacts]; }
}
