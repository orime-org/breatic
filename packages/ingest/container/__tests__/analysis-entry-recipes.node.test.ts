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
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysisPipeline } from '@ingest/container/analysis-pipeline.js';
import { runPlanJob, type PlanRunBody } from '@ingest/container/plan-run.js';
import { gridOf, type GridFacts } from './helpers/frame-grid-harness.js';

vi.mock('@ingest/container/analysis-pipeline.js', () => ({ runAnalysisPipeline: vi.fn() }));

const run = promisify(execFile);
const SOURCE = '10000000-0000-4000-8000-000000000001';
const LIMITS = { probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const SCENE_TARGET = { width: 160, height: 96, colorMatrix: 'bt709', toneMap: 'none' };
const SCENE = { id: 'pyscenedetect-content', version: '0.7.2', weightsHash: null, params: { threshold: 27, minSceneLength: 15 } };

let dir: string;
let written: Uint8Array | null = null;
let reports: { ok: boolean }[] = [];
let facts: GridFacts;

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
  facts = await gridOf(join(dir, 'gop25.mp4'), { numerator: 25, denominator: 1 });
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

describe('scene cuts over the window grid frames (§93 D5-8; design §7.17 scene_cuts row)', () => {
  it('CS01 detects over the window and records each cut by its grid frame number (window start + local index)', async () => {
    vi.mocked(runAnalysisPipeline).mockResolvedValue(JSON.stringify({ cuts: [{ detectorFrameIndex: 5, detectionScore: 85 }] }));
    const json = await analyse({ kind: 'scene_cuts', frames: { start: 25, end: 50 }, profile: SCENE, target: SCENE_TARGET });
    expect(vi.mocked(runAnalysisPipeline).mock.calls[0]![0]).toMatchObject({ width: 160, height: 96, expectedFrameCount: 25 });
    expect(json).toEqual({ schemaVersion: 1, kind: 'scene_cuts', cuts: [{ frameIndex: 30, detectionScore: 85 }] });
  });
});
