// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { advanceVideoPresentation } from '../video-presentation-state.js';
import type { VideoPresentation } from '@breatic/shared';

const accepted = { sourceFingerprint: 'a'.repeat(64), jobId: 'presentation-accepted', deadlineAt: 1900000000000 };
const pending: VideoPresentation = {
  schemaVersion: 1, sourceFingerprint: accepted.sourceFingerprint,
  original: { width: 95, height: 63, duration: 2.4 }, state: 'classifying',
  attempt: { jobId: accepted.jobId, deadlineAt: accepted.deadlineAt },
};
const ready: VideoPresentation = {
  ...pending, state: 'alpha_ready', alpha: { manifestURL: 'https://assets.example.test/canonical.webm.alpha.v1.json' },
};

describe('presentation descriptor attempt arbitration (inner#1306)', () => {
  it('publishes a measured classifying descriptor only under the accepted identity', () => {
    expect(advanceVideoPresentation(null, accepted, pending)).toEqual(pending);
  });

  it('accepts native only from current classification work and clears the error', () => {
    const native: VideoPresentation = { ...pending, state: 'native' };
    expect(advanceVideoPresentation(pending, accepted, native)).toEqual(native);
  });

  it('accepts alpha preparation and matching verified completion', () => {
    const alpha: VideoPresentation = { ...pending, state: 'alpha_pending' };
    expect(advanceVideoPresentation(pending, accepted, alpha)).toEqual(alpha);
    expect(advanceVideoPresentation(alpha, accepted, ready)).toEqual(ready);
  });

  it('allows the same attempt to complete after an expiry failure without a replacement', () => {
    const expired: VideoPresentation = { ...pending, state: 'failed', error: 'expired' };
    expect(advanceVideoPresentation(expired, accepted, ready)).toEqual(ready);
  });

  it('does not extend the first accepted deadline on a proposed replay', () => {
    expect(advanceVideoPresentation(pending, accepted, {
      ...ready, attempt: { jobId: accepted.jobId, deadlineAt: accepted.deadlineAt + 1 },
    })).toEqual(pending);
  });

  it('cannot publish a zero-sized descriptor before trusted measurement', () => {
    expect(advanceVideoPresentation(null, accepted, { ...pending, original: { width: 0, height: 0, duration: 0 } })).toBe(null);
  });

  it('rejects stale source fingerprints and superseded attempt identities for every valid descriptor', () => {
    fc.assert(fc.property(fc.uuid(), fc.integer({ min: 1, max: 1000000 }), (suffix, deadlineDelta) => {
      const replacement = { ...accepted, jobId: `replacement-${suffix}`, deadlineAt: accepted.deadlineAt + deadlineDelta };
      expect(advanceVideoPresentation(pending, replacement, ready)).toEqual(pending);
      expect(advanceVideoPresentation(pending, { ...accepted, sourceFingerprint: 'b'.repeat(64) }, ready)).toEqual(pending);
    }));
  });

  it('keeps the original registered dimensions and duration fixed', () => {
    expect(advanceVideoPresentation(pending, accepted, { ...ready, original: { ...pending.original, width: 96 } })).toEqual(pending);
    expect(advanceVideoPresentation(pending, accepted, { ...ready, original: { ...pending.original, duration: 3 } })).toEqual(pending);
  });

  it('does not erase classification by accepting a contradictory native packed completion', () => {
    const native: VideoPresentation = { ...pending, state: 'native' };
    expect(advanceVideoPresentation(native, accepted, ready)).toEqual(native);
  });
});
