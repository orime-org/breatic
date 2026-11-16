// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALPHA_RUN_PATH, type AlphaPresentationReport, type AlphaProbeEvidence, type AlphaRunBody, type AlphaRunResult } from '@ingest/alpha-run-contract.js';
import { classifyVideoAlpha } from '@ingest/video-alpha-classification.js';
import { CODEC_CROPPING_ONLY, shownFilters } from '@ingest/shown-picture.js';
import { pickMediaMetadata } from '@ingest/media-metadata.js';
import { alphaDecoderArgs, readProbeOutput } from '@ingest/probe-command.js';
import { audioOut } from '@ingest/jobs/op-args.js';
import { cpuUsec, download, put } from '@ingest/container/mini-tool-run.js';
import { runPlanCommand } from '@ingest/container/plan-command.js';
import { verifyAlphaPackedClock, type AlphaPresentationClock } from '@ingest/container/alpha-clock.js';
import { inspectIsoBmffFile } from '@ingest/container/iso-bmff-metadata.js';
import { inspectMatroskaFile } from '@ingest/container/matroska-metadata.js';
import { parsePhysicalVideoProbe, parseMatroskaPhysicalVideoProbe } from '@ingest/container/physical-video-probe.js';
import { assembleVideoSourceLedgerV2 } from '@ingest/container/assemble-video-source-ledger.js';

/** A stable failure code, with raw diagnostics remaining in container logs. */
class AlphaFailure extends Error {
  /**
   * Name the failed preparation step.
   * @param code - Stable owned error code.
   */
  constructor(readonly code: string) { super(code); this.name = 'AlphaFailure'; }
}
/** All physical executions of one accepted identity share the same promise. */
const runs = new Map<string, { identity: string; result: Promise<AlphaRunResult> }>();
let pixelFormats: unknown;

/**
 * Read named fields without coercing missing facts.
 * @param value - Parsed probe JSON.
 * @returns Named fields, or none.
 * @throws {AlphaFailure} When the producer answered malformed JSON structure.
 */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AlphaFailure('probe_invalid');
  return value as Record<string, unknown>;
}

/**
 * Retain exact integer ticks rather than silently rounding JSON numbers.
 * @param value - A measured integer field.
 * @returns Its exact decimal representation.
 * @throws {AlphaFailure} When the field cannot be represented exactly.
 */
function integer(value: unknown): string {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new AlphaFailure('clock_unknown');
}

/**
 * Select the sole real video, excluding attached cover art.
 * @param raw - Complete stream metadata.
 * @returns Its raw measured fields.
 * @throws {AlphaFailure} When no unambiguous source stream exists.
 */
function selectedVideo(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.streams)) throw new AlphaFailure('probe_invalid');
  const streams = raw.streams.map(record).filter(stream => stream.codec_type === 'video' &&
    (typeof stream.disposition !== 'object' || stream.disposition === null || record(stream.disposition).attached_pic !== 1));
  if (streams.length !== 1) throw new AlphaFailure('classification_unknown');
  return streams[0]!;
}

/**
 * Stop before starting another physical operation outside the original lifetime.
 * @param job - The original admitted deadline.
 * @param signal - Its shared IO cancellation.
 * @returns Nothing while the original lifetime remains active.
 * @throws {AlphaFailure} When the original deadline has passed.
 * @throws {DOMException} When the original IO signal is cancelled.
 */
function beforeStage(job: AlphaRunBody, signal: AbortSignal): void {
  if (job.deadlineAt <= Date.now()) throw new AlphaFailure('expired');
  signal.throwIfAborted();
}

/**
 * Read complete metadata under one explicitly selected demuxer view and bound.
 * @param input - The already downloaded immutable source.
 * @param job - Original lifetime and stderr bound.
 * @param signal - Shared IO cancellation.
 * @param stdoutBytes - This capability's frozen complete-output ceiling.
 * @param ignoreEdits - Whether physical ISO metadata must ignore edit lists.
 * @returns Complete stream and format metadata, never normalized frame tokens.
 * @throws {Error} When the command or complete JSON metadata fails.
 */
