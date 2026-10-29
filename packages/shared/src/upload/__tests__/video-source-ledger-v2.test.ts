// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Stored source ledger v2, its receipt naming the compact presentation table,
 * and the ledger failure classification (inner#1306 test plan §76, L/R/F cases).
 *
 * The v2 ledger stores only what consumers read: the compact presentation
 * table, run-length source timing per presented frame and the video and audio
 * edit spans. Per-block offsets and other producer-only evidence are not stored.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as ledgerModule from '../video-source-ledger.js';
import { presentationTableSchema, projectPresentationTable, type VideoPresentationTable } from '../../mini-tools/video-presentation-table.js';

interface Rational { numerator: string; denominator: string }
interface EditSpan { sourceStart: Rational; sourceEnd: Rational; presentationStart: Rational; rate: Rational }
interface SourceRun { start: number; count: number; step: number }
interface LedgerV2 {
  schemaVersion: 2;
  sourceFingerprint: string;
  producerVersion: 2;
  attempt: { jobId: string; deadlineAt: number };
  presentation: VideoPresentationTable;
  source: { timeBase: Rational; runs: SourceRun[] };
  videoEdits: EditSpan[] | null;
  audioEdits: EditSpan[] | null;
}
interface ReceiptV2 {
  schemaVersion: 2;
  sourceFingerprint: string;
  producerVersion: 2;
  attempt: { jobId: string; deadlineAt: number };
  url: string;
  etag: string;
  size: number;
  sha256: string;
  contentType: 'application/json';
  table: { url: string; sha256: string; size: number; frameCount: number };
}
interface Schema<T> { parse: (value: unknown) => T; safeParse: (value: unknown) => { success: boolean } }
interface LedgerV2Api {
  videoSourceLedgerV2Schema: Schema<LedgerV2>;
  videoSourceLedgerReceiptV2Schema: Schema<ReceiptV2>;
  classifyVideoSourceLedgerFailure: (errorCode: string) => 'transient' | 'content';
}

const api = ledgerModule as unknown as Partial<LedgerV2Api>;

/**
 * Read one export of the v2 contract, failing when it does not exist yet.
 * @param name - The export name.
 * @returns The export.
 * @throws {Error} When the export is missing.
 */
function required<K extends keyof LedgerV2Api>(name: K): LedgerV2Api[K] {
  const value = api[name];
  expect(value, `${name} is exported from video-source-ledger`).toBeDefined();
  return value as LedgerV2Api[K];
}

/**
 * An exact rational literal.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rational.
 */
function r(numerator: number, denominator = 1): Rational {
  return { numerator: String(numerator), denominator: String(denominator) };
}

const HASH = 'a'.repeat(64);
const ATTEMPT = { jobId: 'accepted-job', deadlineAt: 1 };

/**
 * The CFR MP4 source (fixture cfr.mp4) with an audio track (fixture audio-tail.mp4), as stored v2.
 * @returns A fresh valid ledger.
 */
function cfrLedger(): LedgerV2 {
  return {
    schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
    presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
    source: { timeBase: r(1, 16384), runs: [{ start: 4096, count: 17, step: 2048 }] },
    videoEdits: [{ sourceStart: r(1, 4), sourceEnd: r(19, 8), presentationStart: r(0), rate: r(1) }],
    audioEdits: [{ sourceStart: r(8, 375), sourceEnd: r(1508, 375), presentationStart: r(0), rate: r(1) }],
  };
}

/**
 * The repeated-edit MP4 (the same media range presented twice), no audio.
 * @returns A fresh valid ledger.
 */
function repeatedLedger(): LedgerV2 {
  return {
    schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
    presentation: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 8, step: 1, duration: 1 }] },
    source: { timeBase: r(1, 16384), runs: [{ start: 4096, count: 4, step: 2048 }, { start: 4096, count: 4, step: 2048 }] },
    videoEdits: [
      { sourceStart: r(1, 4), sourceEnd: r(3, 4), presentationStart: r(0), rate: r(1) },
      { sourceStart: r(1, 4), sourceEnd: r(3, 4), presentationStart: r(1, 2), rate: r(1) },
    ],
    audioEdits: null,
  };
}

/**
 * A Matroska source (fixture K02): no edit lists, a single-frame source run at the end.
 * @returns A fresh valid ledger.
 */
