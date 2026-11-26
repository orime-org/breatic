// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The basic container's presentation probe on the frame grid (frames-split design §5.1 step 2, §4.1–§4.3, §3.2, §7.1): download
 * the source once, read its streams, every video packet (FFmpeg's default interpretation, never `-ignore_editlist`) and the
 * last audio packet, decode the first frame to take its geometry, sample the decoded pixel format for alpha and depth, and
 * answer the plan with its digest, the producer, playback and edit profile versions, the tool-source facts and the grid inputs
 * the decode-only count completes. The versions are sha256 digests of what produces the bytes (§3.2, §3.5).
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCanonicalJson, type CanonicalJson } from '@shared/mini-tools/canonical-json.js';
import { editFileTier, isHdrTransfer, videoPlanOutput, type EditFileTier } from '@shared/mini-tools/video-encode-plan.js';
import { chooseFrameGridRate, isVariableFrameRate, needsEditFile, sourceDecodeKey, SOURCE_DECODE_KEYS, type FrameRate, type SourceDecodeKey } from '@shared/upload/frame-grid-rate.js';
import { audioGridEnd, GRID_RULES_VERSION, planFrameGrid, sourceKeyframeStats } from '@shared/upload/frame-grid.js';
import { PRESENTATION_RUN_PATH, type PresentationProbeAnswer, type PresentationProbeRequest, type PresentationRunBody } from '@ingest/presentation-run-types.js';
import { classifyVideoAlpha } from '@ingest/video-alpha-classification.js';
import { download } from '@ingest/container/mini-tool-run.js';
import { PlanCommandExit, runPlanCommand, runPlanCommandWithStderr } from '@ingest/container/plan-command.js';
import { packetProbeArgs, parsePackets, resolveVideoColorMatrix } from '@ingest/container/physical-video-probe.js';
import { decodedDisplay, decodedSample } from '@ingest/container/decoded-display.js';
import { PLAYBACK_GOP_SECONDS } from '@ingest/container/playback-command.js';

// The two builder digests, embedded by the container build (`esbuild --define`, packages/ingest/Dockerfile); run from source,
// the module files themselves are hashed.
declare const __PLAYBACK_BUILDER_SHA256__: string | undefined;
declare const __EDIT_BUILDER_SHA256__: string | undefined;

/** A stable failure code for the answer; diagnostics stay in the container log. */
class ProbeFailure extends Error {
  /**
   * Name the failure.
   * @param code - The stable code.
   */
  constructor(readonly code: string) { super(code); this.name = 'ProbeFailure'; }
}

/** What the three versions are computed from (§3.2 identity table, §3.5 edit-file receipt row, §7.1 reuse-carrier row). */
export interface PresentationVersionInput {
  /** `ffmpeg -version` as the container reads it at start. */
  ffmpegVersion: string;
  /** The sha256 of the playback command builder's source (`playback-command.ts`). */
  playbackBuilderSha256: string;
  /** The sha256 of the edit command builder's source (`edit-command.ts`). */
  editBuilderSha256: string;
  /** The frozen playback encode values. */
  playback: { crf: number; preset: string; playbackGopSeconds: number; carrier: Record<string, CanonicalJson> };
  /** The frozen edit-file settings; `bytesPerPixel` is only the size estimate's and in no version. */
  edit: { crf: number; preset: string; proresProfile: string; bytesPerPixel: number };
  /** The source's edit tier, null when it needs no edit file. */
  editTier: EditFileTier | null;
}
/** The three versions. */
export interface PresentationVersions { producerVersion: string; profileVersion: string; editProfileVersion: string | null }

/**
 * The versions of a frozen configuration (§3.2, §3.5, §7.1): the producer version digests the FFmpeg version and the playback
 * builder's source; the playback profile version the frozen playback encode values; the edit profile version the values the
 * tier's encoder reads (crf and preset for H.264, the ProRes profile for ProRes) and the edit builder's source, null without
 * an edit file. FFmpeg is in no edit version, and the bytes-per-pixel estimate in none.
 * @param input - The facts.
 * @returns The versions, lowercase sha256 hex.
 * @throws {never} Never.
 */