async function sourceMetadata(input: string, job: AlphaRunBody, signal: AbortSignal, stdoutBytes: number, ignoreEdits = false): Promise<Record<string, unknown>> {
  beforeStage(job, signal);
  return record(JSON.parse((await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
    ...(ignoreEdits ? ['-ignore_editlist', '1'] : []), '-show_streams', '-show_format', '-of', 'json', input],
  { signal, stdoutBytes, stderrTailBytes: job.limits.stderrTailBytes })).toString('utf8')));
}

/**
 * The ISO track id of the first audio stream in ffprobe order, the one the consumer maps as `0:a:0`.
 * @param raw - Complete default-view stream metadata.
 * @returns Its track id, or null when the source has no audio stream.
 * @throws {AlphaFailure} When the first audio stream carries no ISO track id.
 */
function firstAudioTrackId(raw: Record<string, unknown>): number | null {
  const audio = (raw.streams as unknown[]).map(record).find(stream => stream.codec_type === 'audio');
  if (audio === undefined) return null;
  const id = typeof audio.id === 'string' && /^0x[0-9a-f]+$/i.test(audio.id) ? Number.parseInt(audio.id.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new AlphaFailure('source_ledger_selection_unknown');
  return id;
}

/**
 * Assemble the source ledger v2 and upload it with its compact table in one write.
 * @param input - The same immutable downloaded source used by presentation.
 * @param directory - This original execution's temporary directory.
 * @param raw - Complete default-view metadata, retained separately from physical ISO.
 * @param job - Original identity and granted ledger budgets.
 * @param signal - The original IO lifetime.
 * @returns Nothing after the dedicated writer acknowledges both objects.
 * @throws {Error} When exact source selection, metadata, planning or publication fails; planner errors carry their own `code`.
 */
async function produceSourceLedger(input: string, directory: string, raw: Record<string, unknown>, job: AlphaRunBody, signal: AbortSignal): Promise<void> {
  const limits = job.limits.sourceLedger!;
  const video = selectedVideo(raw);
  const first = (raw.streams as unknown[]).map(record).find(stream => stream.codec_type === 'video');
  if (first !== video || typeof video.index !== 'number' || !Number.isSafeInteger(video.index) || video.index < 0) throw new AlphaFailure('source_ledger_selection_unknown');
  const names = String(record(raw.format).format_name).split(',');
  const iso = names.some(name => ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'].includes(name));
  if (!iso && !names.some(name => name === 'matroska' || name === 'webm')) throw new AlphaFailure('source_ledger_format_unknown');
  const physicalMetadata = iso ? await sourceMetadata(input, job, signal, limits.probeStdoutBytes, true) : raw;
  const physicalVideo = selectedVideo(physicalMetadata);
  if (physicalVideo.index !== video.index || physicalVideo.time_base !== video.time_base || iso && physicalVideo.id !== video.id) throw new AlphaFailure('source_ledger_selection_unknown');
  beforeStage(job, signal);
  const frames = await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', ...(iso ? ['-ignore_editlist', '1'] : []),
    '-select_streams', integer(video.index), '-show_frames', '-show_entries', 'frame=media_type,stream_index,pts,pkt_pos', '-of', 'json', input],
  { signal, stdoutBytes: limits.probeStdoutBytes, stderrTailBytes: job.limits.stderrTailBytes });
  const base = { sourceFingerprint: job.sourceFingerprint, attempt: { jobId: job.jobId, deadlineAt: job.deadlineAt } };
  beforeStage(job, signal);
  let assembled: ReturnType<typeof assembleVideoSourceLedgerV2>;
  if (iso) {
    const metadata = await inspectIsoBmffFile(input, { metadataBytes: limits.metadataBytes, boxCount: limits.isoBoxCount });
    assembled = assembleVideoSourceLedgerV2({ ...base, kind: 'iso_bmff', metadata, physical: parsePhysicalVideoProbe(physicalMetadata, frames), audioTrackId: firstAudioTrackId(raw) });
  } else {
    const metadata = await inspectMatroskaFile(input, { metadataBytes: limits.metadataBytes, elementCount: limits.matroskaElementCount, maxBlocks: limits.matroskaMaxBlocks });
    assembled = assembleVideoSourceLedgerV2({ ...base, kind: 'matroska', metadata, physical: parseMatroskaPhysicalVideoProbe(physicalMetadata, frames, metadata) });
  }
  const table = Buffer.from(JSON.stringify(assembled.table), 'utf8');
  const ledger = Buffer.from(JSON.stringify(assembled.ledger), 'utf8');
  if (ledger.length > limits.maxBytes || table.length > limits.maxBytes) throw new AlphaFailure('source_ledger_over_cap');
  beforeStage(job, signal);
  const output = join(directory, 'source-ledger.json');
  // One write carries both objects: the compact table, then the full ledger.
  await writeFile(output, Buffer.concat([table, ledger]));
  const destination = new URL(job.sourceLedgerOutputURL!);
  const frameCount = assembled.table.runs.reduce((total, run) => total + run.count, 0);
  for (const [key, value] of Object.entries({ producerVersion: assembled.ledger.producerVersion, byteLength: ledger.length, tableByteLength: table.length,
    tableFrameCount: frameCount })) destination.searchParams.set(key, String(value));
  beforeStage(job, signal);
  await put(destination.toString(), output, signal);
}

