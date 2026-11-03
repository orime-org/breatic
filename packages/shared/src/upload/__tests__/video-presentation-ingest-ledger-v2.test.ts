// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The backend-to-ingest presentation contract requests the source ledger at
 * every admission and answers with the v2 ledger state (inner#1306 test plan
 * §77, Q/S/K cases). The request carries the ledger budgets without any frame
 * count ceiling and the public addresses of both stored objects: the full
 * ledger and the compact presentation table written with it.
 *
 * S6c (test plan §89) replaces both shapes in place (frames-split design §3.4):
 * the request freezes the basic and standard-4 prices and carries the target
 * policy version and the admission retry caps (§3.5, §5.1); the snapshot is
 * the §3.5 response row without the earlier attempt and sourceLedger fields.
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
  // Design §3.5 and §5.1 (S6c): both container prices are frozen at admission; the target policy travels with the request.
  pricing: {
    basic: { containerClass: 'MediaContainer', size: { vcpu: 0.25, memory_gib: 1, disk_gb: 4 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
    standard4: { containerClass: 'MiniToolContainerStd4', size: { vcpu: 4, memory_gib: 12, disk_gb: 20 }, prices: { vcpu_second_usd: 0, memory_gib_second_usd: 0, disk_gb_second_usd: 0 } },
  },
  targetPolicyVersion: 1, policy: { chunkRetries: 3, maxAutoRepairs: 3 },
  // S6e E2-1: the encoding parameters are frozen at admission.
  encoding: {
    chunkShare: 0.5, maxParallelChunks: 8,
    encoder: { startSeconds: 3, encodePixelsPerSecond: 163000000, decodeConvertPixelsPerSecond: { sdr_8bit: 1950000000, sdr_10bit: 705000000, hdr_8bit: 152000000, hdr_10bit: 103000000 } },
    copyDiskMarginBytes: 33554432, carrier: { maxShortSide: 1080, color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' } },
  },
  actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null,
  // S6e (design §3.5 server/worker→ingest, inner 1c3a5892): one frozen public base replaces the per-object URLs.
  publicBaseURL: 'https://assets.example.test',
};
const ledgerURL = 'https://assets.example.test/video/canonical.webm.ledger.json';
const tableURL = 'https://assets.example.test/video/canonical.webm.table.json';
const requested = { ...accept, limits: { ...accept.limits, sourceLedger: ledgerLimits } };

/**
 * The request schema's verdict on one candidate admission.
 * @param value - Candidate request body.
 * @returns Whether it parses.
 */
function admits(value: unknown): boolean {
  return videoPresentationIngestRequestSchema.safeParse(value).success;
}

describe('presentation admission requesting the source ledger v2 (inner#1306 §77)', () => {
  it('Q01 carries the six ledger budgets unchanged', () => {
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
    ['the ledger URL', { sourceLedgerURL: ledgerURL }],
    ['the table URL', { sourceLedgerTableURL: tableURL }],
  ])('Q02 rejects %s, now derived from the public base (inner 1c3a5892)', (_name, extra) => {
    expect(admits(requested)).toBe(true);
    expect(admits({ ...requested, ...extra })).toBe(false);
  });
});

describe('S6c request fields: both prices, target policy and admission policy (inner#1306 §3.5, §5.1)', () => {
  it('RQ01 accepts an admission with both prices, the target policy version and the frozen retry caps', () => {
    expect(videoPresentationIngestRequestSchema.parse(accept)).toEqual(accept);
  });

  // §3.5 server/worker→ingest: 「freeze/read/repair都传目标policy」.
  it('RQ02 a read carries the target policy version', () => {
    const read = { action: 'read', storageKey: accept.storageKey, sourceFingerprint: fingerprint, targetPolicyVersion: 1 };
    expect(videoPresentationIngestRequestSchema.parse(read)).toEqual(read);
    expect(admits({ action: 'read', storageKey: accept.storageKey, sourceFingerprint: fingerprint })).toBe(false);
  });

  it.each([
    ['the earlier single price', { pricing: accept.pricing.basic }],
    ['a missing standard-4 price', { pricing: { basic: accept.pricing.basic } }],
    ['a missing basic price', { pricing: { standard4: accept.pricing.standard4 } }],
    ['a third price', { pricing: { ...accept.pricing, standard1: accept.pricing.basic } }],
    ['a missing target policy version', { targetPolicyVersion: undefined }],
    ['a zero target policy version', { targetPolicyVersion: 0 }],
    ['a fractional target policy version', { targetPolicyVersion: 1.5 }],
    ['a missing admission policy', { policy: undefined }],
    ['a negative chunk retry cap', { policy: { chunkRetries: -1, maxAutoRepairs: 3 } }],
    ['a fractional auto-repair cap', { policy: { chunkRetries: 3, maxAutoRepairs: 2.5 } }],
    ['an unknown policy key', { policy: { chunkRetries: 3, maxAutoRepairs: 3, extra: 1 } }],
  ])('RQ03 rejects an admission with %s', (_name, change) => {
    expect(admits(accept)).toBe(true);
    const value: Record<string, unknown> = { ...accept, ...change };
    for (const [field, entry] of Object.entries(change)) if (entry === undefined) delete value[field];
    expect(admits(value)).toBe(false);
  });
});

/*
 * The snapshot mirrors the §3.5 web→server response row: the source binding (internally the storageKey and
 * sourceFingerprint, §3.5 「内部请求/快照用原storageKey/sourceFingerprint」), the selected bundle or null, the preparation
 * of the target policy and the L state of the selected version's toolInputId alone, with no full array (§5.1 step 6).
 * Wire ledger states follow §10.1 A: absent is null, then pending, ready and failed with its code.
 */
describe('S6c snapshot: source binding, selected bundle, preparation and the selected ledger (inner#1306 §3.5, §5.1 step 6)', () => {
  const T = 'c'.repeat(64);
  const PLAN = 'd'.repeat(64);
  const bundle = {
    schemaVersion: 1, sourceFingerprint: fingerprint, versionId: 'e'.repeat(64), toolInputId: T, planSha256: PLAN, policyVersion: 1, producerVersion: 2, profileVersion: 1,
    original: { width: 64, height: 48, duration: 2.125 }, display: { width: 64, height: 48, duration: { numerator: '17', denominator: '8' } },
    playback: { kind: 'native', carrier: { storageKey: 'video/canonical.webm', url: 'https://assets.example.test/video/canonical.webm', etag: 'e1', size: 4096, sha256: 'f'.repeat(64), contentType: 'video/webm' }, displayRect: null },
    playbackClock: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
  };
  const receipt = {
    schemaVersion: 2, sourceFingerprint: fingerprint, toolInputId: T, planSha256: PLAN, producerVersion: 2, attempt: { jobId: 'video-presentation-a', deadlineAt: 1900000000000 },
    url: ledgerURL, etag: '"e"', size: 912, sha256: 'b'.repeat(64), contentType: 'application/json',
    table: { url: tableURL, sha256: 'c'.repeat(64), size: 81, contentType: 'application/json', frameCount: 17 },
  };
  const sourceBinding = { storageKey: 'video/canonical.webm', sourceFingerprint: fingerprint };
  // Stages are the §7.1 route stages.
  const preparation = { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'encode', failure: null };
  const ready = { sourceBinding, presentation: bundle, preparation, ledger: { state: 'ready', receipt, failure: null } };

  it.each([
    ['nothing admitted yet', { sourceBinding, presentation: null, preparation: null, ledger: null }],
    ['work in preparation without a selected version', { sourceBinding, presentation: null, preparation, ledger: null }],
    ['a selected version with its ready ledger', ready],
    ['a selected version whose ledger is pending', { ...ready, ledger: { state: 'pending', receipt: null, failure: null } }],
    ['a selected version whose ledger failed transiently', { ...ready, ledger: { state: 'failed', receipt: null, failure: 'source_ledger_invalid' } }],
    ['a selected version whose ledger failed on content', { ...ready, ledger: { state: 'failed', receipt: null, failure: 'unsupported_rate' } }],
    ['a failed preparation of the target policy beside the selected version', { ...ready, preparation: { ...preparation, stage: 'plan', failure: 'too_long' } }],
    ['a recorded usage fact', { ...ready, usageFact: { jobId: 'video-presentation-a', actorUserId: '6061c056-f758-47c1-9527-8495ecba60e3', projectId: null, usage: { wallMs: 1, cpuUsec: null }, pricing: accept.pricing.basic } }],
  ])('SN01 parses a snapshot with %s unchanged', (_name, snapshot) => {
    expect(videoPresentationIngestSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    ['the earlier v2 shape', { presentation: null, attempt: null }],
    ['a full frame array', { ...ready, frames: [] }],
    ['all ledger instances', { ...ready, ledgers: {} }],
    ['the earlier sourceLedger field', { ...ready, sourceLedger: null }],
    ['a missing source binding', (() => { const { sourceBinding: _drop, ...rest } = ready; return rest; })()],
    ['a ready ledger without its receipt', { ...ready, ledger: { state: 'ready', receipt: null, failure: null } }],
    ['a failed ledger without its code', { ...ready, ledger: { state: 'failed', receipt: null, failure: null } }],
    ['a pending ledger with a receipt', { ...ready, ledger: { state: 'pending', receipt, failure: null } }],
    ['a ledger receipt for another toolInputId', { ...ready, ledger: { state: 'ready', receipt: { ...receipt, toolInputId: 'b'.repeat(64) }, failure: null } }],
    ['a ledger without a selected version', { sourceBinding, presentation: null, preparation, ledger: { state: 'pending', receipt: null, failure: null } }],
    ['an internal ledger state name', { ...ready, ledger: { state: 'failed-transient', receipt: null, failure: 'source_ledger_invalid' } }],
    ['a preparation without the target policy version', { ...ready, preparation: { jobId: 'video-presentation-a', stage: 'encode', failure: null } }],
    ['an unknown preparation key', { ...ready, preparation: { ...preparation, attempt: null } }],
    ['a bundle of another source', { ...ready, presentation: { ...bundle, sourceFingerprint: 'b'.repeat(64) } }],
    ['the earlier v1 descriptor', { ...ready, presentation: { schemaVersion: 1, sourceFingerprint: fingerprint, original: { width: 64, height: 48, duration: 2.125 }, state: 'native' } }],
  ])('SN02 rejects a snapshot with %s', (_name, snapshot) => {
    expect(videoPresentationIngestSnapshotSchema.safeParse(ready).success).toBe(true);
    expect(videoPresentationIngestSnapshotSchema.safeParse(snapshot).success).toBe(false);
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
