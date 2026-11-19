// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { trackedBox } from '../video/tracked-box';

// Execution design §10.3 overlay paragraph: after tracking, the selection box follows the object, as the foreground's
// bounding box of the RLE frame for the presented frame (presented ordinal − range start ordinal); outside the range there
// is none. The masks are the COCO decoder's golden counts (shared coco-rle tests): "213" on 2x3 decodes to foreground only
// at row 0, column 1; "6" has none.
const SIZE = { width: 3, height: 2 };
const ONE = { size: [2, 3] as [number, number], counts: '213' };
const NONE = { size: [2, 3] as [number, number], counts: '6' };

describe('trackedBox (execution design §10.3)', () => {
  it('TB01 is the normalized bounding box of the presented frame\'s foreground', () => {
    expect(trackedBox([NONE, ONE], { startFrame: 10, frameCount: 2 }, 11, SIZE)).toEqual({ x: 1 / 3, y: 0, width: 1 / 3, height: 1 / 2 });
  });

  it('TB02 is null on a frame without foreground, without a mask, or outside the range', () => {
    expect(trackedBox([NONE, ONE], { startFrame: 10, frameCount: 2 }, 10, SIZE)).toBeNull();
    expect(trackedBox([null, ONE], { startFrame: 10, frameCount: 2 }, 10, SIZE)).toBeNull();
    expect(trackedBox([NONE, ONE], { startFrame: 10, frameCount: 2 }, 12, SIZE)).toBeNull();
    expect(trackedBox([NONE, ONE], { startFrame: 10, frameCount: 2 }, 9, SIZE)).toBeNull();
  });
});
