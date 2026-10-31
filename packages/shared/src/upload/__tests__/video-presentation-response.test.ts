// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { videoPresentationResponseSchema, videoPresentationSourceBindingSchema } from '../video-presentation-response.js';

const idle = { preparation: null, pollAfterMs: null };
const binding = {
  assetId: '21de0c40-eb00-4bc0-ab81-d32f709b3b14', contentHash: 'a'.repeat(64),
  canonicalURL: 'https://assets.example.test/canonical.webm', kind: 'video',
  mediaInfo: { width: null, height: null, duration: null, mimeType: 'video/webm' },
};
const presentation = {
  schemaVersion: 1, sourceFingerprint: binding.contentHash, original: { width: 95, height: 63, duration: 2.4 },
  state: 'alpha_ready', alpha: { manifestURL: `${binding.canonicalURL}.alpha.v1.json` },
};
const manifest = {
  schemaVersion: 1, sourceFingerprint: binding.contentHash,
  packedURL: `${binding.canonicalURL}.alpha.v1.mp4`, packedWidth: 192, packedHeight: 64,
  colorRect: { x: 0, y: 0, width: 95, height: 63 }, alphaRect: { x: 96, y: 0, width: 95, height: 63 },
};

describe('registered video presentation response (inner#1306)', () => {
  it('carries the real registered identity while media measurements remain unknown', () => {
    expect(videoPresentationSourceBindingSchema.parse(binding)).toEqual(binding);
    expect(videoPresentationResponseSchema.parse({ sourceBinding: binding, presentation: null, ...idle }))
      .toEqual({ sourceBinding: binding, presentation: null, ...idle });
  });

  it('allows partially known measurements without substituting zero', () => {
    const partial = { ...binding, mediaInfo: { ...binding.mediaInfo, width: 95, height: 63 } };
    expect(videoPresentationSourceBindingSchema.parse(partial)).toEqual(partial);
  });

  it.each(['width', 'height', 'duration'] as const)('rejects zero %s instead of treating it as measured', (field) => {
    expect(videoPresentationSourceBindingSchema.safeParse({ ...binding, mediaInfo: { ...binding.mediaInfo, [field]: 0 } }).success).toBe(false);
  });

  it('carries a verified manifest beside the original canonical binding', () => {
    const response = { sourceBinding: binding, presentation, manifest, ...idle };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a presentation from a different registered fingerprint', () => {
    expect(videoPresentationResponseSchema.safeParse({
      ...idle, sourceBinding: binding, presentation: { ...presentation, sourceFingerprint: 'b'.repeat(64) }, manifest,
    }).success).toBe(false);
  });

  it('requires a matching manifest when the query declares alpha ready', () => {
    expect(videoPresentationResponseSchema.safeParse({ ...idle, sourceBinding: binding, presentation }).success).toBe(false);
    expect(videoPresentationResponseSchema.safeParse({
      ...idle, sourceBinding: binding, presentation, manifest: { ...manifest, sourceFingerprint: 'b'.repeat(64) },
    }).success).toBe(false);
  });

  it('rejects a manifest whose display rectangles disagree with the original', () => {
    expect(videoPresentationResponseSchema.safeParse({
      ...idle, sourceBinding: binding, presentation, manifest: { ...manifest, alphaRect: { ...manifest.alphaRect, height: 62 }, colorRect: { ...manifest.colorRect, height: 62 } },
    }).success).toBe(false);
  });

  it('exposes pending work before measurement with the server-owned polling interval', () => {
    const response = { sourceBinding: binding, presentation: null, preparation: {
      status: 'accepted', attempt: { jobId: 'first-accepted', deadlineAt: 1900000000000 },
    }, pollAfterMs: 5000 };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it('exposes a preparation failure without fabricating a measured descriptor', () => {
    const response = { sourceBinding: binding, presentation: null, preparation: {
      status: 'failed', attempt: { jobId: 'first-accepted', deadlineAt: 1900000000000 }, error: 'probe_failed',
    }, pollAfterMs: null };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it('requires polling only while accepted work is pending', () => {
    expect(videoPresentationResponseSchema.safeParse({ sourceBinding: binding, presentation: null, preparation: {
      status: 'running', attempt: { jobId: 'first-accepted', deadlineAt: 1900000000000 },
    }, pollAfterMs: null }).success).toBe(false);
    expect(videoPresentationResponseSchema.safeParse({ sourceBinding: binding, presentation: null, ...idle, pollAfterMs: 5000 }).success).toBe(false);
  });

  it.each([
    [1.323333, 1.323, true], [1.3235, 1.324, true], [1.323499999, 1.323, true],
    [1.324333, 1.323, false], [1.3235, 1.323, false],
  ] as const)('compares probe duration %s to stored numeric duration %s at PostgreSQL decimal precision', (measured, registered, valid) => {
    const response = { ...idle, sourceBinding: { ...binding, mediaInfo: { ...binding.mediaInfo, duration: registered } },
      presentation: { ...presentation, state: 'native', alpha: undefined, original: { ...presentation.original, duration: measured } } };
    expect(videoPresentationResponseSchema.safeParse(response).success).toBe(valid);
  });

  it('preserves positive decimal half-millisecond rounding across a range of registered durations', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), (ticks) => {
      const measured = Number(`${Math.floor(ticks / 1000)}.${String(ticks % 1000).padStart(3, '0')}5`);
      const registered = (ticks + 1) / 1000;
      expect(videoPresentationResponseSchema.safeParse({ ...idle,
        sourceBinding: { ...binding, mediaInfo: { ...binding.mediaInfo, duration: registered } },
        presentation: { ...presentation, state: 'native', alpha: undefined, original: { ...presentation.original, duration: measured } },
      }).success).toBe(true);
    }));
  });
});

