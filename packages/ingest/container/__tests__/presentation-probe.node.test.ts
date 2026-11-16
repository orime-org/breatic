// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6d D1: the basic container's probe action on real media (inner#1306 test plan §91; frames-split design §5.1 step 2,
 * §4.1, §4.2.1, §4.3, §8.2; answers D-3, D-4, D-6).
 *
 * One action of the presentation run contract (`@ingest/presentation-run-contract.js`): the container downloads the
 * source once, reads it by packet-level demux (`-show_packets`: pts, duration, keyframe flag, pos; a frame's source
 * index is its decode order), never decodes every frame (`-show_frames`), decodes a bounded sample of frames to read
 * the decoder-reported pixel format and colour properties, and answers the plan, the full ledger's encode facts, the
 * route facts and the job work. Alpha is confirmed transparent, confirmed opaque or unknown (`classification_unknown`).
 *
 * Every fixture is generated here with FFmpeg, except the HEVC-with-alpha clip (`fixtures/presentation/`, provenance
 * beside it), which needs VideoToolbox. Assertions use only facts FFmpeg reads back (D-5); the HEVC alpha case runs only
 * where FFmpeg is 8 or newer, as in the media image (FFmpeg 7.1 decodes it as yuv420p, §91 D-6 measurement).
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type * as planCommand from '@ingest/container/plan-command.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runOwner from '@ingest/container/presentation-run.js';
import * as contractOwner from '@ingest/presentation-run-contract.js';
import { presentationFrameCount } from '@shared/mini-tools/video-presentation-table.js';
import { chooseVideoCarrierRoute, presentationOutputFps } from '@shared/mini-tools/video-encode-plan.js';
import { videoPresentationPlanSha256, videoPresentationToolInputId } from '@shared/upload/video-presentation-version.js';
import { writePixelCropped } from './helpers/matroska-pixel-crop.js';

const run = promisify(execFile);
const calls = vi.hoisted(() => [] as { program: string; args: string[] }[]);
vi.mock('@ingest/container/plan-command.js', async (original) => {
  const actual = await original<typeof planCommand>();
  return { ...actual, runPlanCommand: vi.fn(async (program: string, args: readonly string[], options: Parameters<typeof actual.runPlanCommand>[2]) => {
    calls.push({ program, args: [...args] });
    return actual.runPlanCommand(program, args, options);
  }) };
});

interface Rational { numerator: string; denominator: string }
interface Plan {
  display: { width: number; height: number; duration: Rational };
  colorMatrix: string;
  source: { transfer: string | null; bitDepth: number };
  output: { toneMap: string; framePngBitDepth: number };
  policy: { singleFrameDurationMs: number; emptyFill: string };
  presentation: { schemaVersion: 1; timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
  originMapping: { origin: Rational; entries: { kind: string }[]; firstSource: { supportStart: Rational; lead: { kind: string; start: Rational } | null };
    lastSource: { support: string; supportEnd: Rational; hold: { kind: string; end: Rational } | null } };
  videoSpans: { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }[] | null;
}
interface Planned {
  kind: 'planned'; toolInputId: string; planSha256: string; plan: Plan;
  encoding: { keyframeOrdinals: number[]; codedWidth: number; codedHeight: number };
  routeInput: { plan: { planSha256: string }; hdr: boolean; alpha: string; identityQualified: boolean; colorMatrixTagged: boolean; codec: string; copyPreservesTimeline: boolean; sourceBytes: number };
  work: { encodedFrames: number; prerollFrames: number; sourceWidth: number; sourceHeight: number; outputWidth: number; outputHeight: number; bitDepth: number; hdr: boolean };
}
type Answer = Planned | { kind: 'failed'; code: string };

const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248000000, decodeConvertPixelsPerSecond: { sdr_8bit: 2200000000, sdr_10bit: 1310000000, sdr_12bit: 816000000, hdr_8bit: 106000000, hdr_10bit: 102000000, hdr_12bit: 109000000 }, aacEncodeSecondsPerSecond: 100 },
  copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const LIMITS = {
  maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536,
  sourceLedger: { maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000 },
};
// §91 D-6: one sampled frame classifies every measured fixture; the default of presentation.probe_sample_frames.
// §91 D1-1: the identity table frozen at admission; the seed is MP4 + H.264 Baseline/Main/High 8-bit 4:2:0 with AAC or no audio.
const IDENTITY_FORMATS = [{ container: 'mp4', videoCodec: 'h264', profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], pixFmt: 'yuv420p', bitDepth: 8, audioCodecs: ['aac', 'none'], rotation: 0, sar: '1:1', matrixTagged: true }];
const PROBE = { sampleFrames: 1, singleFrameDurationMs: 5000, identityFormats: IDENTITY_FORMATS };
const SOURCE_BASE = 'http://source.test/';
const COMMITTED = new URL('./fixtures/presentation/', import.meta.url);
// Read at collection time: the HEVC alpha case needs FFmpeg 8 (the media image), §91 D-6.
const FFMPEG_MAJOR = Number(/ffmpeg version n?(\d+)/.exec(execFileSync('ffmpeg', ['-version']).toString('utf8'))?.[1] ?? 0);

let dir: string;
const files = new Map<string, string>();

/**
 * Generate one fixture with FFmpeg.
 * @param name - Its file name.
 * @param args - FFmpeg arguments before the output path.
 * @returns Nothing.
 */
