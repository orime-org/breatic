// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * S6a pure timing rules of the unified presentation timeline (inner#1306,
 * test plan §87; frames-split design §4.2 audio sample grid, §4.2.1 frame ends,
 * leading and empty intervals and the composite end, §7.16 invariants).
 *
 * Every expected value below is written from the approved design rows, never
 * from an implementation: declared ends first, Matroska Info.Duration is never a
 * frame end, an undeclared last frame of two or more takes the largest earlier
 * start difference, a lone undeclared frame takes `single_frame_duration_ms`.
 * The presentation origin is the earlier of the first video frame and the
 * selected audio's effective start; presentation time 0 is that origin and the
 * rebase amount is reported. The first real frame extends back to the origin as
 * `derived-lead`, so the first frame is never empty. Every empty interval between
 * frames, merged with its adjacent empty intervals, is one `derived-empty` frame;
 * audio beyond the video extends the last real frame as `derived-hold`; an
 * explicit trailing empty edit wins over the hold and extends to the composite
 * end. Audio endpoints land on a 48000 Hz grid rounded as FFmpeg `av_rescale`
 * with AV_ROUND_NEAR_INF (nearest, halves away from zero).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as miniTools from '../index.js';
import { presentationFrameCount, projectPresentationTable } from '../video-presentation-table.js';

interface Rational { numerator: string; denominator: string }
interface InputFrame { start: Rational; declaredEnd: Rational | null }
interface Interval { start: Rational; end: Rational }
interface TimelineInput {
  frames: InputFrame[];
  emptyEdits: Interval[];
  segmentDuration: Rational | null;
  audioStart: Rational | null;
  audioEnd: Rational | null;
  singleFrameDurationMs: number;
}
type SupportRule = 'declared' | 'next-start' | 'previous-max' | 'audio-end' | 'single-frame';
type PlannedFrame =
  | {
    kind: 'source'; occurrence: number; displayStart: Rational; displayEnd: Rational;
    support: { rule: SupportRule; start: Rational; end: Rational }; derivedLead: Interval | null; derivedHold: Interval | null;
  }
  | { kind: 'derived-empty'; displayStart: Rational; displayEnd: Rational };
interface Timeline { origin: Rational; frames: PlannedFrame[]; end: Rational }
interface TimelineApi {
  planVideoPresentationTimeline: (input: TimelineInput) => Timeline;
  videoAudioSampleIndex: (time: Rational) => number;
  VIDEO_AUDIO_SAMPLE_RATE: number;
}

const api = miniTools as unknown as Partial<TimelineApi>;

/**
 * Read one export of the S6a timeline contract from the mini-tools entry, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function required<K extends keyof TimelineApi>(name: K): TimelineApi[K] {
  const value = api[name];
  expect(value, `${name} is exported from @breatic/shared/mini-tools`).toBeDefined();
  return value as TimelineApi[K];
}

/**
 * Greatest common divisor of two non-negative integers.
 * @param a - First value.
 * @param b - Second value.
 * @returns The divisor.
 */
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * A reduced exact rational with a positive denominator.
 * @param numerator - The numerator.
 * @param denominator - A positive denominator.
 * @returns The reduced rational.
 */
function r(numerator: number | bigint, denominator: number | bigint = 1): Rational {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const divisor = gcd(n < 0n ? -n : n, d);
  return { numerator: String(n / divisor), denominator: String(d / divisor) };
}

/**
 * Whether two reduced rationals are equal.
 * @param a - First value.
 * @param b - Second value.
 * @returns Equality.
 */
function same(a: Rational, b: Rational): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

/**
 * A planned source frame; a lead or hold appears when its support is narrower than its window.
 * @param occurrence - Index of the input frame.
 * @param start - Display start.
 * @param end - Display end.
 * @param rule - How the support end was obtained.
 * @param support - The support interval when it differs from the window.
 * @param support.start - The source support start; defaults to the display start.
 * @param support.end - The support end; defaults to the display end.
 * @returns The expected frame.
 */
function source(occurrence: number, start: Rational, end: Rational, rule: SupportRule, support: { start?: Rational; end?: Rational } = {}): PlannedFrame {
  const supportStart = support.start ?? start;
  const supportEnd = support.end ?? end;
  return {
    kind: 'source', occurrence, displayStart: start, displayEnd: end, support: { rule, start: supportStart, end: supportEnd },
    derivedLead: same(supportStart, start) ? null : { start, end: supportStart },
    derivedHold: same(supportEnd, end) ? null : { start: supportEnd, end },
  };
}

