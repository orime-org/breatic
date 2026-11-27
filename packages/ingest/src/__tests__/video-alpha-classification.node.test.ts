// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';
import { classifyVideoAlpha } from '../video-alpha-classification.js';
import oracle from './fixtures/video-alpha-classification.json';

describe('independent pinned-FFmpeg alpha classification oracle (inner#1306)', () => {
  it.each(oracle.cases)('$name resolves to $expected from trusted facts', ({ probe, expected }) => {
    expect(classifyVideoAlpha(probe, oracle.pixelFormats)).toBe(expected);
  });
});
