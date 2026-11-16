// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6b container probe facts and plan assembly (inner#1306, test plan §88;
 * frames-split design §5.1 step 2, §4.3 colour/geometry rows, §4.2.1, §7.16).
 *
 * The probe is packet-level demux: `-show_packets` for pts, duration and the
 * keyframe flag, never `-show_frames`. Untagged colour resolves once by the
 * coded height (≥ 720 → BT.709, else BT.601), whatever the rotation; display geometry applies
 * SAR as `scale=iw*sar:ih` and the display rotation. The assembler feeds the S6a
 * timeline and returns a plan the S6a ledger schema accepts.
 *
 * Confirmed rules (design 0fbbe4e0): the probe also reads `pos` and a frame's source
 * ordinal is its packet's decode order; SAR scaling truncates as FFmpeg `scale`
 * does (`iw*sar`), SAR 0:1 is 1:1 and a mirrored matrix keeps width and height; the
 * plan carries the source transfer and bit depth and the output conversion they
 * decide; the selected audio's start and end are snapped to the 48 kHz grid before
 * they feed the timeline; a single rate-1 edit from the media start covering the
 * whole media is recorded as no edit (design 4d0e1f7c).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as probeOwner from '@ingest/container/physical-video-probe.js';
import * as assemblyOwner from '@ingest/container/assemble-video-source-ledger.js';
import { planVideoPresentationTimeline } from '@shared/mini-tools/video-presentation-timeline.js';
import { projectPresentationTable } from '@shared/mini-tools/video-presentation-projection.js';
import { videoPresentationLedgerSchema } from '@shared/upload/video-presentation-version.js';

interface Rational { numerator: string; denominator: string }
interface Interval { start: Rational; end: Rational }
interface EditSpan { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }
interface PlanInput {
  frames: { sourcePtsTicks: string; start: Rational; declaredEnd: Rational | null }[];
  sourceTimeBase: Rational;
  emptyEdits: Interval[];
  segmentDuration: Rational | null;
  videoSpans: EditSpan[] | null;
  mediaEnd: Rational;
  editTick?: Rational;
  audio: { start: Rational; end: Rational; spans: EditSpan[] | null } | null;
  display: { width: number; height: number };
  colorMatrix: string;
  source: { transfer: string | null; bitDepth: number };
  policy: { singleFrameDurationMs: number; emptyFill: 'black' | 'transparent' };
}
interface Packets { streamIndex: number; sourceTimeBase: Rational; packets: { rawDecodeOrdinal: number; ptsTicks: string; durationTicks: string | null; keyframe: boolean; position: string | null }[] }
interface ProbeApi {
  videoPacketProbeArgs: (input: { input: string; streamIndex: number; iso: boolean }) => string[];
  parsePhysicalVideoPackets: (metadata: unknown, packetBytes: Buffer) => Packets;
  resolveVideoColorMatrix: (stream: Record<string, unknown>) => string;
  videoDisplayGeometry: (stream: Record<string, unknown>, crop?: Crop) => { width: number; height: number };
  videoContainerCrop: (stream: Record<string, unknown>, formatName: string) => Crop;
}
interface Crop { top: number; bottom: number; left: number; right: number }
interface AssemblyApi { assembleVideoPresentationPlan: (input: PlanInput) => Record<string, unknown> }

const probe = probeOwner as unknown as Partial<ProbeApi>;
const assembly = assemblyOwner as unknown as Partial<AssemblyApi>;

/**
 * Read one S6b probe export, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function probeExport<K extends keyof ProbeApi>(name: K): ProbeApi[K] {
  expect(probe[name], `${name} is exported from physical-video-probe`).toBeDefined();
  return probe[name] as ProbeApi[K];
}

/**
 * The S6b plan assembler, failing when it does not exist yet.
 * @returns The assembler.
 * @throws {Error} When the export is missing.
 */
function assemble(): AssemblyApi['assembleVideoPresentationPlan'] {
  expect(assembly.assembleVideoPresentationPlan, 'assembleVideoPresentationPlan is exported from assemble-video-source-ledger').toBeDefined();
  return assembly.assembleVideoPresentationPlan!;
}

