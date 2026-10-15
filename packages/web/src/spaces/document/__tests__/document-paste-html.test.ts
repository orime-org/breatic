// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a `srcset` the way HTML does (inner#1351 design §5.4). The expected
 * candidates are what `srcset` 5.0.3 and `parse-srcset` 1.0.2 both read from
 * the same attributes.
 */

import { describe, it, expect } from 'vitest';

import { srcsetCandidates } from '@web/spaces/document/document-paste-html';

describe('srcset candidates', () => {
  it.each([
    [
      'https://e/a.png 1x,https://e/b.png 2x',
      [{ url: 'https://e/a.png', density: 1 }, { url: 'https://e/b.png', density: 2 }],
    ],
    [
      'https://e/a.png 1x,https://e/m.png 2x,https://e/b.png 3x',
      [
        { url: 'https://e/a.png', density: 1 },
        { url: 'https://e/m.png', density: 2 },
        { url: 'https://e/b.png', density: 3 },
      ],
    ],
    [
      'https://e/s.png 320w, https://e/b.png 1280w, https://e/m.png 640w',
      [
        { url: 'https://e/s.png', width: 320 },
        { url: 'https://e/b.png', width: 1280 },
        { url: 'https://e/m.png', width: 640 },
      ],
    ],
    [
      'https://e/a.png, https://e/b.png 2x, https://e/c.png',
      [{ url: 'https://e/a.png' }, { url: 'https://e/b.png', density: 2 }, { url: 'https://e/c.png' }],
    ],
    [
      'data:image/png;base64,AA,BB 2x, https://e/b.png 1x',
      [{ url: 'data:image/png;base64,AA,BB', density: 2 }, { url: 'https://e/b.png', density: 1 }],
    ],
    ['https://e/a.png 1.5x, https://e/b.png 2x', [{ url: 'https://e/a.png', density: 1.5 }, { url: 'https://e/b.png', density: 2 }]],
    [' , https://e/a.png 1x,, ', [{ url: 'https://e/a.png', density: 1 }]],
    ['https://e/a.png', [{ url: 'https://e/a.png' }]],
  ])('reads %s', (srcset, expected) => {
    expect(srcsetCandidates(srcset)).toEqual(expected);
  });

  it('drops a candidate with a descriptor HTML does not take', () => {
    expect(srcsetCandidates('https://e/a.png 1x 2x, https://e/b.png huge, https://e/c.png 2x')).toEqual([
      { url: 'https://e/c.png', density: 2 },
    ]);
  });
});
