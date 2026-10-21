// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether the cut band draws an audio source's waveform (inner#1305 §4.4):
 * only for a source whose length and size are known and within both
 * ceilings, which the server serves; every other case is a plain band.
 */

import { describe, expect, it } from 'vitest';

import { waveformDrawable } from '@web/spaces/canvas/mini-tool/audio-waveform';

const LIMITS = { maxSeconds: 3600, maxBytes: 200_000_000 };
const SOURCE = { url: 'https://cdn/a.m4a', duration: 600, sizeBytes: 10_000_000 };

describe('waveformDrawable', () => {
  it('draws a source within both ceilings', () => {
    expect(waveformDrawable(SOURCE, LIMITS)).toBe(true);
    expect(waveformDrawable({ ...SOURCE, duration: 3600, sizeBytes: 200_000_000 }, LIMITS)).toBe(true);
  });

  it('leaves the band plain past either ceiling', () => {
    expect(waveformDrawable({ ...SOURCE, duration: 3601 }, LIMITS)).toBe(false);
    expect(waveformDrawable({ ...SOURCE, sizeBytes: 200_000_001 }, LIMITS)).toBe(false);
  });

  it('leaves the band plain when the size, the address or the ceilings are not known', () => {
    expect(waveformDrawable({ ...SOURCE, sizeBytes: undefined }, LIMITS)).toBe(false);
    expect(waveformDrawable({ ...SOURCE, url: undefined }, LIMITS)).toBe(false);
    expect(waveformDrawable(SOURCE, null)).toBe(false);
  });
});
