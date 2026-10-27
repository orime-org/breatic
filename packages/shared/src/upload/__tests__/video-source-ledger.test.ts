// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseVideoSourceLedger, videoSourceLedgerCompanionSchema, videoSourceLedgerKeyFor, videoSourceLedgerReceiptSchema, videoSourceLedgerStateSchema } from '../video-source-ledger.js';
import type { VideoSourceLedgerCompanion, VideoSourceLedgerParseLimits, VideoSourceLedgerReceipt } from '../video-source-ledger-types.js';
import { ledgerFixture, receiptFor, SOURCE_LEDGER_FIXTURES } from './helpers/video-source-ledger-fixtures.js';

const LIMITS = { maxPhysicalFrames: 1024, maxOccurrences: 1024 };
type Path = readonly (string | number)[];

/** Replace one finite fixture field without invoking any runtime schema or planner.
 * @throws {TypeError} When the finite path does not address its expected object.
 */
function patched(value: unknown, path: Path, replacement: unknown): unknown {
  const copy: unknown = structuredClone(value);
  let parent = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
  parent[path.at(-1)!] = replacement;
  return copy;
}

/** Require both strict schema acceptance and exact receipt-bound identity preservation.
 * @throws {Error} When the independently supplied complete companion is not accepted.
 */
function expectAccepted(value: VideoSourceLedgerCompanion): void {
  expect(videoSourceLedgerCompanionSchema.parse(value)).toEqual(value);
  expect(parseVideoSourceLedger(value, receiptFor(value), LIMITS)).toEqual(value);
}

/** Require strict structural rejection, with no mutation or partial companion return.
 * @throws {Error} When an invalid schema input is accepted or remains unimplemented.
 */
function expectRejected(value: unknown, base = ledgerFixture()): void {
  expect(videoSourceLedgerCompanionSchema.safeParse(value).success).toBe(false);
  expect(parseVideoSourceLedger(value, receiptFor(base), LIMITS)).toBeNull();
}