/**
 * The code a ledger failure is reported with.
 * @param cause - What the ledger production threw.
 * @param job - The original deadline.
 * @param signal - The original IO lifetime.
 * @returns `expired` past the deadline, the planner's or our own stable code, otherwise `source_ledger_failed`.
 * @throws {never} Never.
 */
function ledgerFailureCode(cause: unknown, job: AlphaRunBody, signal: AbortSignal): string {
  if (signal.aborted || job.deadlineAt <= Date.now()) return 'expired';
  if (cause instanceof AlphaFailure) return cause.code;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code) ? code : 'source_ledger_failed';
}

/**
 * Ask this exact binary for measured JSON within the original lifetime.
 * @param input - Immutable local source or newly encoded packed object.
 * @param job - Frozen process limits and deadline.
 * @param signal - One original lifetime shared by IO and every child.
 * @param frames - Whether the complete selected-video frame inventory is needed.
 * @returns Full streams, format and any complete selected frames.
 * @throws {Error} When a child fails, exceeds its output cap or returns invalid JSON.
 */
async function probe(input: string, job: AlphaRunBody, signal: AbortSignal, frames: boolean): Promise<Record<string, unknown>> {
  const options = { signal, stdoutBytes: job.limits.probeStdoutBytes, stderrTailBytes: job.limits.stderrTailBytes };
  const raw = await sourceMetadata(input, job, signal, job.limits.probeStdoutBytes);
  if (!frames) return raw;
  const video = selectedVideo(raw);
  beforeStage(job, signal);
  const inventory = record(JSON.parse((await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', integer(video.index), '-show_frames', '-of', 'json', input], options)).toString('utf8')));
  raw.frames = inventory.frames;
  if (Array.isArray(raw.streams) && raw.streams.map(record).some(stream => stream.codec_type === 'audio' && stream.duration_ts === undefined)) {
    beforeStage(job, signal);
    const packets = record(JSON.parse((await runPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'a', '-show_packets', '-show_entries', 'packet=stream_index,pts,duration', '-of', 'json', input], options)).toString('utf8')));
    raw.audioPackets = packets.packets;
  }
  return raw;
}

/**
 * Convert raw facts to our complete exact clock representation.
 * @param raw - All stream metadata and the complete selected-video inventory.
 * @returns Exact video and independent audio coverage.
 * @throws {AlphaFailure} When any required source-clock fact remains unknown.
 */
function clockOf(raw: Record<string, unknown>): AlphaPresentationClock {
  const video = selectedVideo(raw);
  if (typeof video.time_base !== 'string' || !/^\d+\/\d+$/.test(video.time_base) || !Array.isArray(raw.frames) || raw.frames.length === 0) throw new AlphaFailure('clock_unknown');
  const frames = raw.frames.map(record).map(frame => ({ pts: integer(frame.pts ?? frame.best_effort_timestamp), duration: integer(frame.duration ?? frame.pkt_duration) }));
  if (frames.some(frame => BigInt(frame.duration) <= 0n)) throw new AlphaFailure('clock_unknown');
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  const start = video.start_pts === undefined ? first.pts : integer(video.start_pts);
  const duration = video.duration_ts === undefined ? String(BigInt(last.pts) + BigInt(last.duration) - BigInt(start)) : integer(video.duration_ts);
  const audio = (raw.streams as unknown[]).map(record).filter(stream => stream.codec_type === 'audio').map(stream => {
    if (typeof stream.time_base !== 'string' || !/^\d+\/\d+$/.test(stream.time_base)) throw new AlphaFailure('audio_clock_unknown');
    let startPts: string;
    let length: string;
    if (stream.start_pts !== undefined && stream.duration_ts !== undefined) {
      startPts = integer(stream.start_pts); length = integer(stream.duration_ts);
    } else {
      if (!Array.isArray(raw.audioPackets)) throw new AlphaFailure('audio_clock_unknown');
      const packets = raw.audioPackets.map(record).filter(packet => packet.stream_index === stream.index);
      if (packets.length === 0) throw new AlphaFailure('audio_clock_unknown');
      startPts = stream.start_pts === undefined ? integer(packets[0]!.pts) : integer(stream.start_pts);
      const end = packets.reduce((maximum, packet) => {
        const at = BigInt(integer(packet.pts)) + BigInt(integer(packet.duration));
        return at > maximum ? at : maximum;
      }, BigInt(startPts));
      length = String(end - BigInt(startPts));
    }
    const sampleRate = Number(stream.sample_rate);
    const channels = Number(stream.channels);
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0 || !Number.isSafeInteger(channels) || channels <= 0 || BigInt(length) <= 0n) throw new AlphaFailure('audio_clock_unknown');
    return { timeBase: stream.time_base, startPts, duration: length, sampleRate, channels };
  });
  return { videoTimeBase: video.time_base, videoStartPts: start, videoDuration: duration, frames, audio };
}

