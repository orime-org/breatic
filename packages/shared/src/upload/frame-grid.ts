// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { FrameRate } from '@shared/upload/frame-grid-rate.js';

/**
 * The fixed-rate frame grid of a video presentation (frame-grid design §4.1) and the conversion of grid frame
 * numbers to read positions on a tool source (§7.16). Every function is pure: the front end, admission, worker
 * recipes and containers call the same code and get the same answer. Times are exact rationals in seconds
 * ({@link FrameRate} shape) unless a field is a float in seconds measured by the probe.
 */

/**
 * The frame-number mapping rule's version (§3.2 item 2): part of every plan; raised only when re-checking the samples
 * after an FFmpeg upgrade finds a source frame in another slot.
 */
export const GRID_RULES_VERSION = 1;

/** FFmpeg CLI moves a seek target back by 3/23 s before seeking a stream with B-frames (§7.16). */
const CLI_SEEK_BACKOFF = { numerator: 3, denominator: 23 } as const;

/** Inputs of the grid plan, all read from the probe and the decode-only count job. */
export interface FrameGridInput {
  fps: FrameRate;
  /** Display time of the first decoded video frame. */
  firstVideoTime: FrameRate;
  /** Display time of the last decoded video frame. */
  lastVideoTime: FrameRate;
  /** Decoded video frames; 1 makes a single-frame video. */
  sourceFrames: number;
  /** Start of the first decoded audio frame of the selected track, or null without audio. */
  firstAudioFrameTime: FrameRate | null;
  /** End of the selected track's last audio packet ({@link audioGridEnd}), or null without audio. */
  audioEnd: FrameRate | null;
  /** The container's timestamp precision: the Matroska/WebM time base, 0 elsewhere. */
  quantum: FrameRate;
  /** `single_frame_duration_ms`. */
  singleFrameMs: number;
}

/** The grid plan written into P's display grid. */
export interface FrameGrid {
  gridStart: FrameRate;
  /** Absolute grid end time; null for a multi-frame video without audio. */
  gridEnd: FrameRate | null;
  /** Slots before the first video frame, filled by it. */
  leadFrames: number;
  /** V: slots up to and including the last real video frame. */
  realFrameCount: number;
  frameCount: number;
  /** frameCount − V: slots the last frame holds until the grid end. */
  holdFrames: number;
}

/** The selected audio track's last demuxed packet. */
export interface AudioLastPacket {
  pts: number;
  duration: number;
  timeBase: FrameRate;
  /** Samples of `AV_PKT_DATA_SKIP_SAMPLES` discard padding; 0 when absent. */
  discardPadding: number;
  sampleRate: number;
}

/** One demuxed video packet, timestamps in stream time-base ticks. */
export interface SourcePacket {
  pts: number | null;
  dts: number | null;
  duration: number;
  keyframe: boolean;
  /** Discarded by the edit list; still counted for keyframe statistics. */
  discard: boolean;
}

/** Source keyframe statistics frozen into P's receipt (§3.2 item 7), in seconds. */
export interface SourceKeyframeStats {
  earliestKeyframeTime: number;
  maxKeyframeInterval: number;
  allKeyframes: boolean;
}

/** A grid frame range [start, end). */
export interface GridFrameRange {
  start: number;
  end: number;
}

/** A grid time range [start, end) in exact seconds. */
export interface GridTimeRange {
  start: FrameRate;
  end: FrameRate;
}

/** The grid facts a seek needs. */
export interface SeekGrid {
  fps: FrameRate;
  gridStart: FrameRate;
  realFrameCount: number;
}

/** A seek on an original tool source. */
export interface GridSeekInput {
  grid: SeekGrid;
  keyframes: SourceKeyframeStats;
  startFrame: number;
}

/** The facts of the landing check. */
export interface GridLanding {
  fps: FrameRate;
  gridStart: FrameRate;
  seekFrame: number;
}

/** Inputs of the decode pre-roll estimate (§5.4). */
export interface DecodePrerollInput {
  toolSource: 'original' | 'edit';
  keyframes: SourceKeyframeStats;
  fps: FrameRate;
}

/** An exact rational with a positive denominator. */
interface Exact {
  n: bigint;
  d: bigint;
}

/**
 * Greatest common divisor of two non-negative integers.
 * @param a - First value.
 * @param b - Second value.
 * @returns gcd(a, b).
 * @throws {never} Pure arithmetic.
 */
function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

