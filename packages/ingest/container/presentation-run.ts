// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The basic container's presentation probe (inner#1306 test plan §91 D1; frames-split design §5.1 step 2, §4.1, §4.2,
 * §4.2.1, §4.3): download the source once, read its streams and its selected video's packets (`-show_packets`, never
 * `-show_frames`), decode a bounded sample to classify alpha and depth, assemble the plan and answer it with its
 * identities, the full ledger's encode facts, the route facts and the job work. Every action restarts from the source.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { hashCanonicalJson, type CanonicalJson } from '@shared/mini-tools/canonical-json.js';
import type { PresentationRational } from '@shared/mini-tools/video-presentation-projection.js';
import type { VideoEditSpan } from '@shared/upload/video-source-ledger-types.js';
import { isHdrTransfer, videoCarrierGeometry, videoCarrierTagFilter, videoContainerJobId, videoPlanIsUnaltered, type VideoJobWork } from '@shared/mini-tools/video-encode-plan.js';
import {
  PRESENTATION_CARRIER_HOST, PRESENTATION_RUN_PATH, SOURCE_LEDGER_WRITE_HOST, type PresentationCarrierAnswer, type PresentationCarrierRequest, type PresentationEncodeFacts, type PresentationIdentityFormat,
  type PresentationLedgerAnswer, type PresentationLedgerRequest, type PresentationProbeAnswer, type PresentationProbeRequest, type PresentationRunBody,
} from '@ingest/presentation-run-types.js';
import { objectUrlOn } from '@ingest/object-url.js';
import { videoPresentationWorkKeyFor, videoSourceLedgerKeyFor } from '@shared/upload/video-presentation-keys.js';
import { classifyVideoAlpha } from '@ingest/video-alpha-classification.js';
import { download } from '@ingest/container/mini-tool-run.js';
import { declaresAudioWindow, readStreamWindow } from '@ingest/container/stream-window.js';
import { PlanCommandExit, runPlanCommand } from '@ingest/container/plan-command.js';
import { inspectIsoBmffFile } from '@ingest/container/iso-bmff-metadata.js';
import { exactPresentationTime, planEditListPresentation } from '@ingest/container/iso-bmff-presentation.js';
import { CODEC_CROPPING_ONLY } from '@ingest/shown-picture.js';
import { parsePhysicalVideoPackets, resolveVideoColorMatrix, videoDisplayGeometry, videoPacketProbeArgs, type PhysicalVideoPacket } from '@ingest/container/physical-video-probe.js';
import { assembleVideoPresentationPlan, editSpans, type VideoPresentationPlanInput } from '@ingest/container/assemble-video-source-ledger.js';

/** The producer and carrier profile a plan's carrier is reused by (§7.1). */
const PRODUCER_VERSION = 2;
const PROFILE_VERSION = 1;
/** The basic copy writes where the first dispatched copy attempt would (§91 D2-2). */
const COPY_ATTEMPT = 1;
/** Codecs an MP4 carrier can hold, so a stream copy can keep them (§4.1 row 2). */
const MP4_COPY_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'av1', 'vp9']);
/** ISO BMFF demuxer names as ffprobe reports them. */
const ISO_FORMATS: ReadonlySet<string> = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']);
/** No frame ceiling: every upload is presented (inner#1306). */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** A stable failure code for the answer; diagnostics stay in the container log. */
class ProbeFailure extends Error {
  /**
   * Name the failure.
   * @param code - The stable code.
   */
  constructor(readonly code: string) { super(code); this.name = 'ProbeFailure'; }
}

let pixelFormats: unknown;

/**
 * Named fields of a probe object.
 * @param value - Parsed probe JSON.
 * @returns Its fields.
 * @throws {ProbeFailure} When the value is not an object.
 */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ProbeFailure('probe_invalid');
  return value as Record<string, unknown>;
}

/**
 * An exact decimal integer field.
 * @param value - The field.
 * @returns Its digits.
 * @throws {ProbeFailure} When it is not an exact integer.
 */
function integer(value: unknown): bigint {
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new ProbeFailure('clock_unknown');
}

/**
 * An ffprobe `n/d` time base.
 * @param value - The field.
 * @returns It as numerator and denominator.
 * @throws {ProbeFailure} When it is malformed.
 */
function timeBase(value: unknown): [bigint, bigint] {
  const match = typeof value === 'string' ? /^(\d+)\/(\d+)$/u.exec(value) : null;
  if (match === null || BigInt(match[1]!) <= 0n || BigInt(match[2]!) <= 0n) throw new ProbeFailure('clock_unknown');
  return [BigInt(match[1]!), BigInt(match[2]!)];
}

/**
 * Ticks on a time base as an exact time.
 * @param ticks - The ticks.
 * @param base - The time base.
 * @returns The time.
 * @throws {never} Never.
 */
function at(ticks: bigint, base: [bigint, bigint]): PresentationRational {
  return exactPresentationTime(ticks * base[0], base[1]);
}

/**
 * Parse ffprobe JSON from a command's stdout.
 * @param stdout - The bytes.
 * @returns The object.
 * @throws {ProbeFailure} When it is not a JSON object.
 */
function json(stdout: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(stdout.toString('utf8'))); } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure('probe_invalid');
  }
}