describe('small measured source ledger receipt and independent capability state', () => {
  it.each(['cfr.mp4', 'N01', 'K01'])('accepts the %s strategy receipt without treating it as the full table', (id) => {
    const value = receiptFor(ledgerFixture(id));
    expect(videoSourceLedgerReceiptSchema.parse(value)).toEqual(value);
    expect(videoSourceLedgerStateSchema.parse({ state: 'ready', receipt: value })).toEqual({ state: 'ready', receipt: value });
  });

  it('keeps null, pending and failed capability separate from media presentation readiness', () => {
    const value = ledgerFixture(); const identity = { schemaVersion: 1, sourceFingerprint: value.sourceFingerprint, producerVersion: 1, attempt: value.attempt };
    expect(videoSourceLedgerStateSchema.parse(null)).toBeNull();
    expect(videoSourceLedgerStateSchema.parse({ state: 'pending', ...identity })).toEqual({ state: 'pending', ...identity });
    expect(videoSourceLedgerStateSchema.parse({ state: 'failed', ...identity, errorCode: 'ledger_invalid' })).toEqual({ state: 'failed', ...identity, errorCode: 'ledger_invalid' });
  });

  it('permits a stored receipt with zero legal occurrences and positive physical count', () => {
    const receipt = { ...receiptFor(ledgerFixture()), occurrenceCount: 0 };
    expect(videoSourceLedgerReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('keeps ETag opaque, including quotes and uppercase characters', () => {
    const receipt = { ...receiptFor(ledgerFixture()), etag: '"Opaque-UPPER-case-ETag:7"' };
    expect(videoSourceLedgerReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('derives the versioned companion from the original registered canonical key', () => {
    expect(videoSourceLedgerKeyFor('videos/source.webm')).toBe('videos/source.webm.video-source-ledger.v1.json');
  });

  it.each([
    { field: 'schemaVersion', value: 2 }, { field: 'producerVersion', value: 2 }, { field: 'sourceFingerprint', value: 'A'.repeat(64) },
    { field: 'sha256', value: 'short' }, { field: 'sha256', value: 'g'.repeat(64) }, { field: 'url', value: 'http://assets.example.test/ledger.json' },
    { field: 'contentType', value: 'video/mp4' }, { field: 'etag', value: '' }, { field: 'strategy', value: 'native_guess' },
    { field: 'size', value: 0 }, { field: 'size', value: 1.5 }, { field: 'size', value: Number.MAX_SAFE_INTEGER + 1 },
    { field: 'physicalFrameCount', value: 0 }, { field: 'physicalFrameCount', value: 1.5 }, { field: 'physicalFrameCount', value: Number.MAX_SAFE_INTEGER + 1 },
    { field: 'occurrenceCount', value: -1 }, { field: 'occurrenceCount', value: 0.5 }, { field: 'occurrenceCount', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid receipt $field=$value', ({ field, value }) => {
    expect(videoSourceLedgerReceiptSchema.safeParse({ ...receiptFor(ledgerFixture()), [field]: value }).success).toBe(false);
  });

  it.each([
    { jobId: '', deadlineAt: 7201000 }, { jobId: 'original', deadlineAt: 0 }, { jobId: 'original', deadlineAt: 1.5 },
    { jobId: 'original', deadlineAt: Number.MAX_SAFE_INTEGER + 1 }, { jobId: 'original', deadlineAt: 7201000, rawToken: 'not-a-contract-field' },
  ])('rejects invalid or extra attempt fields %j', (attempt) => {
    expect(videoSourceLedgerReceiptSchema.safeParse({ ...receiptFor(ledgerFixture()), attempt }).success).toBe(false);
  });

  it.each([
    { state: 'pending', errorCode: 'unexpected' }, { state: 'failed' }, { state: 'failed', errorCode: '' },
    { state: 'failed', errorCode: 'SQL query failed' }, { state: 'pending', schemaVersion: 2 }, { state: 'pending', producerVersion: 2 },
  ])('rejects inconsistent pending/failed state %j', (patch) => {
    const value = ledgerFixture();
    expect(videoSourceLedgerStateSchema.safeParse({ schemaVersion: 1, producerVersion: 1, sourceFingerprint: value.sourceFingerprint, attempt: value.attempt, ...patch }).success).toBe(false);
  });

  it('rejects full arrays or renderer configuration in the small receipt/envelope', () => {
    const value = ledgerFixture(); const receipt = receiptFor(value);
    expect(videoSourceLedgerReceiptSchema.safeParse({ ...receipt, frames: value.physical.frames }).success).toBe(false);
    expect(videoSourceLedgerStateSchema.safeParse({ state: 'ready', receipt, companion: value }).success).toBe(false);
    expect(videoSourceLedgerStateSchema.safeParse({ state: 'ready', receipt: { ...receipt, vapConfig: {} } }).success).toBe(false);
  });
});

describe('complete exact source companion goldens, without re-running producer planners', () => {
  it.each(SOURCE_LEDGER_FIXTURES)('preserves original $id exact windows, physical identities and provenance', ({ value }) => {
    expectAccepted(value);
  });

  it('keeps the repeated-edit eight occurrences instead of deduplicating its four raw identities', () => {
    const value = ledgerFixture('repeated-edit');
    expect(value.presentation.frames).toHaveLength(8);
    expect(value.presentation.frames.map((frame) => frame.rawDecodeOrdinal)).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expectAccepted(value);
  });

  it('keeps the mid-frame first mappedPTS -1/16 distinct from visible start 0', () => {
    const value = ledgerFixture('mid-frame-start');
    expect(value.presentation.frames[0]!.mappedPts).toEqual({ numerator: '-1', denominator: '16' });
    expect(value.presentation.frames[0]!.displayStart).toEqual({ numerator: '0', denominator: '1' });
    expectAccepted(value);
  });

  it.each(['all-empty', 'empty-edit-list'])('accepts J12/J13 %s with physical frames and no fabricated occurrence', (kind) => {
    const value = ledgerFixture();
    if (value.container.kind !== 'iso_bmff') throw new Error('Expected original ISO fixture');
    value.container.track.edits = kind === 'all-empty' ? [{ segmentDurationMovieTicks: '250', mediaTimeTrackTicks: '-1', mediaRateFixed16_16: '65536' }] : [];
    value.presentation = { edits: kind === 'all-empty' ? [{ editOccurrence: 0, empty: true, start: { numerator: '0', denominator: '1' }, end: { numerator: '1', denominator: '4' } }] : [], frames: [] };
    expectAccepted(value);
    expect(parseVideoSourceLedger(value, receiptFor(value), { maxPhysicalFrames: value.physical.frames.length, maxOccurrences: 1 })).toEqual(value);
  });

  it('accepts a zero-width declared edit while requiring each actual display interval to have width', () => {
    const value = ledgerFixture();
    if (value.container.kind !== 'iso_bmff' || value.container.track.edits === null) throw new Error('Expected original explicit ISO fixture');
    value.container.track.edits.unshift({ segmentDurationMovieTicks: '0', mediaTimeTrackTicks: '0', mediaRateFixed16_16: '65536' });
    value.presentation.edits = [{ editOccurrence: 0, empty: false, start: { numerator: '0', denominator: '1' }, end: { numerator: '0', denominator: '1' } }, ...value.presentation.edits.map((edit) => ({ ...edit, editOccurrence: edit.editOccurrence + 1 }))];
    value.presentation.frames = value.presentation.frames.map((frame) => ({ ...frame, editOccurrence: frame.editOccurrence + 1 }));
    expectAccepted(value);
  });

  it('retains selected Matroska global block ordinals with gaps left by audio', () => {
    const value = ledgerFixture('K01');
    if (value.container.kind !== 'matroska' || value.strategy !== 'matroska_rate_one') throw new Error('Expected original Matroska fixture');
    value.container.blocks.forEach((block, index) => { block.blockOrdinal = [1, 3, 6][index]!; });
    value.physical.frames.forEach((frame, index) => { frame.blockOrdinal = [1, 3, 6][index]!; });
    expectAccepted(value);
  });

  it('allows declared support overlap without inventing a new window policy', () => {
    const value = ledgerFixture('K01');
    if (value.container.kind !== 'matroska') throw new Error('Expected original Matroska fixture');
    value.container.track.defaultDurationNs = '50000000';
    value.presentation.frames[0]!.displayEnd = { numerator: '1', denominator: '20' };
    value.presentation.frames[1]!.displayEnd = { numerator: '9', denominator: '100' };
    value.presentation.frames[2]!.displayEnd = { numerator: '13', denominator: '100' };
    expectAccepted(value);
  });

  it('retains raw signed decimal spelling and unreduced source N/D while display fractions stay canonical', () => {
    const value = ledgerFixture('N04'); value.physical.sourceTimeBase = { numerator: '0002', denominator: '01000' };
    value.physical.frames[0]!.ptsTicks = '-0'; value.physical.frames[1]!.ptsTicks = '00020';
    value.presentation.frames[0]!.sourcePtsTicks = '-0'; value.presentation.frames[1]!.sourcePtsTicks = '00020';
    expectAccepted(value);
  });

  it('does not need an asset UUID, registry geometry or native clock equivalence in the companion', () => {
    const value = ledgerFixture();
    expectAccepted(value);
    expect(Object.keys(value).sort()).toEqual(['attempt', 'container', 'physical', 'presentation', 'producerVersion', 'schemaVersion', 'sourceFingerprint', 'strategy']);
  });
});

const EXPLICIT_EXTRA_PATHS: Path[] = [
  [], ['attempt'], ['physical'], ['physical', 'sourceTimeBase'], ['physical', 'frames', 0], ['container'], ['container', 'track'],
  ['container', 'track', 'edits', 0], ['presentation'], ['presentation', 'edits', 0], ['presentation', 'edits', 0, 'start'],
  ['presentation', 'frames', 0], ['presentation', 'frames', 0, 'mappedPts'], ['presentation', 'frames', 0, 'displayStart'], ['presentation', 'frames', 0, 'displayEnd'],
];

describe('strict complete source structure, identity, clocks and references', () => {
  it.each(EXPLICIT_EXTRA_PATHS.map((path) => ({ path })))('rejects unknown nested field at $path', ({ path }) => {
    expectRejected(patched(ledgerFixture(), [...path, 'extra'], 'not-an-owned-field'));
  });

  it.each([
    { path: ['schemaVersion'], value: 2 }, { path: ['producerVersion'], value: 2 }, { path: ['sourceFingerprint'], value: 'A'.repeat(64) },
    { path: ['physical', 'streamIndex'], value: -1 }, { path: ['physical', 'streamIndex'], value: '1' }, { path: ['physical', 'trackId'], value: 0 },
    { path: ['physical', 'trackId'], value: 4294967296 }, { path: ['container', 'track', 'trackId'], value: 99 },
    { path: ['container', 'movieTimescale'], value: '0' }, { path: ['container', 'track', 'mediaTimescale'], value: '0' },
    { path: ['physical', 'sourceTimeBase', 'numerator'], value: '0' }, { path: ['physical', 'sourceTimeBase', 'denominator'], value: '0' },
    { path: ['physical', 'sourceTimeBase', 'numerator'], value: 1 }, { path: ['physical', 'sourceTimeBase', 'denominator'], value: '-1000' },
    { path: ['physical', 'frames', 0, 'ptsTicks'], value: 4096 }, { path: ['physical', 'frames', 0, 'ptsTicks'], value: '4.096e3' },
    { path: ['physical', 'frames', 0, 'rawDecodeOrdinal'], value: 1 }, { path: ['presentation', 'frames', 0, 'presentationOrdinal'], value: 1 },
    { path: ['presentation', 'frames', 0, 'rawDecodeOrdinal'], value: 999 }, { path: ['presentation', 'frames', 0, 'sourcePtsTicks'], value: '999' },
    { path: ['presentation', 'frames', 0, 'editOccurrence'], value: 999 }, { path: ['presentation', 'edits', 0, 'editOccurrence'], value: 1 },
    { path: ['presentation', 'edits', 0, 'empty'], value: true },
  ] as { path: Path; value: unknown }[])('rejects inconsistent original fact $path=$value', ({ path, value }) => {
    expectRejected(patched(ledgerFixture(), path, value));
  });

  it.each([
    { numerator: '0', denominator: '2' }, { numerator: '-0', denominator: '1' }, { numerator: '01', denominator: '8' },
    { numerator: '2', denominator: '16' }, { numerator: '1', denominator: '0' }, { numerator: '1', denominator: '-8' },
    { numerator: '1.0', denominator: '8' }, { numerator: 1, denominator: '8' }, { numerator: '1', denominator: 8 },
  ])('rejects a noncanonical display fraction %j', (fraction) => {
    expectRejected(patched(ledgerFixture(), ['presentation', 'frames', 0, 'displayEnd'], fraction));
  });

  it.each([
    { path: ['presentation', 'frames', 0, 'displayEnd'], value: { numerator: '0', denominator: '1' } },
    { path: ['presentation', 'frames', 0, 'displayEnd'], value: { numerator: '-1', denominator: '8' } },
    { path: ['presentation', 'edits', 0, 'end'], value: { numerator: '-1', denominator: '8' } },
  ] as { path: Path; value: unknown }[])('rejects reversed edit or nonpositive occurrence interval $path', ({ path, value }) => {
    expectRejected(patched(ledgerFixture(), path, value));
  });

  it('rejects a physical prefix when an occurrence still refers to a missing raw frame', () => {
    const value = ledgerFixture(); value.physical.frames.pop(); expectRejected(value);
  });

  it('does not equate zero legal occurrences with a missing physical source ledger', () => {
    const value = ledgerFixture();
    if (value.container.kind !== 'iso_bmff') throw new Error('Expected original ISO fixture');
    value.container.track.edits = []; value.physical.frames = []; value.presentation = { edits: [], frames: [] };
    expectRejected(value);
  });

  it.each(['raw', 'occurrence', 'edit'])('rejects out-of-order dense %s identities without sorting them', (kind) => {
    const value = ledgerFixture('positive-start.mp4');
    if (kind === 'raw') value.physical.frames.reverse();
    if (kind === 'occurrence') value.presentation.frames.reverse();
    if (kind === 'edit') value.presentation.edits.reverse();
    expectRejected(value);
  });

  it('rejects a truncated occurrence prefix against the original complete receipt', () => {
    const value = ledgerFixture(); const receipt = receiptFor(value); value.presentation.frames.pop();
    expect(parseVideoSourceLedger(value, receipt, LIMITS)).toBeNull();
  });

  it.each([
    { strategy: 'iso_explicit_rate_one', fixture: 'N01' }, { strategy: 'iso_unedited_rate_one', fixture: 'cfr.mp4' },
    { strategy: 'matroska_rate_one', fixture: 'N01' },
  ])('rejects strategy/provenance mismatch $strategy for $fixture', ({ strategy, fixture }) => {
    expectRejected(patched(ledgerFixture(fixture), ['strategy'], strategy));
  });

  it('requires real selected sampleTiming for unedited ISO instead of duration-only fallback', () => {
    expectRejected(patched(ledgerFixture('N01'), ['container', 'track', 'sampleTiming'], undefined));
  });

  it.each(([
    ['container', 'track', 'sampleTiming', 'extra'], ['container', 'track', 'sampleTiming', 'decodeRuns', 0, 'extra'],
    ['container', 'track', 'sampleTiming', 'compositionRuns', 0, 'extra'],
  ] as Path[]).map((path) => ({ path })))('rejects unknown selected timing fields at $path', ({ path }) => {
    expectRejected(patched(ledgerFixture('N03'), path, true));
  });

  it('rejects selected sample count mismatch before treating an unedited prefix as complete', () => {
    expectRejected(patched(ledgerFixture('N01'), ['container', 'track', 'sampleTiming', 'decodeRuns', 0, 'sampleCount'], 2));
  });

  it('rejects incomplete selected CTTS count without losing its signed version', () => {
    expectRejected(patched(ledgerFixture('N03'), ['container', 'track', 'sampleTiming', 'compositionRuns', 0, 'sampleCount'], 2));
  });

  it('does not reinterpret a negative CTTS version1 offset as an unsigned version0 fact', () => {
    expectRejected(patched(ledgerFixture('N03'), ['container', 'track', 'sampleTiming', 'cttsVersion'], 0));
  });

  it.each([
    { path: ['physical', 'trackNumber'], value: '99' }, { path: ['physical', 'trackUid'], value: '99' },
    { path: ['physical', 'frames', 0, 'blockOrdinal'], value: 999 }, { path: ['container', 'blocks', 1, 'blockOrdinal'], value: 0 },
    { path: ['container', 'blocks', 0, 'trackNumber'], value: '99' }, { path: ['container', 'track', 'trackType'], value: '2' },
  ] as { path: Path; value: unknown }[])('rejects selected Matroska identity mismatch at $path', ({ path, value }) => {
    expectRejected(patched(ledgerFixture('K01'), path, value));
  });

  it.each(([['container', 'track'], ['container', 'track', 'trackTimestampScale'], ['container', 'blocks', 0]] as Path[]).map((path) => ({ path })))('rejects unknown Matroska metadata fields at $path', ({ path }) => {
    expectRejected(patched(ledgerFixture('K01'), [...path, 'extra'], true));
  });

  it('rejects a selected Matroska block prefix without dropping physical-only raw identities', () => {
    const value = ledgerFixture('K04');
    if (value.container.kind !== 'matroska') throw new Error('Expected original Matroska fixture');
    value.container.blocks.shift(); expectRejected(value);
  });
});

describe('receipt-bound null parser and mandatory frozen array ceilings', () => {
  it.each([
    { path: ['sourceFingerprint'], value: 'f'.repeat(64) }, { path: ['schemaVersion'], value: 2 }, { path: ['producerVersion'], value: 2 },
    { path: ['strategy'], value: 'iso_unedited_rate_one' }, { path: ['attempt', 'jobId'], value: 'another-accepted-job' },
    { path: ['attempt', 'deadlineAt'], value: 7201001 }, { path: ['physicalFrameCount'], value: 1 }, { path: ['occurrenceCount'], value: 1 },
  ] as { path: Path; value: unknown }[])('returns null for receipt mismatch at $path', ({ path, value }) => {
    const companion = ledgerFixture(); const receipt = patched(receiptFor(companion), path, value) as VideoSourceLedgerReceipt;
    expect(parseVideoSourceLedger(companion, receipt, LIMITS)).toBeNull();
  });

  it.each([undefined, null, [], 'truncated JSON text', { schemaVersion: 1 }])('returns null for an absent or structurally incomplete companion %j', (value) => {
    expect(parseVideoSourceLedger(value, receiptFor(ledgerFixture()), LIMITS)).toBeNull();
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('returns null for invalid mandatory ceiling %s', (limit) => {
    const value = ledgerFixture();
    expect(parseVideoSourceLedger(value, receiptFor(value), { ...LIMITS, maxPhysicalFrames: limit })).toBeNull();
    expect(parseVideoSourceLedger(value, receiptFor(value), { ...LIMITS, maxOccurrences: limit })).toBeNull();
  });

  it.each([{}, { maxPhysicalFrames: 1024 }, { maxOccurrences: 1024 }])('does not supply a fallback for missing mandatory limits %j', (limits) => {
    const value = ledgerFixture();
    expect(parseVideoSourceLedger(value, receiptFor(value), limits as unknown as VideoSourceLedgerParseLimits)).toBeNull();
  });

  it('accepts exact ceilings and returns null rather than a prefix when either is exceeded', () => {
    const value = ledgerFixture(); const receipt = receiptFor(value); const exact = { maxPhysicalFrames: value.physical.frames.length, maxOccurrences: value.presentation.frames.length };
    expect(parseVideoSourceLedger(value, receipt, exact)).toEqual(value);
    expect(parseVideoSourceLedger(value, receipt, { ...exact, maxPhysicalFrames: exact.maxPhysicalFrames - 1 })).toBeNull();
    expect(parseVideoSourceLedger(value, receipt, { ...exact, maxOccurrences: exact.maxOccurrences - 1 })).toBeNull();
  });

  it('preserves input facts across parsing instead of normalizing raw clocks or writing results', () => {
    const value = ledgerFixture('N04'); const receipt = receiptFor(value); const before = structuredClone({ value, receipt });
    expect(parseVideoSourceLedger(value, receipt, LIMITS)).toEqual(value);
    expect({ value, receipt }).toEqual(before);
  });

  it('rejects every altered original source fingerprint while preserving the accepted receipt', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 63 }), (index) => {
      const value = ledgerFixture(); const receipt = receiptFor(value); const original = value.sourceFingerprint;
      value.sourceFingerprint = original.slice(0, index) + (original[index] === '0' ? '1' : '0') + original.slice(index + 1);
      expect(parseVideoSourceLedger(value, receipt, LIMITS)).toBeNull();
      expect(receipt.sourceFingerprint).toBe(original);
    }), { seed: 1306, numRuns: 64 });
  });
});