export async function presentationVersions(input: PresentationVersionInput): Promise<PresentationVersions> {
  const { playback, edit, editTier } = input;
  const encoder: Record<string, CanonicalJson> = editTier === 'edit_prores' ? { proresProfile: edit.proresProfile } : { crf: edit.crf, preset: edit.preset };
  return {
    producerVersion: await hashCanonicalJson({ ffmpegVersion: input.ffmpegVersion, playbackBuilder: input.playbackBuilderSha256 }),
    profileVersion: await hashCanonicalJson({ crf: playback.crf, preset: playback.preset, playbackGopSeconds: playback.playbackGopSeconds, carrier: playback.carrier }),
    editProfileVersion: editTier === null ? null : await hashCanonicalJson({ encoder, editBuilder: input.editBuilderSha256 }),
  };
}

/**
 * A builder module's digest: the one the build embedded, or the module source's own when run from source.
 * @param embedded - The embedded digest, if any.
 * @param module - The module file next to this one.
 * @returns The lowercase sha256 hex.
 * @throws {Error} When the source cannot be read.
 */
async function builderDigest(embedded: string | undefined, module: string): Promise<string> {
  if (embedded !== undefined) return embedded;
  return createHash('sha256').update(await readFile(new URL(module, import.meta.url), 'utf8')).digest('hex');
}

let ffmpegVersionText: Promise<string> | null = null;

/**
 * `ffmpeg -version` of this container, read once.
 * @param signal - The lifetime of the first read.
 * @returns The text.
 * @throws {Error} When FFmpeg cannot be run.
 */
function ffmpegVersion(signal: AbortSignal): Promise<string> {
  ffmpegVersionText ??= runPlanCommand('ffmpeg', ['-version'], { signal, stdoutBytes: 1 << 20, stderrTailBytes: 4096 }).then((out) => out.toString('utf8').trim());
  return ffmpegVersionText;
}

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
 * An ffprobe `n/d` rational, null for 0/0 or a malformed one.
 * @param value - The field.
 * @returns It, or null.
 * @throws {never} Never.
 */
function ratio(value: unknown): FrameRate | null {
  const match = typeof value === 'string' ? /^(\d+)\/(\d+)$/u.exec(value) : null;
  if (match === null || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

/**
 * Ticks on a time base as an exact time.
 * @param ticks - The ticks.
 * @param base - The time base.
 * @returns The time, unreduced.
 * @throws {never} Never.
 */
function at(ticks: number, base: FrameRate): FrameRate {
  return { numerator: ticks * base.numerator, denominator: base.denominator };
}

/**
 * The deepest component of a pixel format, from this build's descriptors.
 * @param formats - `-show_pixel_formats` JSON.
 * @param name - The pixel format.
 * @returns Its bit depth.
 * @throws {ProbeFailure} When the format is unknown.
 */
function pixelDepth(formats: unknown, name: string): number {
  const list = record(formats).pixel_formats;
  const descriptor = Array.isArray(list) ? list.map(record).find((format) => format.name === name) : undefined;
  const components = Array.isArray(descriptor?.components) ? descriptor.components.map(record) : [];
  const bitDepth = Math.max(0, ...components.map((component) => Number(component.bit_depth)));
  if (descriptor === undefined || !Number.isSafeInteger(bitDepth) || bitDepth <= 0) throw new ProbeFailure('classification_unknown');
  return bitDepth;
}

/**
 * The first decoded frame's best-effort timestamp of a stream, on its time base. `-read_intervals %+#n` counts the packets of
 * every stream, so a stream whose first packets come after another's (interleaving, a late audio track) or a decoder that
 * needs several packets before its first frame gets a growing window until a frame decodes; the earliest decoded one counts.
 * @param input - The source.
 * @param stream - The stream index.
 * @param options - The lifetime and IO bounds.
 * @returns The exact time, or null when no frame decodes.
 * @throws {Error} When ffprobe fails.
 */
async function firstFrameTime(input: string, stream: Record<string, unknown>, options: { signal: AbortSignal; stdoutBytes: number; stderrTailBytes: number }): Promise<FrameRate | null> {
  const base = ratio(stream.time_base);
  if (base === null) throw new ProbeFailure('clock_unknown');
  // ponytail: the last window reads the whole file, so a stream that decodes nothing costs about two full reads.
  for (let packets = 32; ; packets *= 4) {
    const whole = packets > 1 << 20;
    const rows = (await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', String(stream.index), ...(whole ? [] : ['-read_intervals', `%+#${packets}`]),
      '-show_entries', 'frame=best_effort_timestamp', '-of', 'csv=p=0', input], options)).toString('utf8').split('\n')
      // ffprobe 8 ends each csv row with a separator (`0,`): the timestamp is the first field.
      .map((line) => line.split(',')[0]!.trim()).filter((field) => /^-?\d+$/u.test(field));
    if (rows.length > 0) return at(Math.min(...rows.map(Number)), base);
    if (whole) return null;
  }
}