/**
 * Lifts a numeric rational to BigInt with a positive denominator.
 * @param r - Rational of safe integers.
 * @returns The same value as BigInt parts.
 * @throws {Error} When the denominator is zero or a part is not an integer.
 */
function exact(r: FrameRate): Exact {
  if (r.denominator === 0) throw new Error('rational with zero denominator');
  const n = BigInt(r.numerator);
  const d = BigInt(r.denominator);
  return d < 0n ? { n: -n, d: -d } : { n, d };
}

/**
 * Reduces a BigInt rational back to the numeric shape.
 * @param r - Rational with a positive denominator.
 * @returns The reduced rational; zero is 0/1.
 * @throws {never} Pure arithmetic.
 */
function toRational(r: Exact): FrameRate {
  const g = gcd(r.n < 0n ? -r.n : r.n, r.d);
  return g === 0n ? { numerator: 0, denominator: 1 } : { numerator: Number(r.n / g), denominator: Number(r.d / g) };
}

/**
 * a − b.
 * @param a - Minuend.
 * @param b - Subtrahend.
 * @returns The difference.
 * @throws {never} Pure arithmetic.
 */
function sub(a: Exact, b: Exact): Exact {
  return { n: a.n * b.d - b.n * a.d, d: a.d * b.d };
}

/**
 * a × b.
 * @param a - Factor.
 * @param b - Factor.
 * @returns The product.
 * @throws {never} Pure arithmetic.
 */
function mul(a: Exact, b: Exact): Exact {
  return { n: a.n * b.n, d: a.d * b.d };
}

/**
 * Compares two rationals.
 * @param a - Left.
 * @param b - Right.
 * @returns Negative, zero or positive as a is below, equal to or above b.
 * @throws {never} Pure arithmetic.
 */