/**
 * A planned derived-empty frame.
 * @param start - Display start.
 * @param end - Display end.
 * @returns The expected frame.
 */
function empty(start: Rational, end: Rational): PlannedFrame {
  return { kind: 'derived-empty', displayStart: start, displayEnd: end };
}

/**
 * A timeline input with the design's default single-frame duration.
 * @param frames - Real frames in presentation order.
 * @param extra - Other fields.
 * @returns The input.
 */
function input(frames: InputFrame[], extra: Partial<TimelineInput> = {}): TimelineInput {
  return { frames, emptyEdits: [], segmentDuration: null, audioStart: null, audioEnd: null, singleFrameDurationMs: 5000, ...extra };
}

/**
 * A declared frame.
 * @param start - Display start.
 * @param end - Declared end.
 * @returns The input frame.
 */
function declared(start: Rational, end: Rational): InputFrame {
  return { start, declaredEnd: end };
}

/**
 * An undeclared frame.
 * @param start - Display start.
 * @returns The input frame.
 */
function bare(start: Rational): InputFrame {
  return { start, declaredEnd: null };
}

describe('PT §4.2.1 frame ends, leading and empty intervals and the composite end', () => {
  it('PT01 a declared frame end is used as declared', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(1, 4), r(1, 2))]))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), source(1, r(1, 4), r(1, 2), 'declared')], end: r(1, 2),
    });
  });

  it('PT02 the four-frame MediaRecorder sample ends at 1.694 s and ignores Info.Duration 932.267 ms', () => {
    // Design §4.2.1 Matroska row: PTS 0/70/170/932 ms, last frame takes the largest earlier difference (762 ms).
    const plan = required('planVideoPresentationTimeline');
    const frames = [bare(r(0)), bare(r(7, 100)), bare(r(17, 100)), bare(r(233, 250))];
    expect(plan(input(frames, { segmentDuration: r(932267, 1_000_000) }))).toEqual({
      origin: r(0),
      frames: [
        source(0, r(0), r(7, 100), 'next-start'),
        source(1, r(7, 100), r(17, 100), 'next-start'),
        source(2, r(17, 100), r(233, 250), 'next-start'),
        source(3, r(233, 250), r(847, 500), 'previous-max'),
      ],
      end: r(847, 500),
    });
  });

  it('PT03 a lone undeclared frame lasts single_frame_duration_ms (default 5000) and ignores a 1 ms Info.Duration', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([bare(r(0))], { segmentDuration: r(1, 1000) }))).toEqual({ origin: r(0), frames: [source(0, r(0), r(5), 'single-frame')], end: r(5) });
    expect(plan(input([bare(r(0))], { singleFrameDurationMs: 2500 }))).toEqual({ origin: r(0), frames: [source(0, r(0), r(5, 2), 'single-frame')], end: r(5, 2) });
  });

  it('PT04 a lone frame with a declared end keeps the declaration instead of the single-frame policy', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 30))]))).toEqual({ origin: r(0), frames: [source(0, r(0), r(1, 30), 'declared')], end: r(1, 30) });
  });

  it('PT05 a declared last frame ends where declared even when earlier frames are undeclared', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([bare(r(0)), bare(r(1, 10)), declared(r(3, 10), r(7, 20))]))).toEqual({
      origin: r(0),
      frames: [source(0, r(0), r(1, 10), 'next-start'), source(1, r(1, 10), r(3, 10), 'next-start'), source(2, r(3, 10), r(7, 20), 'declared')],
      end: r(7, 20),
    });
  });

  it('PT06 the undeclared last frame takes the maximum earlier difference, not the last one or the average', () => {
    // Differences 1/2 and 1/10: maximum 1/2, last 1/10, average 3/10.
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([bare(r(0)), bare(r(1, 2)), bare(r(3, 5))]))).toEqual({
      origin: r(0),
      frames: [source(0, r(0), r(1, 2), 'next-start'), source(1, r(1, 2), r(3, 5), 'next-start'), source(2, r(3, 5), r(11, 10), 'previous-max')],
      end: r(11, 10),
    });
  });

  it('PT07 video starting after 0 with no earlier audio rebases the origin to the first frame, which is never empty', () => {
    // Design §4.2.1 leading row: an explicit leading empty edit and a first frame after 0 without an edit list.
    const plan = required('planVideoPresentationTimeline');
    const expected = { origin: r(1, 4), frames: [source(0, r(0), r(1, 4), 'declared')], end: r(1, 4) };
    expect(plan(input([declared(r(1, 4), r(1, 2))]))).toEqual(expected);
    expect(plan(input([declared(r(1, 4), r(1, 2))], { emptyEdits: [{ start: r(0), end: r(1, 4) }] }))).toEqual(expected);
    // Audio starting at or after the first frame does not move the origin earlier.
    expect(plan(input([declared(r(1, 4), r(1, 2))], { audioStart: r(1, 4), audioEnd: r(1, 2) }))).toEqual(expected);
    expect(plan(input([declared(r(1, 4), r(1, 2))], { audioStart: r(3, 8), audioEnd: r(1, 2) }))).toEqual(expected);
  });

  it('PT08 video starting after the selected audio extends the first real frame back to the audio start as derived-lead', () => {
    const plan = required('planVideoPresentationTimeline');
    const frames = [declared(r(1, 4), r(1, 2)), declared(r(1, 2), r(3, 4))];
    // Audio from 0, with and without an explicit leading empty edit (the Chromium sample: playback from 0 shows the first frame).
    const fromZero = {
      origin: r(0),
      frames: [source(0, r(0), r(1, 2), 'declared', { start: r(1, 4) }), source(1, r(1, 2), r(3, 4), 'declared')],
      end: r(3, 4),
    };
    expect(plan(input(frames, { audioStart: r(0), audioEnd: r(3, 4) }))).toEqual(fromZero);
    expect(plan(input(frames, { audioStart: r(0), audioEnd: r(3, 4), emptyEdits: [{ start: r(0), end: r(1, 4) }] }))).toEqual(fromZero);
    // Audio from 1/10: the origin is 1/10 and every time is rebased by it.
    expect(plan(input(frames, { audioStart: r(1, 10), audioEnd: r(3, 4) }))).toEqual({
      origin: r(1, 10),
      frames: [source(0, r(0), r(2, 5), 'declared', { start: r(3, 20) }), source(1, r(2, 5), r(13, 20), 'declared')],
      end: r(13, 20),
    });
  });

  it('PT09 an internal gap [0.25, 0.75) is exactly one 500 ms derived-empty frame', () => {
    const plan = required('planVideoPresentationTimeline');
    const frames = [declared(r(0), r(1, 4)), declared(r(3, 4), r(1))];
    const expected = { origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), empty(r(1, 4), r(3, 4)), source(1, r(3, 4), r(1), 'declared')], end: r(1) };
    expect(plan(input(frames))).toEqual(expected);
    expect(plan(input(frames, { emptyEdits: [{ start: r(1, 4), end: r(3, 4) }] }))).toEqual(expected);
  });

  it.each([
    ['two adjacent explicit empty edits', [{ start: r(1, 4), end: r(1, 2) }, { start: r(1, 2), end: r(3, 4) }]],
    ['an explicit empty edit followed by an interval without video support', [{ start: r(1, 4), end: r(1, 2) }]],
    ['an interval without video support followed by an explicit empty edit', [{ start: r(1, 2), end: r(3, 4) }]],
  ])('PT10 %s between frames merge into one derived-empty frame', (_, emptyEdits) => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(3, 4), r(1))], { emptyEdits }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), empty(r(1, 4), r(3, 4)), source(1, r(3, 4), r(1), 'declared')], end: r(1),
    });
  });

  it('PT11 audio past the video extends the last real frame as derived-hold without a new frame', () => {
    // Design §4.2.1 audio row: the second frame's support [0.25, 0.5) extends to 1 s.
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(1, 4), r(1, 2))], { audioStart: r(0), audioEnd: r(1) }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), source(1, r(1, 4), r(1), 'declared', { end: r(1, 2) })], end: r(1),
    });
  });

  it.each([[r(1, 3)], [r(1, 2)]])('PT12 audio ending at %o, not after the video, cuts nothing and adds no hold', (audioEnd) => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(1, 4), r(1, 2))], { audioStart: r(0), audioEnd }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), source(1, r(1, 4), r(1, 2), 'declared')], end: r(1, 2),
    });
  });

  it.each([[r(1), r(1)], [r(3, 4), r(1)], [r(1, 3), r(1)], [null, r(1)], [r(3, 2), r(3, 2)]])('PT13 an explicit trailing empty edit [1/2, 1) wins over the hold (audio end %o, composite end %o)', (audioEnd, end) => {
    const plan = required('planVideoPresentationTimeline');
    const audio = audioEnd === null ? {} : { audioStart: r(0), audioEnd };
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(1, 4), r(1, 2))], { emptyEdits: [{ start: r(1, 2), end: r(1) }], ...audio }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), source(1, r(1, 4), r(1, 2), 'declared'), empty(r(1, 2), end)], end,
    });
  });

  it.each([
    ['two adjacent trailing explicit empty edits', [{ start: r(1, 2), end: r(3, 4) }, { start: r(3, 4), end: r(1) }]],
    ['an interval without video support before a trailing explicit empty edit', [{ start: r(3, 4), end: r(1) }]],
  ])('PT14 %s merge into one trailing derived-empty frame', (_, emptyEdits) => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([declared(r(0), r(1, 4)), declared(r(1, 4), r(1, 2))], { emptyEdits, audioStart: r(0), audioEnd: r(1) }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(1, 4), 'declared'), source(1, r(1, 4), r(1, 2), 'declared'), empty(r(1, 2), r(1))], end: r(1),
    });
  });

  it('PT15 a lone frame takes the single-frame support and then holds to a longer audio end', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([bare(r(0))], { audioStart: r(0), audioEnd: r(8) }))).toEqual({ origin: r(0), frames: [source(0, r(0), r(8), 'single-frame', { end: r(5) })], end: r(8) });
    expect(plan(input([bare(r(0))], { audioStart: r(0), audioEnd: r(2) }))).toEqual({ origin: r(0), frames: [source(0, r(0), r(5), 'single-frame')], end: r(5) });
  });

  it('PT16 an undeclared last frame with longer audio ends with the audio, no hold', () => {
    const plan = required('planVideoPresentationTimeline');
    const frames = [bare(r(0)), bare(r(7, 100)), bare(r(17, 100)), bare(r(233, 250))];
    expect(plan(input(frames, { audioStart: r(0), audioEnd: r(2) })).frames.at(-1)).toEqual(source(3, r(233, 250), r(2), 'audio-end'));
  });

  it('PT17 one frame carries both a lead and a hold', () => {
    const plan = required('planVideoPresentationTimeline');
    expect(plan(input([bare(r(1, 2))], { audioStart: r(0), audioEnd: r(8) }))).toEqual({
      origin: r(0), frames: [source(0, r(0), r(8), 'single-frame', { start: r(1, 2), end: r(11, 2) })], end: r(8),
    });
  });

  it.each([
    ['no frames', input([])],
    ['a start that does not increase', input([declared(r(1, 2), r(3, 4)), declared(r(1, 2), r(1))])],
    ['a declared end not after its start', input([declared(r(1, 2), r(1, 2))])],
    ['a negative start', input([declared(r(-1, 4), r(1, 4))])],
    ['a declared end past the next start', input([declared(r(0), r(3, 4)), declared(r(1, 2), r(1))])],
    ['a zero denominator', input([{ start: { numerator: '0', denominator: '0' }, declaredEnd: null }])],
    ['a decimal time', input([{ start: { numerator: '0.5', denominator: '1' }, declaredEnd: null }])],
    ['a zero single-frame duration', input([bare(r(0))], { singleFrameDurationMs: 0 })],
    ['a negative single-frame duration', input([bare(r(0))], { singleFrameDurationMs: -5000 })],
    ['a fractional single-frame duration', input([bare(r(0))], { singleFrameDurationMs: 1.5 })],
    ['a non-finite single-frame duration', input([bare(r(0))], { singleFrameDurationMs: Number.NaN })],
  ])('PT18 rejects %s', (_, value) => {
    const plan = required('planVideoPresentationTimeline');
    expect(() => plan(value)).toThrow(RangeError);
  });
});

