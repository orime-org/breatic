// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The basic container's presentation probe on real media (inner#1306 test plan §65.1 E01; frames-split design §5.1 step 2,
 * §3.2, §4.1–§4.3).
 *
 * The probe downloads the source once, reads every video packet with `-show_packets` (never `-show_frames`), decodes a bounded
 * sample to read the decoder-reported pixel format, takes the display geometry from FFmpeg's default decode of the first frame,
 * and answers the plan with its digest and versions, the tool-source facts and the grid inputs and estimate the decode-only
 * count completes. Alpha is confirmed transparent, confirmed opaque or unknown (`classification_unknown`).
 *
 * Every fixture is generated here with FFmpeg, except the HEVC-with-alpha clip in `fixtures/presentation/` (provenance beside
 * it), which needs VideoToolbox; that case runs only where FFmpeg is 8 or newer, as in the media image.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type * as planCommand from '@ingest/container/plan-command.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as runOwner from '@ingest/container/presentation-run.js';
import { presentationProbeAnswerSchema, presentationRunRequestSchema, type PresentationProbeAnswerParsed } from '@ingest/presentation-run-contract.js';
import { videoPresentationPlanSha256 } from '@shared/upload/video-presentation-version.js';

const run = promisify(execFile);
const calls = vi.hoisted(() => [] as { program: string; args: string[] }[]);
vi.mock('@ingest/container/plan-command.js', async (original) => {
  const actual = await original<typeof planCommand>();
  return { ...actual, runPlanCommand: vi.fn(async (program: string, args: readonly string[], options: Parameters<typeof actual.runPlanCommand>[2]) => {
    calls.push({ program, args: [...args] });
    return actual.runPlanCommand(program, args, options);
  }) };
});

type Planned = Extract<PresentationProbeAnswerParsed, { kind: 'planned' }>;

const SOURCE_RATES = {
  sdr_8bit: 910e6, sdr_10bit: 810e6, sdr_12bit: 690e6, sdr_alpha_layer: 600e6, sdr_prores: 820e6, sdr_dnx: 735e6, sdr_av1_8bit: 740e6, sdr_av1_10bit: 570e6,
  sdr_av1_12bit: 610e6, sdr_jpeg2000: 25e6, sdr_ffv1: 75e6, sdr_png: 340e6, sdr_other: 1080e6,
};
const EDIT_TIERS = { edit_h264_intra_8bit_420: 1500e6, edit_h264_intra_10bit_420: 1200e6, edit_h264_intra_8bit_444: 1100e6, edit_h264_intra_10bit_444: 900e6, edit_prores: 950e6 };
const ENCODING = {
  chunkShare: 0.5, maxParallelChunks: 8,
  encoder: { startSeconds: 3, encodePixelsPerSecond: 248e6, tonemapPixelsPerSecond: 1170e6, decodeConvertPixelsPerSecond: { ...SOURCE_RATES, ...EDIT_TIERS },
    editEncodePixelsPerSecond: EDIT_TIERS, aacEncodeSecondsPerSecond: 100 },
  edit: { crf: 15, preset: 'medium', proresProfile: '4444', bytesPerPixel: 0.5, maxEditBytes: 10_000_000_000 },
  carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
};
const LIMITS = { maxSourceBytes: 1073741824, maxPackedBytes: 1073741824, crf: 18, preset: 'medium', probeStdoutBytes: 268435456, analysisStdoutBytes: 16777216, stderrTailBytes: 65536 };
const PROBE = { sampleFrames: 1, singleFrameDurationMs: 5000, maxFps: 120 };
const SOURCE_BASE = 'http://source.test/';
const COMMITTED = new URL('./fixtures/presentation/', import.meta.url);
const HEX = /^[a-f0-9]{64}$/u;
// Read at collection time: the HEVC alpha case needs FFmpeg 8 (the media image).
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
  await make('untagged-718.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x718:r=10:d=0.4', '-c:v', 'libx264', '-g', '2', '-pix_fmt', 'yuv420p']);
  await make('rot90.mp4', ['-display_rotation', '90', '-i', join(dir, 'untagged-718.mp4'), '-c', 'copy']);
  await make('sar.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=64x32:r=10:d=0.4,setsar=2/1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...tagged]);
  await make('odd.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=161x97:r=10:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', ...tagged]);
  await make('vp9-alpha.webm', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0']);
  // 16 bits per channel with a half alpha, as After Effects' 16 bpc PNG-in-MOV export, and grey with alpha at 16 bits.
  await make('png-rgba64.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2,format=rgba,colorchannelmixer=aa=0.5,format=rgba64be', '-c:v', 'png']);
  await make('png-ya16.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2,format=rgba,colorchannelmixer=aa=0.5,format=ya16be', '-c:v', 'png']);
  await make('prores4444.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.2,format=yuva444p10le', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']);
  await make('pq10.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=25:d=0.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p10le', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']);
  // Origin 0 with audio 0.1 s longer than the 30 fps video: the last frame holds until the audio ends (§4.1 grid end row).
  await make('hold.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000:d=2.1',
    '-c:v', 'libx264', '-g', '30', '-bf', '0', '-pix_fmt', 'yuv420p', ...tagged, '-c:a', 'aac']);
  await make('two-video.mp4', ['-i', join(dir, 'cfr.mp4'), '-i', join(dir, 'sar.mp4'), '-map', '0:v', '-map', '1:v', '-c', 'copy']);
  files.set('hevc-alpha.mov', new URL('hevc-alpha.mov', COMMITTED).pathname);
}, 120_000);

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
async function probed(name: string, fields: Record<string, unknown> = {}): Promise<PresentationProbeAnswerParsed> {
  const body = presentationRunRequestSchema.parse({
    action: 'probe', jobId: 'video-presentation-a', sourceFingerprint: await fingerprint(name), deadlineAt: Date.now() + 3_600_000,
    sourceURL: `${SOURCE_BASE}${name}`, limits: LIMITS, encoding: ENCODING, probe: PROBE, ...fields,
  });
  return presentationProbeAnswerSchema.parse(await runOwner.runPresentationProbe(body));
}