/**
 * The display rotation of a stream, 0 when none is declared.
 * @param stream - The ffprobe stream.
 * @returns Degrees.
 * @throws {never} Never.
 */
function rotationOf(stream: Record<string, unknown>): number {
  const side = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const matrix = side.find((entry: unknown) => typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).side_data_type === 'Display Matrix') as Record<string, unknown> | undefined;
  return typeof matrix?.rotation === 'number' ? matrix.rotation : 0;
}

/**
 * The deepest component of a pixel format, from this build's descriptors.
 * @param formats - `-show_pixel_formats` JSON.
 * @param name - The pixel format.
 * @returns Its bit depth and whether it carries alpha.
 * @throws {ProbeFailure} When the format is unknown.
 */
function pixelFormat(formats: unknown, name: string): { bitDepth: number; alpha: boolean } {
  const list = record(formats).pixel_formats;
  const descriptor = Array.isArray(list) ? list.map(record).find((format) => format.name === name) : undefined;
  const components = Array.isArray(descriptor?.components) ? descriptor.components.map(record) : [];
  const bitDepth = Math.max(0, ...components.map((component) => Number(component.bit_depth)));
  if (descriptor === undefined || !Number.isSafeInteger(bitDepth) || bitDepth <= 0) throw new ProbeFailure('classification_unknown');
  return { bitDepth, alpha: record(descriptor.flags).alpha === 1 };
}

/**
 * The container name an identity entry is matched by: ISO BMFF is `mov` for a QuickTime brand and `mp4` otherwise.
 * @param format - The ffprobe format.
 * @returns The name.
 * @throws {never} Never.
 */
function containerOf(format: Record<string, unknown>): string {
  const names = String(format.format_name).split(',');
  if (names.some((name) => ISO_FORMATS.has(name))) {
    const tags = typeof format.tags === 'object' && format.tags !== null ? format.tags as Record<string, unknown> : {};
    return typeof tags.major_brand === 'string' && tags.major_brand.trim() === 'qt' ? 'mov' : 'mp4';
  }
  return names[0] ?? 'unknown';
}

/**
 * Plan frames from packets without an edit list, in presentation order by pts (§3.1 中间帧行: a middle frame's window runs
 * to the next frame's start). An ISO sample's duration is its decode-order delta, not its own display time, so an ISO middle
 * frame always ends at the next frame. A Matroska block's time and declared duration are each rounded to the container clock,
 * so a declared end within one tick of the next frame, before or after it, is that rounding and ends there too; a larger gap
 * stays a gap. The last frame keeps its declared duration.
 * @param packets - The selected stream's packets.
 * @param base - Their time base.
 * @param iso - Whether the source is an ISO file.
 * @returns The frames in presentation order.
 * @throws {ProbeFailure} When two packets share a pts.
 */
function framesOf(packets: readonly PhysicalVideoPacket[], base: [bigint, bigint], iso: boolean): VideoPresentationPlanInput['frames'][number][] {
  const sorted = [...packets].sort((left, right) => (BigInt(left.ptsTicks) < BigInt(right.ptsTicks) ? -1 : BigInt(left.ptsTicks) > BigInt(right.ptsTicks) ? 1 : 0));
  if (sorted.some((packet, index) => index > 0 && packet.ptsTicks === sorted[index - 1]!.ptsTicks)) throw new ProbeFailure('clock_unknown');
  return sorted.map((packet, index) => {
    const pts = BigInt(packet.ptsTicks);
    const next = index + 1 < sorted.length ? BigInt(sorted[index + 1]!.ptsTicks) : null;
    if (packet.durationTicks === null) return { sourcePtsTicks: packet.ptsTicks, start: at(pts, base), declaredEnd: iso && next !== null ? at(next, base) : null };
    const end = pts + BigInt(packet.durationTicks);
    // A middle frame shows until the next frame starts (design §3.1 full ledger row): ISO durations are decode-order deltas, and
    // a Matroska BlockDuration is often the source sample's decode-order delta too, so players take the next block's time.
    return { sourcePtsTicks: packet.ptsTicks, start: at(pts, base), declaredEnd: at(next ?? end, base) };
  });
}

/**
 * The selected audio's presented window: the first audio stream in ffprobe order, from its declared start and duration or,
 * without them, from its decoded frames, streamed. Samples before time 0 are not presented (§4.2 effective audio): they are
 * an encoder's priming, which FFmpeg's Matroska muxer stores before 0 for AAC, MP3 and AC3 as an MP4 edit list skips it.
 * @param stream - The stream, or undefined without audio.
 * @param input - The local source.
 * @param run - The read's lifetime and stderr tail.
 * @param run.signal - The lifetime.
 * @param run.stderrTailBytes - The stderr tail kept.
 * @returns Its window, or null without audio or with none of it at or after 0.
 * @throws {ProbeFailure} When its clock is unknown.
 * @throws {Error} When the frame read fails.
 */