function matroskaLedger(): LedgerV2 {
  return {
    schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
    presentation: projectPresentationTable([
      { displayStart: r(0), displayEnd: r(1, 25) }, { displayStart: r(1, 25), displayEnd: r(7, 50) }, { displayStart: r(7, 50), displayEnd: r(1, 5) },
    ]),
    source: { timeBase: r(1, 1000), runs: [{ start: 0, count: 2, step: 40 }, { start: 140, count: 1, step: 0 }] },
    videoEdits: null,
    audioEdits: null,
  };
}

/**
 * A rate 3/2 edit starting mid-frame, with an audio track whose edits are all empty.
 * @returns A fresh valid ledger.
 */
function rateLedger(): LedgerV2 {
  return {
    schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
    presentation: { schemaVersion: 1, timescale: 150, runs: [{ start: 0, count: 1, step: 2, duration: 2 }, { start: 2, count: 3, step: 4, duration: 4 }, { start: 14, count: 1, step: 1, duration: 1 }] },
    source: { timeBase: r(1, 1000), runs: [{ start: 0, count: 5, step: 40 }] },
    videoEdits: [{ sourceStart: r(1, 50), sourceEnd: r(17, 100), presentationStart: r(0), rate: r(3, 2) }],
    audioEdits: [],
  };
}

/**
 * Copy a value and replace one nested field.
 * @param value - The source value.
 * @param path - Keys from the root to the field.
 * @param replacement - The new value; `undefined` deletes the key.
 * @returns The patched copy.
 */
function patched<T>(value: T, path: readonly (string | number)[], replacement: unknown): T {
  const copy = structuredClone(value);
  let parent = copy as unknown as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  if (replacement === undefined) delete parent[path.at(-1)!];
  else parent[path.at(-1)!] = replacement;
  return copy;
}

/**
 * The stored v2 receipt for the CFR ledger and its compact table.
 * @returns A fresh valid receipt.
 */
function receipt(): ReceiptV2 {
  return {
    schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
    url: 'https://media.example/source.mp4.video-source-ledger.v2.json', etag: 'etag-1', size: 912, sha256: 'b'.repeat(64), contentType: 'application/json',
    table: { url: 'https://media.example/source.mp4.video-presentation-table.v1.json', sha256: 'c'.repeat(64), size: 81, frameCount: 17 },
  };
}

/**
 * Greedy run-length encoding of per-frame source ticks: a frame extends the last run when it continues its progression, or the last run has one frame and the tick increases.
 * @param ticks - Source ticks per presented frame.
 * @returns The canonical runs.
 */
function encodeSource(ticks: readonly number[]): SourceRun[] {
  const runs: SourceRun[] = [];
  for (const tick of ticks) {
    const run = runs.at(-1);
    if (run !== undefined && run.count === 1 && tick > run.start) { run.step = tick - run.start; run.count = 2; } else if (run !== undefined && run.count > 1 && tick === run.start + run.count * run.step) run.count += 1;
    else runs.push({ start: tick, count: 1, step: 0 });
  }
  return runs;
}

