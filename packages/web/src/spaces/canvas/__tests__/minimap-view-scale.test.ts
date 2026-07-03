// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { minimapViewScale } from '@web/spaces/canvas/minimap-view-scale';

describe('minimapViewScale — flow-units-per-minimap-pixel, mirroring the library formula (#1548)', () => {
  it('with no nodes, scales the viewport box alone (2000px-wide flow at zoom 1 on a 200px map → 10)', () => {
    expect(
      minimapViewScale({
        tx: 0,
        ty: 0,
        zoom: 1,
        flowWidth: 2000,
        flowHeight: 1000,
        nodesBounds: null,
      }),
    ).toBe(10);
  });

  it('unions the nodes bounds with the viewport box (nodes stretching past the view widen the scale)', () => {
    expect(
      minimapViewScale({
        tx: 0,
        ty: 0,
        zoom: 1,
        flowWidth: 1000,
        flowHeight: 750,
        // Nodes reach x=3000 while the view covers 0..1000 → union width 3000.
        nodesBounds: { x: 0, y: 0, width: 3000, height: 100 },
      }),
    ).toBe(15);
  });

  it('zooming IN shrinks the viewport box and (bounded by nodes) the scale follows the union', () => {
    const zoomedIn = minimapViewScale({
      tx: 0,
      ty: 0,
      zoom: 4,
      flowWidth: 1000,
      flowHeight: 750,
      nodesBounds: { x: 0, y: 0, width: 400, height: 300 },
    });
    // view 250×187.5 ∪ nodes 400×300 → 400/200 = 2
    expect(zoomedIn).toBe(2);
  });

  it('degenerate inputs (zero-size flow, not-yet-measured) fall back to 1 instead of 0/NaN', () => {
    expect(
      minimapViewScale({
        tx: 0,
        ty: 0,
        zoom: 1,
        flowWidth: 0,
        flowHeight: 0,
        nodesBounds: null,
      }),
    ).toBe(1);
  });
});