async function audioWindow(stream: Record<string, unknown> | undefined, input: string,
  run: { signal: AbortSignal; stderrTailBytes: number }): Promise<{ start: PresentationRational; end: PresentationRational } | null> {
  if (stream === undefined) return null;
  let window: { start: PresentationRational; end: PresentationRational };
  if (declaresAudioWindow(stream)) {
    const base = timeBase(stream.time_base);
    const start = integer(stream.start_pts);
    window = { start: at(start, base), end: at(start + integer(stream.duration_ts), base) };
  } else {
    const read = await readStreamWindow(input, stream, 'own-file', run);
    if (read === null) throw new ProbeFailure('audio_clock_unknown');
    window = { start: exactPresentationTime(...read.start), end: exactPresentationTime(...read.end) };
  }
  if (BigInt(window.end.numerator) <= 0n) return null;
  return BigInt(window.start.numerator) < 0n ? { start: exactPresentationTime(0n, 1n), end: window.end } : window;
}

/**
 * Whether Chromium plays the source on the plan's clock (§4.1 简单稳定输入, §4.2.1), so it may play as-is: the plan's 0 is the
 * source's 0, every presented frame is a source frame and the last one declares its end; a lead before the first frame (which
 * Chromium shows) and a hold after the last (which it holds) are allowed; and the video's edits are none, or one rate-1 edit
 * at presentation 0 from the first frame that ends inside the last frame, which Chromium cuts there as the plan does (an
 * AVFoundation export, whose composition shift lengthens the last frame's decode delta).
 * @param plan - The assembled plan.
 * @param media - Where the media's first frame starts, its last frame starts and its last frame ends, in source time.
 * @param media.start - The first frame's start.
 * @param media.lastStart - The last frame's start.
 * @param media.end - The last frame's end.
 * @returns Whether it plays on the plan's clock.
 * @throws {RangeError} When a time is not an exact rational.
 */
function playsOnPlanClock(plan: { originMapping: { origin: PresentationRational; entries: readonly { kind: string }[]; lastSource: { support: string } };
  videoSpans: readonly VideoEditSpan[] | null }, media: { start: PresentationRational; lastStart: PresentationRational; end: PresentationRational }): boolean {
  const { origin, entries, lastSource } = plan.originMapping;
  if (BigInt(origin.numerator) !== 0n || lastSource.support !== 'declared' || entries.some((entry) => entry.kind !== 'source')) return false;
  if (plan.videoSpans === null) return true;
  if (plan.videoSpans.length !== 1) return false;
  const span = plan.videoSpans[0]!;
  const compare = (a: PresentationRational, b: PresentationRational): bigint =>
    BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return BigInt(span.presentationStart.numerator) === 0n && compare(span.rate, { numerator: '1', denominator: '1' }) === 0n
    && compare(span.sourceStart, media.start) === 0n && compare(span.sourceEnd, media.lastStart) > 0n && compare(span.sourceEnd, media.end) <= 0n;
}

/**
 * Whether the source plays as itself (§4.1): a combination of the frozen identity table, with no rotation, square
 * samples and a tagged matrix.
 * @param facts - The source facts.
 * @param facts.container - Its container name.
 * @param facts.video - The selected video stream.
 * @param facts.pixFmt - The decoder-reported pixel format.
 * @param facts.bitDepth - Its depth.
 * @param facts.audioCodec - The selected audio codec, or `none`.
 * @param facts.matrixTagged - Whether the matrix is tagged.
 * @param formats - The frozen identity table.
 * @returns Whether it qualifies.
 * @throws {never} Never.
 */
function identityQualified(facts: { container: string; video: Record<string, unknown>; pixFmt: string; bitDepth: number; audioCodec: string; matrixTagged: boolean },
  formats: readonly PresentationIdentityFormat[]): boolean {
  const sar = facts.video.sample_aspect_ratio;
  if (rotationOf(facts.video) !== 0 || (sar !== undefined && sar !== '1:1' && sar !== '0:1') || !facts.matrixTagged) return false;
  return formats.some((entry) => entry.container === facts.container && entry.videoCodec === facts.video.codec_name && entry.profiles.includes(String(facts.video.profile)) &&
    entry.pixFmt === facts.pixFmt && entry.bitDepth === facts.bitDepth && entry.audioCodecs.includes(facts.audioCodec));
}

/**
 * The presented ordinals of the keyframe packets.
 * @param plan - The assembled plan.
 * @param packets - The selected stream's packets.
 * @returns Strictly increasing ordinals.
 * @throws {never} Never.
 */
function keyframeOrdinals(plan: ReturnType<typeof assembleVideoPresentationPlan>, packets: readonly PhysicalVideoPacket[]): number[] {
  const ordinalOf = new Map<number, number>();
  let ordinal = 0;
  for (const entry of plan.originMapping.entries) {
    if (entry.kind === 'derived-empty') { ordinal += 1; continue; }
    for (let k = 0; k < entry.count; k += 1, ordinal += 1) if (!ordinalOf.has(entry.start + k * entry.step)) ordinalOf.set(entry.start + k * entry.step, ordinal);
  }
  const keys = packets.filter((packet) => packet.keyframe).flatMap((packet) => {
    const found = ordinalOf.get(Number(packet.ptsTicks));
    return found === undefined ? [] : [found];
  });
  return [...new Set(keys)].sort((left, right) => left - right);
}

