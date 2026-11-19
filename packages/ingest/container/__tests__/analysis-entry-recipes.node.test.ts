// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6d D5-8: the people and scene_cuts recipes on full-ledger entries (inner#1306 test plan §93 D5-8; frames-split design
 * §7.17 人物检测锚帧 row and scene_cuts row 「切点按呈现序号记录；结果组装按compact核对」).
 *
 * The worker writes the anchor's entry (people) or the window's entries with their presentation ordinal offsets
 * (scene_cuts) and the display target; the container decodes or composes those frames and runs the detector on them.
 * People JSON no longer echoes an anchor (the recipe has none) and is measured in the target's display geometry. Scene
 * JSON records each cut by its presentation ordinal: `{ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ ordinal,
 * detectionScore }] }`. The detector process is mocked (its rows are inputs here); the job runs through `runPlanJob` with
 * real FFmpeg for any frame preparation. The source has keyframes at frames 0 and 25, and every span starts on one.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysisPipeline } from '@ingest/container/analysis-pipeline.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';

vi.mock('@ingest/container/analysis-pipeline.js', () => ({ runAnalysisPipeline: vi.fn() }));

const run = promisify(execFile);
type Exact = { numerator: string; denominator: string };
const q = (numerator: number, denominator = 1): Exact => ({ numerator: String(numerator), denominator: String(denominator) });
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const PNG_TARGET = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none', pngBitDepth: 8, alpha: 'none' };
const SCENE_TARGET = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none' };
const PEOPLE = { id: 'opencv-yunet-2023mar', version: '2023mar', weightsHash: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4', params: { scoreThreshold: 0.6, nmsThreshold: 0.3, topK: 5000 } };
const SCENE = { id: 'pyscenedetect-content', version: '0.7.2', weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };

let dir: string;
let written: Uint8Array | null = null;
let reports: { ok: boolean }[] = [];

/**
 * A source span of 25 fps frames from frame `first` (a keyframe) for `count` frames, decoded from its own first frame.
 * @param first - The first frame.
 * @param count - The frame count.
 * @returns The entry.
 */
function span(first: number, count: number): Record<string, unknown> {
  return { kind: 'source', decodeStart: q(first, 25), clipStart: q(first, 25), displayStart: q(first, 25), displayEnd: q(first + count, 25), rate: q(1) };
}

/**
 * Run one analysis recipe and return the JSON it wrote.
 * @param recipe - The recipe fields besides inputId.
 * @returns The JSON.
 */
async function analyse(recipe: Record<string, unknown>): Promise<unknown> {
  written = null;
  reports = [];
  await runPlanJob({ schemaVersion: 2, attemptId: '30000000-0000-4000-8000-000000000001', deadlineAt: Date.now() + 3_600_000, limits: LIMITS,
    inputs: [{ inputId: SOURCE, url: 'http://inputs.test/source' }],
    outputs: [{ outputIndex: 0, key: 'results/T/o00.txt', url: 'http://outputs.test/o00', contentType: 'text/plain', recipe: { inputId: SOURCE, ...recipe } }],
    reportUrl: 'http://jobs.test/report' } as unknown as PlanRunBody);
  expect(reports[0]?.ok, `the job reports ok (${JSON.stringify(vi.mocked(console.error).mock.calls)})`).toBe(true);
  return JSON.parse(new TextDecoder().decode(written ?? new Uint8Array()));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'analysis-entry-'));
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2',
    '-c:v', 'libx264', '-g', '25', '-bf', '0', '-pix_fmt', 'yuv420p', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709', join(dir, 'gop25.mp4')]);
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
    const bytes = await readFile(join(dir, 'gop25.mp4'));
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

describe('people on the anchor entry (§93 D5-8; design §7.17 人物检测锚帧 row)', () => {
  it('CA01 detects on the target-size frame and writes display people without an anchor echo', async () => {
    // One YuNet row: box 16,8 32x24 in the 160x96 display frame, five landmarks, score 0.9.
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ faces: [[16, 8, 32, 24, 20, 12, 40, 12, 30, 20, 22, 28, 38, 28, 0.9]] }));
    const json = await analyse({ kind: 'people', entry: span(25, 1), target: PNG_TARGET, profile: PEOPLE });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ width: 160, height: 96, expectedFrameCount: 1 });
    expect(json).toEqual({ schemaVersion: 1, kind: 'people', coordinateSpace: 'display', width: 160, height: 96,
      candidates: [{ detectionIndex: 0, faceBox: { x: 0.1, y: 8 / 96, width: 0.2, height: 0.25 }, pixelCrop: { x: 16, y: 8, width: 32, height: 24 } }] });
  });
});

describe('scene cuts on the window entries (§93 D5-8; design §7.17 scene_cuts row)', () => {
  it('CS01 detects over the window and records each cut by its presentation ordinal (offset + local index)', async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ cuts: [{ detectorFrameIndex: 5, detectionScore: 85 }] }));
    const json = await analyse({ kind: 'scene_cuts', window: { start: 25, end: 50 }, timescale: 25, profile: SCENE,
      entries: [{ ...span(25, 25), ordinalOffset: 25 }], target: SCENE_TARGET });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ width: 160, height: 96, expectedFrameCount: 25 });
    expect(json).toEqual({ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ ordinal: 30, detectionScore: 85 }] });
  });

  it('CS02 a derived-empty entry is one composed frame at its own ordinal, after the span before it', async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ cuts: [{ detectorFrameIndex: 25, detectionScore: 40 }, { detectorFrameIndex: 3, detectionScore: 12 }] }));
    const json = await analyse({ kind: 'scene_cuts', window: { start: 0, end: 26 }, timescale: 25, profile: SCENE, target: SCENE_TARGET,
      entries: [{ ...span(0, 25), ordinalOffset: 0 }, { kind: 'empty', fill: 'black', window: { start: q(1), end: q(26, 25) }, ordinalOffset: 25 }] });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ expectedFrameCount: 26 });
    expect(json).toEqual({ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ ordinal: 25, detectionScore: 40 }, { ordinal: 3, detectionScore: 12 }] });
  });
});
