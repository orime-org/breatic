// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The container producer of the source ledger v2 (inner#1306 test plan §77,
 * cases V). Controlled IO, not FFmpeg evidence: ffprobe, download, upload and
 * reports are stand-ins; the parsers, assembler and projection run for real.
 *
 * Contract fixed here:
 * - The ledger is produced only after the presentation is ready: after the
 *   accepted opaque probe report, or after the packed alpha upload; a
 *   ledger-only attempt (presentation already ready) produces it at once.
 *   Presentation work and its reports never wait for, or depend on, the ledger.
 * - A presentation run that fails produces no ledger and reports no ledger
 *   failure carrying the presentation's own code.
 * - One PUT to `sourceLedgerOutputURL` carries both objects: the compact table
 *   JSON, then the full ledger v2 JSON. Its query adds `producerVersion=2`,
 *   `byteLength` (ledger), `tableByteLength` and `tableFrameCount`.
 * - A planner failure is reported with the planner's own code.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlphaRunBody } from '@ingest/alpha-run-contract.js';
import { handleAlphaPresentation, runAlphaPresentation } from '@ingest/container/alpha-presentation.js';
import * as isoOwner from '@ingest/container/iso-bmff-metadata.js';
import * as matroskaOwner from '@ingest/container/matroska-metadata.js';
import * as physicalOwner from '@ingest/container/physical-video-probe.js';
import * as assemblyOwner from '@ingest/container/assemble-video-source-ledger.js';
import * as classificationOwner from '@ingest/video-alpha-classification.js';
import { videoSourceLedgerV2Schema } from '@shared/upload/video-source-ledger.js';
import { projectPresentationTable } from '@shared/mini-tools/video-presentation-projection.js';
import type { VideoSourceLedgerV2 } from '@shared/upload/video-source-ledger-types.js';
import { ORIGINAL_ISO_ASSEMBLY_FIXTURES } from './helpers/source-ledger-assembly-fixtures.js';
import { MATROSKA_PRESENTATION_CASES } from './helpers/matroska-presentation-fixtures.js';

const { command, download, put, cpuUsec } = vi.hoisted(() => ({ command: vi.fn(), download: vi.fn(), put: vi.fn(), cpuUsec: vi.fn() }));
vi.mock('@ingest/container/plan-command.js', async (original) => ({ ...await original<Record<string, unknown>>(), runPlanCommand: command }));
vi.mock('@ingest/container/mini-tool-run.js', async (original) => ({ ...await original<Record<string, unknown>>(), download, put, cpuUsec }));

const NOW = Date.parse('2026-10-29T00:00:00Z');
// Captured before beforeEach spies the export, so a wrapper can call the real assembler.
const realAssemble = assemblyOwner.assembleVideoSourceLedgerV2;
// Six budgets; no frame-count ceiling (design §2 "覆盖全部上传").
const CAPS = { maxBytes: 1000000, probeStdoutBytes: 234567, metadataBytes: 16384, isoBoxCount: 128, matroskaElementCount: 256, matroskaMaxBlocks: 32 };
const JOB = { jobId: 'producer', sourceFingerprint: 'a'.repeat(64), deadlineAt: NOW + 7200000, token: 'accepted-original-token',
  sourceURL: 'http://media-object.local/canonical', outputURL: 'http://alpha-packed.local/packed', reportURL: 'http://alpha-report.local/canonical',
  sourceLedgerOutputURL: 'http://source-ledger.local/canonical?token=accepted-original-token',
  vcpu: 0.25, limits: { sourceLedger: CAPS, maxSourceBytes: 1048576, maxPackedBytes: 1048576, crf: 18, preset: 'medium', probeStdoutBytes: 345678, analysisStdoutBytes: 456789, stderrTailBytes: 16385 } } as unknown as AlphaRunBody;
const ISO_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const DEFAULT_VIDEO = { index: 3, id: '0x1', codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 48, time_base: '1/16384', start_pts: 4096, duration_ts: 34816, disposition: { attached_pic: 0 } };
let raw: { streams: Record<string, unknown>[]; format: Record<string, unknown> };
let iso: isoOwner.IsoBmffMetadata;
let matroska: matroskaOwner.MatroskaMetadata;
let physicalBytes: Buffer;
let reports: Record<string, unknown>[];
let uploads: { url: string; bytes: Buffer }[];
let now: number;
let sequence = 0;

/** A fresh admitted body. @throws {never} Never. */
function job(): AlphaRunBody {
  return { ...structuredClone(JOB), jobId: `producer-${++sequence}` };
}