/**
 * Greatest common divisor.
 * @param a - First value.
 * @param b - Second value.
 * @returns The divisor.
 */
function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * A reduced rational.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rational.
 */
function r(numerator: number, denominator = 1): Rational {
  const divisor = numerator === 0 ? denominator : gcd(Math.abs(numerator), denominator);
  return { numerator: String(numerator / divisor), denominator: String(denominator / divisor) };
}

const METADATA = { streams: [{ index: 0, id: '0x1', codec_type: 'video', time_base: '1/16384' }, { index: 1, id: '0x2', codec_type: 'audio', time_base: '1/48000' }] };

/**
 * Packet JSON bytes as ffprobe writes them.
 * @param packets - Packet objects.
 * @returns The bytes.
 */
function packetBytes(packets: Record<string, unknown>[]): Buffer {
  return Buffer.from(JSON.stringify({ packets }));
}

describe('PR §5.1 step 2 packet-level probe', () => {
  it.each([[true], [false]])('PR01 the probe asks for packets with pts, duration, flags and pos, never frames (ISO %s)', (iso) => {
    const args = probeExport('videoPacketProbeArgs')({ input: '/tmp/source', streamIndex: 3, iso });
    expect(args).toContain('-show_packets');
    expect(args).not.toContain('-show_frames');
    const entries = args[args.indexOf('-show_entries') + 1] ?? '';
    expect(entries.startsWith('packet=')).toBe(true);
    for (const field of ['pts', 'duration', 'flags', 'pos']) expect(entries.slice('packet='.length).split(',')).toContain(field);
    expect(args[args.indexOf('-select_streams') + 1]).toBe('3');
    expect(args.at(-1)).toBe('/tmp/source');
    const editList = args.indexOf('-ignore_editlist');
    if (iso) expect(args[editList + 1]).toBe('1');
    else expect(editList).toBe(-1);
  });

  it('PR02 parses decode-order packets with exact pts, declared duration and the keyframe flag', () => {
    const parsed = probeExport('parsePhysicalVideoPackets')(METADATA, packetBytes([
      { stream_index: 0, pts: 1024, duration: 512, flags: 'K__', pos: '48' },
      { stream_index: 0, pts: 2048, duration: 512, flags: '___', pos: '5120' },
      { stream_index: 0, pts: 1536, duration: 0, flags: '___', pos: '6144' },
      { stream_index: 0, pts: 2560, flags: 'K_' },
    ]));
    expect(parsed).toEqual({
      streamIndex: 0, sourceTimeBase: { numerator: '1', denominator: '16384' },
      packets: [
        { rawDecodeOrdinal: 0, ptsTicks: '1024', durationTicks: '512', keyframe: true, position: '48' },
        { rawDecodeOrdinal: 1, ptsTicks: '2048', durationTicks: '512', keyframe: false, position: '5120' },
        { rawDecodeOrdinal: 2, ptsTicks: '1536', durationTicks: null, keyframe: false, position: '6144' },
        { rawDecodeOrdinal: 3, ptsTicks: '2560', durationTicks: null, keyframe: true, position: null },
      ],
    });
  });

  it('PR03 keeps integer ticks beyond 2^53 exact', () => {
    const parsed = probeExport('parsePhysicalVideoPackets')(METADATA, Buffer.from('{"packets":[{"stream_index":0,"pts":9007199254740993,"duration":9007199254740995,"flags":"K_"}]}'));
    expect(parsed.packets).toEqual([{ rawDecodeOrdinal: 0, ptsTicks: '9007199254740993', durationTicks: '9007199254740995', keyframe: true, position: null }]);
  });

  it.each([
    ['no packets', []],
    ['a packet without pts', [{ stream_index: 0, duration: 512, flags: 'K_' }]],
    ['a fractional pts', [{ stream_index: 0, pts: 1.5, duration: 512, flags: 'K_' }]],
    ['a packet of another stream', [{ stream_index: 1, pts: 0, duration: 1024, flags: 'K_' }]],
    ['a packet without flags', [{ stream_index: 0, pts: 0, duration: 512 }]],
  ])('PR04 rejects %s', (_, packets) => {
    const parse = probeExport('parsePhysicalVideoPackets');
    expect(parse(METADATA, packetBytes([{ stream_index: 0, pts: 0, duration: 512, flags: 'K_' }])).packets).toHaveLength(1);
    expect(() => parse(METADATA, packetBytes(packets))).toThrow(TypeError);
  });
});