async function make(name: string, args: string[]): Promise<void> {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args, path]);
  files.set(name, path);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'presentation-probe-'));
  const tagged = ['-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709'];
  await make('cfr.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25']);
  // §93 D6-1: the decode-start evidence samples (B-frames at the end of a GOP, adjacent IDRs, negative CTS offsets).
  for (const [name, options] of [['bf2.mp4', ['-g', '10', '-bf', '2']], ['idr.mp4', ['-g', '50', '-bf', '2', '-force_key_frames', 'expr:eq(n,10)+eq(n,11)']],
    ['neg.mp4', ['-g', '10', '-bf', '2', '-movflags', 'negative_cts_offsets']]] as const) {
    await make(name, ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', ...options, '-pix_fmt', 'yuv420p', ...tagged, '-video_track_timescale', '25']);
  }
  await make('untagged-718.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x718:r=10:d=0.4', '-c:v', 'libx264', '-g', '2', '-pix_fmt', 'yuv420p']);
  await make('untagged-720.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=10:d=0.4', '-c:v', 'libx264', '-g', '2', '-pix_fmt', 'yuv420p']);
  await make('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'untagged-718.mp4'), '-c', 'copy']);
  await make('sar.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=64x32:r=10:d=0.4,setsar=2/1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...tagged]);
  await make('odd.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=161x97:r=10:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', ...tagged]);
  await make('vp9-alpha.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0']);
  await make('prores4444.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']);
  await make('pq10.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  await make('edit-base.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged]);
  // A 250 ms leading empty edit, as in the 2026-11-01 evidence clip (no audio).
  await make('empty-edit.mp4', ['-itsoffset', '0.25', '-i', join(dir, 'edit-base.mp4'), '-c', 'copy', '-use_editlist', '1']);
  // Whole-media edits FFmpeg writes that no mdhd sum states exactly: x264 B-frames in MOV, and a 7-frame 29.97 fps clip whose
  // edit duration is rounded to the 1/1000 movie timescale (234 of 1000 for 7007 of 30000).
  await make('bf2.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '10', '-bf', '2', '-pix_fmt', 'yuv420p', ...tagged]);
  await make('ntsc7.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30000/1001', '-frames:v', '7', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged]);
  // FFmpeg's WebM at rates that are no whole number of milliseconds: block times and the declared duration are each rounded
  // to the 1 ms TimestampScale (0, 33, 67, 100 ms, each lasting 33 ms).
  await make('w30.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30:d=2', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p']);
  await make('w2997.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30000/1001:d=2', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p']);
  // A screen recording's held frames on a 1/600 clock, then FFmpeg's default WebM of it: frames that outlast DefaultDuration
  // carry a BlockDuration rounded to 1 ms, which can end one tick past the next block.
  await make('screen.mp4', ['-f', 'lavfi', '-i', "testsrc2=s=160x96:r=60:d=2,settb=1/600,setpts='N*10+floor(N/4)*30'", '-fps_mode', 'passthrough',
    '-enc_time_base', '1/600', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', '-video_track_timescale', '600']);
  await make('screen.webm', ['-i', join(dir, 'screen.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']);
  // A VFR clip with B-frames written as fragmented MP4, which has no edit list: ffprobe's durations are the decode-order deltas.
  await make('frag-vfr.mp4', ['-f', 'lavfi', '-i', "testsrc2=s=160x96:r=30:d=2,settb=1/90000,setpts='N*3000+if(mod(N\\,3)\\,600\\,0)'", '-fps_mode', 'passthrough',
    '-enc_time_base', '1/90000', '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000', '-movflags', 'frag_keyframe+empty_moov']);
  // x264's default B-frames in Matroska, as an OBS recording: Matroska stores no dts, so the first packets have none.
  await make('bframes.mkv', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30000/1001:d=2', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p']);
  // A VFR clip with B-frames and dropped frames 10 to 14, copied into Matroska: each block keeps the MP4 sample's decode-order
  // duration, so the frame at 600 ms declares 200 ms while the next one starts at 633 ms.
  await make('vfr-bframes.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30:d=2', '-vf', "select='not(between(n\\,10\\,14))'", '-fps_mode', 'passthrough',
    '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p']);
  await make('vfr-bframes.mkv', ['-i', join(dir, 'vfr-bframes.mp4'), '-c', 'copy']);
  // The same clip transcoded to VP9 WebM with FFmpeg defaults: the frame before the drop declares 33 ms though the next block
  // starts 200 ms later, and the frame after it declares 200 ms though the next block starts 33 ms later.
  await make('vfr-bframes.webm', ['-i', join(dir, 'vfr-bframes.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8']);
  // The picture 0.3 s after the audio: an empty edit before media 0 on the video track, AAC from 0.
  await make('late-video.mp4', ['-itsoffset', '0.3', '-i', join(dir, 'edit-base.mp4'), '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2.5',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-use_editlist', '1']);
  files.set('hevc-alpha.mov', new URL('hevc-alpha.mov', COMMITTED).pathname);
  files.set('noelst-ctts.mp4', new URL('noelst-ctts.mp4', COMMITTED).pathname);
  // A stream-copy cut at 0.5 s: packets start at the 0.4 s keyframe and one edit starts 0.1 s (1280 of 12800) later.
  await make('cut.mp4', ['-ss', '0.5', '-i', join(dir, 'edit-base.mp4'), '-c', 'copy']);
  // §91 D1-1 and D1-2: identity qualification and the copy criterion.
  const audio = ['-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100:d=2'];
  const video2s = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=2', '-c:v', 'libx264', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged];
  await make('cfr-aac.mp4', [...video2s.slice(0, 4), ...audio, ...video2s.slice(4), '-c:a', 'aac', '-shortest']);
  await make('alac.mp4', [...video2s.slice(0, 4), ...audio, ...video2s.slice(4), '-c:a', 'alac']);
  await make('hevc.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=0.4', '-c:v', 'libx265', '-pix_fmt', 'yuv420p',
    '-x265-params', 'log-level=error:colorprim=bt709:transfer=bt709:colormatrix=bt709', '-tag:v', 'hvc1']);
  await make('rot90-tagged.mp4', ['-display_rotation', '90', '-i', join(dir, 'cfr.mp4'), '-c', 'copy']);
  await make('prores422.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2', '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le']);
  await make('two-video.mp4', ['-i', join(dir, 'cfr.mp4'), '-i', join(dir, 'edit-base.mp4'), '-map', '0:v', '-map', '1:v', '-c', 'copy']);
  // §91 D1-4: the selected audio window, the Matroska last frame and a ctts-only leading start.
  // 110251 samples at 44.1 kHz end at 2.500023 s, between two 48 kHz samples: the end snaps to sample 120001.
  await make('long-audio.mov', [...video2s.slice(0, 4), '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=44100,atrim=end_sample=110251', ...video2s.slice(4), '-c:a', 'pcm_s16le']);
  await make('two-audio.mov', ['-i', join(dir, 'long-audio.mov'), '-f', 'lavfi', '-i', 'sine=f=220:sample_rate=48000:d=3', '-map', '0:v', '-map', '0:a', '-map', '1:a', '-c:v', 'copy', '-c:a', 'pcm_s16le']);
  // Matroska writes no stream duration (only a DURATION tag), so an Opus track's window comes from its packets.
  const vp9 = ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=2'];
  await make('opus-long.webm', [...vp9, '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2.5', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-c:a', 'libopus']);
  // A 0.4 s video under 10 s of Opus: the decoded-frame list is far longer than the video's packet list.
  await make('opus-tail.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=10', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-c:a', 'libopus']);
  await make('opus.webm', [...vp9, '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-shortest']);
  // Frames at 0, 100, 400 and 500 ms; FFmpeg writes a DefaultDuration, which is replaced by an EBML Void of the same
  // length, so no frame declares a duration (as MediaRecorder recordings in the 2026-10-31 evidence).
  await make('vfr-default.webm', ['-f', 'lavfi', '-i', "testsrc2=s=160x96:r=10:d=0.4,setpts='if(eq(N\\,2)\\,0.4/TB\\,if(eq(N\\,3)\\,0.5/TB\\,PTS))'", '-fps_mode', 'passthrough', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p']);
  const webm = new Uint8Array(await readFile(join(dir, 'vfr-default.webm')));
  await writeFile(join(dir, 'vfr.webm'), withoutDefaultDuration(webm));
  files.set('vfr.webm', join(dir, 'vfr.webm'));
  // 8 s at 30 fps with the DefaultDuration voided, so no frame stores a duration though FFmpeg's reader would estimate one.
  await make('long-nodefault-src.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=30:d=8', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p']);
  await writeFile(join(dir, 'long-nodefault.webm'), withoutDefaultDuration(new Uint8Array(await readFile(join(dir, 'long-nodefault-src.webm')))));
  files.set('long-nodefault.webm', join(dir, 'long-nodefault.webm'));
  // The CFR H.264 source in Matroska, and the same file with a PixelCrop of one column and one row (CT06).
  await make('cfr.mkv', ['-i', join(dir, 'cfr.mp4'), '-c', 'copy']);
  await writePixelCropped(join(dir, 'cfr.mkv'), join(dir, 'cfr-crop.mkv'), { right: 1, bottom: 1 });
  files.set('cfr-crop.mkv', join(dir, 'cfr-crop.mkv'));
}, 120_000);

/**
 * Replace the one Matroska DefaultDuration element (ID 0x23E383) with an EBML Void element of the same length.
 * @param bytes - The WebM bytes.
 * @returns A copy without the element.
 * @throws {Error} When the element is not there exactly once or its size is not a one-byte vint.
 */
function withoutDefaultDuration(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const ids: number[] = [];
  for (let i = 0; i + 3 < copy.length; i += 1) if (copy[i] === 0x23 && copy[i + 1] === 0xe3 && copy[i + 2] === 0x83) ids.push(i);
  if (ids.length !== 1 || (copy[ids[0]! + 3]! & 0x80) === 0) throw new Error('Expected one DefaultDuration with a one-byte size');
  const at = ids[0]!;
  const total = 4 + (copy[at + 3]! & 0x7f);
  copy.set([0xec, 0x80 | (total - 2), ...new Uint8Array(total - 2)], at);
  return copy;
}
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = files.get(url.slice(SOURCE_BASE.length));
    if (!url.startsWith(SOURCE_BASE) || path === undefined) return new Response('missing', { status: 404 });
    const bytes = await readFile(path);
    return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
  }));
});

/**
 * The probe action, read at call time so a missing export fails each case on its own.
 * @returns It.
 */
function probe(): (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> {
  const fn = (runOwner as Record<string, unknown>).runPresentationProbe;
  expect(fn, 'runPresentationProbe is exported from @ingest/container/presentation-run.js').toBeTypeOf('function');
  return fn as (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

/**
 * The SHA-256 of a fixture's bytes.
 * @param name - The fixture.
 * @returns The hex digest.
 */
async function fingerprint(name: string): Promise<string> {
  return createHash('sha256').update(await readFile(files.get(name)!)).digest('hex');
}

/**
 * Probe one fixture through the contract: the request and the answer both parse.
 * @param name - The fixture.
 * @param fields - Request fields that differ.
 * @returns The parsed answer.
 */
async function probed(name: string, fields: Record<string, unknown> = {}): Promise<Answer> {
  const schemas = contractOwner as unknown as Record<string, { parse: (value: unknown) => unknown } | undefined>;
  expect(schemas.presentationRunRequestSchema, 'presentationRunRequestSchema is exported').toBeDefined();
  expect(schemas.presentationProbeAnswerSchema, 'presentationProbeAnswerSchema is exported').toBeDefined();
  const body = schemas.presentationRunRequestSchema!.parse({
    action: 'probe', jobId: 'video-presentation-a', sourceFingerprint: await fingerprint(name), deadlineAt: Date.now() + 3_600_000,
    sourceURL: `${SOURCE_BASE}${name}`, limits: LIMITS, encoding: ENCODING, probe: PROBE, ...fields,
  }) as Record<string, unknown>;
  return schemas.presentationProbeAnswerSchema!.parse(await probe()(body)) as Answer;
}

/**
 * The planned answer, failing the case otherwise.
 * @param answer - An answer.
 * @returns It as planned.
 */
function planned(answer: Answer): Planned {
  expect(answer.kind, JSON.stringify(answer)).toBe('planned');
  return answer as Planned;
}

/**
 * Whether two exact times are equal.
 * @param value - A rational.
 * @param numerator - Expected numerator.
 * @param denominator - Expected denominator.
 * @returns Whether they are equal.
 */
function equals(value: Rational, numerator: number, denominator = 1): boolean {
  return BigInt(value.numerator) * BigInt(denominator) === BigInt(numerator) * BigInt(value.denominator);
}

describe('the plan and the facts of a plain CFR source (design §5.1 step 2, §4.3)', () => {
  it('PP01 answers the plan, its identities, the encode facts, the route facts and the work of a tagged 25 fps H.264', async () => {
    const answer = planned(await probed('cfr.mp4'));
    const { plan } = answer;
    expect(plan.display).toMatchObject({ width: 320, height: 180 });
    expect(equals(plan.display.duration, 2)).toBe(true);
    expect(presentationFrameCount(plan.presentation as never)).toBe(50);
    expect(equals(plan.originMapping.origin, 0)).toBe(true);
    expect(plan.originMapping.entries.every((entry) => entry.kind === 'source')).toBe(true);
    expect(plan.colorMatrix).toBe('bt709');
    expect(plan.source).toEqual({ transfer: 'bt709', bitDepth: 8 });
    expect(plan.output).toEqual({ toneMap: 'none', framePngBitDepth: 8 });
    expect(plan.policy).toEqual({ singleFrameDurationMs: 5000, emptyFill: 'black' });
    expect(answer.planSha256).toBe(await videoPresentationPlanSha256(plan));
    expect(answer.toolInputId).toBe(await videoPresentationToolInputId({ sourceFingerprint: await fingerprint('cfr.mp4'), planSha256: answer.planSha256 }));
    // GOP of 10 with no B frames: the keyframe flags of packets 0, 10, 20, 30 and 40 (read back with ffprobe).
    // §93 D6-1 (contract change, design §3.2 item 7): the encoding records every source keyframe's pts and dts and the first
    // packet dts beside the presented keyframe ordinals; cfr.mp4 has no B-frames, so dts equals pts and nothing is shifted.
    const at = (numerator: number, denominator = 1): { numerator: string; denominator: string } => ({ numerator: String(numerator), denominator: String(denominator) });
    expect(answer.encoding).toEqual({ keyframeOrdinals: [0, 10, 20, 30, 40], codedWidth: 320, codedHeight: 180,
      sourceKeyframes: [at(0), at(2, 5), at(4, 5), at(6, 5), at(8, 5)].map((time) => ({ pts: time, dts: time })), firstPacketDts: at(0) });
    expect(answer.routeInput).toMatchObject({ plan: { planSha256: answer.planSha256 }, hdr: false, alpha: 'confirmed_opaque', colorMatrixTagged: true, codec: 'h264',
      sourceBytes: (await stat(files.get('cfr.mp4')!)).size });
    // Contract change (design §5.4 上限行, §93 D7-1): the work carries the selected audio's seconds; cfr.mp4 has no audio.
    expect(answer.work).toEqual({ encodedFrames: 50, prerollFrames: 0, sourceWidth: 320, sourceHeight: 180, outputWidth: 320, outputHeight: 180, bitDepth: 8, hdr: false, audioSeconds: 0 });
  });

  it('PP02 the same source and frozen policy give the same plan and toolInputId on every run', async () => {
    const first = planned(await probed('cfr.mp4'));
    const second = planned(await probed('cfr.mp4'));
    expect(second.planSha256).toBe(first.planSha256);
    expect(second.toolInputId).toBe(first.toolInputId);
  });

  it('PP03 the frozen single-frame duration is part of the plan, so another value is another tool input', async () => {
    const first = planned(await probed('cfr.mp4'));
    const other = planned(await probed('cfr.mp4', { probe: { ...PROBE, singleFrameDurationMs: 4000 } }));
    expect(other.plan.policy.singleFrameDurationMs).toBe(4000);
    expect(other.toolInputId).not.toBe(first.toolInputId);
  });
});

describe('packet-level demux and a bounded sample decode (design §5.1 step 2; §91 D-6)', () => {
  it('PD01 reads packets with -show_packets and never decodes every frame with -show_frames', async () => {
    planned(await probed('cfr.mp4'));
    expect(calls.some((call) => call.program === 'ffprobe' && call.args.includes('-show_packets'))).toBe(true);
    expect(calls.filter((call) => call.args.includes('-show_frames'))).toEqual([]);
  });

  // §91 D-6: the sample is decoded by ffmpeg, not read with ffprobe -show_frames: FFmpeg 8.0.1's ffprobe reports HEVC with an
  // alpha layer as yuv420p while ffmpeg decodes it as yuva420p; VP9 alpha decodes as yuva only with libvpx-vp9.
  it.each([1, 3])('PD02 decodes at most the frozen sample of %i frame(s) to read the decoder-reported pixel format', async (sampleFrames) => {
    planned(await probed('cfr.mp4', { probe: { ...PROBE, sampleFrames } }));
    const decodes = calls.filter((call) => call.program === 'ffmpeg');
    expect(decodes.length).toBeGreaterThan(0);
    for (const decode of decodes) {
      const at = decode.args.indexOf('-frames:v');
      expect(at, decode.args.join(' ')).toBeGreaterThan(-1);
      expect(Number(decode.args[at + 1])).toBeLessThanOrEqual(sampleFrames);
    }
  });

  it('PD03 the frozen sample count reaches the decode: 3 frames are decoded when the probe facts say 3', async () => {
    planned(await probed('cfr.mp4', { probe: { ...PROBE, sampleFrames: 3 } }));
    const counts = calls.filter((call) => call.program === 'ffmpeg').map((call) => call.args[call.args.indexOf('-frames:v') + 1]);
    expect(counts).toContain('3');
  });
});

describe('colour matrix, geometry and transfer (design §4.3)', () => {
  it.each([
    ['untagged-718.mp4', 'bt601', { width: 1280, height: 718 }],
    ['untagged-720.mp4', 'bt709', { width: 1280, height: 720 }],
    // Rotation swaps the display sides; the matrix follows the coded height (718), as the untagged evidence clip shows.
    ['rot90.mp4', 'bt601', { width: 718, height: 1280 }],
  ] as const)('PC01 an untagged %s resolves %s by the coded height and is not matrix-tagged', async (name, matrix, display) => {
    const answer = planned(await probed(name));
    expect(answer.plan.colorMatrix).toBe(matrix);
    expect(answer.plan.display).toMatchObject(display);
    expect(answer.routeInput.colorMatrixTagged).toBe(false);
    expect(answer.encoding).toMatchObject({ codedWidth: 1280, codedHeight: 718 + (name === 'untagged-720.mp4' ? 2 : 0) });
  });

  it('PC02 SAR 2:1 widens the display as scale=iw*sar:ih does', async () => {
    const answer = planned(await probed('sar.mp4'));
    expect(answer.plan.display).toMatchObject({ width: 128, height: 32 });
    expect(answer.encoding).toMatchObject({ codedWidth: 64, codedHeight: 32 });
  });

  it('PC03 an odd size keeps its display size in the plan; the carrier work pads to even', async () => {
    const answer = planned(await probed('odd.mp4'));
    expect(answer.plan.display).toMatchObject({ width: 161, height: 97 });
    expect(answer.work).toMatchObject({ sourceWidth: 161, sourceHeight: 97, outputWidth: 162, outputHeight: 98 });
  });

  it('PC04 a 10-bit PQ source is HDR: tone mapped to SDR in the plan, HDR in the route and the work', async () => {
    const answer = planned(await probed('pq10.mp4'));
    expect(answer.plan.source).toEqual({ transfer: 'smpte2084', bitDepth: 10 });
    expect(answer.plan.output).toEqual({ toneMap: 'sdr-bt709', framePngBitDepth: 8 });
    expect(answer.routeInput.hdr).toBe(true);
    expect(answer.work).toMatchObject({ bitDepth: 10, hdr: true });
  });
});

describe('alpha classification from real stream properties (design §5.1 step 2, §4.1 透明源; §91 D-6)', () => {
  it.each(['vp9-alpha.webm', 'prores4444.mov'])('PA01 %s is confirmed transparent: empty fill is transparent', async (name) => {
    const answer = planned(await probed(name));
    expect(answer.routeInput.alpha).toBe('confirmed_alpha');
    // §91 D1-3: ProRes 4444 decodes as 12-bit (yuva444p12le); the work carries its 12-bit SDR depth.
    if (name === 'prores4444.mov') expect(answer.work).toMatchObject({ bitDepth: 12, hdr: false });
    expect(answer.plan.policy.emptyFill).toBe('transparent');
  });

  it.runIf(FFMPEG_MAJOR >= 8)('PA02 HEVC with an alpha layer is confirmed transparent (FFmpeg 8 decodes it as yuva420p)', async () => {
    const answer = planned(await probed('hevc-alpha.mov'));
    expect(answer.routeInput.alpha).toBe('confirmed_alpha');
    expect(answer.plan.policy.emptyFill).toBe('transparent');
  });

  it.each(['cfr.mp4', 'untagged-718.mp4', 'pq10.mp4'])('PA03 %s is confirmed opaque', async (name) => {
    expect(planned(await probed(name)).routeInput.alpha).toBe('confirmed_opaque');
  });
});

describe('timeline rules applied by the probe (design §4.2.1 开头行)', () => {
  it('PT01 a 250 ms leading empty edit without earlier audio rebases the start onto the first frame: origin 1/4, duration 2 s, no derived frame', async () => {
    const answer = planned(await probed('empty-edit.mp4'));
    expect(equals(answer.plan.originMapping.origin, 1, 4)).toBe(true);
    expect(equals(answer.plan.display.duration, 2)).toBe(true);
    expect(presentationFrameCount(answer.plan.presentation as never)).toBe(50);
    expect(answer.plan.originMapping.entries.every((entry) => entry.kind === 'source')).toBe(true);
    // The edit moves the media 1/4 s later, so it stays: presentation 0 shows media 0, not media 1/4 (the origin).
    const at = (numerator: number, denominator = 1): Rational => ({ numerator: String(numerator), denominator: String(denominator) });
    expect(answer.plan.videoSpans).toEqual([{ sourceStart: at(0), sourceEnd: at(2), presentationStart: at(0), rate: at(1) }]);
  });

  it.each([['w30.webm', 60, { numerator: '30', denominator: '1' }], ['w2997.webm', 60, { numerator: '30000', denominator: '1001' }]] as const)(
    'PT03 %s: a declared end one container tick short of the next frame is rounding, not a gap: every frame runs to the next, no derived-empty frame', async (name, count, fps) => {
      const { plan } = planned(await probed(name));
      expect(plan.originMapping.entries.every((entry) => entry.kind === 'source')).toBe(true);
      expect(presentationFrameCount(plan.presentation as never)).toBe(count);
      expect(presentationOutputFps(plan.presentation as never)).toEqual(fps);
    });

  it.each([['screen.webm', 120], ['frag-vfr.mp4', 60]] as const)('PT04 %s: a middle frame ends at the next frame, whatever its packet duration says', async (name, count) => {
    const { plan } = planned(await probed(name));
    expect(plan.originMapping.entries.every((entry) => entry.kind === 'source')).toBe(true);
    expect(presentationFrameCount(plan.presentation as never)).toBe(count);
  });

  it('PT05 a B-frame H.264 Matroska file plans: each keyframe decodes from its block time, and nothing is shifted', async () => {
    const { plan, encoding } = planned(await probed('bframes.mkv')) as unknown as { plan: { presentation: unknown }; encoding: { sourceKeyframes: { pts: Rational; dts: Rational }[]; firstPacketDts: Rational } };
    expect(presentationFrameCount(plan.presentation as never)).toBe(60);
    expect(encoding.sourceKeyframes.length).toBeGreaterThan(1);
    encoding.sourceKeyframes.forEach((keyframe) => expect(keyframe.dts).toEqual(keyframe.pts));
    expect(Number(encoding.firstPacketDts.numerator)).toBe(0);
  });

  it('PT06 a Matroska frame declared past the next frame ends where the next one starts', async () => {
    const { plan } = planned(await probed('vfr-bframes.mkv'));
    const table = plan.presentation as { timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
    const frames = table.runs.flatMap((run) => Array.from({ length: run.count }, (_unused, k) => ({ start: run.start + k * run.step, end: run.start + k * run.step + run.duration })));
    const at600 = frames.find((frame) => frame.start * 1000 === 600 * table.timescale)!;
    expect(at600.end * 1000).toBe(633 * table.timescale);
    frames.slice(1).forEach((frame, k) => expect(frame.start).toBeGreaterThanOrEqual(frames[k]!.end));
  });

  it('PT07 a Matroska middle frame shows until the next block starts, as players hold it: a dropped stretch holds the frame before it', async () => {
    const { plan } = planned(await probed('vfr-bframes.webm'));
    expect(plan.originMapping.entries.every((entry) => entry.kind === 'source')).toBe(true);
    const table = plan.presentation as { timescale: number; runs: { start: number; count: number; step: number; duration: number }[] };
    const frames = table.runs.flatMap((run) => Array.from({ length: run.count }, (_unused, k) => ({ start: run.start + k * run.step, end: run.start + k * run.step + run.duration })));
    const at300 = frames.find((frame) => frame.start * 1000 === 300 * table.timescale)!;
    expect(at300.end * 1000).toBe(500 * table.timescale);
  });

  it('PT08 a Matroska frame without a stored duration is undeclared, whatever duration FFmpeg would estimate for it', async () => {
    const { plan } = planned(await probed('long-nodefault.webm'));
    expect((plan.originMapping as { lastSource: { support: string } }).lastSource.support).toBe('previous-max');
  });

  it('PT02 the picture 0.3 s after the audio: origin 0, the first frame held from 0 as derived-lead, and the edit kept at 3/10', async () => {
    const { plan } = planned(await probed('late-video.mp4'));
    const at = (numerator: number, denominator = 1): Rational => ({ numerator: String(numerator), denominator: String(denominator) });
    expect(plan.originMapping.origin).toEqual(at(0));
    expect(plan.originMapping.firstSource).toEqual({ supportStart: at(3, 10), lead: { kind: 'derived-lead', start: at(0) } });
    expect(plan.videoSpans).toEqual([{ sourceStart: at(0), sourceEnd: at(2), presentationStart: at(3, 10), rate: at(1) }]);
  });
});

describe('identity qualification from the versioned format table (design §4.1; §91 D1-1)', () => {
  it.each(['cfr.mp4', 'cfr-aac.mp4'])('IQ01 a seeded combination qualifies: %s (MP4, H.264 High 8-bit 4:2:0, tagged, no rotation, SAR 1:1, AAC or no audio)', async (name) => {
    const answer = planned(await probed(name));
    expect(answer.routeInput.identityQualified).toBe(true);
  });

  it.each([
    ['an unlisted video codec (HEVC)', 'hevc.mp4'],
    ['a rotation of 90', 'rot90-tagged.mp4'],
    ['SAR 2:1', 'sar.mp4'],
    ['an unsupported audio codec (ALAC)', 'alac.mp4'],
    ['an untagged matrix', 'untagged-720.mp4'],
    ['4:4:4 chroma', 'odd.mp4'],
    ['a codec outside the table (ProRes)', 'prores422.mov'],
  ])('IQ02 %s does not qualify', async (_name, file) => {
    expect(planned(await probed(file)).routeInput.identityQualified).toBe(false);
  });
});

describe('each field of the frozen identity table decides on its own (§91 D1-1)', () => {
  const seed = IDENTITY_FORMATS[0]!;

  it('IQ03 the seeded table qualifies the plain CFR source', async () => {
    expect(planned(await probed('cfr.mp4', { probe: { ...PROBE, identityFormats: [seed] } })).routeInput.identityQualified).toBe(true);
  });

  it.each([
    ['container', { container: 'mov' }],
    ['video codec', { videoCodec: 'hevc' }],
    ['profiles', { profiles: ['Main'] }],
    ['pixel format', { pixFmt: 'yuv444p' }],
    ['bit depth', { bitDepth: 10 }],
    ['audio codecs (the source has no audio)', { audioCodecs: ['aac'] }],
  ])('IQ03 a table that differs from the CFR source only in %s does not qualify it', async (_field, change) => {
    const answer = planned(await probed('cfr.mp4', { probe: { ...PROBE, identityFormats: [{ ...seed, ...change }] } }));
    expect(answer.routeInput.identityQualified).toBe(false);
  });

  // The source plays as-is only when its picture is the coded one: a Matroska PixelCrop is part of the display geometry (§4.3).
  it('IQ04 a table that names Matroska qualifies the Matroska source until it carries a PixelCrop', async () => {
    const table = { probe: { ...PROBE, identityFormats: [{ ...IDENTITY_FORMATS[0]!, container: 'matroska' }] } };
    expect(planned(await probed('cfr.mkv', table)).routeInput.identityQualified).toBe(true);
    expect(planned(await probed('cfr-crop.mkv', table)).routeInput.identityQualified).toBe(false);
  });
});

describe('whether a stream copy keeps the plan timeline (design §4.1 row 2; §91 D1-2)', () => {
  // hevc.mp4 has B frames (has_b_frames 2): its one edit starts at media time 1024 of 12800, the track's minimum CTS, so the
  // edit is the media start and the plan is unaltered (design line 282, inner f446990c).
  it.each(['cfr.mp4', 'hevc.mp4'])('CT01 an unaltered plan with one video track whose codec the MP4 carrier can hold copies: %s', async (name) => {
    expect(planned(await probed(name)).routeInput.copyPreservesTimeline).toBe(true);
  });

  // One rate-1 edit from movie 0 over exactly the presented frames, the media's first pts to its last frame's end (within one
  // movie tick, the precision elst durations are written in), is no edit (design §5.3 row): the plan is unaltered and copies.
  it.each(['bf2.mp4', 'bf2.mov', 'ntsc7.mp4'])('CT05 a whole-media edit that differs from mdhd or is rounded to the movie timescale is no edit: %s', async (name) => {
    const answer = planned(await probed(name));
    expect(answer.plan.videoSpans).toBeNull();
    expect(answer.routeInput.copyPreservesTimeline).toBe(true);
  });

  it('CT04 a single edit starting later than the track\'s first CTS is a cut, not the media start: the plan is altered and does not copy', async () => {
    const answer = planned(await probed('cut.mp4'));
    expect(answer.routeInput.copyPreservesTimeline).toBe(false);
    // The edit presents media [0.1, 1.6) s: 1.5 s, frames 2 to 39 of the 40 copied (the first one partly, design §4.1 row 2).
    expect(equals(answer.plan.display.duration, 3, 2)).toBe(true);
    expect(presentationFrameCount(answer.plan.presentation as never)).toBe(38);
  });

  it('CT02 a codec the MP4 carrier cannot hold (ProRes) does not copy', async () => {
    expect(planned(await probed('prores422.mov')).routeInput.copyPreservesTimeline).toBe(false);
  });

  // A Matroska PixelCrop is part of the display geometry (§4.3), which a copied carrier does not keep.
  it('CT06 a Matroska source copies until it carries a PixelCrop, which also crops its display size', async () => {
    expect(planned(await probed('cfr.mkv')).routeInput.copyPreservesTimeline).toBe(true);
    const answer = planned(await probed('cfr-crop.mkv'));
    expect(answer.routeInput.copyPreservesTimeline).toBe(false);
    expect(answer.plan.display).toMatchObject({ width: 319, height: 179 });
  });

  it.each([
    ['a hold after the video (audio continues)', 'long-audio.mov'],
    ['a derived last-frame support (Matroska previous-max)', 'vfr.webm'],
  ])('CT03 an altered plan does not copy: %s', async (_name, file) => {
    expect(planned(await probed(file)).routeInput.copyPreservesTimeline).toBe(false);
  });
});

// §93 D6 (frames-split design §4.1 row 2, §4.3 audio row, round 2): a copy keeps the selected audio packets only when its
// codec is in the MP4 entry's `audio_codecs` of `identity_formats`; any other audio goes to the dispatched copy, whose
// standard-4 `copy_carrier` copies the video and encodes the audio to AAC. The route is chosen from the probe's own route facts.
// §93 D7-1 (frames-split design §5.4 上限行, §4.1 row 2): the probe reports the selected audio's duration for the dispatched
// copy's estimate: `work.audioSeconds`, the first audio stream in ffprobe order, 0 without audio. The oracle is ffprobe's
// own duration of that stream.
describe('the selected audio\'s seconds in the probe work (§93 D7-1; design §5.4)', () => {
  it.each([['cfr-aac.mp4'], ['alac.mp4'], ['two-audio.mov']])('AW01 %s: work.audioSeconds is the first audio stream\'s duration', async (file) => {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', files.get(file)!]);
    const work = planned(await probed(file)).work as unknown as { audioSeconds?: number };
    expect(work.audioSeconds).toBeCloseTo(Number(stdout.trim()), 3);
  });

  it('AW02 a source without audio: work.audioSeconds is 0', async () => {
    expect((planned(await probed('cfr.mp4')).work as unknown as { audioSeconds?: number }).audioSeconds).toBe(0);
  });
});

describe('copyable audio is identity_formats\' MP4 audio_codecs (§93 D6; design §4.1 row 2)', () => {
  const ROOM = { selected: null, copyDiskMarginBytes: 0, basicDiskBytes: 1e12 };
  /** The route of a probed file under a frozen identity table whose H.264 profiles never match, so identity is out. */
  const routeOf = async (file: string, audioCodecs: string[]): Promise<string> => {
    const table = [{ ...IDENTITY_FORMATS[0]!, profiles: ['None'], audioCodecs }];
    const answer = planned(await probed(file, { probe: { ...PROBE, identityFormats: table } }));
    expect(answer.routeInput.copyPreservesTimeline, `${file} keeps its timeline under a copy`).toBe(true);
    return chooseVideoCarrierRoute({ ...(answer.routeInput as unknown as Parameters<typeof chooseVideoCarrierRoute>[0]), ...ROOM });
  };

  it('CA10 AAC audio, listed: a basic packet copy', async () => {
    expect(await routeOf('cfr-aac.mp4', ['aac', 'none'])).toBe('copy');
  });

  it('CA11 ALAC audio, not listed: the dispatched copy that encodes the audio', async () => {
    expect(await routeOf('alac.mp4', ['aac', 'none'])).toBe('dispatch_copy');
  });

  it('CA12 ALAC audio, listed in the frozen table: a basic packet copy', async () => {
    expect(await routeOf('alac.mp4', ['aac', 'alac', 'none'])).toBe('copy');
  });
});

// §93 D6-1 (frames-split design §5.1 探测行 「-show_packets取pts、dts…」, §3.2 item 7): the probe reads packet dts and the full's
// encoding records every source keyframe's pts and dts (presented or not) and the stream's first packet dts, as exact times on
// the media timeline with the edit list ignored. The oracle is ffprobe's own packet list of the same file.
describe('source keyframes and the first packet dts in the encode facts (§93 D6-1; design §5.1, §3.2 item 7)', () => {
  /** A time of these 1/25 s samples as a reduced exact rational. */
  const exact = (seconds: number): { numerator: string; denominator: string } => {
    const n = Math.round(seconds * 25); let [a, b] = [Math.abs(n), 25]; while (b !== 0) [a, b] = [b, a % b];
    const g = a === 0 ? 25 : a;
    return { numerator: String(n / g), denominator: String(25 / g) };
  };
  /** ffprobe's keyframes and first packet dts of a sample, edit list ignored. */
  const oracle = async (file: string): Promise<{ sourceKeyframes: unknown[]; firstPacketDts: unknown }> => {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-ignore_editlist', '1', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'csv=p=0', files.get(file)!]);
    const packets = stdout.trim().split('\n').map((line) => line.split(',')).map(([pts, dts, flags]) => ({ pts: Number(pts), dts: Number(dts), key: flags!.includes('K') }));
    return { sourceKeyframes: packets.filter((packet) => packet.key).sort((a, b) => a.pts - b.pts).map((packet) => ({ pts: exact(packet.pts), dts: exact(packet.dts) })),
      firstPacketDts: exact(packets[0]!.dts) };
  };

  it.each(['cfr.mp4', 'bf2.mp4', 'idr.mp4', 'neg.mp4'])('KP01 %s: every source keyframe\'s pts and dts and the first packet dts', async (file) => {
    const encoding = planned(await probed(file)).encoding as unknown as Record<string, unknown>;
    expect({ sourceKeyframes: encoding.sourceKeyframes, firstPacketDts: encoding.firstPacketDts }).toEqual(await oracle(file));
  });

  it('KP02 the negative-CTS sample\'s first packet dts is negative and its keyframe dts precede their pts', async () => {
    const encoding = planned(await probed('neg.mp4')).encoding as unknown as { sourceKeyframes?: { pts: { numerator: string }; dts: { numerator: string } }[]; firstPacketDts?: { numerator: string } };
    expect(Number(encoding.firstPacketDts?.numerator)).toBeLessThan(0);
    expect(encoding.sourceKeyframes?.[0]).toEqual({ pts: exact(0), dts: exact(-0.04) });
  });
});

describe('audio window, Matroska last frame and leading start (design §4.2, §4.2.1; §91 D1-4)', () => {
  it('AU01 audio past the video end extends the presentation to its end snapped to 48 kHz, with a derived hold on the last frame', async () => {
    const answer = planned(await probed('long-audio.mov'));
    // round-half-away(110251 × 48000 / 44100) = round(120001.088) = 120001.
    expect(equals(answer.plan.display.duration, 120001, 48000)).toBe(true);
    expect(answer.plan.originMapping.lastSource.hold?.kind).toBe('derived-hold');
    expect(equals(answer.plan.originMapping.lastSource.hold!.end, 120001, 48000)).toBe(true);
    expect(equals(answer.plan.originMapping.lastSource.supportEnd, 2)).toBe(true);
    expect(presentationFrameCount(answer.plan.presentation as never)).toBe(50);
  });

  it('AU02 the selected audio is the first audio stream in ffprobe order, not the longest', async () => {
    const answer = planned(await probed('two-audio.mov'));
    expect(equals(answer.plan.display.duration, 120001, 48000)).toBe(true);
  });

  it('AU03 audio that ends with the video adds no hold', async () => {
    const answer = planned(await probed('cfr-aac.mp4'));
    expect(equals(answer.plan.display.duration, 2)).toBe(true);
    expect(answer.plan.originMapping.lastSource.hold).toBeNull();
  });

  it('AU04 a WebM whose Opus track carries no stream duration takes its window from the audio packets', async () => {
    const longer = planned(await probed('opus-long.webm'));
    expect(Number(longer.plan.display.duration.numerator) / Number(longer.plan.display.duration.denominator)).toBeGreaterThan(2.4);
    expect(longer.plan.originMapping.lastSource.hold?.kind).toBe('derived-hold');
    const even = planned(await probed('opus.webm'));
    expect(Number(even.plan.display.duration.numerator) / Number(even.plan.display.duration.denominator)).toBeLessThan(2.1);
  });

  it('AU05 the decoded Opus frames are streamed, so a frame list past the ledger\'s probe stdout bound still plans', async () => {
    // 10 packets of video list in about 2 KB of JSON; 500 decoded Opus frames would take about 37 KB.
    const answer = planned(await probed('opus-tail.webm', { limits: { ...LIMITS, sourceLedger: { ...LIMITS.sourceLedger, probeStdoutBytes: 16384 } } }));
    expect(Number(answer.plan.display.duration.numerator) / Number(answer.plan.display.duration.denominator)).toBeGreaterThan(9.9);
  });

  it('MK01 a Matroska last frame without BlockDuration or DefaultDuration takes the largest earlier frame duration (previous-max)', async () => {
    const answer = planned(await probed('vfr.webm'));
    // Frames at 0, 100, 400, 500 ms: earlier durations 100, 300, 100; the last ends at 500 + 300 ms. Info.Duration (0.6 s) is not used.
    expect(presentationFrameCount(answer.plan.presentation as never)).toBe(4);
    expect(answer.plan.originMapping.lastSource.support).toBe('previous-max');
    expect(equals(answer.plan.display.duration, 4, 5)).toBe(true);
  });

  it('CL01 a first frame starting at 0.25 s through ctts alone, without an edit list or audio, rebases onto the first frame', async () => {
    const answer = planned(await probed('noelst-ctts.mp4'));
    // 17 frames of 2048 ticks on 1/16384 start at 4096: origin 1/4, duration 17 × 1/8 s.
    expect(equals(answer.plan.originMapping.origin, 1, 4)).toBe(true);
    expect(equals(answer.plan.display.duration, 17, 8)).toBe(true);
    expect(presentationFrameCount(answer.plan.presentation as never)).toBe(17);
    expect(answer.plan.colorMatrix).toBe('bt601');
  });
});

describe('failures (design §10.6 失败分类)', () => {
  it('PF02 two video tracks are not a single video track: classification_unknown', async () => {
    expect(await probed('two-video.mp4')).toEqual({ kind: 'failed', code: 'classification_unknown' });
  });

  it('PF01 a source over the frozen byte cap answers source_over_cap', async () => {
    expect(await probed('cfr.mp4', { limits: { ...LIMITS, maxSourceBytes: 1024 } })).toEqual({ kind: 'failed', code: 'source_over_cap' });
  });
  it('PF03 a source ffprobe cannot open (an MP4 header and noise: moov atom not found) is the source\'s failure, probe_invalid', async () => {
    const path = join(dir, 'unreadable.mp4');
    const header = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
    await writeFile(path, Buffer.concat([header, createHash('sha256').update('noise').digest(), Buffer.alloc(4096, 0x5a)]));
    files.set('unreadable.mp4', path);
    expect(await probed('unreadable.mp4')).toEqual({ kind: 'failed', code: 'probe_invalid' });
  });
});