interface GeneratedFrame { gap: number; length: number }
interface GeneratedAudio { start: number; length: number }

/**
 * The naive oracle for declared frames with gaps, an optional undeclared last frame and optional audio, written from §4.2.1:
 * an undeclared last frame after others ends with audio that outlasts its start, else after the widest earlier difference.
 * @param frames - Gap before and length of each frame, in units of 1/denominator.
 * @param denominator - The unit.
 * @param lastUndeclared - Whether the last frame has no declared end.
 * @param audio - Audio start and length in units, or null.
 * @param singleFrameMs - The single-frame policy value.
 * @returns The input and the expected timeline.
 */
function oracle(frames: readonly GeneratedFrame[], denominator: number, lastUndeclared: boolean, audio: GeneratedAudio | null, singleFrameMs: number): { input: TimelineInput; expected: Timeline } {
  // Ticks of 1/(denominator·1000) s, so the single-frame milliseconds stay integral.
  const d = BigInt(denominator) * 1000n;
  const starts: bigint[] = [];
  const ends: bigint[] = [];
  let at = 0n;
  for (const frame of frames) { at += BigInt(frame.gap) * 1000n; starts.push(at); at += BigInt(frame.length) * 1000n; ends.push(at); }
  const last = frames.length - 1;
  const audioStart = audio === null ? null : BigInt(audio.start) * 1000n;
  const audioEnd = audio === null ? null : BigInt(audio.start + audio.length) * 1000n;
  let lastRule: SupportRule = 'declared';
  if (lastUndeclared) {
    if (frames.length === 1) { lastRule = 'single-frame'; ends[last] = starts[last]! + BigInt(singleFrameMs) * BigInt(denominator); } else if (audioEnd !== null && audioEnd > starts[last]!) {
      lastRule = 'audio-end';
      ends[last] = audioEnd;
    } else {
      let widest = 0n;
      for (let index = 1; index <= last; index += 1) if (starts[index]! - starts[index - 1]! > widest) widest = starts[index]! - starts[index - 1]!;
      lastRule = 'previous-max';
      ends[last] = starts[last]! + widest;
    }
  }
  const origin = audioStart !== null && audioStart < starts[0]! ? audioStart : starts[0]!;
  const t = (value: bigint): Rational => r(value - origin, d);
  const planned: PlannedFrame[] = [];
  starts.forEach((start, index) => {
    if (index > 0 && start > ends[index - 1]!) planned.push(empty(t(ends[index - 1]!), t(start)));
    planned.push(source(index, t(index === 0 ? origin : start), t(ends[index]!), index === last ? lastRule : 'declared', { start: t(start) }));
  });
  let end = ends[last]!;
  if (audioEnd !== null && audioEnd > end) {
    end = audioEnd;
    const first = last === 0 ? origin : starts[last]!;
    planned[planned.length - 1] = source(last, t(first), t(end), lastRule, { start: t(starts[last]!), end: t(ends[last]!) });
  }
  const inputFrames = starts.map((start, index) => (index === last && lastUndeclared ? bare(r(start, d)) : declared(r(start, d), r(ends[index]!, d))));
  return {
    input: input(inputFrames, {
      audioStart: audioStart === null ? null : r(audioStart, d), audioEnd: audioEnd === null ? null : r(audioEnd, d), singleFrameDurationMs: singleFrameMs,
    }),
    expected: { origin: r(origin, d), frames: planned, end: t(end) },
  };
}