/**
 * Every source keyframe's pts and decode position in pts order and the first packet's, on the media timeline (§3.2 item 7):
 * an ISO packet's dts; a Matroska block's time, which is its pts (Matroska stores no dts and seeks by block time).
 * @param packets - The selected stream's packets in decode order.
 * @param base - Their time base.
 * @param iso - Whether the container is ISO BMFF.
 * @returns The keyframes and the first packet dts.
 * @throws {ProbeFailure} When an ISO keyframe or first packet has no dts.
 */
function sourceKeyframesOf(packets: readonly PhysicalVideoPacket[], base: [bigint, bigint], iso: boolean): Pick<PresentationEncodeFacts, 'sourceKeyframes' | 'firstPacketDts'> {
  /**
   * A packet's decode position.
   * @param packet - The packet.
   * @returns The time.
   * @throws {ProbeFailure} When an ISO packet has no dts.
   */
  const dtsOf = (packet: PhysicalVideoPacket): PresentationRational => {
    if (!iso) return at(BigInt(packet.ptsTicks), base);
    if (packet.dtsTicks === undefined) throw new ProbeFailure('clock_unknown');
    return at(BigInt(packet.dtsTicks), base);
  };
  const keyframes = packets.filter((packet) => packet.keyframe).sort((left, right) => (BigInt(left.ptsTicks) < BigInt(right.ptsTicks) ? -1 : 1));
  return { sourceKeyframes: keyframes.map((packet) => ({ pts: at(BigInt(packet.ptsTicks), base), dts: dtsOf(packet) })), firstPacketDts: dtsOf(packets[0]!) };
}

/**
 * The bit depth class whose measured rates the job estimate uses.
 * @param bitDepth - The decoded depth.
 * @returns 8, 10 or 12.
 * @throws {ProbeFailure} When it is deeper than 12 bits.
 */
function workDepth(bitDepth: number): VideoJobWork['bitDepth'] {
  if (bitDepth <= 8) return 8;
  if (bitDepth <= 10) return 10;
  if (bitDepth <= 12) return 12;
  throw new ProbeFailure('classification_unknown');
}

/**
 * Probe one downloaded source.
 * @param body - The request.
 * @param input - The local source.
 * @param directory - The run's directory.
 * @param signal - The run's lifetime.
 * @returns The planned answer.
 * @throws {ProbeFailure} When the source cannot be planned.
 * @throws {Error} When a command fails.
 */