// inner#1306 consumer oracle §6: the small response carries the source ledger
// state and the current read limits, never the arrays.
describe('source ledger state and read limits on the presentation response (G01–G07)', () => {
  const identity = {
    schemaVersion: 1, sourceFingerprint: binding.contentHash, producerVersion: 1,
    attempt: { jobId: 'ledger-attempt-a', deadlineAt: 1000 },
  };
  const receipt = {
    ...identity, strategy: 'matroska_rate_one', url: 'https://assets.example.test/canonical.webm.video-source-ledger.v1.json',
    etag: '"Opaque-R2-ETag"', size: 2048, sha256: 'b'.repeat(64), contentType: 'application/json', physicalFrameCount: 3, occurrenceCount: 3,
  };
  const limits = { maxBytes: 16777216 };
  const work = {
    preparation: { status: 'failed', attempt: { jobId: 'presentation-work-b', deadlineAt: 1900000000000 }, error: 'probe_failed' },
    pollAfterMs: null,
  };

  it('keeps ready receipt A unchanged beside another current work B (G01, G07)', () => {
    const response = { sourceBinding: binding, presentation: null, ...work, sourceLedger: { state: 'ready', receipt }, sourceLedgerReadLimits: limits };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    ['ready', { state: 'ready', receipt: { ...receipt, sourceFingerprint: 'c'.repeat(64) } }],
    ['pending', { state: 'pending', ...identity, sourceFingerprint: 'c'.repeat(64) }],
    ['failed', { state: 'failed', ...identity, sourceFingerprint: 'c'.repeat(64), errorCode: 'ledger_invalid' }],
  ])('rejects a %s ledger naming another source (G02)', (_state, sourceLedger) => {
    expect(videoPresentationResponseSchema.safeParse({ sourceBinding: binding, presentation: null, ...idle, sourceLedger, sourceLedgerReadLimits: limits }).success).toBe(false);
  });

  it('accepts a legacy response with neither field (G03)', () => {
    const response = { sourceBinding: binding, presentation: null, ...idle };
    const parsed = videoPresentationResponseSchema.parse(response);
    expect(parsed).toEqual(response);
    expect('sourceLedger' in parsed).toBe(false);
    expect('sourceLedgerReadLimits' in parsed).toBe(false);
  });

  it('keeps a ready receipt without read limits as it arrived (G04)', () => {
    const response = { sourceBinding: binding, presentation: null, ...idle, sourceLedger: { state: 'ready', receipt } };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    ['a missing byte budget', {}],
    ['zero', { ...limits, maxBytes: 0 }],
    ['a fraction', { maxBytes: 1.5 }],
    ['an unsafe value', { maxBytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['a retired physical frame cap', { ...limits, maxPhysicalFrames: 100000 }],
    ['a retired occurrence cap', { ...limits, maxOccurrences: 100000 }],
    ['an extra key', { ...limits, retries: 3 }],
  ])('rejects read limits with %s (G05)', (_name, sourceLedgerReadLimits) => {
    expect(videoPresentationResponseSchema.safeParse({ sourceBinding: binding, presentation: null, ...idle, sourceLedger: null, sourceLedgerReadLimits: limits }).success).toBe(true);
    expect(videoPresentationResponseSchema.safeParse({ sourceBinding: binding, presentation: null, ...idle, sourceLedger: null, sourceLedgerReadLimits }).success).toBe(false);
  });

  it.each([
    ['null', null],
    ['pending', { state: 'pending', ...identity }],
    ['failed', { state: 'failed', ...identity, errorCode: 'ledger_invalid' }],
  ])('parses a %s ledger with complete limits (G06)', (_state, sourceLedger) => {
    const response = { sourceBinding: binding, presentation: null, ...idle, sourceLedger, sourceLedgerReadLimits: limits };
    expect(videoPresentationResponseSchema.parse(response)).toEqual(response);
  });
});
