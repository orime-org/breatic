// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The web→server presentation response (inner#1306 test plan §90 E1; frames-split
 * design §3.5 web→server row, §5.1 step 6, §7.12). It mirrors the S6c ingest
 * snapshot with one name per concept: the registered sourceBinding, the selected
 * bundle or null (no separate manifest), the target policy's preparation
 * `{targetPolicyVersion, jobId, stage, failure}`, the selected version's L as
 * `ledger` in the §10.1 wire states, the polling interval and the read limits.
 * A repair answers the same response; there is no `attempt` field.
 *
 * pollAfterMs is non-null exactly when §7.12 steps 1–5 would paint waiting from
 * server data. The case of a target candidate verified but waiting on its own
 * exhausted L with nothing selected is held (§90 需要确认) and not asserted here.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { videoPresentationResponseSchema, videoPresentationSourceBindingSchema } from '../video-presentation-response.js';

const H = 'a'.repeat(64);
const T = 'c'.repeat(64);
const PLAN = 'd'.repeat(64);
const binding = {
  assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: H,
  canonicalURL: 'https://assets.example.test/canonical.webm', kind: 'video',
  mediaInfo: { width: null, height: null, duration: null, mimeType: 'video/webm' },
};
const bundle = {
  schemaVersion: 1, sourceFingerprint: H, versionId: 'e'.repeat(64), toolInputId: T, planSha256: PLAN, policyVersion: 1,
  original: { width: 64, height: 48, duration: 2.125 }, display: { width: 64, height: 48, duration: { numerator: '17', denominator: '8' } },
  playback: { kind: 'native', carrier: { storageKey: 'video/canonical.webm', url: 'https://assets.example.test/canonical.webm', etag: 'e1', size: 4096, sha256: 'f'.repeat(64), contentType: 'video/webm' }, displayRect: null },
  playbackClock: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] },
};
const receipt = {
  schemaVersion: 2, sourceFingerprint: H, toolInputId: T, planSha256: PLAN, producerVersion: 2, attempt: { jobId: 'video-presentation-a', deadlineAt: 1900000000000 },
  url: 'https://assets.example.test/canonical.webm.ledger.json', etag: '"e"', size: 912, sha256: 'b'.repeat(64), contentType: 'application/json',
  table: { url: 'https://assets.example.test/canonical.webm.table.json', sha256: 'c'.repeat(64), size: 81, contentType: 'application/json', frameCount: 17 },
};
const limits = { maxBytes: 16777216 };
const inFlight = { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'encode', failure: null };
const failedPrep = { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'plan', failure: 'too_long' };
const readyLedger = { state: 'ready', receipt, failure: null };
const pendingLedger = { state: 'pending', receipt: null, failure: null };
const failedLedger = { state: 'failed', receipt: null, failure: 'source_ledger_invalid' };
/** Nothing selected, work in flight: waiting-presentation (§7.12 step 2). */
const waiting = { sourceBinding: binding, presentation: null, preparation: inFlight, ledger: null, pollAfterMs: 5000, sourceLedgerReadLimits: limits };
/** A selected version with its ready ledger and no target work: usable (§7.12 step 5). */
const usable = { sourceBinding: binding, presentation: bundle, preparation: null, ledger: readyLedger, pollAfterMs: null, sourceLedgerReadLimits: limits };

/**
 * The response schema's verdict.
 * @param value - A candidate response.
 * @returns Whether it parses.
 */
function parses(value: unknown): boolean {
  return videoPresentationResponseSchema.safeParse(value).success;
}

describe('registered source binding (inner#1306 §3.5: sourceBinding unchanged)', () => {
  it('B01 carries the registered identity while media measurements remain unknown', () => {
    expect(videoPresentationSourceBindingSchema.parse(binding)).toEqual(binding);
    expect(videoPresentationResponseSchema.parse(waiting)).toEqual(waiting);
  });

  it('B02 allows partially known measurements without substituting zero', () => {
    const partial = { ...binding, mediaInfo: { ...binding.mediaInfo, width: 95, height: 63 } };
    expect(videoPresentationSourceBindingSchema.parse(partial)).toEqual(partial);
  });

  it.each(['width', 'height', 'duration'] as const)('B03 rejects zero %s instead of treating it as measured', (field) => {
    expect(videoPresentationSourceBindingSchema.safeParse({ ...binding, mediaInfo: { ...binding.mediaInfo, [field]: 0 } }).success).toBe(false);
  });
});

describe('selected bundle on the response (inner#1306 §3.5 P descriptor, §5.1 step 6)', () => {
  it('V01 carries the selected version and its ready ledger', () => {
    expect(videoPresentationResponseSchema.parse(usable)).toEqual(usable);
  });

  it('V02 has no separate manifest field: the alpha-packed bundle carries its manifest receipt', () => {
    expect(parses(usable)).toBe(true);
    expect(parses({ ...usable, manifest: { schemaVersion: 1 } })).toBe(false);
  });

  it('V03 rejects a bundle of another registered fingerprint', () => {
    expect(parses({ ...usable, ledger: null, pollAfterMs: 5000 })).toBe(true);
    expect(parses({ ...usable, presentation: { ...bundle, sourceFingerprint: 'b'.repeat(64) }, ledger: null, pollAfterMs: 5000 })).toBe(false);
  });

  it('V04 rejects the earlier v1 descriptor', () => {
    expect(parses(waiting)).toBe(true);
    expect(parses({ ...waiting, presentation: { schemaVersion: 1, sourceFingerprint: H, original: { width: 64, height: 48, duration: 2.125 }, state: 'native' } })).toBe(false);
  });

  it.each([
    [1.323333, 1.323, true], [1.3235, 1.324, true], [1.323499999, 1.323, true],
    [1.324333, 1.323, false], [1.3235, 1.323, false],
  ] as const)('V05 compares the bundle original duration %s to stored numeric duration %s at PostgreSQL decimal precision', (measured, registered, valid) => {
    const response = { ...usable, sourceBinding: { ...binding, mediaInfo: { ...binding.mediaInfo, duration: registered } },
      presentation: { ...bundle, original: { ...bundle.original, duration: measured } } };
    expect(parses(usable)).toBe(true);
    expect(parses(response)).toBe(valid);
  });

  it('V06 preserves positive decimal half-millisecond rounding across a range of registered durations', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), (ticks) => {
      const measured = Number(`${Math.floor(ticks / 1000)}.${String(ticks % 1000).padStart(3, '0')}5`);
      const registered = (ticks + 1) / 1000;
      expect(parses({ ...usable, sourceBinding: { ...binding, mediaInfo: { ...binding.mediaInfo, duration: registered } },
        presentation: { ...bundle, original: { ...bundle.original, duration: measured } } })).toBe(true);
    }));
  });
});

