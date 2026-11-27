// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { createInterface } from 'node:readline';
import { protocolsFor, type ReadFrom } from '@ingest/probe-command.js';
import { startPlanCommand } from '@ingest/container/plan-command.js';
import { readServedObject } from '@ingest/container/served-object-read.js';

/** An exact time as a numerator over a positive denominator, in seconds. */
export type ExactSeconds = readonly [bigint, bigint];

/** The window a stream covers: start inclusive, end exclusive. */
export interface StreamWindow { start: ExactSeconds; end: ExactSeconds }

/**
 * Whether ffprobe reported the stream's own start and length. Matroska writes neither length nor stream duration (only
 * a `DURATION` tag), so its audio is measured from decoded frames.
 * @param stream - One ffprobe stream.
 * @returns True when both are present.
 */
export function declaresAudioWindow(stream: Record<string, unknown>): boolean {
  return stream.start_pts !== undefined && stream.duration_ts !== undefined;
}

/**
 * Read an exact integer without rounding.
 * @param value - A JSON field.
 * @returns The integer, or null when the field is not one.
 */
function integer(value: unknown): bigint | null {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

/** Collects one stream's window frame by frame, so a long source never holds its frame list. */
export interface WindowAccumulator {
  /**
   * Take one entry from FFprobe.
   * @param fields - Its fields by name (`pts` with `nb_samples` for decoded audio, `pts` with `duration` for packets).
   * @returns False when the entry carries no exact clock, which leaves the window unknown.
   */
  add(fields: Readonly<Record<string, unknown>>): boolean;
  /**
   * The window seen so far.
   * @returns It, or null when nothing was taken or a taken entry had no exact clock.
   */
  window(): StreamWindow | null;
}

/**
 * Collect the window an audio stream plays from its decoded frames: the first frame's start to the latest end, each end
 * being the frame's start plus its sample count at the stream's sample rate.
 * @param stream - The ffprobe audio stream (its `time_base` and `sample_rate`).
 * @returns The accumulator, or null when the stream's clock facts are missing.
 */
export function decodedAudioAccumulator(stream: Record<string, unknown>): WindowAccumulator | null {
  const base = typeof stream.time_base === 'string' ? /^(\d+)\/(\d+)$/.exec(stream.time_base) : null;
  const rate = integer(stream.sample_rate);
  if (base === null || rate === null || rate <= 0n || BigInt(base[1]!) <= 0n || BigInt(base[2]!) <= 0n) return null;
  const numerator = BigInt(base[1]!);
  const denominator = BigInt(base[2]!);
  // Every time is held over the common denominator `denominator * rate`.
  const scale = denominator * rate;
  let start: bigint | null = null;
  let end: bigint | null = null;
  let broken = false;
  return {
    add(fields) {
      const pts = integer(fields.pts);
      const samples = integer(fields.nb_samples);
      if (pts === null || samples === null || samples < 0n) { broken = true; return false; }
      const at = pts * numerator * rate;
      const until = at + samples * denominator;
      if (start === null || at < start) start = at;
      if (end === null || until > end) end = until;
      return true;
    },
    window() {
      if (broken || start === null || end === null || end <= start) return null;
      return { start: [start, scale], end: [end, scale] };
    },
  };
}

/**
 * Collect the window a video stream covers from its packets: the earliest presentation time to the latest packet end.
 * A packet without a duration (a Matroska last block without BlockDuration or DefaultDuration) ends after the
 * stream's largest known packet duration.
 * @param stream - The ffprobe video stream (its `time_base`).
 * @returns The accumulator, or null when the stream's time base is missing.
 */
export function videoPacketAccumulator(stream: Record<string, unknown>): WindowAccumulator | null {
  const base = typeof stream.time_base === 'string' ? /^(\d+)\/(\d+)$/.exec(stream.time_base) : null;
  if (base === null || BigInt(base[1]!) <= 0n || BigInt(base[2]!) <= 0n) return null;
  const numerator = BigInt(base[1]!);
  const denominator = BigInt(base[2]!);
  let start: bigint | null = null;
  let knownEnd: bigint | null = null;
  let lastUntimed: bigint | null = null;
  let widest = 0n;
  let broken = false;
  return {
    add(fields) {
      const pts = integer(fields.pts);
      if (pts === null) { broken = true; return false; }
      const duration = integer(fields.duration);
      if (start === null || pts < start) start = pts;
      if (duration !== null && duration > 0n) {
        if (duration > widest) widest = duration;
        if (knownEnd === null || pts + duration > knownEnd) knownEnd = pts + duration;
      } else if (lastUntimed === null || pts > lastUntimed) lastUntimed = pts;
      return true;
    },
    window() {
      if (broken || start === null) return null;
      let end = knownEnd;
      if (lastUntimed !== null) {
        if (widest === 0n) return null;
        if (end === null || lastUntimed + widest > end) end = lastUntimed + widest;
      }
      if (end === null || end <= start) return null;
      return { start: [start * numerator, denominator], end: [end * numerator, denominator] };
    },
  };
}

/**
 * Measure the window one stream covers by streaming FFprobe's entries line by line, so a long source never holds its
 * list: an audio stream from its decoded frames, which apply the codec's priming and end trimming (Opus pre-skip,
 * Matroska CodecDelay) that packet timestamps include; a video stream from its packets. A served object is read through
 * `readServedObject`, because FFprobe exits 0 with the entries seen so far when its own read stops early, and its log is
 * no sign of a whole read (FFmpeg 8.0.1 logs an Opus packet error at the end of every Opus stream).
 * @param input - Where the source is read.
 * @param stream - The ffprobe stream (its `index`, `codec_type`, `time_base` and, for audio, `sample_rate`).
 * @param from - Whether the source is the served object or a local file.
 * @param run - The read's lifetime and the stderr tail kept for its error.
 * @param run.signal - The lifetime; aborting kills FFprobe.
 * @param run.stderrTailBytes - The stderr tail kept.
 * @returns The window, or null when a clock fact is missing or nothing is read.
 * @throws {PlanCommandExit} When FFprobe exits non-zero.
 * @throws {Error} When a served object's read does not complete, or the read is cancelled.
 */
export async function readStreamWindow(input: string, stream: Record<string, unknown>, from: ReadFrom,
  run: { signal: AbortSignal; stderrTailBytes: number }): Promise<StreamWindow | null> {
  if (from === 'object') return readServedObject(input, run.signal, (local) => probeStreamWindow(local, stream, from, run));
  return probeStreamWindow(input, stream, from, run);
}

/**
 * Run FFprobe over one stream and fold its entries into the stream's window.
 * @param input - Where FFprobe reads the source.
 * @param stream - The ffprobe stream.
 * @param from - What FFprobe reads, which decides the protocols it may open.
 * @param run - The read's lifetime and the stderr tail kept for its error.
 * @param run.signal - The lifetime; aborting kills FFprobe.
 * @param run.stderrTailBytes - The stderr tail kept.
 * @returns The window, or null when a clock fact is missing or nothing is read.
 * @throws {PlanCommandExit} When FFprobe exits non-zero.
 * @throws {Error} When the read is cancelled.
 */
async function probeStreamWindow(input: string, stream: Record<string, unknown>, from: ReadFrom,
  run: { signal: AbortSignal; stderrTailBytes: number }): Promise<StreamWindow | null> {
  const audio = stream.codec_type === 'audio';
  const accumulator = audio ? decodedAudioAccumulator(stream) : videoPacketAccumulator(stream);
  if (accumulator === null) return null;
  const pipe = startPlanCommand('ffprobe', ['-v', 'error', '-protocol_whitelist', protocolsFor(from),
    '-select_streams', String(stream.index), '-show_entries', audio ? 'frame=pts,nb_samples' : 'packet=pts,duration', '-of', 'compact=p=0',
    input], run, { stdout: true });
  let clockless = false;
  try {
    for await (const line of createInterface({ input: pipe.stdout!, crlfDelay: Infinity })) {
      if (line.length === 0) continue;
      const fields = Object.fromEntries(line.split('|').map((pair) => pair.split('=', 2) as [string, string]));
      if (!accumulator.add(fields)) { clockless = true; pipe.stop(); break; }
    }
  } finally {
    await pipe.done.catch((error: unknown) => { if (!clockless) throw error; });
  }
  if (clockless) return null;
  return accumulator.window();
}