let pixelFormats: unknown;
const UNTAGGED = new Set(['', 'unknown', 'unspecified', 'reserved']);

/**
 * A colour tag, or null when untagged.
 * @param value - The ffprobe field.
 * @returns The tag, or null.
 * @throws {never} Never.
 */
function tag(value: unknown): string | null {
  return typeof value === 'string' && !UNTAGGED.has(value) ? value : null;
}

/**
 * Probe one downloaded source and plan its grid.
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
  const raw = json(await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', input], options)
    .catch((cause: unknown) => { throw cause instanceof PlanCommandExit ? new ProbeFailure('probe_invalid') : cause; }));
  if (!Array.isArray(raw.streams)) throw new ProbeFailure('probe_invalid');
  const streams = raw.streams.map(record);
  const videos = streams.filter((stream) => stream.codec_type === 'video' && (typeof stream.disposition !== 'object' || stream.disposition === null || record(stream.disposition).attached_pic !== 1));
  if (videos.length !== 1) throw new ProbeFailure('classification_unknown');
  const video = videos[0]!;
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const videoBase = ratio(video.time_base);
  if (videoBase === null) throw new ProbeFailure('clock_unknown');

  // The first frame of FFmpeg's default decode (container cropping and autorotation applied): its size, sample aspect ratio and
  // pixel format, decoded by ffmpeg (ffprobe reports HEVC with an alpha layer as opaque). The sample is bounded by the frozen count.
  pixelFormats ??= json(await runPlanCommand('ffprobe', ['-v', 'error', '-show_pixel_formats', '-of', 'json'], options));
  const decoded = record(await decodedSample((program, args) => runPlanCommand(program, args, options), input, 'file', Number(video.index),
    body.probe.sampleFrames, join(directory, 'sample.nut')));
  const sampled = decoded.pix_fmt;
  if (typeof sampled !== 'string') throw new ProbeFailure('classification_unknown');
  // NUT converts formats it has no tag for to rgb555le, dropping alpha and depth; such a sample's format is the stream's own.
  const pixFmt = sampled === 'rgb555le' && typeof video.pix_fmt === 'string' && video.pix_fmt !== 'rgb555le' ? video.pix_fmt : sampled;
  const bitDepth = pixelDepth(pixelFormats, pixFmt);
  const alpha = classifyVideoAlpha({ ...raw, streams: streams.map((stream) => (stream === video ? { ...stream, pix_fmt: pixFmt } : stream)) }, pixelFormats);
  if (alpha === 'unknown') throw new ProbeFailure('classification_unknown');
  const display = decodedDisplay(decoded);

  // Every video packet as FFmpeg's demuxer gives it (§3.2 item 7, §4.1 frame rate row).
  const packets = parsePackets((await runPlanCommand('ffprobe', packetProbeArgs(input, String(video.index)), options)).toString('utf8'));
  const timed = packets.filter((packet) => (packet.pts ?? packet.dts) !== null);
  if (timed.length === 0) throw new ProbeFailure('clock_unknown');
  const keyframes = sourceKeyframeStats(packets, videoBase);
  const rate = chooseFrameGridRate({ rFrameRate: ratio(video.r_frame_rate), avgFrameRate: ratio(video.avg_frame_rate),
    ticksPerSecond: { numerator: videoBase.denominator, denominator: videoBase.numerator }, ticks: timed.map((packet) => (packet.pts ?? packet.dts)!), maxFps: body.probe.maxFps });
  const fps = rate.fps;
  const presented = timed.filter((packet) => !packet.discard);
  const lastTicks = Math.max(...(presented.length === 0 ? timed : presented).map((packet) => (packet.pts ?? packet.dts)!));

  const firstVideo = await firstFrameTime(input, video, options);
  if (firstVideo === null) throw new ProbeFailure('no_presented_frames');
  let firstAudio: FrameRate | null = null;
  let audioEnd: FrameRate | null = null;
  if (audio !== undefined) {
    firstAudio = await firstFrameTime(input, audio, options);
    const audioBase = ratio(audio.time_base);
    const last = (json(await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', String(audio.index),
      '-show_entries', 'packet=pts,duration:packet_side_data=discard_padding', '-of', 'json', input], options)).packets as unknown[] | undefined)
      ?.map(record).filter((packet) => typeof packet.pts === 'number' && typeof packet.duration === 'number').at(-1);
    if (firstAudio !== null && last !== undefined && audioBase !== null) {
      const side = Array.isArray(last.side_data_list) ? last.side_data_list.map(record) : [];
      const padding = side.map((entry) => entry.discard_padding).find((value) => typeof value === 'number');
      audioEnd = audioGridEnd({ pts: last.pts as number, duration: last.duration as number, timeBase: audioBase, discardPadding: (padding) ?? 0,
        sampleRate: Number(audio.sample_rate) });
    } else firstAudio = null;
  }
  const matroska = String(record(raw.format).format_name).split(',').some((name) => name === 'matroska' || name === 'webm');
  const gridInput = { fps, firstVideoTime: firstVideo, firstAudioFrameTime: firstAudio, audioEnd, quantum: matroska ? videoBase : { numerator: 0, denominator: 1 } };
  const estimate = planFrameGrid({ ...gridInput, lastVideoTime: at(lastTicks, videoBase), sourceFrames: presented.length, singleFrameMs: body.probe.singleFrameDurationMs });

  const transfer = tag(video.color_transfer);
  const hdr = isHdrTransfer(transfer);
  // §4.2: the original is not seekable when FFmpeg's seek to the grid start fails.
  const start = estimate.gridStart.numerator / estimate.gridStart.denominator;
  const seek = await runPlanCommandWithStderr('ffmpeg', ['-v', 'warning', '-nostdin', '-protocol_whitelist', 'file', '-copyts', '-seek_timestamp', '1', '-noaccurate_seek',
    '-ss', start.toFixed(6), '-i', input, '-map', `0:${String(video.index)}`, '-frames:v', '1', '-f', 'null', '-'], options);
  const seekable = !/could not seek/u.test(seek.stderr);
  const variableFrameRate = isVariableFrameRate({ packetDurations: timed.slice(0, 20).map((packet) => packet.duration),
    avgFrameRate: ratio(video.avg_frame_rate), rFrameRate: ratio(video.r_frame_rate) });
  const edit = needsEditFile({ variableFrameRate, transfer, seekable });
  const editTier = edit ? editFileTier({ alpha: alpha === 'confirmed_alpha', bitDepth, hdr, width: display.width, height: display.height }) : null;
  const matrix = resolveVideoColorMatrix(video);
  const output = videoPlanOutput({ transfer, bitDepth });
  const sourceRates = Object.fromEntries(SOURCE_DECODE_KEYS.map((key) => [key, body.encoding.encoder.decodeConvertPixelsPerSecond[key] ?? Number.POSITIVE_INFINITY])) as Record<SourceDecodeKey, number>;
  const planned = {
    gridRulesVersion: GRID_RULES_VERSION,
    grid: { fps, gridStart: estimate.gridStart, leadFrames: estimate.leadFrames, gridEnd: estimate.gridEnd, singleFrameDurationMs: body.probe.singleFrameDurationMs },
    toolSource: edit ? 'edit' : 'original', audioTrack: audio === undefined || firstAudio === null ? null : 0,
    display, color: { matrix, toneMap: output.toneMap }, framePngBitDepth: output.framePngBitDepth,
  } as const;
  const versions = await presentationVersions({
    ffmpegVersion: await ffmpegVersion(signal),
    playbackBuilderSha256: await builderDigest(typeof __PLAYBACK_BUILDER_SHA256__ === 'string' ? __PLAYBACK_BUILDER_SHA256__ : undefined, './playback-command.ts'),
    editBuilderSha256: await builderDigest(typeof __EDIT_BUILDER_SHA256__ === 'string' ? __EDIT_BUILDER_SHA256__ : undefined, './edit-command.ts'),
    playback: { crf: body.limits.crf, preset: body.limits.preset, playbackGopSeconds: PLAYBACK_GOP_SECONDS, carrier: body.encoding.carrier },
    edit: body.encoding.edit, editTier,
  });
  return {
    kind: 'planned', plan: planned, planSha256: await hashCanonicalJson(planned as unknown as CanonicalJson), versions,
    source: {
      sourceDecodeKey: sourceDecodeKey({ codec: String(video.codec_name), bitDepth, alpha }, sourceRates), keyframes, hdr, alpha: alpha === 'confirmed_alpha', editTier, seekable, bitDepth,
      color: { matrix, transfer, primaries: tag(video.color_primaries), range: video.color_range === 'pc' || pixFmt.startsWith('yuvj') ? 'pc' : 'tv',
        chromaLocation: tag(video.chroma_location) ?? 'left' },
    },
    gridInput, estimate: { lastVideoTime: at(lastTicks, videoBase), sourceFrames: presented.length, frameCount: estimate.frameCount, realFrameCount: estimate.realFrameCount },
    sourceBytes: (await stat(input)).size,
  };
}

/**
 * Run the probe over a fresh download of the source, bounded by the job's deadline; a stable failure becomes its code.
 * @param body - The probe request.
 * @param signal - The caller's lifetime, when it has one.
 * @returns The answer.
 * @throws {Error} When the container itself fails (a command or IO fault), which is not a property of the source.
 */
