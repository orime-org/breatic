// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * S6d D2: the basic container's ledger and carrier actions on real media (inner#1306 test plan §91; frames-split design
 * §5.1 steps 3–5, §3.2 item 7, §4.1, §7.1; answers D-3, D-5).
 *
 * Both actions restart from the source (§91 D-3): they download it once, plan it again and check the plan is the one the
 * DO recorded. The ledger action writes the full ledger and its compact projection through the edge PUT of the
 * toolInputId's full key (`writeSourceLedgerPresentation`: table bytes then full bytes, lengths in the query); a ledger-
 * only repair derives the encode facts again. The carrier action writes nothing for identity (the source is the carrier)
 * and, for the basic copy, a stream copy into MP4 whose colour matrix tag is the plan's matrix, written with the codec's
 * `*_metadata` bitstream filter; it answers role-tagged receipts for the store to measure (§91 D2-1).
 *
 * Every fixture is generated here with FFmpeg; assertions use only facts FFmpeg reads back (D-5). The edge is faked at
 * `fetch`: GET of the source, PUT of the ledger and of the carrier, recorded with their bytes.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runOwner from '@ingest/container/presentation-run.js';
import { presentationFrameCount } from '@shared/mini-tools/video-presentation-table.js';
import { videoContainerJobId } from '@shared/mini-tools/video-encode-plan.js';
import { projectVideoPresentationCompact, videoPresentationLedgerSchema, type VideoPresentationLedger } from '@shared/upload/video-presentation-version.js';
import { videoSourceLedgerKeyFor } from '@shared/upload/video-source-ledger.js';

const run = promisify(execFile);
type Action = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
interface Put { url: URL; body: Uint8Array; contentType: string | null }

const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000, sdr_16bit: 294000000, hdr_16bit: 71900000 }, aacEncodeSecondsPerSecond: 100 },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const LIMITS = {
  maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
  sourceLedger: { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 },
};
const IDENTITY_FORMATS = [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }];
const PROBE = { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: IDENTITY_FORMATS };
const SOURCE_BASE = 'http://source.test/';
const JOB = 'video-presentation-a';
// A deadline an hour ahead: the actions bound their work by it (a far-future instant overflows the timer).
const DEADLINE = Date.now() + 3_600_000;

let dir: string;
const files = new Map<string, { path: string; contentType: string }>();
let puts: Put[] = [];
let putStatus = 200;
// When set, the source read answers this type instead of the fixture's (CW01: the receipt takes the registered type, §91 D2-7).
let servedType: string | null = null;

/**
 * Generate one fixture with FFmpeg.
 * @param name - Its file name.
 * @param contentType - The type the source read answers with.
 * @param args - FFmpeg arguments before the output path.
 * @returns Nothing.
 */
async function make(name: string, contentType: string, args: string[]): Promise<void> {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, path]);
  files.set(name, { path, contentType });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'presentation-ledger-carrier-'));
  const tagged = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  await make('cfr.mp4', 'video/mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25']);
  // Untagged sources of the four codecs the copy can tag (§4.1 简单稳定输入: copy writes the plan's matrix). 320x180 resolves BT.601.
  const small = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=0.4'];
  await make('u-h264.mp4', 'video/mp4', [...small, '-c:v', 'libx264', '-g', '2', '-pix_fmt', 'yuv420p']);
  await make('u-hevc.mp4', 'video/mp4', [...small, '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', '-tag:v', 'hvc1']);
  await make('u-vp9.webm', 'video/webm', [...small, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p']);
  await make('u-av1.mp4', 'video/mp4', [...small, '-c:v', 'libaom-av1', '-cpu-used', '8', '-pix_fmt', 'yuv420p']);
  // 1280x720 untagged resolves BT.709 (coded height ≥ 720).
  await make('u-h264-720.mp4', 'video/mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=10:d=0.4', '-c:v', 'libx264', '-g', '2', '-pix_fmt', 'yuv420p']);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => {
  puts = [];
  putStatus = 200;
  servedType = null;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method === 'PUT') {
      const body = new Uint8Array(await new Response(init?.body ?? (input instanceof Request ? input.body : null)).arrayBuffer());
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      puts.push({ url, body, contentType: headers.get('content-type') });
      // §91 D2-2: the Worker measures what landed and answers its receipt; the container forwards it.
      if (url.host === 'presentation-carrier.local' && putStatus === 200) {
        return Response.json({ storageKey: decodeURIComponent(url.pathname.slice(1)), sha256: sha256(body), sizeBytes: body.byteLength, contentType: headers.get('content-type') });
      }
      return new Response(null, { status: putStatus });
    }
    const file = url.href.startsWith(SOURCE_BASE) ? files.get(url.href.slice(SOURCE_BASE.length)) : undefined;
    if (file === undefined) return new Response('missing', { status: 404 });
    const bytes = await readFile(file.path);
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength), 'content-type': servedType ?? file.contentType } });
  }));
});