function cmp(a: Exact, b: Exact): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Rounds to the nearest integer, a half away from zero (the `fps` filter's `round=near`).
 * @param r - Rational with a positive denominator.
 * @returns The rounded integer.
 * @throws {never} Pure arithmetic.
 */
function roundNear(r: Exact): bigint {
  const magnitude = (2n * (r.n < 0n ? -r.n : r.n) + r.d) / (2n * r.d);
  return r.n < 0n ? -magnitude : magnitude;
}

/**
 * Rounds up to an integer.
 * @param r - Rational with a positive denominator.
 * @returns The ceiling.
 * @throws {never} Pure arithmetic.
 */
function ceil(r: Exact): bigint {
  const q = r.n / r.d;
  return r.n > q * r.d ? q + 1n : q;
}

/**
 * Float value of a rational.
 * @param r - Numeric rational.
 * @returns numerator ÷ denominator.
 * @throws {never} Pure arithmetic.
 */
function seconds(r: FrameRate): number {
  return r.numerator / r.denominator;
}

/**
 * Rounds a float to the nearest integer, a half away from zero.
 * @param x - Value.
 * @returns The rounded integer.
 * @throws {never} Pure arithmetic.
 */
function roundNearFloat(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * The grid end of the selected audio track: its last packet's pts plus duration, less the packet's
 * `discard_padding` (§4.1 grid end row), not the end of the last decoded (padded) audio frame.
 * @param last - The track's last demuxed packet.
 * @returns The absolute end time in exact seconds.
 * @throws {Error} When a time base or sample rate is zero.
 */
export function audioGridEnd(last: AudioLastPacket): FrameRate {
  if (last.sampleRate <= 0) throw new Error('audio sample rate must be positive');
  const end = mul({ n: BigInt(last.pts + last.duration), d: 1n }, exact(last.timeBase));
  return toRational(sub(end, { n: BigInt(last.discardPadding), d: BigInt(last.sampleRate) }));
}

/**
 * Plans a video's frame grid (§4.1): the grid starts at the earlier of the first video frame and the first
 * decoded audio frame; V = round((last frame − start) × fps) + 1; frameCount = max(V, ceil((end − start − q) × fps)),
 * where the end is the audio end and q the container's timestamp quantum. A multi-frame video without audio has
 * no grid end; a single-frame video lasts `singleFrameMs`, or until a longer audio track ends.
 * @param input - Probe and count facts.
 * @returns The grid plan.
 * @throws {Error} When fps is not positive or a rational has a zero denominator.
 */
export function planFrameGrid(input: FrameGridInput): FrameGrid {
  const fps = exact(input.fps);
  if (fps.n <= 0n) throw new Error('frame rate must be positive');
  const firstVideo = exact(input.firstVideoTime);
  const firstAudio = input.firstAudioFrameTime === null ? null : exact(input.firstAudioFrameTime);
  const start = firstAudio !== null && cmp(firstAudio, firstVideo) < 0 ? firstAudio : firstVideo;
  const leadFrames = roundNear(mul(sub(firstVideo, start), fps));
  const realFrameCount = roundNear(mul(sub(exact(input.lastVideoTime), start), fps)) + 1n;
  const audioEnd = input.audioEnd === null ? null : exact(input.audioEnd);

  let end: Exact | null = audioEnd;
  // q is taken off only when the end comes from an audio packet; a derived single-frame end is exact.
  let quantum: Exact = audioEnd === null ? { n: 0n, d: 1n } : exact(input.quantum);
  if (input.sourceFrames <= 1) {
    const derived: Exact = { n: start.n * 1000n + BigInt(input.singleFrameMs) * start.d, d: start.d * 1000n };
    if (audioEnd === null || cmp(derived, audioEnd) >= 0) {
      end = derived;
      quantum = { n: 0n, d: 1n };
    }
  }

  const covered = end === null ? 0n : ceil(mul(sub(sub(end, start), quantum), fps));
  const frameCount = covered > realFrameCount ? covered : realFrameCount;
  return {
    gridStart: toRational(start),
    gridEnd: end === null ? null : toRational(end),
    leadFrames: Number(leadFrames),
    realFrameCount: Number(realFrameCount),
    frameCount: Number(frameCount),
    holdFrames: Number(frameCount - realFrameCount),
  };
}

/**
 * The FFmpeg filter chain that places source frames on the grid (§4.1 source placement row): shift time to the
 * grid start, clone the last source frame forever so it keeps its slot and fills the hold area, resample to the
 * grid, then cut by frame number to [startFrame, endFrame).
 * @param input - Grid start, fps and the job's grid frame range.
 * @param input.gridStart - Grid start in source time.
 * @param input.fps - Grid frame rate.
 * @param input.startFrame - First grid frame of the job (k0).
 * @param input.endFrame - Grid frame the job stops before (k1).
 * @returns A comma-separated filter chain.
 * @throws {Error} When a rational has a zero denominator.
 */
export function gridFilterChain(input: { gridStart: FrameRate; fps: FrameRate; startFrame: number; endFrame: number }): string {
  const shift = toRational(exact(input.gridStart));
  return [
    `setpts=PTS-(${shift.numerator}/${shift.denominator})/TB`,
    'tpad=stop_mode=clone:stop=-1',
    `fps=${input.fps.numerator}/${input.fps.denominator}:start_time=0:round=near:eof_action=pass`,
    `trim=start_frame=${input.startFrame}:end_frame=${input.endFrame}`,
  ].join(',');
}

/**
 * Grid time of frame i: exactly i / fps (§7.16).
 * @param frame - Grid frame number.
 * @param fps - Grid frame rate.
 * @returns The reduced rational time in seconds.
 * @throws {Error} When fps has a zero part.
 */
export function gridFrameTime(frame: number, fps: FrameRate): FrameRate {
  const rate = exact(fps);
  if (rate.n === 0n) throw new Error('frame rate must be non-zero');
  return toRational({ n: BigInt(frame) * rate.d * (rate.n < 0n ? -1n : 1n), d: rate.n < 0n ? -rate.n : rate.n });
}

/**
 * A frame range [k0, k1) as grid time [k0/fps, k1/fps).
 * @param range - Grid frame range.
 * @param fps - Grid frame rate.
 * @returns The exact grid time range.
 * @throws {Error} When fps has a zero part.
 */
export function gridRangeTimes(range: GridFrameRange, fps: FrameRate): GridTimeRange {
  return { start: gridFrameTime(range.start, fps), end: gridFrameTime(range.end, fps) };
}

/**
 * A grid time range back to frame numbers; a time off the grid goes to the nearest slot, a half away from zero.
 * @param times - Grid time range.
 * @param fps - Grid frame rate.
 * @returns The grid frame range.
 * @throws {Error} When a rational has a zero denominator.
 */
export function gridRangeFrames(times: GridTimeRange, fps: FrameRate): GridFrameRange {
  const rate = exact(fps);
  return { start: Number(roundNear(mul(exact(times.start), rate))), end: Number(roundNear(mul(exact(times.end), rate))) };
}

/**
 * Source keyframe statistics from every video packet, read without `-ignore_editlist` (§3.2 item 7): packets are
 * timed by pts, or dts without pts; keyframes discarded by the edit list count. The largest interval also covers
 * the last GOP up to the end of the last frame, so a source with one keyframe takes its whole duration.
 * @param packets - All video packets in stream ticks.
 * @param timeBase - The stream time base.
 * @returns The statistics in seconds.
 * @throws {Error} When no packet is a timed keyframe.
 */
export function sourceKeyframeStats(packets: readonly SourcePacket[], timeBase: FrameRate): SourceKeyframeStats {
  const keyframes: number[] = [];
  let end = Number.NEGATIVE_INFINITY;
  let allKeyframes = true;
  for (const packet of packets) {
    const time = packet.pts ?? packet.dts;
    if (time === null) continue;
    end = Math.max(end, time + packet.duration);
    if (packet.keyframe) keyframes.push(time);
    else allKeyframes = false;
  }
  if (keyframes.length === 0) throw new Error('source has no timed keyframe packet');
  keyframes.sort((a, b) => a - b);
  let maxTicks = end - keyframes[keyframes.length - 1]!;
  for (let i = 1; i < keyframes.length; i++) maxTicks = Math.max(maxTicks, keyframes[i]! - keyframes[i - 1]!);
  const tick = seconds(timeBase);
  return { earliestKeyframeTime: keyframes[0]! * tick, maxKeyframeInterval: maxTicks * tick, allKeyframes };
}

/**
 * Seconds the seek backs off by: the largest keyframe interval, never under FFmpeg CLI's 3/23 s.
 * @param keyframes - Source keyframe statistics.
 * @returns The back-off in seconds.
 * @throws {never} Pure arithmetic.
 */
function seekBackoff(keyframes: SourceKeyframeStats): number {
  return Math.max(keyframes.maxKeyframeInterval, seconds(CLI_SEEK_BACKOFF));
}

/**
 * The `-ss` position on an original tool source (§7.16): one frame before the seek frame, which is the target or
 * the last real video frame (V − 1), whichever is earlier, in absolute source time. Attempt n > 0 backs off a
 * further max(largest keyframe interval, 3/23 s) × 2^(n−1). A position before the earliest keyframe packet plus
 * that back-off gives no `-ss`: decode from the start.
 * @param input - Grid, keyframe statistics and target frame.
 * @param attempt - 0 for the first seek, then one more per late landing.
 * @returns Seconds for `-ss`, or null to decode from the start.
 * @throws {never} Pure arithmetic.
 */
export function gridSeekPosition(input: GridSeekInput, attempt: number): number | null {
  const { grid, keyframes } = input;
  const seekFrame = Math.min(input.startFrame, grid.realFrameCount - 1);
  const backoff = seekBackoff(keyframes);
  const position = seconds(grid.gridStart) + (seekFrame - 1) / seconds(grid.fps) - (attempt > 0 ? backoff * 2 ** (attempt - 1) : 0);
  return position < keyframes.earliestKeyframeTime + backoff ? null : position;
}

/**
 * The landing check (§7.16): the first source frame decoded before the `fps` filter landed late when its slot,
 * round((pts − grid start) × fps), is past the seek frame, or when nothing was decoded.
 * @param landing - Grid start, fps and the seek frame.
 * @param firstFrameTime - Absolute source time of the first decoded frame, or null.
 * @returns Whether to seek again with a larger back-off.
 * @throws {never} Pure arithmetic.
 */
export function gridLandingLate(landing: GridLanding, firstFrameTime: number | null): boolean {
  if (firstFrameTime === null) return true;
  return roundNearFloat((firstFrameTime - seconds(landing.gridStart)) * seconds(landing.fps)) > landing.seekFrame;
}

/**
 * Decode pre-roll frames of one job (§5.4): max(largest keyframe interval, 3/23 s) × fps + 1, rounded up, on an
 * original; an all-intra edit file seeks exactly and has none.
 * @param input - Tool source kind, keyframe statistics and fps.
 * @returns Frames decoded before the job's first frame.
 * @throws {never} Pure arithmetic.
 */
export function decodePrerollFrames(input: DecodePrerollInput): number {
  if (input.toolSource === 'edit') return 0;
  // ponytail: 1e-9 absorbs float error in exact products such as 3/23 s × 23 fps; it is far under one frame.
  return Math.ceil(seekBackoff(input.keyframes) * seconds(input.fps) + 1 - 1e-9);
}
