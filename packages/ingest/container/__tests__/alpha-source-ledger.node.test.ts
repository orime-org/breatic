// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { readFile, writeFile, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlphaRunBody } from '@ingest/alpha-run-contract.js';
import { handleAlphaPresentation, runAlphaPresentation } from '@ingest/container/alpha-presentation.js';
import * as isoOwner from '@ingest/container/iso-bmff-metadata.js';
import * as matroskaOwner from '@ingest/container/matroska-metadata.js';
import * as physicalOwner from '@ingest/container/physical-video-probe.js';
import * as assemblyOwner from '@ingest/container/assemble-video-source-ledger.js';
import * as clockOwner from '@ingest/container/alpha-clock.js';
import * as classificationOwner from '@ingest/video-alpha-classification.js';
import type { VideoSourceLedgerCompanion } from '@shared/upload/video-source-ledger-types.js';
import { ORIGINAL_ISO_ASSEMBLY_FIXTURES } from './helpers/source-ledger-assembly-fixtures.js';
import { MATROSKA_PRESENTATION_CASES } from './helpers/matroska-presentation-fixtures.js';
import { sampleMovie, sampleTrack, sampleStts } from './helpers/iso-sample-timing-fixtures.js';
import { block, cluster, document, element, info, trackEntry } from './matroska-metadata-fixtures.js';

const { command, download, put, cpuUsec } = vi.hoisted(() => ({ command: vi.fn(), download: vi.fn(), put: vi.fn(), cpuUsec: vi.fn() }));
vi.mock('@ingest/container/plan-command.js', async (original) => ({ ...await original<Record<string, unknown>>(), runPlanCommand: command }));
vi.mock('@ingest/container/mini-tool-run.js', async (original) => ({ ...await original<Record<string, unknown>>(), download, put, cpuUsec }));

const NOW = Date.parse('2026-10-27T00:00:00Z');
const assembleReal = assemblyOwner.assembleVideoSourceLedger;
const CAPS = { maxBytes: 1000000, probeStdoutBytes: 234567, metadataBytes: 16384, maxPhysicalFrames: 101, maxOccurrences: 103, isoBoxCount: 128, matroskaElementCount: 256, matroskaMaxBlocks: 32 };
const JOB: AlphaRunBody = { jobId: 'producer', sourceFingerprint: 'a'.repeat(64), deadlineAt: NOW + 7200000, token: 'accepted-original-token',
  sourceURL: 'http://media-object.local/canonical', outputURL: 'http://alpha-packed.local/packed', reportURL: 'http://alpha-report.local/canonical',
  sourceLedgerOutputURL: 'http://source-ledger.local/canonical.video-source-ledger.v1.json?jobId=producer&sourceFingerprint=' + 'a'.repeat(64) + '&deadlineAt=' + String(NOW + 7200000) + '&token=accepted-original-token',
  vcpu: 0.25, limits: { sourceLedger: CAPS, maxSourceBytes: 1048576, maxPackedBytes: 1048576, crf: 18, preset: 'medium', probeStdoutBytes: 345678, analysisStdoutBytes: 456789, stderrTailBytes: 16385 } };
const ISO_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const DEFAULT_VIDEO = { index: 3, id: '0x1', codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 64, height: 48, time_base: '1/16384', start_pts: 4096, duration_ts: 34816, disposition: { attached_pic: 0 } };
const CFR = { edits: [], frames: [
  { presentationOrdinal: 0, editOccurrence: 0, rawDecodeOrdinal: 0, sourcePtsTicks: '0', mappedPts: { numerator: '0', denominator: '1' }, displayStart: { numerator: '0', denominator: '1' }, displayEnd: { numerator: '1', denominator: '25' } },
  { presentationOrdinal: 1, editOccurrence: 0, rawDecodeOrdinal: 1, sourcePtsTicks: '40', mappedPts: { numerator: '1', denominator: '25' }, displayStart: { numerator: '1', denominator: '25' }, displayEnd: { numerator: '2', denominator: '25' } },
  { presentationOrdinal: 2, editOccurrence: 0, rawDecodeOrdinal: 2, sourcePtsTicks: '80', mappedPts: { numerator: '2', denominator: '25' }, displayStart: { numerator: '2', denominator: '25' }, displayEnd: { numerator: '3', denominator: '25' } },
] };
let raw: { streams: Record<string, unknown>[]; format: Record<string, unknown> };
let iso: isoOwner.IsoBmffMetadata;
let matroska: matroskaOwner.MatroskaMetadata;
let physicalBytes: Buffer;
let sourceBytes: Buffer;
let sourcePath: string;
let packedMismatch: boolean;
let reports: Record<string, unknown>[];
let uploads: { url: string; file: string; bytes: Buffer; signal: AbortSignal }[];
let ledgerReportRejected: boolean;
let now: number;
let sequence = 0;