export async function runPresentationProbe(body: PresentationProbeRequest, signal?: AbortSignal): Promise<PresentationProbeAnswer> {
  if (body.deadlineAt <= Date.now()) return { kind: 'failed', code: 'expired' };
  const deadline = AbortSignal.timeout(Math.max(1, body.deadlineAt - Date.now()));
  const lifetime = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  const directory = await mkdtemp(join(tmpdir(), 'presentation-run-'));
  try {
    const input = join(directory, 'source');
    await download(body.sourceURL, input, lifetime);
    if ((await stat(input)).size > body.limits.maxSourceBytes) return { kind: 'failed', code: 'source_over_cap' };
    return await plan(body, input, directory, lifetime);
  } catch (cause) {
    if (lifetime.aborted || body.deadlineAt <= Date.now()) return { kind: 'failed', code: 'expired' };
    if (cause instanceof ProbeFailure) return { kind: 'failed', code: cause.code };
    if (cause instanceof PlanCommandExit) return { kind: 'failed', code: 'probe_invalid' };
    if (cause instanceof TypeError || cause instanceof RangeError) return { kind: 'failed', code: 'probe_invalid' };
    throw cause;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Serve the run path: one JSON probe request, answered when it ends.
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
    if (body.action !== 'probe') { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await runPresentationProbe(body)));
  } catch (err) {
    console.error('presentation_run_failed', { err });
    response.writeHead(500).end();
  }
}

export { PRESENTATION_RUN_PATH };