async function plan(body: PresentationProbeRequest, input: string, directory: string, signal: AbortSignal): Promise<PresentationProbeAnswer> {
  const options = { signal, stdoutBytes: body.limits.probeStdoutBytes, stderrTailBytes: body.limits.stderrTailBytes };
  // ffprobe exiting non-zero on a complete local download means it cannot read the source, a property of the bytes.
  const raw = json(await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', input], options)
    .catch((cause: unknown) => { throw cause instanceof PlanCommandExit ? new ProbeFailure('probe_invalid') : cause; }));
  if (!Array.isArray(raw.streams)) throw new ProbeFailure('probe_invalid');
  const streams = raw.streams.map(record);
  const videos = streams.filter((stream) => stream.codec_type === 'video' && (typeof stream.disposition !== 'object' || stream.disposition === null || record(stream.disposition).attached_pic !== 1));
  if (videos.length !== 1) throw new ProbeFailure('classification_unknown');
  const video = videos[0]!;
  const format = record(raw.format);
  pixelFormats ??= json(await runPlanCommand('ffprobe', ['-v', 'error', '-show_pixel_formats', '-of', 'json'], options));
  // §91 D-6: the sample is decoded by ffmpeg and its pixel format read from the decoded stream, never with ffprobe
  // -show_frames: ffprobe 8.0.1 reports HEVC with an alpha layer as opaque yuv420p while ffmpeg's decoder gives yuva420p.
  // The sample is bounded by the frozen frame count.
  const sample = join(directory, 'sample.nut');
  await runPlanCommand('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', ...CODEC_CROPPING_ONLY, '-i', input, '-map', `0:${String(video.index)}`,
    '-frames:v', String(body.probe.sampleFrames), '-c:v', 'rawvideo', '-f', 'nut', sample], options);
  const decoded = json(await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-of', 'json', sample], options)).streams;
  const pixFmt = Array.isArray(decoded) ? decoded.map(record).find((stream) => stream.codec_type === 'video')?.pix_fmt : undefined;
  if (typeof pixFmt !== 'string') throw new ProbeFailure('classification_unknown');
  const depth = pixelFormat(pixelFormats, pixFmt);
  const alpha = classifyVideoAlpha({ ...raw, streams: streams.map((stream) => (stream === video ? { ...stream, pix_fmt: pixFmt } : stream)) }, pixelFormats);
  if (alpha === 'unknown') throw new ProbeFailure('classification_unknown');

  const names = String(format.format_name).split(',');
  const iso = names.some((name) => ISO_FORMATS.has(name));
  if (!iso && !names.some((name) => name === 'matroska' || name === 'webm')) throw new ProbeFailure('source_ledger_format_unknown');
  const ledger = body.limits.sourceLedger;
  const packetBytes = await runPlanCommand('ffprobe', videoPacketProbeArgs({ input, streamIndex: Number(video.index), iso }), { ...options, stdoutBytes: ledger.probeStdoutBytes });
  const { packets, sourceTimeBase } = parsePhysicalVideoPackets(raw, packetBytes);
  const base: [bigint, bigint] = [BigInt(sourceTimeBase.numerator), BigInt(sourceTimeBase.denominator)];
  let frames = framesOf(packets, base, iso);
  let emptyEdits: VideoPresentationPlanInput['emptyEdits'] = [];
  let videoSpans: VideoPresentationPlanInput['videoSpans'] = null;
  // The media's presented range on the media timeline: the first pts to the latest frame end.
  const mediaStart = frames[0]!.start;
  const later = (a: PresentationRational, b: PresentationRational): PresentationRational =>
    (BigInt(a.numerator) * BigInt(b.denominator) > BigInt(b.numerator) * BigInt(a.denominator) ? a : b);
  const mediaEnd = frames.reduce((latest, frame) => later(frame.declaredEnd ?? frame.start, latest), mediaStart);
  const lastStart = frames.reduce((latest, frame) => later(frame.start, latest), mediaStart);
  let editTick: PresentationRational | undefined;
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  let audioSpans: VideoPresentationPlanInput['videoSpans'] = null;
  if (iso) {
    const metadata = await inspectIsoBmffFile(input, { metadataBytes: ledger.metadataBytes, boxCount: ledger.isoBoxCount });
    const trackId = typeof video.id === 'string' && /^0x[0-9a-f]+$/iu.test(video.id) ? Number.parseInt(video.id.slice(2), 16) : Number.NaN;
    const tracks = metadata.tracks.filter((track) => track.trackId === trackId);
    if (tracks.length !== 1) throw new ProbeFailure('source_ledger_selection_unknown');
    const track = tracks[0]!;
    editTick = exactPresentationTime(1n, BigInt(metadata.movieTimescale));
    if (track.edits !== null) {
      // The edit list maps the presentation-ordered frames onto movie time; plan frames take those windows.
      const presented = planEditListPresentation({ movieTimescale: metadata.movieTimescale, mediaTimescale: track.mediaTimescale, sourceTimeBase,
        edits: track.edits, frames: frames.map((frame, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks: frame.sourcePtsTicks })) }, UNBOUNDED);
      frames = presented.frames.map((frame) => ({ sourcePtsTicks: frame.sourcePtsTicks, start: frame.displayStart, declaredEnd: frame.displayEnd }));
      emptyEdits = presented.edits.filter((edit) => edit.empty).map(({ start, end }) => ({ start, end }));
      videoSpans = editSpans(track.edits, metadata.movieTimescale, track.mediaTimescale);
      if (videoSpans.length === 0) videoSpans = null;
    }
    // §91 D3b-10: the selected audio track's edit list, derived like the video's (the assembler rebases both by the origin).
    const audioId = typeof audio?.id === 'string' && /^0x[0-9a-f]+$/iu.test(audio.id) ? Number.parseInt(audio.id.slice(2), 16) : Number.NaN;
    const audioTrack = metadata.tracks.find((item) => item.trackId === audioId);
    if (audioTrack?.edits !== null && audioTrack?.edits !== undefined) {
      audioSpans = editSpans(audioTrack.edits, metadata.movieTimescale, audioTrack.mediaTimescale);
      if (audioSpans.length === 0) audioSpans = null;
    }
  }

  const window = await audioWindow(audio, input, options);
  const colorSpace = video.color_space;
  const matrixTagged = typeof colorSpace === 'string' && colorSpace !== '' && colorSpace !== 'unknown';
  const transfer = typeof video.color_transfer === 'string' && video.color_transfer !== '' && video.color_transfer !== 'unknown' ? video.color_transfer : null;
  const display = videoDisplayGeometry(video);
  const assembled = assembleVideoPresentationPlan({
    frames, sourceTimeBase, emptyEdits, segmentDuration: null, videoSpans, mediaEnd, mediaStart, ...(editTick === undefined ? {} : { editTick }),
    audio: window === null ? null : { ...window, spans: audioSpans }, display, colorMatrix: resolveVideoColorMatrix(video),
    source: { transfer, bitDepth: depth.bitDepth },
    policy: { singleFrameDurationMs: body.probe.singleFrameDurationMs, emptyFill: alpha === 'confirmed_alpha' ? 'transparent' : 'black' },
  });
  const planSha256 = await hashCanonicalJson(assembled as unknown as CanonicalJson);
  const toolInputId = await hashCanonicalJson({ sourceFingerprint: body.sourceFingerprint, planSha256 });
  const codec = String(video.codec_name);
  const audioCodec = audio === undefined ? 'none' : String(audio.codec_name);
  const hdr = isHdrTransfer(transfer);
  const output = videoCarrierGeometry(assembled.display, body.encoding.carrier.maxShortSide);
  const encodedFrames = assembled.originMapping.entries.reduce((total, entry) => total + (entry.kind === 'source' ? entry.count : 1), 0);
  return {
    kind: 'planned', toolInputId, planSha256, plan: assembled,
    encoding: { keyframeOrdinals: keyframeOrdinals(assembled, packets), codedWidth: Number(video.width), codedHeight: Number(video.height), ...sourceKeyframesOf(packets, base, iso) },
    routeInput: {
      plan: { planSha256, producerVersion: PRODUCER_VERSION, profileVersion: PROFILE_VERSION }, hdr, alpha,
      // Playing as-is keeps the source's own clock, which must be the plan's as Chromium plays it (§4.1).
      identityQualified: playsOnPlanClock(assembled, { start: mediaStart, lastStart, end: mediaEnd })
        && identityQualified({ container: containerOf(format), video, pixFmt, bitDepth: depth.bitDepth, matrixTagged, audioCodec }, body.probe.identityFormats),
      colorMatrixTagged: matrixTagged, codec,
      // §4.1 row 2: a copy keeps the plan when the plan presents the source unaltered and the MP4 carrier can hold the codec.
      copyPreservesTimeline: videoPlanIsUnaltered(assembled) && MP4_COPY_CODECS.has(codec),
      // §4.1 row 2: only audio in the MP4 audio codecs of the frozen identity table is packet-copied; other audio is dispatched.
      audioCopyable: body.probe.identityFormats.some((entry) => entry.container === 'mp4' && entry.audioCodecs.includes(audioCodec)),
      sourceBytes: (await stat(input)).size,
    },
    work: { encodedFrames, prerollFrames: 0, sourceWidth: Number(video.width), sourceHeight: Number(video.height), outputWidth: output.width, outputHeight: output.height,
      bitDepth: workDepth(depth.bitDepth), hdr,
      // The selected audio's seconds, which the dispatched copy encodes to AAC (§5.4); 0 without audio.
      audioSeconds: window === null ? 0 : Number(window.end.numerator) / Number(window.end.denominator) - Number(window.start.numerator) / Number(window.start.denominator) },
  };
}