describe('target policy preparation (inner#1306 §3.5 「preparation报告目标policy、原attempt和真实阶段」)', () => {
  it('P01 carries work in flight and a failed preparation in the snapshot shape', () => {
    expect(videoPresentationResponseSchema.parse(waiting)).toEqual(waiting);
    const failed = { ...waiting, preparation: failedPrep, pollAfterMs: null };
    expect(videoPresentationResponseSchema.parse(failed)).toEqual(failed);
  });

  it.each([
    ['the earlier status and attempt', { status: 'running', attempt: { jobId: 'video-presentation-a', deadlineAt: 1900000000000 } }],
    ['a deadline', { ...inFlight, deadlineAt: 1900000000000 }],
    ['no target policy version', { jobId: 'video-presentation-a', stage: 'encode', failure: null }],
    ['a zero target policy version', { ...inFlight, targetPolicyVersion: 0 }],
  ])('P02 rejects a preparation with %s', (_name, preparation) => {
    expect(parses(waiting)).toBe(true);
    expect(parses({ ...waiting, preparation })).toBe(false);
  });
});

describe('the selected version\'s ledger (inner#1306 §5.1 step 6, §10.1 A)', () => {
  it.each([
    ['ready', readyLedger, null],
    ['pending', pendingLedger, 5000],
    ['failed', failedLedger, null],
  ] as const)('L01 carries a %s ledger of the selected version', (_name, ledger, pollAfterMs) => {
    const response = { ...usable, ledger, pollAfterMs };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    ['a ready ledger without its receipt', { ...usable, ledger: { state: 'ready', receipt: null, failure: null } }],
    ['a failed ledger without its code', { ...usable, ledger: { state: 'failed', receipt: null, failure: null } }],
    ['a pending ledger with a receipt', { ...usable, ledger: { state: 'pending', receipt, failure: null }, pollAfterMs: 5000 }],
    ['a receipt of another source', { ...usable, ledger: { ...readyLedger, receipt: { ...receipt, sourceFingerprint: 'b'.repeat(64) } } }],
    ['a receipt of another toolInputId', { ...usable, ledger: { ...readyLedger, receipt: { ...receipt, toolInputId: 'b'.repeat(64) } } }],
    ['a ledger without a selected version', { ...waiting, ledger: pendingLedger }],
    ['an internal state name', { ...usable, ledger: { state: 'failed-transient', receipt: null, failure: 'source_ledger_invalid' } }],
    ['the earlier sourceLedger field', { ...usable, sourceLedger: null }],
    ['the earlier repair attempt field', { ...usable, attempt: null }],
  ])('L02 rejects %s', (_name, response) => {
    expect(parses(usable)).toBe(true);
    expect(parses(response)).toBe(false);
  });
});

describe('polling only while §7.12 paints waiting from server data (inner#1306 §7.12 steps 2 and 4)', () => {
  it.each([
    ['a selected version whose ledger is pending', { ...usable, ledger: pendingLedger }, true],
    ['a selected version whose ledger is absent', { ...usable, ledger: null }, true],
    ['a selected version whose ledger is ready', usable, false],
    ['a selected version whose ledger failed', { ...usable, ledger: failedLedger }, false],
    ['a selected version with a ready ledger while target work is in flight', { ...usable, preparation: inFlight }, false],
    ['nothing selected and the target work failed', { ...waiting, preparation: failedPrep }, false],
  ] as const)('Q01 %s polls exactly when it waits', (_name, response, polls) => {
    expect(parses({ ...response, pollAfterMs: polls ? 5000 : null })).toBe(true);
    expect(parses({ ...response, pollAfterMs: polls ? null : 5000 })).toBe(false);
  });

  it.each([0, -1, 1.5])('Q02 rejects a polling interval of %s', (pollAfterMs) => {
    expect(parses(waiting)).toBe(true);
    expect(parses({ ...waiting, pollAfterMs })).toBe(false);
  });
});

describe('read limits beside the ledger (inner#1306 §5.1 step 6; web bounded compact read)', () => {
  it.each([
    ['a missing byte budget', {}],
    ['zero', { maxBytes: 0 }],
    ['a fraction', { maxBytes: 1.5 }],
    ['an unsafe value', { maxBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['a retired physical frame cap', { ...limits, maxPhysicalFrames: 100000 }],
    ['a retired occurrence cap', { ...limits, maxOccurrences: 100000 }],
    ['an extra key', { ...limits, retries: 3 }],
  ])('RL01 rejects read limits with %s', (_name, sourceLedgerReadLimits) => {
    expect(parses(usable)).toBe(true);
    expect(parses({ ...usable, sourceLedgerReadLimits })).toBe(false);
  });
});