describe('L stored source ledger v2', () => {
  it.each([['cfr', cfrLedger], ['repeated edit', repeatedLedger], ['matroska', matroskaLedger], ['rate 3/2', rateLedger]] as const)('L01 accepts the %s ledger unchanged', (_, make) => {
    const ledger = make();
    expect(required('videoSourceLedgerV2Schema').parse(ledger)).toEqual(ledger);
  });

  it('L01 embeds exactly the S1 compact presentation table', () => {
    const ledger = required('videoSourceLedgerV2Schema').parse(cfrLedger());
    expect(presentationTableSchema.parse(ledger.presentation)).toEqual(cfrLedger().presentation);
  });

  it.each([
    ['physical frames', ['physical'], { frames: [] }],
    ['container blocks', ['container'], { kind: 'matroska', blocks: [] }],
    ['strategy', ['strategy'], 'iso_explicit_rate_one'],
    ['span editOccurrence', ['videoEdits', 0, 'editOccurrence'], 0],
    ['span empty flag', ['videoEdits', 0, 'empty'], false],
    ['source run rawDecodeOrdinal', ['source', 'runs', 0, 'rawDecodeOrdinal'], 0],
    ['source run blockOrdinal', ['source', 'runs', 0, 'blockOrdinal'], 0],
    ['presentation run mappedPts', ['presentation', 'runs', 0, 'mappedPts'], 0],
  ] as const)('L02 rejects producer-only evidence: %s', (_, path, value) => {
    expect(required('videoSourceLedgerV2Schema').safeParse(patched(cfrLedger(), path, value)).success).toBe(false);
  });

  it.each([
    ['schemaVersion 1', ['schemaVersion'], 1],
    ['producerVersion 1', ['producerVersion'], 1],
    ['uppercase fingerprint', ['sourceFingerprint'], 'A'.repeat(64)],
    ['short fingerprint', ['sourceFingerprint'], 'a'.repeat(63)],
    ['empty job id', ['attempt', 'jobId'], ''],
    ['zero deadline', ['attempt', 'deadlineAt'], 0],
    ['missing videoEdits', ['videoEdits'], undefined],
    ['missing audioEdits', ['audioEdits'], undefined],
    ['empty presentation runs', ['presentation', 'runs'], []],
    ['presentation frame longer than its step', ['presentation', 'runs', 0, 'duration'], 2],
    ['zero time base numerator', ['source', 'timeBase'], r(0, 1)],
    ['zero time base denominator', ['source', 'timeBase'], r(1, 0)],
    ['decimal time base', ['source', 'timeBase'], { numerator: '1.5', denominator: '2' }],
    ['empty source runs', ['source', 'runs'], []],
    ['zero-count source run', ['source', 'runs', 0, 'count'], 0],
    ['source frames fewer than presented frames', ['source', 'runs', 0, 'count'], 16],
    ['source frames more than presented frames', ['source', 'runs', 0, 'count'], 18],
    ['non-integer source start', ['source', 'runs', 0, 'start'], 4096.5],
    ['unsafe source start', ['source', 'runs', 0, 'start'], Number.MAX_SAFE_INTEGER + 1],
    ['unsafe last source tick', ['source', 'runs', 0], { start: Number.MAX_SAFE_INTEGER - 10, count: 17, step: 2048 }],
    ['zero step in a multi-frame run', ['source', 'runs', 0, 'step'], 0],
    ['decreasing step in a multi-frame run', ['source', 'runs', 0, 'step'], -2048],
    ['non-zero step in a single-frame run', ['source', 'runs'], [{ start: 4096, count: 16, step: 2048 }, { start: 36864, count: 1, step: 2048 }]],
    ['empty video edit list', ['videoEdits'], []],
    ['zero-width video span', ['videoEdits', 0, 'sourceEnd'], r(1, 4)],
    ['reversed video span', ['videoEdits', 0, 'sourceEnd'], r(1, 8)],
    ['zero rate', ['videoEdits', 0, 'rate'], r(0)],
    ['negative rate', ['videoEdits', 0, 'rate'], r(-1, 2)],
    ['zero rate denominator', ['videoEdits', 0, 'rate'], r(1, 0)],
    ['unreduced rate', ['videoEdits', 0, 'rate'], r(2, 2)],
    ['unreduced source start', ['videoEdits', 0, 'sourceStart'], r(2, 8)],
    ['negative presentation start', ['videoEdits', 0, 'presentationStart'], r(-1, 4)],
    ['decimal span time', ['videoEdits', 0, 'sourceStart'], { numerator: '0.25', denominator: '1' }],
    ['zero-width audio span', ['audioEdits', 0, 'sourceEnd'], r(8, 375)],
    ['zero audio rate', ['audioEdits', 0, 'rate'], r(0)],
  ] as const)('L03 rejects %s', (_, path, value) => {
    expect(required('videoSourceLedgerV2Schema').safeParse(patched(cfrLedger(), path, value)).success).toBe(false);
  });

  it('L03 rejects a span that starts before the previous span ends in presentation time', () => {
    const schema = required('videoSourceLedgerV2Schema');
    // The first span presents [0, 1/2); the second may start at 1/2 but not earlier.
    expect(schema.safeParse(patched(repeatedLedger(), ['videoEdits', 1, 'presentationStart'], r(1, 4))).success).toBe(false);
    // Rate 3/2 over 3/20 s of source presents 1/10 s; a following span at 1/20 overlaps it.
    const rate = rateLedger();
    rate.audioEdits = [
      { sourceStart: r(0), sourceEnd: r(3, 20), presentationStart: r(0), rate: r(3, 2) },
      { sourceStart: r(1), sourceEnd: r(2), presentationStart: r(1, 20), rate: r(1) },
    ];
    expect(schema.safeParse(rate).success).toBe(false);
    rate.audioEdits[1]!.presentationStart = r(1, 10);
    expect(schema.parse(rate)).toEqual(rate);
  });

  it('L04 round-trips any valid ledger through JSON unchanged (property)', () => {
    const schema = required('videoSourceLedgerV2Schema');
    const frame = fc.record({ gap: fc.integer({ min: 0, max: 5 }), length: fc.integer({ min: 1, max: 5 }), source: fc.integer({ min: -100, max: 100 }) });
    const span = fc.record({ start: fc.integer({ min: 0, max: 1000 }), length: fc.integer({ min: 1, max: 1000 }), gap: fc.integer({ min: 0, max: 50 }), rate: fc.constantFrom([1, 1], [1, 2], [3, 2], [2, 1], [5, 4]) });
    fc.assert(fc.property(fc.array(frame, { minLength: 1, maxLength: 40 }), fc.integer({ min: 1, max: 1000 }), fc.array(span, { minLength: 1, maxLength: 4 }), fc.option(fc.array(span, { maxLength: 4 }), { nil: null }), (frames, denominator, video, audio) => {
      let tick = 0;
      let source = 0;
      const presented = frames.map((item) => { tick += item.gap; const start = tick; tick += item.length; return { displayStart: r(start, denominator), displayEnd: r(tick, denominator) }; });
      const ticks = frames.map((item) => { source += item.source; return source; });
      /**
       * Lay spans end to end in presentation time with their own gaps.
       * @param spans - Generated spans.
       * @returns Ordered non-overlapping edit spans in milliseconds.
       */
      const lay = (spans: readonly { start: number; length: number; gap: number; rate: readonly [number, number] }[]): EditSpan[] => {
        let at = 0;
        return spans.map((item) => {
          at += item.gap;
          const presentationStart = at;
          at += item.length;
          const [rateNumerator, rateDenominator] = item.rate;
          const sourceLength = item.length * rateNumerator / rateDenominator;
          return { sourceStart: reduce(item.start, 1000), sourceEnd: reduce(item.start * rateDenominator + sourceLength * rateDenominator, 1000 * rateDenominator), presentationStart: reduce(presentationStart, 1000), rate: reduce(rateNumerator, rateDenominator) };
        });
      };
      const ledger: LedgerV2 = {
        schemaVersion: 2, sourceFingerprint: HASH, producerVersion: 2, attempt: { ...ATTEMPT },
        presentation: projectPresentationTable(presented), source: { timeBase: r(1, 90000), runs: encodeSource(ticks) },
        videoEdits: lay(video), audioEdits: audio === null ? null : lay(audio),
      };
      expect(schema.parse(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
    }), { seed: 1306, numRuns: 200 });
  });

  it('L05 rejects any ledger whose source frame count differs from its presented frame count (property)', () => {
    const schema = required('videoSourceLedgerV2Schema');
    fc.assert(fc.property(fc.integer({ min: -16, max: 16 }).filter((delta) => delta !== 0), (delta) => {
      const ledger = cfrLedger();
      ledger.source.runs = [{ start: 4096, count: 17 + delta, step: 2048 }];
      expect(schema.safeParse(ledger).success).toBe(false);
    }), { seed: 1306, numRuns: 32 });
  });
});

/**
 * Reduce a fraction with a positive denominator.
 * @param numerator - The numerator.
 * @param denominator - A positive denominator.
 * @returns The reduced rational.
 */
function reduce(numerator: number, denominator: number): Rational {
  let a = Math.abs(numerator);
  let b = denominator;
  while (b !== 0) [a, b] = [b, a % b];
  return a === 0 ? r(0) : r(numerator / a, denominator / a);
}

describe('R stored receipt v2 names the full ledger and the compact table', () => {
  it('R01 accepts a receipt naming both objects', () => {
    const value = receipt();
    expect(required('videoSourceLedgerReceiptV2Schema').parse(value)).toEqual(value);
  });

  it.each([
    ['schemaVersion 1', ['schemaVersion'], 1],
    ['producerVersion 1', ['producerVersion'], 1],
    ['no compact table', ['table'], undefined],
    ['v1 strategy field', ['strategy'], 'iso_explicit_rate_one'],
    ['v1 physical frame count', ['physicalFrameCount'], 17],
    ['v1 occurrence count', ['occurrenceCount'], 17],
    ['http ledger url', ['url'], 'http://media.example/source.mp4.video-source-ledger.v2.json'],
    ['non-url ledger', ['url'], 'source-ledger'],
    ['bad ledger digest', ['sha256'], 'B'.repeat(64)],
    ['zero ledger size', ['size'], 0],
    ['non-json content type', ['contentType'], 'application/octet-stream'],
    ['http table url', ['table', 'url'], 'http://media.example/source.mp4.video-presentation-table.v1.json'],
    ['table url equal to the ledger url', ['table', 'url'], 'https://media.example/source.mp4.video-source-ledger.v2.json'],
    ['missing table url', ['table', 'url'], undefined],
    ['bad table digest', ['table', 'sha256'], 'c'.repeat(63)],
    ['missing table digest', ['table', 'sha256'], undefined],
    ['zero table size', ['table', 'size'], 0],
    ['fractional table size', ['table', 'size'], 80.5],
    ['missing table size', ['table', 'size'], undefined],
    ['zero frame count', ['table', 'frameCount'], 0],
    ['fractional frame count', ['table', 'frameCount'], 1.5],
    ['unsafe frame count', ['table', 'frameCount'], Number.MAX_SAFE_INTEGER + 1],
    ['missing frame count', ['table', 'frameCount'], undefined],
    ['unknown table field', ['table', 'etag'], 'etag-2'],
  ] as const)('R02 rejects %s', (_, path, value) => {
    expect(required('videoSourceLedgerReceiptV2Schema').safeParse(patched(receipt(), path, value)).success).toBe(false);
  });
});

// Design §2 "失败与重试" and §10.2: expiry, container failure and a missing or
// mismatched stored object are transient; unsupported content is not retried.
const TRANSIENT = [
  ['expired', 'deadline passed (alpha-presentation.ts beforeStage, media-container.ts:203)'],
  ['source_ledger_missing', 'stored ledger object missing on refresh (video-presentation-store.ts:536)'],
  ['source_ledger_invalid', 'stored ledger object does not match its receipt (video-presentation-store.ts:536)'],
  ['presentation_failed', 'container answered non-ok or threw (media-container.ts:220,226; alpha-presentation.ts outer catch)'],
  ['presentation_report_failed', 'container could not deliver its report (alpha-presentation.ts report)'],
  ['cleanup_failed', 'container temporary directory cleanup failed (alpha-presentation.ts finally)'],
] as const;
const CONTENT = [
  ['source_ledger_format_unknown', 'neither ISO BMFF nor Matroska/WebM (alpha-presentation.ts produceSourceLedger)'],
  ['source_ledger_selection_unknown', 'no unambiguous first video stream (alpha-presentation.ts produceSourceLedger)'],
  ['unsupported_rate', 'edit rate zero or negative (iso-bmff-presentation.ts planner)'],
  ['invalid_edit', 'malformed edit list entry (iso-bmff-presentation.ts planner)'],
  ['invalid_clock', 'zero or malformed clock (iso-bmff-presentation.ts planner)'],
  ['invalid_ledger', 'physical frames not dense or not strictly increasing (iso-bmff-presentation.ts planner)'],
] as const;

describe('F ledger failure classification', () => {
  it.each(TRANSIENT)('F01 %s is transient: %s', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('transient');
  });

  it.each(CONTENT)('F02 %s is content: %s', (code) => {
    expect(required('classifyVideoSourceLedgerFailure')(code)).toBe('content');
  });

  it('F03 classifies every stable error code as exactly one class (property)', () => {
    const classify = required('classifyVideoSourceLedgerFailure');
    fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{0,40}$/), (code) => {
      expect(['transient', 'content']).toContain(classify(code));
    }), { seed: 1306, numRuns: 200 });
  });

  // Codes the design does not settle; each is a question in test plan §76.
  it.todo('F04 source_ledger_failed: producer catch-all that mixes planner content rejections with IO and tool failures');
  it.todo('F04 probe_invalid: ffprobe answered malformed JSON, tool fault or content');
  it.todo('F04 classification_unknown and clock_unknown: raised both by the ledger producer (E4) and the presentation run (E5, which §10.2 maps to transient)');
  it.todo('F04 metadata_unknown, audio_clock_unknown, packed_over_cap, packed_clock_mismatch: presentation-run codes that reach the ledger only through store.fail (E5)');
  it.todo('F04 source_over_cap and source_ledger_over_cap: deterministic for the same bytes and config, but design §2 lifts both caps to cover every upload');
  it.todo('F04 admission_invalid and source_missing: server or storage faults that a retry with the same admission may not change');
  it.todo('F04 resource_limit and invalid_limits: planner ceiling codes, while design §2 removes the frame ceiling');
});