/**
 * Deliver one replay-safe fact through the canonical owner's outbound handler.
 * @param job - Accepted source and private report capability.
 * @param fact - Curated source, encoded geometry or measured usage.
 * @param signal - Original remaining lifetime.
 * @returns Nothing after durable acknowledgement.
 * @throws {Error} When durable reporting is refused.
 */
async function report(job: AlphaRunBody, fact: AlphaPresentationReport, signal: AbortSignal): Promise<void> {
  const answer = await fetch(job.reportURL, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(fact) });
  if (!answer.ok) throw new AlphaFailure('presentation_report_failed');
  await answer.body?.cancel();
}

/**
 * Report an observed ledger failure without skipping original final accounting.
 * @param job - The original private report identity.
 * @param error - Stable failure of this capability alone.
 * @returns Nothing after acknowledgement or logged transport failure.
 * @throws {never} The original execution still delivers its final usage fact.
 */
async function reportLedgerFailure(job: AlphaRunBody, error: string): Promise<void> {
  try {
    await report(job, { jobId: job.jobId, sourceFingerprint: job.sourceFingerprint, deadlineAt: job.deadlineAt, token: job.token,
      kind: 'source_ledger_failed', error }, new AbortController().signal);
  } catch (err) {
    console.error('source_ledger_report_failed', { err, jobId: job.jobId, sourceFingerprint: job.sourceFingerprint });
  }
}

/**
 * Execute and verify one platform-funded source preparation in the container.
 * @param job - Fixed source, deadline, limits and private outbound capabilities.
 * @returns Acknowledgement after storage reports and local cleanup.
 * @throws {Error} When the final durable usage report cannot be acknowledged.
 */