/**
 * The planned answer, failing the case otherwise.
 * @param answer - An answer.
 * @returns It as planned.
 */
function planned(answer: PresentationProbeAnswerParsed): Planned {
  expect(answer.kind, JSON.stringify(answer)).toBe('planned');
  return answer as Planned;
}

describe('the plan and the facts of a plain CFR source (design §5.1 step 2, §3.2)', () => {
  it('PP01 answers the plan, its digest, the sha256 versions, the tool-source facts and the grid estimate of a tagged 25 fps H.264', async () => {
    const answer = planned(await probed('cfr.mp4'));
    expect(answer.plan).toEqual({
      gridRulesVersion: 1, grid: { fps: { numerator: 25, denominator: 1 }, gridStart: expect.objectContaining({ numerator: 0 }), leadFrames: 0, gridEnd: null, singleFrameDurationMs: 5000 },
      toolSource: 'original', audioTrack: null, display: { width: 320, height: 180 }, color: { matrix: 'bt709', toneMap: 'none' }, framePngBitDepth: 8,
    });
    expect(answer.planSha256).toBe(await videoPresentationPlanSha256(answer.plan));
    expect(answer.versions.producerVersion).toMatch(HEX);
    expect(answer.versions.profileVersion).toMatch(HEX);
    expect(answer.versions.editProfileVersion).toBeNull();
    expect(answer.source).toMatchObject({ sourceDecodeKey: 'sdr_8bit', hdr: false, alpha: false, editTier: null, seekable: true, bitDepth: 8,
      keyframes: { earliestKeyframeTime: 0, allKeyframes: false } });
    expect(answer.estimate).toMatchObject({ sourceFrames: 50, frameCount: 50, realFrameCount: 50 });
  });

  it('PP02 the same source and frozen policy give the same plan and versions on every run', async () => {
    const [first, second] = [planned(await probed('cfr.mp4')), planned(await probed('cfr.mp4'))];
    expect(second.planSha256).toBe(first.planSha256);
    expect(second.versions).toEqual(first.versions);
  });

  it('PP03 the frozen single-frame duration is part of the plan, so another value is another plan', async () => {
    const other = planned(await probed('cfr.mp4', { probe: { ...PROBE, singleFrameDurationMs: 4000 } }));
    expect(other.planSha256).not.toBe(planned(await probed('cfr.mp4')).planSha256);
  });

  it('PP04 only the frozen playback crf changes: the plan stays and the playback profile version changes (§3.2, §7.1)', async () => {
    const base = planned(await probed('cfr.mp4'));
    const other = planned(await probed('cfr.mp4', { limits: { ...LIMITS, crf: 20 } }));
    expect(other.planSha256).toBe(base.planSha256);
    expect(other.versions.profileVersion).not.toBe(base.versions.profileVersion);
    expect(other.versions.producerVersion).toBe(base.versions.producerVersion);
  });
});

describe('packet-level demux and a bounded sample decode (design §5.1 step 2)', () => {
  it('PD01 reads every video packet\'s pts, dts, duration and flags and never decodes every frame with -show_frames', async () => {
    planned(await probed('cfr.mp4'));
    expect(calls.some((call) => call.program === 'ffprobe' && call.args.includes('packet=pts,dts,duration,flags'))).toBe(true);
    expect(calls.filter((call) => call.args.includes('-show_frames'))).toEqual([]);
  });

  it('PD02 the frozen sample count reaches the decode: 3 frames are decoded when the probe facts say 3', async () => {
    planned(await probed('cfr.mp4', { probe: { ...PROBE, sampleFrames: 3 } }));
    const counts = calls.filter((call) => call.program === 'ffmpeg' && call.args.includes('rawvideo')).map((call) => call.args[call.args.indexOf('-frames:v') + 1]);
    expect(counts).toEqual(['3']);
  });
});

