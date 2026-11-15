// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

// Kept free of zod: the media container bundles these timing rules (frames-split design §4.2, §4.2.1, §7.16).

import { gcd, rational, type PresentationRational } from "@shared/mini-tools/video-presentation-projection.js";

/** The fixed output audio sample rate; Opus is 48000 as well. */
export const VIDEO_AUDIO_SAMPLE_RATE = 48000;

/** A half-open interval in exact seconds. */
export interface VideoTimelineInterval { start: PresentationRational; end: PresentationRational }
/** One real frame in edited (original) time; `declaredEnd` is the source's own declared end, if any. */
export interface VideoTimelineInputFrame { start: PresentationRational; declaredEnd: PresentationRational | null }
/** Everything the unified presentation timeline is planned from. */
export interface VideoTimelineInput {
  frames: readonly VideoTimelineInputFrame[];
  emptyEdits: readonly VideoTimelineInterval[];
  /** Matroska Info.Duration: a source fact, never a frame end. */
  segmentDuration: PresentationRational | null;
  audioStart: PresentationRational | null;
  audioEnd: PresentationRational | null;
  singleFrameDurationMs: number;
}
/** How a real frame's support end was obtained. */
export type VideoSupportRule = "declared" | "next-start" | "previous-max" | "audio-end" | "single-frame";
/** One planned frame on the presentation timeline, whose time 0 is the origin. */
export type VideoTimelineFrame =
  | {
    kind: "source"; occurrence: number; displayStart: PresentationRational; displayEnd: PresentationRational;
    support: { rule: VideoSupportRule; start: PresentationRational; end: PresentationRational };
    derivedLead: VideoTimelineInterval | null; derivedHold: VideoTimelineInterval | null;
  }
  | { kind: "derived-empty"; displayStart: PresentationRational; displayEnd: PresentationRational };
/** The planned timeline: `origin` is presentation time 0 on the original timeline. */
export interface VideoPresentationTimeline { origin: PresentationRational; frames: VideoTimelineFrame[]; end: PresentationRational }

type Exact = readonly [bigint, bigint];

/**
 * Reduce a fraction with a positive denominator.
 * @param numerator - The numerator.
 * @param denominator - A positive denominator.
 * @returns The reduced fraction.
 * @throws {never} Never.
 */
function exact(numerator: bigint, denominator: bigint): Exact {
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return [numerator / divisor, denominator / divisor];
}

/**
 * Compare two fractions with positive denominators.
 * @param a - First value.
 * @param b - Second value.
 * @returns A value with the sign of a − b.
 * @throws {never} Never.
 */
function cmp(a: Exact, b: Exact): bigint {
  return a[0] * b[1] - b[0] * a[1];
}

/**
 * Add or subtract two fractions.
 * @param a - First value.
 * @param b - Second value.
 * @param sign - 1n to add, -1n to subtract.
 * @returns The reduced result.
 * @throws {never} Never.
 */
function shift(a: Exact, b: Exact, sign: bigint): Exact {
  return exact(a[0] * b[1] + sign * b[0] * a[1], a[1] * b[1]);
}

/**
 * Write a reduced fraction as decimal strings.
 * @param value - A reduced fraction.
 * @returns The rational.
 * @throws {never} Never.
 */
function text(value: Exact): PresentationRational {
  return { numerator: String(value[0]), denominator: String(value[1]) };
}

/**
 * Plan the unified presentation timeline of design §4.2.1: declared ends first, undeclared frames end at the next start,
 * an undeclared last frame takes the largest earlier start difference and a lone one the single-frame policy; the origin
 * is the earlier of the first frame and the audio start, the first frame leads back to it, every gap after it is one
 * `derived-empty` frame, an explicit trailing empty edit extends to the composite end, otherwise longer audio holds the last frame.
 * @param input - Real frames, empty edits and audio window in original time.
 * @returns The timeline rebased so the origin is 0, in reduced rationals.
 * @throws {RangeError} When there are no frames, a time is not an integer rational, starts are negative or do not increase,
 * a declared end is not after its start or passes the next start, an interval is reversed or the single-frame duration is not a positive integer.
 */