const generatedFrame = fc.record({ gap: fc.integer({ min: 0, max: 6 }), length: fc.integer({ min: 1, max: 6 }) });
const generatedAudio = fc.option(fc.record({ start: fc.integer({ min: 0, max: 10 }), length: fc.integer({ min: 1, max: 200 }) }), { nil: null });

describe('PP §4.2.1 and §7.16 invariants (property)', () => {
  it('PP01 equals the naive oracle for random declared frames, gaps, an undeclared last frame and audio windows', () => {
    const plan = required('planVideoPresentationTimeline');
    fc.assert(fc.property(
      fc.array(generatedFrame, { minLength: 1, maxLength: 12 }), fc.constantFrom(4, 25, 1000), fc.boolean(), generatedAudio, fc.constantFrom(5000, 1000, 2500),
      (frames, denominator, lastUndeclared, audio, singleFrameMs) => {
        const { input: value, expected } = oracle(frames, denominator, lastUndeclared, audio, singleFrameMs);
        expect(plan(value)).toEqual(expected);
      },
    ), { seed: 130687, numRuns: 300 });
  });

  it('PP02 the output tiles [0, end): first frame real, contiguous, one derived-empty per gap, lead and hold add no frame', () => {
    const plan = required('planVideoPresentationTimeline');
    fc.assert(fc.property(
      fc.array(generatedFrame, { minLength: 1, maxLength: 12 }), fc.boolean(), generatedAudio,
      (frames, lastUndeclared, audio) => {
        const { input: value } = oracle(frames, 25, lastUndeclared, audio, 5000);
        const result = plan(value);
        const gaps = frames.slice(1).filter((frame) => frame.gap > 0).length;
        expect(result.frames.filter((frame) => frame.kind === 'source')).toHaveLength(frames.length);
        expect(result.frames.filter((frame) => frame.kind === 'derived-empty')).toHaveLength(gaps);
        expect(result.frames[0]!.kind).toBe('source');
        expect(result.frames[0]!.displayStart).toEqual(r(0));
        result.frames.forEach((frame, index) => {
          if (index > 0) expect(frame.displayStart).toEqual(result.frames[index - 1]!.displayEnd);
          if (index > 0 && frame.kind === 'derived-empty') expect(result.frames[index - 1]!.kind).toBe('source');
          if (index > 0 && frame.kind === 'source') expect(frame.derivedLead).toBeNull();
        });
        expect(result.frames.at(-1)!.displayEnd).toEqual(result.end);
        const held = result.frames.filter((frame) => frame.kind === 'source' && frame.derivedHold !== null);
        expect(held.length).toBeLessThanOrEqual(1);
        if (held.length === 1) expect(result.frames.at(-1)).toBe(held[0]);
        // The S1 projection of the planned windows accepts them and counts the same frames.
        expect(presentationFrameCount(projectPresentationTable(result.frames))).toBe(result.frames.length);
      },
    ), { seed: 130688, numRuns: 300 });
  });

  it('PP03 undeclared frames end at the next start and the last at the largest earlier difference (Matroska, property)', () => {
    const plan = required('planVideoPresentationTimeline');
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 900 }), { minLength: 1, maxLength: 19 }), (differences) => {
      // differences[i] separates frame i from frame i + 1; there is one more frame than differences.
      const starts = differences.reduce<number[]>((all, difference) => [...all, all.at(-1)! + difference], [0]);
      const widest = Math.max(...differences);
      const result = plan(input(starts.map((start) => bare(r(start, 1000)))));
      expect(result.frames).toEqual(starts.map((start, index) => index < starts.length - 1
        ? source(index, r(start, 1000), r(starts[index + 1]!, 1000), 'next-start')
        : source(index, r(start, 1000), r(start + widest, 1000), 'previous-max')));
    }), { seed: 130689, numRuns: 200 });
  });

  it('PP04 Matroska Info.Duration never changes the timeline (property)', () => {
    const plan = required('planVideoPresentationTimeline');
    fc.assert(fc.property(
      fc.array(generatedFrame, { minLength: 1, maxLength: 8 }), fc.boolean(), fc.integer({ min: 1, max: 1_000_000 }),
      (frames, lastUndeclared, duration) => {
        const { input: value, expected } = oracle(frames, 1000, lastUndeclared, null, 5000);
        expect(plan({ ...value, segmentDuration: r(duration, 1000) })).toEqual(expected);
      },
    ), { seed: 130690, numRuns: 200 });
  });

  it('PP05 is pure: frozen input is not mutated and repeated calls are equal', () => {
    const plan = required('planVideoPresentationTimeline');
    const frames = Object.freeze([Object.freeze(bare(r(1, 10))), Object.freeze(bare(r(1, 5)))]) as unknown as InputFrame[];
    const value = Object.freeze(input(frames, { audioStart: r(0), audioEnd: r(1) }));
    const first = plan(value);
    expect(plan(value)).toEqual(first);
  });
});