/**
 * One action of the run module, read at call time.
 * @param name - The export.
 * @returns It.
 */
function action(name: 'runPresentationProbe' | 'runPresentationLedger' | 'runPresentationCarrier'): Action {
  const fn = (runOwner as Record<string, unknown>)[name];
  expect(fn, `${name} is exported from @ingest/container/presentation-run.js`).toBeTypeOf('function');
  return fn as Action;
}

/**
 * The SHA-256 of bytes.
 * @param bytes - The bytes.
 * @returns The hex digest.
 */
function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The fields every action names: the job, its capability token, the source and the frozen probe facts.
 * @param name - The fixture.
 * @returns The fields.
 */
async function common(name: string): Promise<Record<string, unknown>> {
  return { jobId: JOB, sourceFingerprint: sha256(new Uint8Array(await readFile(files.get(name)!.path))), deadlineAt: DEADLINE, token: 'token-a',
    storageKey: `video/${name}`, sourceURL: `${SOURCE_BASE}${name}`, limits: LIMITS, encoding: ENCODING, probe: PROBE };
}

/**
 * The probe answer for a fixture, the plan the DO recorded.
 * @param name - The fixture.
 * @returns The planned answer.
 */
async function probed(name: string): Promise<{ toolInputId: string; planSha256: string; plan: VideoPresentationLedger['plan']; encoding: VideoPresentationLedger['encoding'] }> {
  const { token: _unused, storageKey: _key, ...fields } = await common(name);
  const answer = await action('runPresentationProbe')({ action: 'probe', ...fields }) as { kind: string; toolInputId: string; planSha256: string; plan: VideoPresentationLedger['plan']; encoding: VideoPresentationLedger['encoding'] };
  expect(answer.kind).toBe('planned');
  return answer;
}

/**
 * Packet presentation times of the first video stream, in seconds.
 * @param path - The file.
 * @returns The times.
 */
async function packetTimes(path: string): Promise<string[]> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path]);
  return stdout.trim().split('\n').map((line) => Number(line).toFixed(6)).sort();
}

/**
 * Stream facts of the first video stream.
 * @param path - The file.
 * @returns The facts.
 */
async function streamOf(path: string): Promise<Record<string, string>> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=codec_name,color_space,nb_read_packets:format=format_name,duration', '-of', 'json', path]);
  const parsed = JSON.parse(stdout) as { streams: Record<string, string>[]; format: Record<string, string> };
  // A Matroska/WebM video stream has no `duration` (only a DURATION tag), so durations are compared on the format.
  return { ...parsed.streams[0]!, format_name: parsed.format.format_name!, format_duration: parsed.format.duration! };
}