/**
 * Run one action over a fresh download of the source, bounded by the job's deadline; a stable failure becomes its code.
 * @param body - The request.
 * @param signal - The caller's lifetime, when it has one.
 * @param work - The action over the downloaded source.
 * @returns The action's answer, or the failure.
 * @throws {Error} When the container itself fails (a command or IO fault), which is not a property of the source.
 */
async function withSource<T>(body: PresentationProbeRequest | PresentationLedgerRequest | PresentationCarrierRequest, signal: AbortSignal | undefined,
  work: (input: string, directory: string, lifetime: AbortSignal) => Promise<T>): Promise<T | { kind: 'failed'; code: string }> {
  if (body.deadlineAt <= Date.now()) return { kind: 'failed', code: 'expired' };
  const deadline = AbortSignal.timeout(Math.max(1, body.deadlineAt - Date.now()));
  const lifetime = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const directory = await mkdtemp(join(tmpdir(), 'presentation-run-'));
  try {
    const input = join(directory, 'source');
    await download(body.sourceURL, input, lifetime);
    if ((await stat(input)).size > body.limits.maxSourceBytes) return { kind: 'failed', code: 'source_over_cap' };
    return await work(input, directory, lifetime);
  } catch (cause) {
    if (lifetime.aborted || body.deadlineAt <= Date.now()) return { kind: 'failed', code: 'expired' };
    if (cause instanceof ProbeFailure) return { kind: 'failed', code: cause.code };
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && /^[a-z][a-z0-9_]*$/u.test(code)) return { kind: 'failed', code };
    if (cause instanceof TypeError || cause instanceof RangeError) return { kind: 'failed', code: 'probe_invalid' };
    throw cause;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Run the probe action: one download, the plan and its facts, or a stable failure code.
 * @param body - The probe request.
 * @param signal - The caller's lifetime, when it has one.
 * @returns The answer.
 * @throws {Error} When the container itself fails (a command or IO fault), which is not a property of the source.
 */
export function runPresentationProbe(body: PresentationProbeRequest, signal?: AbortSignal): Promise<PresentationProbeAnswer> {
  return withSource(body, signal, (input, directory, lifetime) => plan(body, input, directory, lifetime));
}

/**
 * Plan the source again and require the plan the DO recorded (§91 D-3, D2-3).
 * @param body - The writing request.
 * @param input - The local source.
 * @param directory - The run's directory.
 * @param lifetime - The run's lifetime.
 * @returns The planned answer.
 * @throws {ProbeFailure} When the source cannot be planned.
 */
async function planned(body: PresentationLedgerRequest | PresentationCarrierRequest, input: string, directory: string, lifetime: AbortSignal): Promise<Extract<PresentationProbeAnswer, { kind: 'planned' }>> {
  const answer = await plan({ ...body, action: 'probe' }, input, directory, lifetime);
  if (answer.kind === 'failed') throw new ProbeFailure(answer.code);
  return answer;
}

/**
 * Run the ledger action (§5.1 step 5, §3.2 item 7): plan again, require the requested toolInputId, and write the compact
 * table then the full ledger in one PUT through the edge of that toolInputId's full key.
 * @param body - The ledger request.
 * @param signal - The caller's lifetime, when it has one.
 * @returns Written, or the failure: `source_ledger_plan_mismatch` when the source plans another toolInputId (a content
 *   failure), `source_ledger_failed` when the edge refuses the write.
 * @throws {Error} When the container itself fails.
 */
export function runPresentationLedger(body: PresentationLedgerRequest, signal?: AbortSignal): Promise<PresentationLedgerAnswer> {
  return withSource(body, signal, async (input, directory, lifetime): Promise<PresentationLedgerAnswer> => {
    const answer = await planned(body, input, directory, lifetime);
    if (answer.toolInputId !== body.toolInputId) return { kind: 'failed', code: 'source_ledger_plan_mismatch' };
    const assembled = answer.plan as ReturnType<typeof assembleVideoPresentationPlan>;
    const full = { schemaVersion: 2, sourceFingerprint: body.sourceFingerprint, toolInputId: answer.toolInputId, planSha256: answer.planSha256,
      attempt: { jobId: body.jobId, deadlineAt: body.deadlineAt }, plan: assembled, encoding: body.encodeFacts ?? answer.encoding };
    // §7.16: the compact object is the full ledger's projection.
    const compact = { sourceFingerprint: full.sourceFingerprint, toolInputId: full.toolInputId, planSha256: full.planSha256, presentation: assembled.presentation };
    const table = Buffer.from(JSON.stringify(compact), 'utf8');
    const ledger = Buffer.from(JSON.stringify(full), 'utf8');
    if (ledger.length > body.limits.sourceLedger.maxBytes || table.length > body.limits.sourceLedger.maxBytes) return { kind: 'failed', code: 'source_ledger_over_cap' };
    const destination = new URL(objectUrlOn(SOURCE_LEDGER_WRITE_HOST, videoSourceLedgerKeyFor(body.storageKey, body.toolInputId)));
    const frames = assembled.originMapping.entries.reduce((total, entry) => total + (entry.kind === 'source' ? entry.count : 1), 0);
    for (const [name, value] of Object.entries({ jobId: body.jobId, sourceFingerprint: body.sourceFingerprint, deadlineAt: body.deadlineAt, token: body.token,
      toolInputId: body.toolInputId, planSha256: answer.planSha256, producerVersion: PRODUCER_VERSION, byteLength: ledger.length, tableByteLength: table.length,
      tableFrameCount: frames })) destination.searchParams.set(name, String(value));
    const written = await fetch(destination, { method: 'PUT', signal: lifetime, headers: { 'content-type': 'application/json' }, body: Buffer.concat([table, ledger]) });
    await written.body?.cancel();
    return written.ok ? { kind: 'written' } : { kind: 'failed', code: 'source_ledger_failed' };
  });
}

/** The matrix coefficients each tag filter writes for a plan matrix (H.273; vp9_metadata names its colour spaces). */
const MATRIX_CODES: Readonly<Record<string, string>> = { bt709: '1', bt601: '6', bt2020nc: '9' };
const VP9_COLOR_SPACES: Readonly<Record<string, string>> = { bt709: 'bt709', bt601: 'bt601', bt2020nc: 'bt2020' };

/**
 * The bitstream filter that writes only the plan's matrix tag (§4.1, §91 D2-5), or none when the codec has no tag filter.
 * @param codec - The ffprobe codec name.
 * @param matrix - The plan's colour matrix.
 * @returns The `-bsf:v` value, or null.
 * @throws {ProbeFailure} When the matrix has no tag value.
 */
function matrixTag(codec: string, matrix: string): string | null {
  const filter = videoCarrierTagFilter(codec);
  if (filter === null) return null;
  const value = codec === 'vp9' ? VP9_COLOR_SPACES[matrix] : MATRIX_CODES[matrix];
  if (value === undefined) throw new ProbeFailure('classification_unknown');
  return codec === 'vp9' ? `${filter}=color_space=${value}` : `${filter}=matrix_coefficients=${value}`;
}

/**
 * Stream-copy the first video into MP4 with `+faststart`, every packet time kept less the plan's origin, so the copy plays
 * on the plan's clock (§7.16 start row), writing only the plan's matrix tag (§4.1, §91 D2-5); the basic copy and the
 * standard-4 `copy_carrier` recipe both write the copy this way. The first audio is copied as well (on the same clock), left
 * out, or encoded by the caller's filter chain on a second input of the same source, which starts it at 0 (§7.17).
 * @param input - The downloaded source.
 * @param output - The local MP4 to write.
 * @param matrix - The plan's colour matrix.
 * @param origin - The plan's origin: the source time its 0 is.
 * @param run - The lifetime and frozen process IO bounds.
 * @param run.signal - The lifetime.
 * @param run.limits - The bounds.
 * @param audio - `copy`, null for no audio, or the input arguments and filter chain ending at `[a]` to encode to AAC 48 kHz.
 * @returns Nothing once the file is written.
 * @throws {ProbeFailure} When the source has no video or the matrix has no tag value.
 * @throws {Error} When a process fails.
 */
export async function copyWithMatrixTag(input: string, output: string, matrix: string, origin: { numerator: string; denominator: string },
  run: { signal: AbortSignal; limits: { probeStdoutBytes: number; analysisStdoutBytes: number; stderrTailBytes: number } },
  audio: 'copy' | null | { args: string[]; graph: string } = 'copy'): Promise<void> {
  const raw = json(await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-of', 'json', input],
    { signal: run.signal, stdoutBytes: run.limits.probeStdoutBytes, stderrTailBytes: run.limits.stderrTailBytes }));
  const video = (Array.isArray(raw.streams) ? raw.streams.map(record) : []).find((stream) => stream.codec_type === 'video');
  if (video === undefined) throw new ProbeFailure('classification_unknown');
  const tag = matrixTag(String(video.codec_name), matrix);
  const sound = audio === 'copy' ? ['-map', '0:a:0?', '-c:a', 'copy'] : audio === null ? ['-an']
    : ['-filter_complex', audio.graph, '-map', '[a]', '-c:a', 'aac', '-ar', '48000'];
  // -copyts keeps every packet time, so a source whose audio primes before 0 (FFmpeg's Matroska AAC, MP3, AC3) keeps its
  // picture at its own start and the MP4 audio edit skips the priming; -itsoffset moves the source onto the plan's clock,
  // to the microsecond FFmpeg keeps time in.
  const shift = (BigInt(origin.numerator) * 2_000_000n + BigInt(origin.denominator)) / (2n * BigInt(origin.denominator));
  await runPlanCommand('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-copyts', ...(shift === 0n ? [] : ['-itsoffset', `${-shift}us`]),
    '-i', input, ...(typeof audio === 'object' && audio !== null ? [...audio.args, input] : []),
    '-map', `0:${String(video.index)}`, '-c:v', 'copy', ...(tag === null ? [] : ['-bsf:v', tag]), ...sound, '-movflags', '+faststart', '-f', 'mp4', output],
  { signal: run.signal, stdoutBytes: run.limits.analysisStdoutBytes, stderrTailBytes: run.limits.stderrTailBytes });
}