export function planVideoPresentationTimeline(input: VideoTimelineInput): VideoPresentationTimeline {
  const single = input.singleFrameDurationMs;
  if (!Number.isSafeInteger(single) || single <= 0) throw new RangeError("The single-frame duration must be a positive integer of milliseconds");
  if (input.frames.length === 0) throw new RangeError("A presentation timeline needs at least one frame");
  if (input.segmentDuration !== null) rational(input.segmentDuration);
  const starts = input.frames.map((frame) => rational(frame.start));
  const last = starts.length - 1;
  const audioStart = input.audioStart === null ? null : rational(input.audioStart);
  const audioEnd = input.audioEnd === null ? null : rational(input.audioEnd);
  if (audioStart !== null && (audioStart[0] < 0n || (audioEnd !== null && cmp(audioEnd, audioStart) < 0n))) throw new RangeError("The audio window must start at or after zero and not end before it starts");
  const ends: Exact[] = [];
  const rules: VideoSupportRule[] = [];
  starts.forEach((start, index) => {
    if (start[0] < 0n || (index > 0 && cmp(start, starts[index - 1]!) <= 0n)) throw new RangeError("Frame starts must be non-negative and increase");
    const next = starts[index + 1];
    const declared = input.frames[index]!.declaredEnd;
    if (declared !== null) {
      const end = rational(declared);
      if (cmp(end, start) <= 0n || (next !== undefined && cmp(end, next) > 0n)) throw new RangeError("A declared end must lie after its start and not past the next start");
      ends.push(end);
      rules.push("declared");
    } else if (next !== undefined) {
      ends.push(next);
      rules.push("next-start");
    } else if (index === 0) {
      ends.push(shift(start, exact(BigInt(single), 1000n), 1n));
      rules.push("single-frame");
    } else if (audioEnd !== null && cmp(audioEnd, start) > 0n) {
      // A recording's sound runs to its stop, so an undeclared last frame shows until the sound ends (§4.2.1 last frame row).
      ends.push(audioEnd);
      rules.push("audio-end");
    } else {
      let widest: Exact = [0n, 1n];
      for (let at = 1; at <= last; at += 1) {
        const difference = shift(starts[at]!, starts[at - 1]!, -1n);
        if (cmp(difference, widest) > 0n) widest = difference;
      }
      ends.push(shift(start, widest, 1n));
      rules.push("previous-max");
    }
  });

  const origin = audioStart !== null && cmp(audioStart, starts[0]!) < 0n ? audioStart : starts[0]!;
  const support = ends[last]!;
  let end = support;
  let trailing = false;
  for (const edit of input.emptyEdits) {
    const [start, stop] = [rational(edit.start), rational(edit.end)];
    if (cmp(stop, start) <= 0n) throw new RangeError("An empty edit must end after it starts");
    // Leading and internal edits change nothing: gaps follow from the frames' support. Only an edit past the video support matters.
    if (cmp(stop, support) > 0n) {
      trailing = true;
      if (cmp(stop, end) > 0n) end = stop;
    }
  }
  if (audioEnd !== null && cmp(audioEnd, end) > 0n) end = audioEnd;

  /**
   * Rebase an original time onto the presentation timeline.
   * @param value - An original time.
   * @returns The presentation time.
   * @throws {never} Never.
   */
  const at = (value: Exact): PresentationRational => text(shift(value, origin, -1n));
  const frames: VideoTimelineFrame[] = [];
  starts.forEach((start, index) => {
    if (index > 0 && cmp(start, ends[index - 1]!) > 0n) frames.push({ kind: "derived-empty", displayStart: at(ends[index - 1]!), displayEnd: at(start) });
    const displayStart = index === 0 ? origin : start;
    const displayEnd = index === last && !trailing ? end : ends[index]!;
    frames.push({
      kind: "source", occurrence: index, displayStart: at(displayStart), displayEnd: at(displayEnd),
      support: { rule: rules[index]!, start: at(start), end: at(ends[index]!) },
      derivedLead: cmp(displayStart, start) < 0n ? { start: at(displayStart), end: at(start) } : null,
      derivedHold: cmp(ends[index]!, displayEnd) < 0n ? { start: at(ends[index]!), end: at(displayEnd) } : null,
    });
  });
  if (trailing) frames.push({ kind: "derived-empty", displayStart: at(support), displayEnd: at(end) });
  return { origin: text(origin), frames, end: at(end) };
}

/**
 * Map an exact time onto the 48000 Hz output sample grid as FFmpeg `av_rescale` with AV_ROUND_NEAR_INF (nearest, halves away from zero).
 * @param time - Seconds as an exact rational.
 * @returns The sample index.
 * @throws {RangeError} When the time is not an integer rational with a positive denominator or the index is not a safe integer.
 */
export function videoAudioSampleIndex(time: PresentationRational): number {
  const [numerator, denominator] = rational(time);
  const scaled = numerator * BigInt(VIDEO_AUDIO_SAMPLE_RATE);
  const magnitude = (2n * (scaled < 0n ? -scaled : scaled) + denominator) / (2n * denominator);
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("The audio sample index exceeds the safe integer range");
  // Negate as bigint so a value that rounds to zero stays +0.
  return Number(scaled < 0n ? -magnitude : magnitude);
}
