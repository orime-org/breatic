// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Hiding a canvas resets ReactFlow's own store — the camera to the origin and
 * the selection box off (inner#1235 §5.2). What the reader left is taken just
 * before that reset and put back when the canvas is shown.
 */

import { describe, it, expect, vi } from 'vitest';

import { restoreFlow, snapshotFlow } from '@web/spaces/canvas/flow-snapshot';

describe('flow snapshot', () => {
  it('takes the camera and the selection box from the live store', () => {
    const snapshot = snapshotFlow({
      transform: [-120, 40, 1.5],
      nodesSelectionActive: true,
    });

    expect(snapshot).toEqual({
      viewport: { x: -120, y: 40, zoom: 1.5 },
      nodesSelectionActive: true,
    });
  });

  it('puts both back at once, with no animation', () => {
    const setViewport = vi.fn();
    const setState = vi.fn();

    restoreFlow(
      { setViewport, setState },
      { viewport: { x: -120, y: 40, zoom: 1.5 }, nodesSelectionActive: true },
    );

    expect(setViewport).toHaveBeenCalledWith(
      { x: -120, y: 40, zoom: 1.5 },
      { duration: 0 },
    );
    expect(setState).toHaveBeenCalledWith({ nodesSelectionActive: true });
  });
});