describe('CM §4.3 colour matrix resolved once into the plan', () => {
  it.each([
    [{ color_space: 'bt709', height: 480 }, 'bt709'],
    [{ color_space: 'smpte170m', height: 1080 }, 'bt601'],
    [{ color_space: 'bt470bg', height: 1080 }, 'bt601'],
    [{ color_space: 'bt2020nc', height: 2160 }, 'bt2020nc'],
  ])('CM01 a tagged source %o keeps its matrix %s', (stream, matrix) => {
    expect(probeExport('resolveVideoColorMatrix')(stream)).toBe(matrix);
  });

  it.each([
    [{ height: 720 }, 'bt709'], [{ height: 2160 }, 'bt709'], [{ height: 718 }, 'bt601'], [{ height: 480 }, 'bt601'],
    [{ color_space: 'unknown', height: 720 }, 'bt709'], [{ color_space: 'unknown', height: 718 }, 'bt601'],
    // A rotation does not change the rule: it reads the coded height.
    [{ width: 1280, height: 718, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, 'bt601'],
    [{ width: 1280, height: 720, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, 'bt709'],
    [{ width: 718, height: 1280, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, 'bt709'],
  ])('CM02 an untagged source %o resolves by its coded height to %s', (stream, matrix) => {
    expect(probeExport('resolveVideoColorMatrix')(stream)).toBe(matrix);
  });
});

describe('DG §4.3 display geometry', () => {
  it.each([
    [{ width: 64, height: 32 }, { width: 64, height: 32 }],
    [{ width: 64, height: 32, sample_aspect_ratio: '1:1' }, { width: 64, height: 32 }],
    [{ width: 64, height: 32, sample_aspect_ratio: '2:1' }, { width: 128, height: 32 }],
    [{ width: 64, height: 32, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, { width: 32, height: 64 }],
    [{ width: 64, height: 32, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }, { width: 32, height: 64 }],
    [{ width: 64, height: 32, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] }, { width: 64, height: 32 }],
    [{ width: 64, height: 32, sample_aspect_ratio: '2:1', side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }, { width: 32, height: 128 }],
    // FFmpeg 7.1.1 `setsar=…,scale=iw*sar:ih` readings (test plan §88): the width is truncated.
    [{ width: 720, height: 480, sample_aspect_ratio: '10:11' }, { width: 654, height: 480 }],
    [{ width: 720, height: 480, sample_aspect_ratio: '40:33' }, { width: 872, height: 480 }],
    [{ width: 101, height: 50, sample_aspect_ratio: '3:2' }, { width: 151, height: 50 }],
    [{ width: 64, height: 32, sample_aspect_ratio: '0:1' }, { width: 64, height: 32 }],
    // ffprobe 7.1.1 reports an `-display_hflip` matrix as rotation -180 and `-display_vflip` as rotation 0; both decode at 64×32.
    [{ width: 64, height: 32, side_data_list: [{ side_data_type: 'Display Matrix', rotation: -180 }] }, { width: 64, height: 32 }],
    [{ width: 64, height: 32, side_data_list: [{ side_data_type: 'Display Matrix', rotation: 0 }] }, { width: 64, height: 32 }],
  ])('DG01 %o displays as %o', (stream, geometry) => {
    expect(probeExport('videoDisplayGeometry')(stream)).toEqual(geometry);
  });

  // A Matroska stream's PixelCrop is what the picture shows, as Chromium shows a WebM; an MP4 clap box, which ffprobe reports
  // the same way, is not applied by Chromium, so the picture is the coded one.
  it.each([
    ['matroska,webm', { width: 160, height: 96, side_data_list: [{ side_data_type: 'Frame Cropping', crop_top: 0, crop_bottom: 1, crop_left: 0, crop_right: 1 }] }, { width: 159, height: 95 }],
    ['matroska,webm', { width: 160, height: 96, sample_aspect_ratio: '2:1', side_data_list: [{ side_data_type: 'Frame Cropping', crop_top: 1, crop_bottom: 2, crop_left: 3, crop_right: 4 },
      { side_data_type: 'Display Matrix', rotation: 90 }] }, { width: 93, height: 306 }],
    ['mov,mp4,m4a,3gp,3g2,mj2', { width: 160, height: 96, side_data_list: [{ side_data_type: 'Frame Cropping', crop_top: 0, crop_bottom: 1, crop_left: 0, crop_right: 1 }] }, { width: 160, height: 96 }],
  ])('DG02 a %s stream %o displays as %o', (format, stream, geometry) => {
    expect(probeExport('videoDisplayGeometry')(stream, probeExport('videoContainerCrop')(stream, format))).toEqual(geometry);
  });
});

const POLICY = { singleFrameDurationMs: 5000, emptyFill: 'black' as const };

/**
 * A plan input with no audio, spans or empty edits.
 * @param frames - Real frames.
 * @param overrides - Other fields.
 * @returns The input.
 */
function input(frames: PlanInput['frames'], overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    frames, sourceTimeBase: r(1, 1000), emptyEdits: [], segmentDuration: null, videoSpans: null, mediaEnd: r(100), audio: null,
    display: { width: 64, height: 48 }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, policy: POLICY, ...overrides,
  };
}

/**
 * Wrap a plan in a full ledger for the S6a schema.
 * @param plan - The plan.
 * @returns The ledger.
 */
function ledger(plan: unknown): Record<string, unknown> {
  // S6e E3 (design §3.2 item 7): the full ledger carries the physical encode facts beside the plan; frame 0 is always valid.
  return { schemaVersion: 2, sourceFingerprint: 'a'.repeat(64), toolInputId: 'c'.repeat(64), planSha256: 'd'.repeat(64), attempt: { jobId: 'video-presentation:job-1', deadlineAt: 1 }, plan,
    encoding: { keyframeOrdinals: [0], codedWidth: 64, codedHeight: 48, sourceKeyframes: [{ pts: { numerator: '0', denominator: '1' }, dts: { numerator: '0', denominator: '1' } }], firstPacketDts: { numerator: '0', denominator: '1' } } };
}

describe('PA §4.2.1 and §7.16 plan assembly', () => {
  it('PA01 three declared CFR frames give one source run and declared support', () => {
    const plan = assemble()(input([
      { sourcePtsTicks: '0', start: r(0), declaredEnd: r(1, 8) },
      { sourcePtsTicks: '2048', start: r(1, 8), declaredEnd: r(1, 4) },
      { sourcePtsTicks: '4096', start: r(1, 4), declaredEnd: r(3, 8) },
    ], { sourceTimeBase: r(1, 16384) }));
    expect(plan).toEqual({
      display: { width: 64, height: 48, duration: r(3, 8) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: POLICY,
      presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 3, step: 1, duration: 1 }] },
      originMapping: {
        timeBase: r(1, 16384), origin: r(0), entries: [{ kind: 'source', start: 0, count: 3, step: 2048 }],
        firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(3, 8), hold: null },
      },
      videoSpans: null, audioSpans: null, segmentDuration: null,
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA02 audio from 0 gives the first frame a lead, a gap one derived-empty frame and the last frame a hold', () => {
    const videoSpans = [{ sourceStart: r(0), sourceEnd: r(1, 4), presentationStart: r(1, 4), rate: r(1) }, { sourceStart: r(1, 2), sourceEnd: r(3, 4), presentationStart: r(3, 4), rate: r(1) }];
    const audioSpans = [{ sourceStart: r(0), sourceEnd: r(2), presentationStart: r(0), rate: r(1) }];
    const plan = assemble()(input([
      { sourcePtsTicks: '0', start: r(1, 4), declaredEnd: r(1, 2) },
      { sourcePtsTicks: '512', start: r(3, 4), declaredEnd: r(1) },
    ], { sourceTimeBase: r(1, 1024), videoSpans, audio: { start: r(0), end: r(2), spans: audioSpans }, display: { width: 96, height: 64 }, colorMatrix: 'bt709', source: { transfer: 'bt709', bitDepth: 8 }, policy: { singleFrameDurationMs: 5000, emptyFill: 'transparent' } }));
    expect(plan).toEqual({
      display: { width: 96, height: 64, duration: r(2) }, colorMatrix: 'bt709', source: { transfer: 'bt709', bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 },
      policy: { singleFrameDurationMs: 5000, emptyFill: 'transparent' },
      presentation: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 1, step: 1, duration: 1 }, { start: 3, count: 1, step: 5, duration: 5 }] },
      originMapping: {
        timeBase: r(1, 1024), origin: r(0),
        entries: [{ kind: 'source', start: 0, count: 1, step: 0 }, { kind: 'derived-empty' }, { kind: 'source', start: 512, count: 1, step: 0 }],
        firstSource: { supportStart: r(1, 4), lead: { kind: 'derived-lead', start: r(0) } },
        lastSource: { support: 'declared', supportEnd: r(1), hold: { kind: 'derived-hold', end: r(2) } },
      },
      videoSpans, audioSpans, segmentDuration: null,
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA03 video starting at 1/8 with no earlier audio rebases presentation time and its spans by the origin', () => {
    const plan = assemble()(input([
      { sourcePtsTicks: '125', start: r(1, 8), declaredEnd: r(3, 8) },
      { sourcePtsTicks: '875', start: r(7, 8), declaredEnd: r(9, 8) },
    ], { videoSpans: [{ sourceStart: r(1, 8), sourceEnd: r(3, 8), presentationStart: r(1, 8), rate: r(1) }, { sourceStart: r(7, 8), sourceEnd: r(9, 8), presentationStart: r(7, 8), rate: r(1) }] }));
    expect(plan).toEqual({
      display: { width: 64, height: 48, duration: r(1) }, colorMatrix: 'bt601', source: { transfer: null, bitDepth: 8 }, output: { toneMap: 'none', framePngBitDepth: 8 }, policy: POLICY,
      presentation: { schemaVersion: 1, timescale: 4, runs: [{ start: 0, count: 1, step: 1, duration: 1 }, { start: 1, count: 1, step: 2, duration: 2 }, { start: 3, count: 1, step: 1, duration: 1 }] },
      originMapping: {
        timeBase: r(1, 1000), origin: r(1, 8),
        entries: [{ kind: 'source', start: 125, count: 1, step: 0 }, { kind: 'derived-empty' }, { kind: 'source', start: 875, count: 1, step: 0 }],
        firstSource: { supportStart: r(0), lead: null }, lastSource: { support: 'declared', supportEnd: r(1), hold: null },
      },
      videoSpans: [{ sourceStart: r(1, 8), sourceEnd: r(3, 8), presentationStart: r(0), rate: r(1) }, { sourceStart: r(7, 8), sourceEnd: r(9, 8), presentationStart: r(3, 4), rate: r(1) }],
      audioSpans: null, segmentDuration: null,
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA04 the MediaRecorder sample keeps Info.Duration as a source fact and ends its last frame at 1.694 s', () => {
    const plan = assemble()(input([
      { sourcePtsTicks: '0', start: r(0), declaredEnd: null }, { sourcePtsTicks: '70', start: r(7, 100), declaredEnd: null },
      { sourcePtsTicks: '170', start: r(17, 100), declaredEnd: null }, { sourcePtsTicks: '932', start: r(233, 250), declaredEnd: null },
    ], { segmentDuration: r(932267, 1_000_000), display: { width: 320, height: 240 } }));
    expect(plan).toMatchObject({
      display: { width: 320, height: 240, duration: r(847, 500) }, segmentDuration: r(932267, 1_000_000),
      originMapping: {
        origin: r(0), entries: [{ kind: 'source', start: 0, count: 2, step: 70 }, { kind: 'source', start: 170, count: 2, step: 762 }],
        lastSource: { support: 'previous-max', supportEnd: r(847, 500), hold: null },
      },
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA05 a lone undeclared frame takes the frozen single-frame policy value', () => {
    const plan = assemble()(input([{ sourcePtsTicks: '0', start: r(0), declaredEnd: null }], { segmentDuration: r(1, 1000), policy: { singleFrameDurationMs: 2500, emptyFill: 'black' } }));
    expect(plan).toMatchObject({
      display: { width: 64, height: 48, duration: r(5, 2) }, policy: { singleFrameDurationMs: 2500, emptyFill: 'black' },
      presentation: { schemaVersion: 1, timescale: 2, runs: [{ start: 0, count: 1, step: 5, duration: 5 }] },
      originMapping: { lastSource: { support: 'single-frame', supportEnd: r(5, 2), hold: null } },
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA06 no presented frame fails with no_presented_frames', () => {
    const build = assemble();
    let caught: unknown;
    try { build(input([])); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'no_presented_frames' });
  });

  it.each([
    ['PQ 10-bit', { transfer: 'smpte2084', bitDepth: 10 }, { toneMap: 'sdr-bt709', framePngBitDepth: 8 }],
    ['HLG 10-bit', { transfer: 'arib-std-b67', bitDepth: 10 }, { toneMap: 'sdr-bt709', framePngBitDepth: 8 }],
    ['SDR 10-bit', { transfer: 'bt709', bitDepth: 10 }, { toneMap: 'none', framePngBitDepth: 16 }],
    ['untagged 8-bit', { transfer: null, bitDepth: 8 }, { toneMap: 'none', framePngBitDepth: 8 }],
  ])('PA08 a %s source records its transfer, bit depth and output conversion in the plan', (_, source, output) => {
    const plan = assemble()(input([{ sourcePtsTicks: '0', start: r(0), declaredEnd: r(1, 8) }], { source }));
    expect(plan).toMatchObject({ source, output });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA09 the audio start and end are snapped to the 48 kHz grid before they set the origin, the hold and display.duration', () => {
    // Audio [1/96000, 49152/65537) snaps to samples [1, 35999): origin 1/48000, end 35999/48000, both before rebasing.
    const plan = assemble()(input([{ sourcePtsTicks: '0', start: r(1, 4), declaredEnd: r(1, 2) }], { audio: { start: r(1, 96000), end: r(49152, 65537), spans: null } }));
    expect(plan).toMatchObject({
      display: { width: 64, height: 48, duration: r(17999, 24000) },
      presentation: { schemaVersion: 1, timescale: 24000, runs: [{ start: 0, count: 1, step: 17999, duration: 17999 }] },
      originMapping: {
        origin: r(1, 48000),
        firstSource: { supportStart: r(11999, 48000), lead: { kind: 'derived-lead', start: r(0) } },
        lastSource: { support: 'declared', supportEnd: r(23999, 48000), hold: { kind: 'derived-hold', end: r(17999, 24000) } },
      },
    });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it('PA10 a single rate-1 edit from the media start covering the whole media is recorded as no edit', () => {
    const frames = [{ sourcePtsTicks: '0', start: r(0), declaredEnd: r(1, 8) }, { sourcePtsTicks: '125', start: r(1, 8), declaredEnd: r(1, 4) }];
    const plan = assemble()(input(frames, { mediaEnd: r(1, 4), videoSpans: [{ sourceStart: r(0), sourceEnd: r(1, 4), presentationStart: r(0), rate: r(1) }] }));
    expect(plan).toMatchObject({ videoSpans: null });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it.each([
    ['ending before the media ends', { sourceStart: r(0), sourceEnd: r(1, 4), presentationStart: r(0), rate: r(1) }, r(3, 8)],
    ['starting after the media start', { sourceStart: r(1, 8), sourceEnd: r(3, 8), presentationStart: r(0), rate: r(1) }, r(3, 8)],
    ['at another rate', { sourceStart: r(0), sourceEnd: r(1, 2), presentationStart: r(0), rate: r(2) }, r(1, 2)],
  ])('PA11 a single edit %s stays recorded', (_, span, mediaEnd) => {
    const frames = [{ sourcePtsTicks: '0', start: r(0), declaredEnd: r(1, 8) }, { sourcePtsTicks: '125', start: r(1, 8), declaredEnd: r(1, 4) }];
    const plan = assemble()(input(frames, { mediaEnd, videoSpans: [span] }));
    expect(plan).toMatchObject({ videoSpans: [span] });
    expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
  });

  it.each([
    ['within one movie tick of the media end is no edit', r(1251, 5000), null],
    ['more than one movie tick short of the media end stays recorded', r(62, 250), 'kept'],
  ] as const)('PA12 a whole-media edit ending %s', (_, sourceEnd, expected) => {
    // Edit durations are written on a 1/1000 movie timescale; the media ends at 1/4 s.
    const frames = [{ sourcePtsTicks: '0', start: r(0), declaredEnd: r(1, 8) }, { sourcePtsTicks: '125', start: r(1, 8), declaredEnd: r(1, 4) }];
    const span = { sourceStart: r(0), sourceEnd, presentationStart: r(0), rate: r(1) };
    const plan = assemble()(input(frames, { mediaEnd: r(1, 4), editTick: r(1, 1000), videoSpans: [span] }));
    expect(plan.videoSpans).toEqual(expected === null ? null : [span]);
  });

  it('PA07 any declared frames, gaps and audio window assemble into a schema-valid plan taken from the S6a timeline (property)', () => {
    const build = assemble();
    const frame = fc.record({ gap: fc.integer({ min: 0, max: 5 }), length: fc.integer({ min: 1, max: 5 }) });
    const audio = fc.option(fc.record({ start: fc.integer({ min: 0, max: 8 }), length: fc.integer({ min: 1, max: 300 }) }), { nil: null });
    fc.assert(fc.property(fc.array(frame, { minLength: 1, maxLength: 30 }), audio, (frames, window) => {
      let at = 0;
      const real = frames.map((item, index) => {
        at += item.gap;
        const start = at;
        at += item.length;
        return { sourcePtsTicks: String(index * 40), start: r(start, 25), declaredEnd: r(at, 25) };
      });
      const audioWindow = window === null ? null : { start: r(window.start, 25), end: r(window.start + window.length, 25), spans: null };
      const plan = build(input(real, { audio: audioWindow })) as { display: { duration: Rational }; presentation: unknown; originMapping: { origin: Rational; entries: { kind: string }[] } };
      expect(videoPresentationLedgerSchema.safeParse(ledger(plan)).success).toBe(true);
      const timeline = planVideoPresentationTimeline({
        frames: real.map(({ start, declaredEnd }) => ({ start, declaredEnd })), emptyEdits: [], segmentDuration: null,
        audioStart: audioWindow?.start ?? null, audioEnd: audioWindow?.end ?? null, singleFrameDurationMs: 5000,
      });
      expect(plan.display.duration).toEqual(timeline.end);
      expect(plan.originMapping.origin).toEqual(timeline.origin);
      expect(plan.presentation).toEqual(projectPresentationTable(timeline.frames));
      // Source ticks advance by 40 per frame, so consecutive source frames share one run: compare kinds with sources collapsed.
      const collapse = (kinds: readonly string[]): string[] => kinds.filter((kind, index) => kind !== 'source' || kinds[index - 1] !== 'source');
      expect(collapse(plan.originMapping.entries.map((entry) => entry.kind))).toEqual(collapse(timeline.frames.map((item) => item.kind)));
    }), { seed: 130808, numRuns: 200 });
  });
});