/** Use one original ISO fixture, with no audio stream so that no audio track is selected. @throws {never} Never. */
function original(id = 'cfr.mp4'): void {
  const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
  iso = structuredClone(fixture.metadata);
  raw = { streams: [{ ...DEFAULT_VIDEO, time_base: `${fixture.physical.sourceTimeBase.numerator}/${fixture.physical.sourceTimeBase.denominator}` }], format: { format_name: ISO_FORMAT, duration: '2.125' } };
  physicalBytes = Buffer.from(JSON.stringify({ frames: fixture.physical.frames.map((frame) => ({ media_type: 'video', stream_index: 3, pts: frame.ptsTicks, pkt_pos: '200' })) }));
}

/** Use one Matroska fixture with its own video track only. @throws {never} Never. */
function webm(id: string): void {
  const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
  matroska = structuredClone(fixture.metadata);
  raw = { streams: [{ ...DEFAULT_VIDEO, codec_name: 'vp9', time_base: '1/1000' }], format: { format_name: 'matroska,webm', duration: '0.12' } };
  physicalBytes = Buffer.from(JSON.stringify({ frames: fixture.physical.frames.map((frame, index) => ({ media_type: 'video', stream_index: 3, pts: Number(frame.ptsTicks),
    pkt_pos: Number(BigInt(matroska.blocks[index]!.elementOffset) + 1n) })) }));
}

/** Whether a command belongs to ledger production rather than presentation. @throws {never} Never. */
function ledgerCommand(args: unknown): boolean {
  const list = args as string[];
  return list.includes('-ignore_editlist') || list.includes('frame=media_type,stream_index,pts,pkt_pos');
}

/** The single ledger PUT, split into its two objects. @throws {Error} When there is not exactly one. */
function ledger(): { url: URL; table: unknown; value: VideoSourceLedgerV2; tableText: string } {
  const found = uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local');
  expect(found).toHaveLength(1);
  const url = new URL(found[0]!.url);
  expect(url.searchParams.get('producerVersion')).toBe('2');
  const tableBytes = Number(url.searchParams.get('tableByteLength'));
  expect(Number.isSafeInteger(tableBytes) && tableBytes > 0).toBe(true);
  expect(Number(url.searchParams.get('byteLength'))).toBe(found[0]!.bytes.length - tableBytes);
  const tableText = found[0]!.bytes.subarray(0, tableBytes).toString('utf8');
  const value = JSON.parse(found[0]!.bytes.subarray(tableBytes).toString('utf8')) as VideoSourceLedgerV2;
  return { url, table: JSON.parse(tableText) as unknown, value, tableText };
}

/** The ledger failure reports observed. @throws {never} Never. */
function ledgerFailures(): Record<string, unknown>[] {
  return reports.filter((entry) => entry.kind === 'source_ledger_failed');
}

/** The call order index of the first report of this kind. @throws {Error} When there is none. */
function reportOrder(kind: string): number {
  const index = vi.mocked(globalThis.fetch).mock.calls.findIndex(([, init]) => (JSON.parse(String(init?.body)) as { kind: string }).kind === kind);
  expect(index).toBeGreaterThanOrEqual(0);
  return vi.mocked(globalThis.fetch).mock.invocationCallOrder[index]!;
}

/** Dispatch through the real HTTP replay owner. @throws {Error} When the handler rejects outside its response. */
async function handle(body: AlphaRunBody): Promise<{ status: number; value: unknown }> {
  let status = 0; let value: unknown;
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const response: ServerResponse = { writeHead: (code: number): ServerResponse => { status = code; return response; }, end: (bytes: string): void => { value = JSON.parse(bytes) as unknown; } } as unknown as ServerResponse;
  await handleAlphaPresentation(request, response);
  return { status, value };
}