describe('the ledger action writes full and compact through the edge PUT of the toolInputId (§5.1 step 5, §3.2 item 7)', () => {
  it('LW01 writes one PUT to the full key of the toolInputId: table bytes then full bytes, lengths and identities in the query', async () => {
    const planned = await probed('cfr.mp4');
    const fields = await common('cfr.mp4');
    const answer = await action('runPresentationLedger')({ action: 'ledger', ...fields, toolInputId: planned.toolInputId, encodeFacts: planned.encoding });
    expect(answer).toEqual({ kind: 'written' });
    expect(puts).toHaveLength(1);
    const [put] = puts;
    expect(put!.url.host).toBe('source-ledger.local');
    expect(decodeURIComponent(put!.url.pathname.slice(1))).toBe(videoSourceLedgerKeyFor('video/cfr.mp4', planned.toolInputId));
    const query = Object.fromEntries(put!.url.searchParams);
    const tableLength = Number(query.tableByteLength);
    const fullLength = Number(query.byteLength);
    expect(query).toMatchObject({ jobId: JOB, sourceFingerprint: fields.sourceFingerprint, deadlineAt: String(DEADLINE), token: 'token-a',
      toolInputId: planned.toolInputId, planSha256: planned.planSha256, producerVersion: '2', tableFrameCount: String(presentationFrameCount(planned.plan.presentation)) });
    expect(put!.body.byteLength).toBe(tableLength + fullLength);
    const full = videoPresentationLedgerSchema.parse(JSON.parse(new TextDecoder().decode(put!.body.subarray(tableLength))));
    const compact = JSON.parse(new TextDecoder().decode(put!.body.subarray(0, tableLength))) as unknown;
    expect(full).toMatchObject({ schemaVersion: 2, sourceFingerprint: fields.sourceFingerprint, toolInputId: planned.toolInputId, planSha256: planned.planSha256,
      attempt: { jobId: JOB, deadlineAt: DEADLINE }, encoding: planned.encoding });
    expect(full.plan).toEqual(planned.plan);
    // §7.16: the compact object is the full ledger's projection.
    expect(compact).toEqual(projectVideoPresentationCompact(full));
  });

  it('LW02 a ledger-only repair without encode facts derives the same encode facts from the source', async () => {
    const planned = await probed('cfr.mp4');
    expect(await action('runPresentationLedger')({ action: 'ledger', ...await common('cfr.mp4'), toolInputId: planned.toolInputId, encodeFacts: null })).toEqual({ kind: 'written' });
    const query = Object.fromEntries(puts[0]!.url.searchParams);
    const full = JSON.parse(new TextDecoder().decode(puts[0]!.body.subarray(Number(query.tableByteLength)))) as VideoPresentationLedger;
    // Contract change (design §3.2 item 7): the encoding also records every source keyframe's pts and dts and the first packet
    // dts; cfr.mp4 has no B-frames, so dts equals pts and nothing is shifted.
    const at = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
    expect(full.encoding).toEqual({ keyframeOrdinals: [0, 10, 20, 30, 40], codedWidth: 320, codedHeight: 180,
      sourceKeyframes: [at(0), at(2, 5), at(4, 5), at(6, 5), at(8, 5)].map((time) => ({ pts: time, dts: time })), firstPacketDts: at(0) });
  });

  it('LW05 given encode facts are written as given, even where a re-probe derives others: only null derives them again', async () => {
    const planned = await probed('cfr.mp4');
    const given = { keyframeOrdinals: [0, 25], codedWidth: 320, codedHeight: 180 };
    expect(given).not.toEqual(planned.encoding);
    expect(await action('runPresentationLedger')({ action: 'ledger', ...await common('cfr.mp4'), toolInputId: planned.toolInputId, encodeFacts: given })).toEqual({ kind: 'written' });
    const query = Object.fromEntries(puts[0]!.url.searchParams);
    const full = JSON.parse(new TextDecoder().decode(puts[0]!.body.subarray(Number(query.tableByteLength)))) as VideoPresentationLedger;
    expect(full.encoding).toEqual(given);
  });

  it('LW03 a toolInputId the source does not plan to writes nothing and fails source_ledger_plan_mismatch, a content failure (§91 D2-3)', async () => {
    const answer = await action('runPresentationLedger')({ action: 'ledger', ...await common('cfr.mp4'), toolInputId: 'f'.repeat(64), encodeFacts: null });
    expect(puts).toEqual([]);
    expect(answer).toEqual({ kind: 'failed', code: 'source_ledger_plan_mismatch' });
  });

  it('LW04 an edge that refuses the write (the DO claim) fails source_ledger_failed, not written', async () => {
    const planned = await probed('cfr.mp4');
    putStatus = 409;
    const answer = await action('runPresentationLedger')({ action: 'ledger', ...await common('cfr.mp4'), toolInputId: planned.toolInputId, encodeFacts: planned.encoding });
    // §91 D2-3: the edge refusal is the transient source_ledger_failed.
    expect(answer).toEqual({ kind: 'failed', code: 'source_ledger_failed' });
  });
});

