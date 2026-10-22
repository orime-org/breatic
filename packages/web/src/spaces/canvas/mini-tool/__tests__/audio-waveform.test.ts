// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the cut band may decode an audio source in the browser while it has
 * no peaks file (inner#1305 §4.4): only for a source whose length and size are
 * known and within both ceilings, which the server serves; otherwise not.
 */

import { describe, expect, it } from 'vitest';

import { waveformDecodable } from '@web/spaces/canvas/mini-tool/audio-waveform';

const LIMITS = { maxSeconds: 3600, maxBytes: 200_000_000 };
const SOURCE = { url: 'https://cdn/a.m4a', duration: 600, sizeBytes: 10_000_000 };

describe('waveformDecodable', () => {
  it('decodes a source within both ceilings', () => {
    expect(waveformDecodable(SOURCE, LIMITS)).toBe(true);
    expect(waveformDecodable({ ...SOURCE, duration: 3600, sizeBytes: 200_000_000 }, LIMITS)).toBe(true);
  });

  it('decodes nothing past either ceiling', () => {
    expect(waveformDecodable({ ...SOURCE, duration: 3601 }, LIMITS)).toBe(false);
    expect(waveformDecodable({ ...SOURCE, sizeBytes: 200_000_001 }, LIMITS)).toBe(false);
  });

  it('decodes nothing when the size, the address or the ceilings are not known', () => {
    expect(waveformDecodable({ ...SOURCE, sizeBytes: undefined }, LIMITS)).toBe(false);
    expect(waveformDecodable({ ...SOURCE, url: undefined }, LIMITS)).toBe(false);
    expect(waveformDecodable(SOURCE, null)).toBe(false);
  });
});
