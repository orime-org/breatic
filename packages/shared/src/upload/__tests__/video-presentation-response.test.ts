// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The web→server presentation response (inner#1306 test plan §90 E1; frames-split
 * design §3.5 web→server row, §5.1 step 6, §7.12). It mirrors the S6c ingest
 * snapshot with one name per concept: the registered sourceBinding, the selected
 * bundle or null (no separate manifest), the target policy's preparation
 * `{targetPolicyVersion, jobId, stage, failure}` and the polling interval. The
 * selected version is complete with its grid (frames-split §3.5, §10.6 存储 row),
 * so there is no ledger or read limit beside it any more (§3.4). A repair answers
 * the same response; there is no `attempt` field.
 *
 * pollAfterMs is non-null exactly when §7.12 would paint waiting from server data:
 * nothing selected while the target work has not failed.
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
  schemaVersion: 1, sourceFingerprint: H, versionId: 'e'.repeat(64), toolInputId: T, planSha256: PLAN, policyVersion: 1, producerVersion: '1'.repeat(64), profileVersion: '2'.repeat(64),
  original: { width: 64, height: 48, duration: 2.125 },
  display: { width: 64, height: 48, fps: { numerator: 8, denominator: 1 }, frameCount: 17, gridStart: { numerator: 0, denominator: 1 }, realFrameCount: 17, leadFrames: 0, holdFrames: 0 },
  playback: { kind: 'native', carrier: { storageKey: 'video/canonical.webm.playback.mp4', url: 'https://assets.example.test/canonical.webm.playback.mp4', etag: 'e1', size: 4096, sha256: 'f'.repeat(64), contentType: 'video/mp4' }, displayRect: null },
  toolSource: { edit: null, keyframes: { earliestKeyframeTime: 0, maxKeyframeInterval: 2, allKeyframes: false }, sourceDecodeKey: 'sdr_8bit' },
};
const inFlight = { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'encode', failure: null };
const failedPrep = { targetPolicyVersion: 1, jobId: 'video-presentation-a', stage: 'plan', failure: 'too_long' };
/** Nothing selected, work in flight: waiting-presentation (§7.12 step 2). */
const waiting = { sourceBinding: binding, presentation: null, preparation: inFlight, pollAfterMs: 5000 };
/** A selected version and no target work: usable (§7.12 step 5). */
const usable = { sourceBinding: binding, presentation: bundle, preparation: null, pollAfterMs: null };

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
  it('V01 carries the selected version', () => {
    expect(videoPresentationResponseSchema.parse(usable)).toEqual(usable);
  });

  it('V02 has no separate manifest field: the alpha-packed bundle carries its manifest receipt', () => {
    expect(parses(usable)).toBe(true);
    expect(parses({ ...usable, manifest: { schemaVersion: 1 } })).toBe(false);
  });

  it('V03 rejects a bundle of another registered fingerprint', () => {
    expect(parses(usable)).toBe(true);
    expect(parses({ ...usable, presentation: { ...bundle, sourceFingerprint: 'b'.repeat(64) } })).toBe(false);
  });

  it('V04 rejects the earlier v1 descriptor and the playback-clock version', () => {
    expect(parses(waiting)).toBe(true);
    expect(parses({ ...waiting, presentation: { schemaVersion: 1, sourceFingerprint: H, original: { width: 64, height: 48, duration: 2.125 }, state: 'native' } })).toBe(false);
    expect(parses({ ...usable, presentation: { ...bundle, playbackClock: { schemaVersion: 1, timescale: 8, runs: [{ start: 0, count: 17, step: 1, duration: 1 }] } } })).toBe(false);
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

describe('the retired ledger fields (frames-split §3.4)', () => {
  it.each([['ledger', null], ['sourceLedgerReadLimits', { maxBytes: 16777216 }], ['sourceLedger', null], ['attempt', null]])('L02 rejects the earlier %s field', (field, value) => {
    expect(parses(usable)).toBe(true);
    expect(parses({ ...usable, [field]: value })).toBe(false);
  });
});

describe('polling only while §7.12 paints waiting from server data (inner#1306 §7.12 steps 2 and 4)', () => {
  it.each([
    ['nothing selected while target work is in flight', waiting, true],
    ['a selected version', usable, false],
    ['a selected version while target work is in flight', { ...usable, preparation: inFlight }, false],
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