beforeEach(() => {
  vi.clearAllMocks(); now = NOW; reports = []; uploads = []; original();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(isoOwner, 'inspectIsoBmffFile').mockImplementation(async () => iso);
  vi.spyOn(matroskaOwner, 'inspectMatroskaFile').mockImplementation(async () => matroska);
  vi.spyOn(physicalOwner, 'parsePhysicalVideoProbe');
  vi.spyOn(physicalOwner, 'parseMatroskaPhysicalVideoProbe');
  vi.spyOn(assemblyOwner, 'assembleVideoSourceLedgerV2');
  vi.spyOn(classificationOwner, 'classifyVideoAlpha');
  cpuUsec.mockResolvedValueOnce(100).mockResolvedValue(1000100);
  download.mockImplementation(async (_url: string, file: string) => { await writeFile(file, Buffer.from([1, 2, 3])); });
  put.mockImplementation(async (url: string, file: string) => { uploads.push({ url, bytes: await readFile(file) }); });
  command.mockImplementation(async (program: string, args: string[]) => {
    if (program === 'ffmpeg') { await writeFile(args.at(-1)!, Buffer.from([4, 5, 6])); return Buffer.alloc(0); }
    if (args.includes('-show_pixel_formats')) return Buffer.from(JSON.stringify({ pixel_formats: [{ name: 'yuv420p', flags: { alpha: 0 } }, { name: 'rgba', flags: { alpha: 1 } }] }));
    const packed = args.at(-1)?.endsWith('packed.mp4') === true;
    if (args.includes('-show_frames')) {
      if (ledgerCommand(args)) return physicalBytes;
      const frames = ORIGINAL_ISO_ASSEMBLY_FIXTURES[0]!.physical.frames.map((frame) => ({ media_type: 'video', stream_index: 3, pts: frame.ptsTicks, duration: '2048' }));
      return Buffer.from(JSON.stringify({ frames }));
    }
    return Buffer.from(JSON.stringify(packed ? { ...raw, streams: raw.streams.map((stream) => stream.codec_type === 'video' ? { ...stream, codec_name: 'h264', width: 128, height: 48 } : stream) } : raw));
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    reports.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('source ledger v2 producer ordering and output (inner#1306 §77)', () => {
  it('V01 runs no ledger work for an admission that requested none', async () => {
    const body = job(); delete (body as { limits: { sourceLedger?: unknown } }).limits.sourceLedger; delete body.sourceLedgerOutputURL;
    expect(await runAlphaPresentation(body)).toEqual({ ok: true });
    expect(command.mock.calls.some(([, args]) => ledgerCommand(args))).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(reports.map((entry) => entry.kind)).toEqual(['probe', 'finished']);
  });

  it.each(ORIGINAL_ISO_ASSEMBLY_FIXTURES.map((fixture) => fixture.id))('V02 %s: produces the ledger only after the opaque probe is reported, in one PUT of the projected table and the v2 ledger', async (id) => {
    original(id);
    const body = job();
    expect(await runAlphaPresentation(body)).toEqual({ ok: true });
    const probeAt = reportOrder('probe');
    const ledgerCalls = command.mock.calls.map((call, index) => [call, command.mock.invocationCallOrder[index]!] as const).filter(([call]) => ledgerCommand(call[1]));
    expect(ledgerCalls.length).toBeGreaterThan(0);
    expect(ledgerCalls.every(([, order]) => order > probeAt)).toBe(true);
    expect(vi.mocked(isoOwner.inspectIsoBmffFile).mock.invocationCallOrder[0]).toBeGreaterThan(probeAt);
    expect(put.mock.invocationCallOrder[0]).toBeGreaterThan(probeAt);
    const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
    const { url, table, value, tableText } = ledger();
    const expectedTable = projectPresentationTable(fixture.expected.frames);
    expect(table).toEqual(expectedTable);
    expect(tableText).toBe(JSON.stringify(value.presentation));
    expect(url.searchParams.get('tableFrameCount')).toBe(String(fixture.expected.frames.length));
    expect(url.searchParams.get('token')).toBe(body.token);
    expect(videoSourceLedgerV2Schema.parse(value)).toEqual(value);
    const physical = physicalOwner.parsePhysicalVideoProbe({ ...raw, streams: raw.streams }, physicalBytes);
    expect(value).toEqual(assemblyOwner.assembleVideoSourceLedgerV2({ kind: 'iso_bmff', sourceFingerprint: body.sourceFingerprint,
      attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, metadata: iso, physical, audioTrackId: null }).ledger);
    expect(isoOwner.inspectIsoBmffFile).toHaveBeenCalledWith(expect.any(String), { metadataBytes: CAPS.metadataBytes, boxCount: CAPS.isoBoxCount });
    expect(reports.at(-1)).toMatchObject({ kind: 'finished' });
    expect(reports.at(-1)).not.toHaveProperty('error');
  });

  it.each(['K01', 'K04', 'K08'])('V03 %s: Matroska ledger has the projected table and no edit spans', async (id) => {
    webm(id);
    expect(await runAlphaPresentation(job())).toEqual({ ok: true });
    const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
    const { table, value } = ledger();
    expect(table).toEqual(projectPresentationTable(fixture.expected!.frames));
    expect(value.videoEdits).toBeNull();
    expect(value.audioEdits).toBeNull();
    expect(command.mock.calls.every(([, args]) => !(args as string[]).includes('-ignore_editlist'))).toBe(true);
    expect(matroskaOwner.inspectMatroskaFile).toHaveBeenCalledWith(expect.any(String), { metadataBytes: CAPS.metadataBytes, elementCount: CAPS.matroskaElementCount, maxBlocks: CAPS.matroskaMaxBlocks });
  });

  it('V04 an alpha source: the ledger is produced only after the packed presentation is uploaded', async () => {
    raw.streams[0]!.codec_name = 'qtrle'; raw.streams[0]!.pix_fmt = 'rgba';
    expect(await runAlphaPresentation(job())).toEqual({ ok: true });
    const packedIndex = uploads.findIndex((entry) => new URL(entry.url).hostname === 'alpha-packed.local');
    const ledgerIndex = uploads.findIndex((entry) => new URL(entry.url).hostname === 'source-ledger.local');
    expect(packedIndex).toBeGreaterThanOrEqual(0);
    expect(ledgerIndex).toBeGreaterThan(packedIndex);
    const packedAt = put.mock.invocationCallOrder[packedIndex]!;
    expect(command.mock.calls.map((call, index) => [call, command.mock.invocationCallOrder[index]!] as const)
      .filter(([call]) => ledgerCommand(call[1])).every(([, order]) => order > packedAt)).toBe(true);
  });

  it.each([
    ['classification_unknown', (): void => { delete raw.streams[0]!.pix_fmt; }],
    ['metadata_unknown', (): void => { delete raw.format.duration; }],
    ['packed_over_cap', (): void => { raw.streams[0]!.codec_name = 'qtrle'; raw.streams[0]!.pix_fmt = 'rgba'; JOB.limits.maxPackedBytes = 1; }],
  ])('V05 a presentation run failing with %s produces no ledger and reports no ledger failure with that code', async (code, arrange) => {
    const saved = JOB.limits.maxPackedBytes;
    try {
      arrange();
      expect(await runAlphaPresentation(job())).toEqual({ ok: false, error: code });
    } finally { JOB.limits.maxPackedBytes = saved; }
    expect(uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local')).toEqual([]);
    expect(command.mock.calls.some(([, args]) => ledgerCommand(args))).toBe(false);
    expect(ledgerFailures().some((entry) => entry.error === code)).toBe(false);
    expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: code });
  });

  it('V06 a ledger failure after the presentation is ready is reported as a ledger failure and leaves the presentation outcome clean', async () => {
    vi.mocked(isoOwner.inspectIsoBmffFile).mockRejectedValue(new Error('reader IO failure'));
    await runAlphaPresentation(job());
    expect(ledgerFailures()).toHaveLength(1);
    expect(reportOrder('probe')).toBeLessThan(reportOrder('source_ledger_failed'));
    expect(reports.find((entry) => entry.kind === 'probe')).toMatchObject({ classification: 'confirmed_opaque' });
    expect(reports.at(-1)).toMatchObject({ kind: 'finished' });
    expect(reports.at(-1)).not.toHaveProperty('error');
    expect(uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local')).toEqual([]);
  });

  it('V07 reports the planner code no_presented_frames when the edits present nothing', async () => {
    iso.tracks[0]!.edits = [];
    await runAlphaPresentation(job());
    expect(ledgerFailures().map((entry) => entry.error)).toEqual(['no_presented_frames']);
  });

  it('V07 reports the planner code unsupported_rate thrown by the assembler', async () => {
    vi.mocked(assemblyOwner.assembleVideoSourceLedgerV2).mockImplementation(() => { throw Object.assign(new Error('rate'), { code: 'unsupported_rate' }); });
    await runAlphaPresentation(job());
    expect(assemblyOwner.assembleVideoSourceLedgerV2).toHaveBeenCalledTimes(1);
    expect(ledgerFailures().map((entry) => entry.error)).toEqual(['unsupported_rate']);
  });

  it('V08 a ledger over its byte budget is not uploaded and reports source_ledger_over_cap', async () => {
    const body = job(); (body.limits.sourceLedger as { maxBytes: number }).maxBytes = 1;
    await runAlphaPresentation(body);
    expect(assemblyOwner.assembleVideoSourceLedgerV2).toHaveBeenCalledTimes(1);
    expect(ledgerFailures().map((entry) => entry.error)).toEqual(['source_ledger_over_cap']);
    expect(uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local')).toEqual([]);
  });

  it('V09 a ledger-only attempt produces the ledger without presentation work', async () => {
    delete raw.format.duration; delete raw.streams[0]!.pix_fmt;
    const body = job(); body.ledgerOnly = true;
    expect(await runAlphaPresentation(body)).toEqual({ ok: true });
    expect(ledger().value.sourceFingerprint).toBe(body.sourceFingerprint);
    expect(command.mock.calls.some(([program, args]) => program === 'ffmpeg' || (args as string[]).includes('-show_pixel_formats'))).toBe(false);
    expect(classificationOwner.classifyVideoAlpha).not.toHaveBeenCalled();
    expect(reports.map((entry) => entry.kind)).toEqual(['finished']);
  });

  it('V10 starts no download, child or PUT after the original deadline', async () => {
    const body = job(); body.deadlineAt = NOW;
    expect(await runAlphaPresentation(body)).toEqual({ ok: false, error: 'expired' });
    expect(download).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });

  it('V10 starts no ledger PUT when the deadline passes during assembly', async () => {
    const body = job();
    vi.mocked(assemblyOwner.assembleVideoSourceLedgerV2).mockImplementation((input) => { const value = realAssemble(input); now = body.deadlineAt; return value; });
    await runAlphaPresentation(body);
    expect(assemblyOwner.assembleVideoSourceLedgerV2).toHaveBeenCalledTimes(1);
    expect(uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local')).toEqual([]);
  });

  it('V11 shares one run per accepted body and refuses a changed same-job body', async () => {
    const body = job(); const [a, b] = await Promise.all([handle(body), handle(body)]);
    expect(a).toEqual(b); expect(a).toMatchObject({ status: 200, value: { ok: true } }); expect(download).toHaveBeenCalledTimes(1); ledger();
    const changed = structuredClone(body); (changed.limits.sourceLedger as { maxBytes: number }).maxBytes++;
    expect(await handle(changed)).toEqual({ status: 500, value: { ok: false, error: 'presentation_failed' } });
  });

  it.each([
    ['the only audio stream', [{ index: 4, id: '0x2', codec_type: 'audio', codec_name: 'aac' }], 2],
    ['the first of two audio streams', [{ index: 4, id: '0x2', codec_type: 'audio', codec_name: 'aac' }, { index: 5, id: '0x3', codec_type: 'audio', codec_name: 'aac' }], 2],
    ['the first audio stream in ffprobe order, not the lowest track id', [{ index: 4, id: '0x3', codec_type: 'audio', codec_name: 'aac' }, { index: 5, id: '0x2', codec_type: 'audio', codec_name: 'aac' }], 3],
  ] as const)('V12 audio edits describe the ISO track of %s (the consumer maps 0:a:0)', async (_name, audio, trackId) => {
    const video = iso.tracks[0]!;
    iso.tracks.push({ ...structuredClone(video), trackId: 2, mediaTimescale: '48000', edits: [{ segmentDurationMovieTicks: '2000', mediaTimeTrackTicks: '1024', mediaRateFixed16_16: '65536' }] });
    iso.tracks.push({ ...structuredClone(video), trackId: 3, mediaTimescale: '48000', edits: [{ segmentDurationMovieTicks: '1000', mediaTimeTrackTicks: '0', mediaRateFixed16_16: '131072' }] });
    raw.streams.push(...audio.map((stream) => ({ ...stream })));
    const body = job();
    expect(await runAlphaPresentation(body)).toEqual({ ok: true });
    const physical = physicalOwner.parsePhysicalVideoProbe({ ...raw, streams: raw.streams }, physicalBytes);
    const assemble = (audioTrackId: number | null): VideoSourceLedgerV2 => assemblyOwner.assembleVideoSourceLedgerV2({ kind: 'iso_bmff', sourceFingerprint: body.sourceFingerprint,
      attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, metadata: iso, physical, audioTrackId }).ledger;
    const expected = assemble(trackId);
    expect(expected.audioEdits).not.toEqual(assemble(trackId === 2 ? 3 : 2).audioEdits);
    expect(expected.audioEdits).not.toBeNull();
    expect(ledger().value).toEqual(expected);
  });

  it.todo('V13 executePresentation passing sourceLedgerOutputURL and registering the ledger outbound host: verified in the real-app run at affected-scope verification');
});
