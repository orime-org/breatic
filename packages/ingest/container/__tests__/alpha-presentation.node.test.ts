// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAlphaPresentation } from '@ingest/container/alpha-presentation.js';
import type { AlphaRunBody } from '@ingest/alpha-run-contract.js';

const { command, download, put, cpuUsec } = vi.hoisted(() => ({ command: vi.fn(), download: vi.fn(), put: vi.fn(), cpuUsec: vi.fn() }));
vi.mock('@ingest/container/plan-command.js', () => ({ runPlanCommand: command }));
vi.mock('@ingest/container/mini-tool-run.js', async (original) => ({ ...await original<Record<string, unknown>>(), download, put, cpuUsec }));

const NOW = Date.parse('2026-10-25T00:00:00Z');
const job: AlphaRunBody = { jobId: 'native-probe', sourceFingerprint: 'a'.repeat(64), deadlineAt: NOW + 2 * 60 * 60 * 1000,
  token: 'accepted-capability', sourceURL: 'http://media-object.local/canonical', outputURL: 'http://alpha-packed.local/packed', reportURL: 'http://alpha-report.local/canonical', vcpu: 0.25,
  limits: { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 1048576, analysisStdoutBytes: 1048576, stderrTailBytes: 65536 } };
const raw = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 48,
  side_data_list: [{ rotation: 90 }], disposition: { attached_pic: 0 } }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2' } };
let reports: Record<string, unknown>[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  reports = [];
  download.mockImplementation(async (_url: string, file: string) => { await writeFile(file, new Uint8Array([1, 2, 3])); });
  cpuUsec.mockResolvedValue(null);
  command.mockImplementation(async (_program: string, args: string[]) => Buffer.from(JSON.stringify(args.includes('-show_pixel_formats')
    ? { pixel_formats: [{ name: 'yuv420p', flags: { alpha: 0 } }] } : raw)));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('actual native classification orchestration (inner#1306)', () => {
  it('reports measured display geometry for a 90 degree source and performs no alpha encoding', async () => {
    expect(await runAlphaPresentation(job)).toEqual({ ok: true });
    expect(command.mock.calls.every(([program]) => program === 'ffprobe')).toBe(true);
    expect(command.mock.calls.some(([, args]) => (args as string[]).includes('-show_streams'))).toBe(true);
    expect(reports[0]).toMatchObject({ kind: 'probe', jobId: job.jobId, sourceFingerprint: job.sourceFingerprint, deadlineAt: job.deadlineAt,
      classification: 'confirmed_opaque', original: { width: 48, height: 64, duration: 2 },
      evidence: { codecName: 'h264', pixelFormat: 'yuv420p', pixelAlpha: 0, videoStreamIndex: 0 } });
    expect(reports[1]).toMatchObject({ kind: 'finished', jobId: job.jobId, usage: { cpuUsec: null } });
    expect(put).not.toHaveBeenCalled();
  });

  it('retains unknown classification when no real video can supply evidence', async () => {
    command.mockResolvedValue(Buffer.from(JSON.stringify({ streams: [], format: { duration: '2' } })));
    expect(await runAlphaPresentation({ ...job, jobId: 'unknown-probe' })).toEqual({ ok: false, error: 'classification_unknown' });
    expect(reports).toEqual([expect.objectContaining({ kind: 'finished', error: 'classification_unknown' })]);
    expect(put).not.toHaveBeenCalled();
  });

  it('retains the actual Matroska ALPHA_MODE tag in the classification provenance', async () => {
    command.mockResolvedValue(Buffer.from(JSON.stringify({ ...raw, streams: [{ ...raw.streams[0], codec_name: 'vp9', tags: { ALPHA_MODE: '1' } }], format: { format_name: 'matroska,webm', duration: '2' } })));
    await runAlphaPresentation({ ...job, jobId: 'alpha-provenance' });
    expect(reports[0]).toMatchObject({ kind: 'probe', classification: 'confirmed_alpha', evidence: { pixelFormat: 'yuv420p', pixelAlpha: 0, alphaMode: '1' } });
  });
});