/**
 * Exact AV_ROUND_NEAR_INF of time × 48000, written independently from FFmpeg's definition.
 * @param numerator - Time numerator.
 * @param denominator - Positive time denominator.
 * @returns The nearest sample index with halves away from zero.
 */
function nearInf(numerator: bigint, denominator: bigint): bigint {
  const scaled = numerator * 48000n;
  const magnitude = scaled < 0n ? -scaled : scaled;
  const rounded = (2n * magnitude + denominator) / (2n * denominator);
  return scaled < 0n ? -rounded : rounded;
}

describe('AS §4.2 audio sample grid', () => {
  it('AS01 the output sample rate is fixed at 48000', () => {
    expect(required('VIDEO_AUDIO_SAMPLE_RATE')).toBe(48000);
  });

  it.each([
    [r(0), 0], [r(1, 2), 24000], [r(3, 8), 18000], [r(6, 1000), 288], [r(1), 48000],
    [r(1, 96000), 1], [r(3, 96000), 2], [r(5, 96000), 3], [r(-1, 96000), -1], [r(-3, 96000), -2],
    [r(1, 144000), 0], [r(1, 72000), 1], [r(49152, 65537), 35999],
  ] as const)('AS02 maps %o seconds to sample %i', (time, sample) => {
    expect(required('videoAudioSampleIndex')(time)).toBe(sample);
  });

  it('AS03 the design example: 49152/65537 s lands 29537/3145776000 s before its exact end', () => {
    const index = required('videoAudioSampleIndex')(r(49152, 65537));
    // 35999/48000 − 49152/65537, as stated in design §4.2.
    const difference = BigInt(index) * 65537n - 49152n * 48000n;
    expect(r(difference, 48000n * 65537n)).toEqual(r(-29537, 3145776000));
  });

  it('AS04 equals AV_ROUND_NEAR_INF and stays within half a sample (property)', () => {
    const index = required('videoAudioSampleIndex');
    fc.assert(fc.property(fc.bigInt({ min: -10_000_000_000n, max: 10_000_000_000n }), fc.bigInt({ min: 1n, max: 10_000_000n }), (numerator, denominator) => {
      const sample = BigInt(index(r(numerator, denominator)));
      expect(sample).toBe(nearInf(numerator, denominator));
      const error = sample * denominator - numerator * 48000n;
      expect((error < 0n ? -error : error) * 2n <= denominator).toBe(true);
    }), { seed: 130691, numRuns: 500 });
  });

  it('AS05 is monotonic, odd-symmetric and exact on sample times (property)', () => {
    const index = required('videoAudioSampleIndex');
    fc.assert(fc.property(fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 1, max: 999_983 }), (a, b, denominator) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      expect(index(r(low, denominator))).toBeLessThanOrEqual(index(r(high, denominator)));
      // 0 - x keeps zero as +0 for Object.is.
      expect(index(r(-a, denominator))).toBe(0 - index(r(a, denominator)));
      expect(index(r(a, 48000))).toBe(a);
    }), { seed: 130692, numRuns: 300 });
  });

  it('AS06 rounds every exact half sample away from zero (property)', () => {
    const index = required('videoAudioSampleIndex');
    fc.assert(fc.property(fc.integer({ min: 0, max: 100_000_000 }), (k) => {
      expect(index(r(2 * k + 1, 96000))).toBe(k + 1);
      expect(index(r(-(2 * k + 1), 96000))).toBe(-(k + 1));
    }), { seed: 130693, numRuns: 200 });
  });

  it.each([
    ['a zero denominator', { numerator: '1', denominator: '0' }],
    ['a negative denominator', { numerator: '1', denominator: '-2' }],
    ['a decimal numerator', { numerator: '0.5', denominator: '1' }],
    ['an empty numerator', { numerator: '', denominator: '1' }],
    ['an unsafe sample index', r(10n ** 15n)],
  ])('AS07 rejects %s', (_, time) => {
    const index = required('videoAudioSampleIndex');
    expect(() => index(time)).toThrow(RangeError);
  });
});

describe('an undeclared last frame with sound after it (§4.2.1 last frame row)', () => {
  it('AE01 a recording paused mid-way ends its last frame with its sound, not after its widest gap', () => {
    const plan = required('planVideoPresentationTimeline');
    // A MediaRecorder screen capture: frames at 0, 0.579 and 2.616 s with no durations, Opus ending at 3.054 s.
    const frames = [bare(r(0)), bare(r(579, 1000)), bare(r(2616, 1000))];
    const result = plan(input(frames, { audioStart: r(0), audioEnd: r(3054, 1000) }));
    expect(result.frames.at(-1)).toEqual(source(2, r(2616, 1000), r(3054, 1000), 'audio-end'));
    expect(result.end).toEqual(r(3054, 1000));
  });

  it('AE02 sound that ends before the last frame starts leaves the widest-gap rule', () => {
    const plan = required('planVideoPresentationTimeline');
    const frames = [bare(r(0)), bare(r(1, 2)), bare(r(3, 5))];
    expect(plan(input(frames, { audioStart: r(0), audioEnd: r(1, 2) })).frames.at(-1)).toEqual(source(2, r(3, 5), r(11, 10), 'previous-max'));
  });
});
