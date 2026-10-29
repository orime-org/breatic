// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The backend-to-ingest presentation contract requests the source ledger at
 * every admission and answers with the v2 ledger state (inner#1306 test plan
 * §77, Q/S/K cases). The request carries the ledger budgets without any frame
 * count ceiling and the public addresses of both stored objects: the full
 * ledger and the compact presentation table written with it.
 */

import { describe, expect, it } from 'vitest';
import * as shared from '../../index.js';
import * as ledgerModule from '../video-source-ledger.js';
import { videoPresentationIngestRequestSchema, videoPresentationIngestSnapshotSchema } from '../video-presentation-ingest.js';

const fingerprint = 'a'.repeat(64);
const ledgerLimits = {
  maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216,
  isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000,
};
const accept = {
  action: 'accept', storageKey: 'video/canonical.webm', sourceFingerprint: fingerprint, jobId: 'video-presentation-a', deadlineAt: 1900000000000,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
  pricing: { containerClass: 'MediaContainer', size: { vcpu: 1, memory_gib: 1, disk_gb: 1 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  packedURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.mp4', manifestURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.json',
};
const ledgerURL = 'https://assets.example.test/video/canonical.webm.ledger.json';
const tableURL = 'https://assets.example.test/video/canonical.webm.table.json';
const requested = { ...accept, limits: { ...accept.limits, sourceLedger: ledgerLimits }, sourceLedgerURL: ledgerURL, sourceLedgerTableURL: tableURL };

/**
 * The request schema's verdict on one candidate admission.
 * @param value - Candidate request body.
 * @returns Whether it parses.
 */
function admits(value: unknown): boolean {
  return videoPresentationIngestRequestSchema.safeParse(value).success;
}

describe('presentation admission requesting the source ledger v2 (inner#1306 §77)', () => {
  it('Q01 carries the six ledger budgets and both companion URLs unchanged', () => {
    expect(videoPresentationIngestRequestSchema.parse(requested)).toEqual(requested);
  });

  it('Q03 still accepts an admission that requests no ledger', () => {
    expect(admits(accept)).toBe(true);
  });

  it.each([
    ['a frame ceiling on physical frames', { ...ledgerLimits, maxPhysicalFrames: 100000 }],
    ['a frame ceiling on occurrences', { ...ledgerLimits, maxOccurrences: 100000 }],
    ['a missing budget', (() => { const { matroskaMaxBlocks: _drop, ...rest } = ledgerLimits; return rest; })()],
    ['a zero budget', { ...ledgerLimits, maxBytes: 0 }],
    ['a fractional budget', { ...ledgerLimits, metadataBytes: 1.5 }],
    ['an unsafe budget', { ...ledgerLimits, isoBoxCount: Number.MAX_SAFE_INTEGER + 1 }],
  ])('Q02 rejects ledger budgets with %s', (_name, sourceLedger) => {
    expect(admits(requested)).toBe(true);
    expect(admits({ ...requested, limits: { ...accept.limits, sourceLedger } })).toBe(false);
  });

  it.each([
    ['budgets without either URL', { limits: requested.limits }],
    ['budgets without the table URL', { limits: requested.limits, sourceLedgerURL: ledgerURL }],
    ['budgets without the ledger URL', { limits: requested.limits, sourceLedgerTableURL: tableURL }],
    ['both URLs without budgets', { sourceLedgerURL: ledgerURL, sourceLedgerTableURL: tableURL }],
    ['the same URL for both objects', { limits: requested.limits, sourceLedgerURL: ledgerURL, sourceLedgerTableURL: ledgerURL }],
    ['a table URL that is not https', { limits: requested.limits, sourceLedgerURL: ledgerURL, sourceLedgerTableURL: 'http://assets.example.test/t.json' }],
    ['a ledger URL that is not a URL', { limits: requested.limits, sourceLedgerURL: 'not a url', sourceLedgerTableURL: tableURL }],
  ])('Q02 rejects %s', (_name, extra) => {
    expect(admits(requested)).toBe(true);
    expect(admits({ ...accept, ...extra })).toBe(false);
  });
});

describe('presentation snapshot answering with the v2 ledger state (inner#1306 §77)', () => {
  const identity = { schemaVersion: 2, sourceFingerprint: fingerprint, producerVersion: 2, attempt: { jobId: 'video-presentation-a', deadlineAt: 1900000000000 } };
  const receipt = {
    ...identity, url: ledgerURL, etag: '"e"', size: 912, sha256: 'b'.repeat(64), contentType: 'application/json',
    table: { url: tableURL, sha256: 'c'.repeat(64), size: 81, frameCount: 17 },
  };

  it.each([
    ['absent', undefined],
    ['null', null],
    ['pending', { state: 'pending', ...identity }],
    ['ready', { state: 'ready', receipt }],
    ['failed', { state: 'failed', ...identity, errorCode: 'source_ledger_invalid' }],
  ])('S01 parses a %s v2 ledger state unchanged', (_name, sourceLedger) => {
    const snapshot = { presentation: null, attempt: null, ...(sourceLedger === undefined ? {} : { sourceLedger }) };
    expect(videoPresentationIngestSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    ['a ready state without its receipt', { state: 'ready' }],
    ['a ready receipt without the table', { state: 'ready', receipt: (() => { const { table: _drop, ...rest } = receipt; return rest; })() }],
    ['a failed state without its code', { state: 'failed', ...identity }],
    ['a pending state without its attempt', { state: 'pending', schemaVersion: 2, sourceFingerprint: fingerprint, producerVersion: 2 }],
  ])('S02 rejects %s', (_name, sourceLedger) => {
    expect(videoPresentationIngestSnapshotSchema.safeParse({ presentation: null, attempt: null, sourceLedger: { state: 'ready', receipt } }).success).toBe(true);
    expect(videoPresentationIngestSnapshotSchema.safeParse({ presentation: null, attempt: null, sourceLedger }).success).toBe(false);
  });
});

describe('compact table storage key (inner#1306 §77)', () => {
  const tableKeyFor = (ledgerModule as Record<string, unknown>).videoSourceLedgerTableKeyFor as ((key: string) => string) | undefined;

  it('K01 derives a distinct table key from the registered key, beside the ledger key, and exports it from the main entry', () => {
    expect(typeof tableKeyFor).toBe('function');
    expect(typeof (shared as Record<string, unknown>).videoSourceLedgerTableKeyFor).toBe('function');
    const key = 'video/canonical.webm';
    expect(tableKeyFor!(key)).toBe(tableKeyFor!(key));
    expect(tableKeyFor!(key).startsWith(`${key}.`)).toBe(true);
    expect(tableKeyFor!(key)).not.toBe(ledgerModule.videoSourceLedgerKeyFor(key));
    expect(tableKeyFor!('video/other.webm')).not.toBe(tableKeyFor!(key));
  });
});