/** Return a fresh admitted body; no current configuration is consulted.
 * @throws {never} Never.
 */
function job(): AlphaRunBody {
  const body = { ...structuredClone(JOB), jobId: `producer-${++sequence}` };
  const destination = new URL(body.sourceLedgerOutputURL!); destination.searchParams.set('jobId', body.jobId); body.sourceLedgerOutputURL = destination.href;
  return body;
}

/** Use the original independent explicit input and its exact original frame tokens.
 * @throws {never} Never.
 */
function original(id = 'cfr.mp4'): void {
  const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES.find((entry) => entry.id === id)!;
  iso = structuredClone(fixture.metadata);
  raw = { streams: [{ index: 1, codec_type: 'audio', codec_name: 'aac' }, { ...DEFAULT_VIDEO, time_base: `${fixture.physical.sourceTimeBase.numerator}/${fixture.physical.sourceTimeBase.denominator}` }], format: { format_name: ISO_FORMAT, duration: '2.125' } };
  physicalBytes = Buffer.from(JSON.stringify({ frames: fixture.physical.frames.map((frame) => ({ media_type: 'video', stream_index: 3, pts: frame.ptsTicks, pkt_pos: '200' })) }));
}

/** Install K facts unchanged except a reversible global block-ordinal/offset embedding.
 * @throws {never} Never.
 */
function webm(id = 'K01', largePosition = false): void {
  const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
  matroska = structuredClone(fixture.metadata);
  const base = largePosition ? 9007199254740993n : 0n;
  matroska.blocks = matroska.blocks.map((entry, index) => ({ ...entry, blockOrdinal: [1, 3, 6][index]!, elementOffset: String(BigInt(entry.elementOffset) + base), dataOffset: String(BigInt(entry.dataOffset) + base) }));
  // The audio block makes selected video ordinals genuinely global, not dense.
  matroska.tracks.unshift({ ...matroska.tracks[0]!, trackNumber: '2', trackUid: '8', trackType: '2', codecId: 'A_OPUS' });
  matroska.blocks.unshift({ ...matroska.blocks[0]!, blockOrdinal: 0, trackNumber: '2', elementOffset: String(base + 100n), dataOffset: String(base + 110n) });
  raw = { streams: [{ index: 1, codec_type: 'audio', codec_name: 'aac' }, { ...DEFAULT_VIDEO, codec_name: 'vp9', time_base: '1/1000' }], format: { format_name: 'matroska,webm', duration: '0.12' } };
  const frames = fixture.physical.frames.map((frame, index) => {
    const selected = matroska.blocks[index + 1]!;
    return `{"media_type":"video","stream_index":3,"pts":${frame.ptsTicks},"pkt_pos":${BigInt(selected.elementOffset) + 1n}}`;
  });
  physicalBytes = Buffer.from(`{"frames":[{"media_type":"audio","stream_index":1,"pts":0,"pkt_pos":${base + 101n}},${frames.join(',')}]}`);
}

/** Observe only the new ledger PUT, never a packed derivative.
 * @throws {Error} When a complete ledger was not uploaded.
 */
function ledger(): { upload: typeof uploads[number]; value: VideoSourceLedgerCompanion } {
  const found = uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local');
  expect(found).toHaveLength(1);
  return { upload: found[0]!, value: JSON.parse(found[0]!.bytes.toString('utf8')) as VideoSourceLedgerCompanion };
}

/** Require a stable scoped ledger failure while retaining separate alpha accounting.
 * @throws {Error} When the observed reports violate the adopted independent outcome contract.
 */
