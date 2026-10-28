// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The backend-to-ingest presentation contract carries the source ledger
 * request and answers with its state (inner#1306 source-ledger-oracle §2).
 */

import { describe, expect, it } from 'vitest';

import { videoPresentationIngestRequestSchema, videoPresentationIngestSnapshotSchema } from '../video-presentation-ingest.js';

const fingerprint = 'a'.repeat(64);
const ledgerLimits = {
  maxBytes: 16777216, probeStdoutBytes: 67108864, metadataBytes: 16777216, maxPhysicalFrames: 100000,
  maxOccurrences: 100000, isoBoxCount: 100000, matroskaElementCount: 1000000, matroskaMaxBlocks: 250000,
};
const accept = {
  action: 'accept', storageKey: 'video/canonical.webm', sourceFingerprint: fingerprint, jobId: 'video-presentation-a', deadlineAt: 1900000000000,
  original: null, contentType: 'video/webm',
  limits: { maxSourceBytes: 1, maxPackedBytes: 1, crf: 18, preset: 'medium', probeStdoutBytes: 1, analysisStdoutBytes: 1, stderrTailBytes: 1 },
  pricing: { containerClass: 'MediaContainer', size: { vcpu: 1, memory_gib: 1, disk_gb: 1 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  packedURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.mp4', manifestURL: 'https://assets.example.test/video/canonical.webm.alpha.v1.json',
};
const ledgerURL = 'https://assets.example.test/video/canonical.webm.video-source-ledger.v1.json';

describe('presentation admission requesting a source ledger', () => {
  it('carries the eight frozen ledger budgets and the companion URL', () => {
    const request = { ...accept, limits: { ...accept.limits, sourceLedger: ledgerLimits }, sourceLedgerURL: ledgerURL };
    expect(videoPresentationIngestRequestSchema.parse(request)).toEqual(request);
  });

  it('still accepts an admission that requests no ledger', () => {
    expect(videoPresentationIngestRequestSchema.parse(accept)).toEqual(accept);
  });

  it.each([
    ['a missing budget', (() => { const { matroskaMaxBlocks: _drop, ...rest } = ledgerLimits; return rest; })()],
    ['a zero budget', { ...ledgerLimits, maxBytes: 0 }],
    ['an extra key', { ...ledgerLimits, retries: 3 }],
  ])('rejects ledger budgets with %s', (_name, sourceLedger) => {
    expect(videoPresentationIngestRequestSchema.safeParse({ ...accept, limits: { ...accept.limits, sourceLedger }, sourceLedgerURL: ledgerURL }).success).toBe(false);
  });

  it.each([
    ['budgets without a URL', { limits: { ...accept.limits, sourceLedger: ledgerLimits } }],
    ['a URL without budgets', { sourceLedgerURL: ledgerURL }],
    ['a URL that is not one', { limits: { ...accept.limits, sourceLedger: ledgerLimits }, sourceLedgerURL: 'not a url' }],
  ])('rejects %s', (_name, extra) => {
    expect(videoPresentationIngestRequestSchema.safeParse({ ...accept, ...extra }).success).toBe(false);
  });
});

describe('presentation snapshot answering with the ledger state', () => {
  const identity = { schemaVersion: 1, sourceFingerprint: fingerprint, producerVersion: 1, attempt: { jobId: 'video-presentation-a', deadlineAt: 1900000000000 } };
  const receipt = {
    ...identity, strategy: 'matroska_rate_one', url: ledgerURL, etag: '"e"', size: 10, sha256: 'b'.repeat(64),
    contentType: 'application/json', physicalFrameCount: 3, occurrenceCount: 3,
  };

  it.each([
    ['absent', undefined],
    ['null', null],
    ['pending', { state: 'pending', ...identity }],
    ['ready', { state: 'ready', receipt }],
    ['failed', { state: 'failed', ...identity, errorCode: 'ledger_invalid' }],
  ])('parses a %s ledger state', (_name, sourceLedger) => {
    const snapshot = { presentation: null, attempt: null, ...(sourceLedger === undefined ? {} : { sourceLedger }) };
    expect(videoPresentationIngestSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('rejects a malformed ledger state', () => {
    expect(videoPresentationIngestSnapshotSchema.safeParse({ presentation: null, attempt: null, sourceLedger: { state: 'ready' } }).success).toBe(false);
  });
});
