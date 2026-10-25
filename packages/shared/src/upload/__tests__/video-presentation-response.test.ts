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