/**
 * Run the carrier action (§5.1 steps 3–4, §4.1): identity writes nothing and the source itself is the carrier; the basic
 * copy stream-copies into MP4 with `+faststart`, writes the plan's matrix tag and PUTs the object to its copy key through
 * the edge, forwarding the Worker's measured receipt.
 * @param body - The carrier request.
 * @param signal - The caller's lifetime, when it has one.
 * @returns The receipts, or the failure.
 * @throws {Error} When the container itself fails.
 */
export function runPresentationCarrier(body: PresentationCarrierRequest, signal?: AbortSignal): Promise<PresentationCarrierAnswer> {
  return withSource(body, signal, async (input, directory, lifetime): Promise<PresentationCarrierAnswer> => {
    if (body.route === 'identity') {
      // §91 D2-7: the receipt takes the registered type, which the Worker reported from the stored bytes.
      return { kind: 'carrier', receipts: [{ role: 'carrier', packing: 'native', storageKey: body.storageKey, sha256: body.sourceFingerprint,
        sizeBytes: (await stat(input)).size, contentType: body.contentType }] };
    }
    const answer = await planned(body, input, directory, lifetime);
    const output = join(directory, 'carrier.mp4');
    const plan = answer.plan as { colorMatrix: string; originMapping: { origin: { numerator: string; denominator: string } } };
    await copyWithMatrixTag(input, output, plan.colorMatrix, plan.originMapping.origin, { signal: lifetime, limits: body.limits });
    const key = videoPresentationWorkKeyFor(body.storageKey, videoContainerJobId({ kind: 'presentation-copy', jobId: body.jobId, attempt: COPY_ATTEMPT }));
    const destination = new URL(objectUrlOn(PRESENTATION_CARRIER_HOST, key));
    const size = (await stat(output)).size;
    for (const [name, value] of Object.entries({ jobId: body.jobId, sourceFingerprint: body.sourceFingerprint, deadlineAt: body.deadlineAt, token: body.token,
      attempt: COPY_ATTEMPT, byteLength: size })) destination.searchParams.set(name, String(value));
    const written = await fetch(destination, { method: 'PUT', signal: lifetime, duplex: 'half', headers: { 'content-type': 'video/mp4', 'content-length': String(size) },
      body: Readable.toWeb(createReadStream(output)) as ReadableStream<Uint8Array> });
    if (!written.ok) { await written.body?.cancel(); return { kind: 'failed', code: 'presentation_carrier_refused' }; }
    // The Worker's measurement of what landed, forwarded unchanged (§91 D2-2).
    const measured = record(await written.json());
    return { kind: 'carrier', receipts: [{ role: 'carrier', packing: 'native', storageKey: String(measured.storageKey), sha256: String(measured.sha256),
      sizeBytes: Number(measured.sizeBytes), contentType: String(measured.contentType) }] };
  });
}

/**
 * Serve the run path: one JSON request, answered when the action ends.
 * @param request - Container-local HTTP request from the presentation DO.
 * @param response - Its response.
 * @returns Nothing after answering.
 * @throws {never} Failures are logged and answered 500.
 */
export async function handlePresentationRun(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PresentationRunBody;
    const answer = body.action === 'probe' ? await runPresentationProbe(body) : body.action === 'ledger' ? await runPresentationLedger(body)
      : body.action === 'carrier' ? await runPresentationCarrier(body) : null;
    if (answer === null) { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  } catch (err) {
    console.error('presentation_run_failed', { err });
    response.writeHead(500).end();
  }
}

export { PRESENTATION_RUN_PATH };