describe('geometry, colour and the tool source (design §4.2, §4.3)', () => {
  it('PC01 an untagged 718-line source resolves bt601 by the coded height; rotation swaps the display sides', async () => {
    expect(planned(await probed('untagged-718.mp4')).plan).toMatchObject({ color: { matrix: 'bt601' }, display: { width: 1280, height: 718 } });
    expect(planned(await probed('rot90.mp4')).plan).toMatchObject({ color: { matrix: 'bt601' }, display: { width: 718, height: 1280 } });
  });

  it('PC02 SAR 2:1 widens the display as scale=iw*sar:ih does', async () => {
    expect(planned(await probed('sar.mp4')).plan.display).toEqual({ width: 128, height: 32 });
  });

  it('PC03 an odd size keeps its display size in the plan', async () => {
    expect(planned(await probed('odd.mp4')).plan.display).toEqual({ width: 161, height: 97 });
  });

  it('PC04 a 10-bit PQ source is HDR: tone mapped to SDR in the plan and read through an 8-bit edit file (§4.2, E01)', async () => {
    const answer = planned(await probed('pq10.mp4'));
    expect(answer.plan).toMatchObject({ toolSource: 'edit', color: { toneMap: 'sdr-bt709' }, framePngBitDepth: 8 });
    expect(answer.source).toMatchObject({ hdr: true, bitDepth: 10, sourceDecodeKey: 'sdr_10bit', editTier: 'edit_h264_intra_8bit_420', color: { transfer: 'smpte2084' } });
    expect(answer.versions.editProfileVersion).toMatch(HEX);
  });

  it('PC05 audio longer than the video extends the grid estimate with a hold on the last frame (§4.1 grid end row)', async () => {
    const answer = planned(await probed('hold.mp4'));
    expect(answer.plan.audioTrack).toBe(0);
    expect(answer.gridInput.audioEnd).not.toBeNull();
    expect(answer.estimate.realFrameCount).toBe(60);
    expect(answer.estimate.frameCount).toBeGreaterThan(60);
  });
});

describe('alpha classification from real stream properties (design §5.1 step 2)', () => {
  it.each([
    ['vp9-alpha.webm', 'sdr_alpha_layer'],
    // ProRes 4444 decodes as 12-bit (yuva444p12le) and takes the ProRes key, not the alpha-layer or 12-bit key (K05).
    ['prores4444.mov', 'sdr_prores'],
    ['png-rgba64.mov', 'sdr_png'],
    ['png-ya16.mov', 'sdr_png'],
  ])('PA01 %s is confirmed transparent and read through a ProRes edit file only when it needs one', async (name, key) => {
    const answer = planned(await probed(name));
    expect(answer.source).toMatchObject({ alpha: true, sourceDecodeKey: key });
    if (answer.source.editTier !== null) expect(answer.source.editTier).toBe('edit_prores');
  });

  it.runIf(FFMPEG_MAJOR >= 8)('PA02 HEVC with an alpha layer is confirmed transparent (FFmpeg 8 decodes it as yuva420p)', async () => {
    expect(planned(await probed('hevc-alpha.mov')).source).toMatchObject({ alpha: true, sourceDecodeKey: 'sdr_alpha_layer' });
  });

  it.each(['cfr.mp4', 'untagged-718.mp4', 'pq10.mp4'])('PA03 %s is confirmed opaque', async (name) => {
    expect(planned(await probed(name)).source.alpha).toBe(false);
  });
});

describe('failures (design §10.6 失败分类)', () => {
  it('PF01 a source over the frozen byte cap answers source_over_cap', async () => {
    expect(await probed('cfr.mp4', { limits: { ...LIMITS, maxSourceBytes: 1024 } })).toEqual({ kind: 'failed', code: 'source_over_cap' });
  });

  it('PF02 two video tracks are not a single video track: classification_unknown', async () => {
    expect(await probed('two-video.mp4')).toEqual({ kind: 'failed', code: 'classification_unknown' });
  });

  it('PF03 a source ffprobe cannot open (an MP4 header and noise: moov atom not found) is the source\'s failure, probe_invalid', async () => {
    const path = join(dir, 'unreadable.mp4');
    const header = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
    await writeFile(path, Buffer.concat([header, createHash('sha256').update('noise').digest(), Buffer.alloc(4096, 0x5a)]));
    files.set('unreadable.mp4', path);
    expect(await probed('unreadable.mp4')).toEqual({ kind: 'failed', code: 'probe_invalid' });
  });
});
