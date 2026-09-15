// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import {
  PIN_ORIGIN,
  PIN_SCREEN_SIZE,
  pinFlowSize,
} from '@web/spaces/canvas/annotation/pin-geometry';

/** Every zoom the canvas allows, from `minZoom` to the top of the range. */
const ZOOMS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4];

describe('the pin a collapsed annotation is', () => {
  it('holds 28 screen pixels at every zoom the canvas allows', () => {
    // The reader zooms out to find which notes still need answering, so a pin
    // that shrinks with the board makes that whole move pointless (user
    // 2026-09-15). Delivered by the box rather than by a transform: xyflow
    // measures a node with `offsetWidth` (@xyflow/system@0.0.79:854), which a
    // CSS transform is invisible to — so the drawn pin and the rect xyflow
    // remembers would be two rects that do not overlap.
    for (const zoom of ZOOMS) {
      expect(pinFlowSize(zoom) * zoom).toBeCloseTo(PIN_SCREEN_SIZE, 10);
    }
  });

  it('stays above the repo minimum click target', () => {
    // 24px, the floor #2020 / #2021 are both judged against.
    expect(PIN_SCREEN_SIZE).toBeGreaterThanOrEqual(24);
  });

  it('answers a zoom of zero without dividing by it', () => {
    expect(Number.isFinite(pinFlowSize(0))).toBe(true);
    expect(pinFlowSize(0)).toBe(PIN_SCREEN_SIZE);
  });

  it('puts the node coordinate on the tail tip, bottom left', () => {
    // xyflow's own per-node origin (`@xyflow/system:274` and `:463` both read
    // `node.origin ?? nodeOrigin`), so `getNodePositionWithOrigin` folds it
    // into `positionAbsolute` — marquee selection, group geometry and the
    // sticky's anchor all read the same point the eye sees.
    expect(PIN_ORIGIN).toEqual([0, 1]);
  });
});
