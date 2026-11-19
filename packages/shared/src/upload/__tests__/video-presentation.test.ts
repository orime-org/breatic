// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { videoPresentationKeyFor } from '../video-presentation.js';

// The earlier descriptor and alpha manifest were removed with their parser; the packed geometry they checked is covered
// on `alphaPackedManifestSchema` (video-presentation-version.test.ts M03–M05).
const key = 'video/fixture/original.webm';

describe('owned video presentation descriptor', () => {
  it('derives the descriptor pointer from the canonical registered key', () => {
    expect(videoPresentationKeyFor(key)).toBe('video/fixture/original.webm.video-presentation.v1.json');
  });
});