describe('the carrier action (§5.1 steps 3–4, §4.1, §7.1; §91 D2-1, D2-2)', () => {
  it('CW01 identity writes no object and answers the source itself as the native carrier, with the registered content type', async () => {
    const fields = await common('cfr.mp4');
    servedType = 'application/octet-stream';
    const answer = await action('runPresentationCarrier')({ action: 'carrier', ...fields, route: 'identity', contentType: 'video/mp4' });
    expect(puts).toEqual([]);
    expect(answer).toEqual({ kind: 'carrier', receipts: [{ role: 'carrier', packing: 'native', storageKey: 'video/cfr.mp4', sha256: fields.sourceFingerprint,
      sizeBytes: (await stat(files.get('cfr.mp4')!.path)).size, contentType: 'video/mp4' }] });
  });

  it.each([
    ['u-h264.mp4', 'h264', ['smpte170m', 'bt470bg']],
    ['u-hevc.mp4', 'hevc', ['smpte170m', 'bt470bg']],
    ['u-vp9.webm', 'vp9', ['smpte170m', 'bt470bg']],
    ['u-av1.mp4', 'av1', ['smpte170m', 'bt470bg']],
    ['u-h264-720.mp4', 'h264', ['bt709']],
  ] as const)('CW02 copying %s writes one MP4 at the copy key whose %s stream carries the plan matrix, frames and duration unchanged', async (name, codec, matrices) => {
    const source = files.get(name)!.path;
    const answer = await action('runPresentationCarrier')({ action: 'carrier', ...await common(name), route: 'copy', contentType: files.get(name)!.contentType }) as { kind: string; receipts: Record<string, unknown>[] };
    expect(puts).toHaveLength(1);
    const [put] = puts;
    // §91 D2-2: the basic copy writes where the first dispatched copy attempt would, `presentation-copy` attempt 1.
    // The output key is the storage key and the full job id joined by a dot (§5.4; shared WK01, `videoPresentationWorkKeyFor`).
    const key = `video/${name}.${videoContainerJobId({ kind: 'presentation-copy', jobId: JOB, attempt: 1 })}`;
    expect(put!.url.host).toBe('presentation-carrier.local');
    expect(decodeURIComponent(put!.url.pathname.slice(1))).toBe(key);
    expect(put!.contentType).toBe('video/mp4');
    const written = join(dir, `written-${name}.mp4`);
    await writeFile(written, put!.body);
    const before = await streamOf(source);
    const after = await streamOf(written);
    expect(after.format_name).toContain('mp4');
    expect(after.codec_name).toBe(codec);
    expect(matrices as readonly string[]).toContain(after.color_space);
    expect(after.nb_read_packets).toBe(before.nb_read_packets);
    expect(Number(after.format_duration)).toBeGreaterThan(0);
    expect(Number(after.format_duration)).toBeCloseTo(Number(before.format_duration), 3);
    expect(await packetTimes(written)).toEqual(await packetTimes(source));
    // §91 D2-6: faststart, the movie box before the media data.
    const text = new TextDecoder('latin1').decode(put!.body);
    expect(text.indexOf('moov')).toBeGreaterThan(-1);
    expect(text.indexOf('moov')).toBeLessThan(text.indexOf('mdat'));
    // The receipt is the Worker's measurement of what landed, forwarded unchanged (§91 D2-2, D2-7).
    expect(answer).toEqual({ kind: 'carrier', receipts: [{ role: 'carrier', packing: 'native', storageKey: key, sha256: sha256(put!.body), sizeBytes: put!.body.byteLength, contentType: 'video/mp4' }] });
  });

  it('CW03 a carrier write the edge refuses answers a failure', async () => {
    putStatus = 403;
    const answer = await action('runPresentationCarrier')({ action: 'carrier', ...await common('u-h264.mp4'), route: 'copy', contentType: 'video/mp4' }) as { kind: string };
    expect(answer.kind).toBe('failed');
  });
});