function failedLedger(): void {
  const failures = reports.filter((entry) => entry.kind === 'source_ledger_failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]!.error).toEqual(expect.stringMatching(/^[a-z][a-z0-9_]*$/));
  expect(uploads.filter((entry) => new URL(entry.url).hostname === 'source-ledger.local')).toHaveLength(0);
  expect(reports.filter((entry) => entry.kind === 'finished')).toHaveLength(1);
}

/** Dispatch a request through the existing in-memory HTTP replay owner.
 * @throws {Error} When the real handler rejects outside its own response boundary.
 */
async function handle(body: AlphaRunBody): Promise<{ status: number; value: unknown }> {
  let status = 0; let value: unknown;
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const response: ServerResponse = { writeHead: (code: number): ServerResponse => { status = code; return response; }, end: (bytes: string): void => { value = JSON.parse(bytes) as unknown; } } as unknown as ServerResponse;
  await handleAlphaPresentation(request, response);
  return { status, value };
}

beforeEach(() => {
  vi.clearAllMocks(); now = NOW; packedMismatch = false; ledgerReportRejected = false;
  reports = []; uploads = []; sourcePath = ''; sourceBytes = Buffer.from([1, 2, 3]); original();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(isoOwner, 'inspectIsoBmffFile').mockImplementation(async () => iso);
  vi.spyOn(matroskaOwner, 'inspectMatroskaFile').mockImplementation(async () => matroska);
  vi.spyOn(physicalOwner, 'parsePhysicalVideoProbe');
  vi.spyOn(physicalOwner, 'parseMatroskaPhysicalVideoProbe');
  vi.spyOn(assemblyOwner, 'assembleVideoSourceLedger');
  vi.spyOn(clockOwner, 'verifyAlphaPackedClock');
  vi.spyOn(classificationOwner, 'classifyVideoAlpha');
  cpuUsec.mockResolvedValueOnce(100).mockResolvedValue(1000100);
  download.mockImplementation(async (_url: string, file: string) => { sourcePath = file; await writeFile(file, sourceBytes); });
  put.mockImplementation(async (url: string, file: string, signal: AbortSignal) => { uploads.push({ url, file, bytes: await readFile(file), signal }); });
  command.mockImplementation(async (program: string, args: string[]) => {
    if (program === 'ffmpeg') { await writeFile(args.at(-1)!, Buffer.from([4, 5, 6])); return Buffer.alloc(0); }
    if (args.includes('-show_pixel_formats')) return Buffer.from(JSON.stringify({ pixel_formats: [{ name: 'yuv420p', flags: { alpha: 0 } }, { name: 'rgba', flags: { alpha: 1 } }] }));
    const packed = args.at(-1)?.endsWith('packed.mp4') === true;
    if (args.includes('-show_frames')) {
      if (args.includes('-ignore_editlist') || args.includes('-show_entries')) return physicalBytes;
      const frames = ORIGINAL_ISO_ASSEMBLY_FIXTURES[0]!.physical.frames.map((frame, index) => ({ media_type: 'video', stream_index: 3, pts: String(BigInt(frame.ptsTicks) + (packed && packedMismatch && index === 0 ? 1n : 0n)), duration: '2048' }));
      return Buffer.from(JSON.stringify({ frames }));
    }
    return Buffer.from(JSON.stringify(packed ? { ...raw, streams: raw.streams.map((stream) => stream.codec_type === 'video' ? { ...stream, codec_name: 'h264', width: 128, height: 48 } : stream) } : raw));
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const fact = JSON.parse(String(init?.body)) as Record<string, unknown>; reports.push(fact);
    return new Response(null, { status: fact.kind === 'source_ledger_failed' && ledgerReportRejected ? 503 : 200 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('source ledger capability in the actual alpha producer (controlled IO, not FFmpeg evidence)', () => {
  it('P01 preserves the original legacy alpha path without inventing ledger work', async () => {
    const body = job(); delete body.limits.sourceLedger; delete body.sourceLedgerOutputURL;
    expect(await runAlphaPresentation(body)).toEqual({ ok: true });
    expect(download).toHaveBeenCalledTimes(1); expect(isoOwner.inspectIsoBmffFile).not.toHaveBeenCalled(); expect(matroskaOwner.inspectMatroskaFile).not.toHaveBeenCalled();
    expect(assemblyOwner.assembleVideoSourceLedger).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(reports.map((entry) => entry.kind)).toEqual(['probe', 'finished']);
  });

  it('P02 carries frozen eight-field ceilings, original signal/D, full metadata and global index3', async () => {
    const body = job(); const before = structuredClone(body); await runAlphaPresentation(body); const { upload, value } = ledger();
    expect(body).toEqual(before); expect(download).toHaveBeenCalledTimes(1); expect(download.mock.calls[0]![0]).toBe(body.sourceURL);
    const signal = download.mock.calls[0]![2] as AbortSignal;
    const ledgerCommands = command.mock.calls.filter(([, , options]) => (options as { stdoutBytes: number }).stdoutBytes === CAPS.probeStdoutBytes);
    expect(ledgerCommands.length).toBeGreaterThanOrEqual(3);
    expect(ledgerCommands.every(([program, , options]) => program === 'ffprobe' && (options as { signal: AbortSignal; stderrTailBytes: number }).signal === signal && (options as { stderrTailBytes: number }).stderrTailBytes === body.limits.stderrTailBytes)).toBe(true);
    const frames = ledgerCommands.find(([, args]) => (args as string[]).includes('-show_frames'))!;
    expect(frames[1]).toEqual(expect.arrayContaining(['-select_streams', '3', '-show_entries', 'frame=media_type,stream_index,pts,pkt_pos', '-ignore_editlist', '1']));
    expect((frames[1] as string[]).at(-1)).toBe(sourcePath); expect((frames[1] as string[]).join(' ')).not.toMatch(/read_intervals|v:0/);
    expect(isoOwner.inspectIsoBmffFile).toHaveBeenCalledExactlyOnceWith(sourcePath, { metadataBytes: CAPS.metadataBytes, boxCount: CAPS.isoBoxCount });
    expect(assemblyOwner.assembleVideoSourceLedger).toHaveBeenCalledWith(expect.objectContaining({ sourceFingerprint: body.sourceFingerprint, attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, limits: { maxPhysicalFrames: CAPS.maxPhysicalFrames, maxOccurrences: CAPS.maxOccurrences } }));
    expect(value.physical.streamIndex).toBe(3); expect(upload.signal).toBe(signal);
    const url = new URL(upload.url); expect(url.searchParams.get('token')).toBe(body.token); expect(url.searchParams.get('deadlineAt')).toBe(String(body.deadlineAt));
    expect(url.searchParams.get('producerVersion')).toBe('1'); expect(url.searchParams.get('strategy')).toBe('iso_explicit_rate_one'); expect(url.searchParams.get('physicalFrameCount')).toBe('17'); expect(url.searchParams.get('occurrenceCount')).toBe('17');
  });

  it.each(ORIGINAL_ISO_ASSEMBLY_FIXTURES)('P03 uploads original $id literal schedule through real exact parser and assembler', async (fixture) => {
    original(fixture.id); const body = job(); await runAlphaPresentation(body); const { value } = ledger();
    expect(value).toEqual({ schemaVersion: 1, producerVersion: 1, sourceFingerprint: body.sourceFingerprint, attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, strategy: 'iso_explicit_rate_one', physical: { ...fixture.physical, streamIndex: 3 }, container: { kind: 'iso_bmff', movieTimescale: fixture.metadata.movieTimescale, movieDurationTicks: fixture.metadata.movieDurationTicks, track: fixture.metadata.tracks[0] }, presentation: fixture.expected });
    expect(physicalOwner.parsePhysicalVideoProbe).toHaveBeenCalledWith(expect.objectContaining({ streams: raw.streams }), physicalBytes);
  });

  it.each(['index', 'id', 'time_base'])('P02 rejects a changed physical-view %s identity independently from presentation', async (field) => {
    const prior = command.getMockImplementation()!;
    command.mockImplementation(async (program, args, options) => {
      if ((args as string[]).includes('-ignore_editlist') && (args as string[]).includes('-show_streams')) {
        const changed = structuredClone(raw); changed.streams[1]![field] = field === 'index' ? 7 : field === 'id' ? '0x7' : '1/1000'; return Buffer.from(JSON.stringify(changed));
      }
      return prior(program, args, options);
    });
    await runAlphaPresentation(job()); failedLedger(); expect(reports.at(-1)).not.toHaveProperty('error');
  });

  it('P03 preserves unsafe signed numeric frame tokens as the original Buffer, without inventing their window', async () => {
    physicalBytes = Buffer.from('{"frames":[{"media_type":"video","stream_index":3,"pts":-9007199254740993},{"media_type":"video","stream_index":3,"pts":9007199254740993}]}');
    await runAlphaPresentation(job());
    expect(physicalOwner.parsePhysicalVideoProbe).toHaveBeenCalledWith(expect.anything(), physicalBytes);
    expect(vi.mocked(physicalOwner.parsePhysicalVideoProbe).mock.calls[0]![1]).toBe(physicalBytes);
    expect(assemblyOwner.assembleVideoSourceLedger).toHaveBeenCalledWith(expect.objectContaining({ physical: expect.objectContaining({ frames: [{ rawDecodeOrdinal: 0, ptsTicks: '-9007199254740993' }, { rawDecodeOrdinal: 1, ptsTicks: '9007199254740993' }] }) }));
  });

  it('P04 uses original N01 no-elst sample facts without fabricating an edit', async () => {
    iso = { movieTimescale: '1000', movieDurationTicks: '4000', tracks: [{ trackId: 1, trackFlags: 3, durationMovieTicks: '120', mediaTimescale: '1000', mediaDurationTicks: '120', edits: null, sampleTiming: { decodeRuns: [{ sampleCount: 3, deltaTicks: '40' }], cttsVersion: null, compositionRuns: null, compositionShift: null } }] };
    raw.streams[1]!.time_base = '1/1000'; physicalBytes = Buffer.from('{"frames":[{"media_type":"video","stream_index":3,"pts":0},{"media_type":"video","stream_index":3,"pts":40},{"media_type":"video","stream_index":3,"pts":80}]}');
    await runAlphaPresentation(job()); expect(ledger().value.strategy).toBe('iso_unedited_rate_one'); expect(ledger().value.presentation).toEqual(CFR);
  });

  it('P04 keeps explicit empty edits and uploads a genuine zero occurrence count', async () => {
    iso.tracks[0]!.edits = []; await runAlphaPresentation(job()); const { upload, value } = ledger();
    expect(value.strategy).toBe('iso_explicit_rate_one'); expect(value.presentation).toEqual({ edits: [], frames: [] }); expect(value.physical.frames).toHaveLength(17); expect(new URL(upload.url).searchParams.get('occurrenceCount')).toBe('0');
  });

  it.each(['K01', 'K04', 'K08'])('P05 preserves original %s physical-only facts, global blocks and exact large positions', async (id) => {
    webm(id, true); const body = job(); await runAlphaPresentation(body); const { value } = ledger();
    const fixture = MATROSKA_PRESENTATION_CASES.find((entry) => entry.id === id)!;
    expect(value.strategy).toBe('matroska_rate_one'); expect(value.presentation).toEqual(fixture.expected);
    expect(value.physical).toEqual({ ...fixture.physical, frames: fixture.physical.frames.map((frame, index) => ({ ...frame, blockOrdinal: [1, 3, 6][index] })) });
    expect(value.container).toEqual({ kind: 'matroska', timestampScaleNs: matroska.timestampScaleNs, track: matroska.tracks[1], blocks: matroska.blocks.slice(1) });
    expect(physicalOwner.parseMatroskaPhysicalVideoProbe).toHaveBeenCalledWith(expect.objectContaining({ streams: raw.streams }), physicalBytes, matroska);
    expect(command.mock.calls.every(([, args]) => !(args as string[]).includes('-ignore_editlist'))).toBe(true);
    expect(matroskaOwner.inspectMatroskaFile).toHaveBeenCalledExactlyOnceWith(sourcePath, { metadataBytes: CAPS.metadataBytes, elementCount: CAPS.matroskaElementCount, maxBlocks: CAPS.matroskaMaxBlocks });
  });

  it('P06 completes ledger independently before the original unknown alpha-evidence failure', async () => {
    delete raw.streams[1]!.pix_fmt; expect(await runAlphaPresentation(job())).toEqual({ ok: false, error: 'classification_unknown' }); ledger();
    expect(reports.filter((entry) => entry.kind === 'source_ledger_failed')).toEqual([]); expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: 'classification_unknown' });
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(classificationOwner.classifyVideoAlpha).mock.invocationCallOrder[0]!);
  });

  it.each(['duration', 'geometry'])('P07 does not gate exact ledger facts on unavailable %s', async (missing) => {
    if (missing === 'duration') delete raw.format.duration; else { delete raw.streams[1]!.width; delete raw.streams[1]!.height; }
    await runAlphaPresentation(job()); ledger(); expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: 'metadata_unknown' });
  });

  it.each(['multiple-real', 'cover-first'])('P08 isolates actual %s selection mismatch without changing alpha selection rules', async (kind) => {
    raw.streams.unshift({ ...DEFAULT_VIDEO, index: 0, id: '0x7', disposition: { attached_pic: kind === 'cover-first' ? 1 : 0 } });
    await runAlphaPresentation(job()); failedLedger(); expect(physicalOwner.parsePhysicalVideoProbe).not.toHaveBeenCalled();
    expect(reports.at(-1)).toMatchObject(kind === 'multiple-real' ? { kind: 'finished', error: 'classification_unknown' } : { kind: 'finished' });
    if (kind === 'cover-first') expect(reports.at(-1)).not.toHaveProperty('error');
  });

  it.each(['unknown-format', 'reader-failure', 'metadata-exit', 'physical-exit', 'physical-overflow', 'truncated-frame-json', 'write-refused'])('P09 isolates %s and never uploads a partial companion', async (kind) => {
    if (kind === 'unknown-format') raw.format.format_name = 'unsupported_container';
    if (kind === 'reader-failure') vi.mocked(isoOwner.inspectIsoBmffFile).mockRejectedValue(Object.assign(new Error('actual bounded reader refused facts'), { code: 'unsupported_box' }));
    if (kind === 'truncated-frame-json') physicalBytes = Buffer.from('{"frames":[{"media_type":"video","stream_index":3,"pts":4096}');
    if (kind === 'write-refused') put.mockRejectedValue(new Error('the dedicated write was answered 409'));
    if (kind === 'metadata-exit') {
      const prior = command.getMockImplementation()!; command.mockImplementation(async (program, args, options) => {
        if ((options as { stdoutBytes: number }).stdoutBytes === CAPS.probeStdoutBytes) throw new Error('ffprobe exited 1');
        return prior(program, args, options);
      });
    }
    if (kind.startsWith('physical-')) {
      const prior = command.getMockImplementation()!; command.mockImplementation(async (program, args, options) => {
        if ((args as string[]).includes('-show_frames')) throw new Error(kind === 'physical-exit' ? 'ffprobe exited 1' : 'ffprobe stdout exceeded its frozen byte limit');
        return prior(program, args, options);
      });
    }
    await runAlphaPresentation(job()); failedLedger(); expect(reports.at(-1)).not.toHaveProperty('error'); expect(reports.some((entry) => entry.kind === 'probe')).toBe(true);
  });

  it.each(['maxPhysicalFrames', 'maxOccurrences'] as const)('P10 lets the real pure owner reject one-over %s without truncation', async (field) => {
    const body = job(); body.limits.sourceLedger![field] = 16; await runAlphaPresentation(body); failedLedger();
    const input = vi.mocked(assemblyOwner.assembleVideoSourceLedger).mock.calls[0]![0]; expect(input.physical.frames).toHaveLength(17); expect(input.limits[field]).toBe(16); expect(reports.at(-1)).not.toHaveProperty('error');
  });

  it.each(['metadataBytes', 'isoBoxCount'] as const)('P10 passes %s to the real bounded ISO file reader and retains refusal', async (field) => {
    vi.mocked(isoOwner.inspectIsoBmffFile).mockRestore();
    sourceBytes = sampleMovie([sampleTrack({ trackId: 1, sampleBoxes: [sampleStts([{ sampleCount: 3, deltaTicks: '40' }])] })]);
    const body = job(); body.limits.sourceLedger![field] = 1; await runAlphaPresentation(body); failedLedger(); expect(assemblyOwner.assembleVideoSourceLedger).not.toHaveBeenCalled();
  });

  it.each(['metadataBytes', 'matroskaElementCount', 'matroskaMaxBlocks'] as const)('P10 passes %s to the real bounded Matroska file reader and retains refusal', async (field) => {
    webm(); vi.mocked(matroskaOwner.inspectMatroskaFile).mockRestore(); sourceBytes = document([info(), element('1654ae6b', trackEntry(3n, 4n)), cluster(0n, [block(0), block(40)])]);
    const body = job(); body.limits.sourceLedger![field] = 1; await runAlphaPresentation(body); failedLedger(); expect(assemblyOwner.assembleVideoSourceLedger).not.toHaveBeenCalled();
  });

  it.each([0, -1])('P11 measures full UTF-8 serialized bytes at exact cap offset %s', async (offset) => {
    const body = job(); body.jobId += '-é'; const destination = new URL(body.sourceLedgerOutputURL!); destination.searchParams.set('jobId', body.jobId); body.sourceLedgerOutputURL = destination.href;
    const fixture = ORIGINAL_ISO_ASSEMBLY_FIXTURES[0]!;
    const expected = { schemaVersion: 1, producerVersion: 1, sourceFingerprint: body.sourceFingerprint, attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, strategy: 'iso_explicit_rate_one', physical: { ...fixture.physical, streamIndex: 3 }, container: { kind: 'iso_bmff', movieTimescale: iso.movieTimescale, movieDurationTicks: iso.movieDurationTicks, track: iso.tracks[0] }, presentation: fixture.expected };
    body.limits.sourceLedger!.maxBytes = Buffer.byteLength(JSON.stringify(expected), 'utf8') + offset;
    await runAlphaPresentation(body);
    if (offset === 0) { expect(ledger().value).toEqual(expected); expect(ledger().upload.bytes.length).toBe(body.limits.sourceLedger!.maxBytes); }
    else failedLedger();
  });

  it('P12 retains completed ledger and original strict packed clock failure/codec arguments', async () => {
    raw.streams[1]!.codec_name = 'qtrle'; raw.streams[1]!.pix_fmt = 'rgba'; raw.streams[0] = { index: 1, codec_type: 'audio', codec_name: 'opus', time_base: '1/48000', start_pts: 648, duration_ts: 240240, sample_rate: '48000', channels: 2 }; packedMismatch = true;
    expect(await runAlphaPresentation(job())).toEqual({ ok: false, error: 'packed_clock_mismatch' }); ledger();
    expect(clockOwner.verifyAlphaPackedClock).toHaveBeenCalledTimes(1); expect(reports.some((entry) => entry.kind === 'source_ledger_failed')).toBe(false);
    expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: 'packed_clock_mismatch', usage: { cpuUsec: 1000000 } });
    const encode = command.mock.calls.find(([program]) => program === 'ffmpeg')!;
    expect(encode[1]).toEqual(expect.arrayContaining(['-copyts', '-c:v', 'libx264', '-fps_mode:v', 'passthrough', '-enc_time_base:v', '1/16384', '-avoid_negative_ts', 'disabled', '-c:a', 'copy']));
    expect((encode[1] as string[]).join(' ')).not.toMatch(/-shortest|-start_at_zero/); expect(uploads.some((entry) => new URL(entry.url).hostname === 'alpha-packed.local')).toBe(false);
  });

  it('P13 preserves native presentation success and a single actual usage fact after ledger failure', async () => {
    vi.mocked(isoOwner.inspectIsoBmffFile).mockRejectedValue(new Error('original reader IO failure')); await runAlphaPresentation(job()); failedLedger();
    expect(reports.find((entry) => entry.kind === 'probe')).toMatchObject({ classification: 'confirmed_opaque' }); expect(reports.at(-1)).toEqual(expect.objectContaining({ kind: 'finished', usage: { wallMs: 0, cpuUsec: 1000000 } })); expect(reports.at(-1)).not.toHaveProperty('error'); expect(cpuUsec).toHaveBeenCalledTimes(2);
  });

  it('P14 runs only the admitted ledger capability without pixel/classification/duration/packed work', async () => {
    delete raw.format.duration; delete raw.streams[1]!.pix_fmt; const body = job(); body.ledgerOnly = true;
    expect(await runAlphaPresentation(body)).toEqual({ ok: true }); ledger();
    expect(command.mock.calls.some(([program, args]) => program === 'ffmpeg' || (args as string[]).includes('-show_pixel_formats'))).toBe(false);
    expect(reports.map((entry) => entry.kind)).toEqual(['finished']); expect(clockOwner.verifyAlphaPackedClock).not.toHaveBeenCalled();
    expect(classificationOwner.classifyVideoAlpha).not.toHaveBeenCalled();
  });

  it('P15 starts no download/child/PUT after the original deadline already expired', async () => {
    const body = job(); body.deadlineAt = NOW; expect(await runAlphaPresentation(body)).toEqual({ ok: false, error: 'expired' });
    expect(download).not.toHaveBeenCalled(); expect(command).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled(); expect(reports.filter((entry) => entry.kind === 'finished')).toHaveLength(1);
  });

  it('P15 rechecks original D before a later new child and never uploads after expiry', async () => {
    const body = job(); const prior = command.getMockImplementation()!;
    command.mockImplementation(async (program, args, options) => { const result = await prior(program, args, options); now = body.deadlineAt; return result; });
    await runAlphaPresentation(body); expect(command).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(reports.at(-1)).toMatchObject({ kind: 'finished', deadlineAt: body.deadlineAt, error: 'expired' });
  });

  it('P15 retains a completed ledger but starts no alpha child after original D expires', async () => {
    const body = job(); const prior = put.getMockImplementation()!; put.mockImplementation(async (url, file, signal) => { await prior(url, file, signal); now = body.deadlineAt; });
    await runAlphaPresentation(body); ledger(); expect(command.mock.calls.every(([, , options]) => (options as { stdoutBytes: number }).stdoutBytes === CAPS.probeStdoutBytes)).toBe(true); expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: 'expired' });
  });

  it('P15 starts no new PUT when the original deadline expires after pure assembly', async () => {
    const body = job(); vi.mocked(assemblyOwner.assembleVideoSourceLedger).mockImplementation((input) => { const value = assembleReal(input); now = body.deadlineAt; return value; });
    await runAlphaPresentation(body); expect(assemblyOwner.assembleVideoSourceLedger).toHaveBeenCalledTimes(1); expect(put).not.toHaveBeenCalled(); expect(reports.at(-1)).toMatchObject({ kind: 'finished', error: 'expired', deadlineAt: body.deadlineAt });
  });

  it('P16 still cleans and reports one actual finished usage when the scoped failure report rejects', async () => {
    vi.mocked(isoOwner.inspectIsoBmffFile).mockRejectedValue(new Error('original reader failed')); ledgerReportRejected = true;
    let result: unknown; let rejected: unknown; try { result = await runAlphaPresentation(job()); } catch (cause) { rejected = cause; }
    expect(reports.filter((entry) => entry.kind === 'source_ledger_failed')).toHaveLength(1); expect(reports.filter((entry) => entry.kind === 'finished')).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ usage: { cpuUsec: 1000000 } }); expect(cpuUsec).toHaveBeenCalledTimes(2); await expect(access(sourcePath)).rejects.toThrow();
    expect(rejected !== undefined || (typeof result === 'object' && result !== null && 'ok' in result && result.ok === false)).toBe(true); expect(console.error).toHaveBeenCalled();
  });

  it('P17 shares the original accepted HTTP body promise and refuses a changed same-job body', async () => {
    const body = job(); const [a, b] = await Promise.all([handle(body), handle(body)]);
    expect(a).toEqual(b); expect(a).toMatchObject({ status: 200, value: { ok: true } }); expect(download).toHaveBeenCalledTimes(1); ledger();
    const changed = structuredClone(body); changed.limits.sourceLedger!.maxOccurrences++;
    expect(await handle(changed)).toEqual({ status: 500, value: { ok: false, error: 'presentation_failed' } }); expect(download).toHaveBeenCalledTimes(1);
  });
});