export async function runAlphaPresentation(job: AlphaRunBody): Promise<AlphaRunResult> {
  const startedAt = Date.now();
  const beforeCPU = await cpuUsec();
  const signal = AbortSignal.timeout(Math.max(1, job.deadlineAt - Date.now()));
  const identity = { jobId: job.jobId, sourceFingerprint: job.sourceFingerprint, deadlineAt: job.deadlineAt, token: job.token };
  let directory: string | undefined;
  let error: string | undefined;
  let ledgerError: string | undefined;
  const requestedLedger = job.limits.sourceLedger !== undefined || job.sourceLedgerOutputURL !== undefined || job.ledgerOnly === true;
  // The ledger is produced only once the presentation is ready, so playback never waits for it.
  let ready: { input: string; directory: string; raw?: Record<string, unknown> } | undefined;
  try {
    beforeStage(job, signal);
    if (requestedLedger && (job.limits.sourceLedger === undefined || job.sourceLedgerOutputURL === undefined ||
      Object.values(job.limits.sourceLedger).some(value => !Number.isSafeInteger(value) || value <= 0))) throw new AlphaFailure('admission_invalid');
    directory = await mkdtemp(join(tmpdir(), 'alpha-presentation-'));
    const input = join(directory, 'source');
    await download(job.sourceURL, input, signal);
    if ((await stat(input)).size > job.limits.maxSourceBytes) throw new AlphaFailure('source_over_cap');
    if (job.ledgerOnly === true) ready = { input, directory };
    else {
      beforeStage(job, signal);
      const raw = await probe(input, job, signal, false);
      beforeStage(job, signal);
      if (pixelFormats === undefined) pixelFormats = JSON.parse((await runPlanCommand('ffprobe', ['-v', 'error', '-show_pixel_formats', '-of', 'json'], {
        signal, stdoutBytes: job.limits.probeStdoutBytes, stderrTailBytes: job.limits.stderrTailBytes,
      })).toString('utf8'));
      const classification = classifyVideoAlpha(raw, pixelFormats);
      if (classification === 'unknown') throw new AlphaFailure('classification_unknown');
      const source = readProbeOutput(JSON.stringify(raw));
      const metadata = pickMediaMetadata(source);
      if (metadata.width === null || metadata.height === null || metadata.durationSeconds === null || metadata.durationSeconds <= 0) throw new AlphaFailure('metadata_unknown');
      const video = selectedVideo(raw);
      const format = record(raw.format);
      const formats = record(pixelFormats).pixel_formats as unknown[];
      const pixel = formats.map(record).find(value => value.name === video.pix_fmt)!;
      const tags = typeof video.tags === 'object' && video.tags !== null ? record(video.tags) : {};
      const alphaMode = Object.entries(tags).find(([name]) => name.toLowerCase() === 'alpha_mode')?.[1];
      const evidence: AlphaProbeEvidence = { codecName: String(video.codec_name), pixelFormat: String(video.pix_fmt),
        pixelAlpha: record(pixel.flags).alpha as 0 | 1, alphaMode: typeof alphaMode === 'string' ? alphaMode : null,
        formatName: String(format.format_name), videoStreamIndex: Number(video.index) };
      await report(job, { ...identity, kind: 'probe', classification, original: { width: metadata.width, height: metadata.height, duration: metadata.durationSeconds }, evidence }, signal);
      if (classification === 'confirmed_alpha') {
        const full = await probe(input, job, signal, true);
        const originalClock = clockOf(full);
        const width = metadata.width;
        const height = metadata.height;
        const planeWidth = Math.ceil(width / 2) * 2;
        const packedHeight = Math.ceil(height / 2) * 2;
        const packedWidth = planeWidth * 2;
        // The packed picture is the one the source shows, the size it is filed at: codec cropping only, at the SAR's natural size.
        const decoder = [...CODEC_CROPPING_ONLY, ...alphaDecoderArgs(String(video.codec_name), typeof alphaMode === 'string' ? alphaMode : null)];
        const picture = shownFilters(source);
        const output = join(directory, 'packed.mp4');
        // Both branches read planar RGBA: split hands a palette (pal8) frame on as it is, and alphaextract crashes on it.
        const filter = `[0:${integer(video.index)}]${picture === null ? '' : `${picture},`}format=gbrap,split=2[r][a];[r]premultiply=inplace=1,format=rgb24,pad=${planeWidth}:${packedHeight}:0:0:color=black[rgb];[a]alphaextract,format=rgb24,pad=${planeWidth}:${packedHeight}:0:0:color=black[alpha];[rgb][alpha]hstack,format=yuv420p[v]`;
        const last = originalClock.frames[originalClock.frames.length - 1]!;
        const timescale = originalClock.videoTimeBase.split('/')[1]!;
        const threads = String(Math.max(1, Math.floor(job.vcpu)));
        beforeStage(job, signal);
        await runPlanCommand('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-copyts', '-protocol_whitelist', 'file', ...decoder, '-i', input,
          '-filter_complex_threads', threads, '-filter_complex', filter, '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-threads:v', threads, '-preset', job.limits.preset, '-crf', String(job.limits.crf),
          '-fps_mode:v', 'passthrough', '-enc_time_base:v', originalClock.videoTimeBase, '-video_track_timescale', timescale, '-bf', '0',
          '-bsf:v', `setts=duration=if(eq(N\\,${originalClock.frames.length - 1})\\,${last.duration}\\,DURATION)`,
          ...audioOut(source), '-avoid_negative_ts', 'disabled', '-fs', String(job.limits.maxPackedBytes + 1), '-movflags', '+faststart', output],
        { signal, stdoutBytes: job.limits.analysisStdoutBytes, stderrTailBytes: job.limits.stderrTailBytes });
        const size = (await stat(output)).size;
        if (size <= 0 || size > job.limits.maxPackedBytes) throw new AlphaFailure('packed_over_cap');
        const packed = await probe(output, job, signal, true);
        const packedVideo = selectedVideo(packed);
        if (packedVideo.codec_name !== 'h264' || packedVideo.width !== packedWidth || packedVideo.height !== packedHeight || !verifyAlphaPackedClock(originalClock, clockOf(packed))) throw new AlphaFailure('packed_clock_mismatch');
        await report(job, { ...identity, kind: 'encoded', packedWidth, packedHeight,
          colorRect: { x: 0, y: 0, width, height }, alphaRect: { x: planeWidth, y: 0, width, height } }, signal);
        beforeStage(job, signal);
        await put(job.outputURL, output, signal);
      }
      ready = { input, directory, raw };
    }
  } catch (cause) {
    const observed = signal.aborted || job.deadlineAt <= Date.now() ? 'expired' : cause instanceof AlphaFailure ? cause.code : 'presentation_failed';
    // A failed presentation produces no ledger; the store ends the pending ledger without this code.
    if (job.ledgerOnly !== true) error = observed;
    else {
      ledgerError = observed;
      await reportLedgerFailure(job, ledgerError);
    }
    console.error('alpha_presentation_failed', { err: cause, jobId: job.jobId, sourceFingerprint: job.sourceFingerprint });
  }
  if (requestedLedger && ready !== undefined) {
    try {
      const raw = ready.raw ?? await sourceMetadata(ready.input, job, signal, job.limits.sourceLedger!.probeStdoutBytes);
      await produceSourceLedger(ready.input, ready.directory, raw, job, signal);
    } catch (cause) {
      ledgerError = ledgerFailureCode(cause, job, signal);
      console.error('source_ledger_failed', { err: cause, jobId: job.jobId, sourceFingerprint: job.sourceFingerprint });
      await reportLedgerFailure(job, ledgerError);
    }
  }
  // Cleanup runs after both phases; neither of them throws past its own catch.
  if (directory !== undefined) await rm(directory, { recursive: true, force: true }).catch((err: unknown) => {
    console.error('alpha_presentation_cleanup_failed', { err, jobId: job.jobId });
    error ??= 'cleanup_failed';
  });
  const afterCPU = await cpuUsec();
  const usage = { wallMs: Date.now() - startedAt, cpuUsec: beforeCPU === null || afterCPU === null ? null : Math.max(0, afterCPU - beforeCPU) };
  // Reporting a completed measurement is not another media subprocess and may
  // arrive after the original deadline; the owner still fences its attempt.
  await report(job, { ...identity, kind: 'finished', usage, ...(error === undefined ? {} : { error }) }, new AbortController().signal);
  const outcome = error ?? ledgerError;
  return outcome === undefined ? { ok: true } : { ok: false, error: outcome };
}

/**
 * Handle the owned synchronous alpha endpoint without creating a background run.
 * @param request - Container-local HTTP request, already scoped by the edge owner.
 * @param response - HTTP acknowledgement kept open through the entire run.
 * @returns Nothing after the complete report has been delivered.
 * @throws {never} Failures are logged and represented by a stable response.
 */
export async function handleAlphaPresentation(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let job: AlphaRunBody | undefined;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    job = JSON.parse(Buffer.concat(chunks).toString('utf8')) as AlphaRunBody;
    const identity = JSON.stringify(job);
    const prior = runs.get(job.jobId);
    if (prior !== undefined && prior.identity !== identity) throw new AlphaFailure('attempt_conflict');
    const result = prior?.result ?? runAlphaPresentation(job);
    if (prior === undefined) runs.set(job.jobId, { identity, result });
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await result));
  } catch (err) {
    console.error('alpha_presentation_request_failed', { err, jobId: job?.jobId });
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'presentation_failed' }));
  }
}

export { ALPHA_RUN_PATH };
