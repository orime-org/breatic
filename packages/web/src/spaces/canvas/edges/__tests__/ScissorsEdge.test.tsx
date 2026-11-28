// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { act, render, screen } from '@testing-library/react';
import { Position, ReactFlowProvider, useStoreApi, type EdgeProps } from '@xyflow/react';
import type * as React from 'react';
import { describe, it, expect, vi } from 'vitest';

// The label renderer portals into the canvas's label layer, which only a
// mounted <ReactFlow> draws; inline it so the scissors land in the test tree.
vi.mock('@xyflow/react', async (original) => ({
  ...(await original<object>()),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ScissorsEdge, shouldShowScissors } from '@web/spaces/canvas/edges/ScissorsEdge';

// The scissors button's counter-scale (constant screen size down to a floor
// zoom) is the shared `overlayCounterScale` — covered by overlay-scale.test.ts.

describe('shouldShowScissors (selected and not a read-only viewer)', () => {
  it('shows only when the edge is selected and the canvas is editable', () => {
    expect(shouldShowScissors(true, false)).toBe(true);
  });

  it('hides when the edge is not selected', () => {
    expect(shouldShowScissors(false, false)).toBe(false);
  });

  it('hides for a read-only viewer even when selected', () => {
    expect(shouldShowScissors(true, true)).toBe(false);
  });
});

/** Captures the xyflow store api so a test can drive the marquee flag. */
let storeApi: ReturnType<typeof useStoreApi> | null = null;

/**
 * Grabs the xyflow store api into `storeApi` (rendered inside the provider).
 * @returns Nothing.
 */
function StoreGrabber(): null {
  storeApi = useStoreApi();
  return null;
}

/**
 * Renders a selected, editable edge e1.
 */
function renderSelectedEdge(): void {
  const props = {
    id: 'e1',
    source: 'a',
    target: 'b',
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 0,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    selected: true,
    data: {},
  } as unknown as EdgeProps;
  render(
    <ReactFlowProvider>
      <StoreGrabber />
      <svg>
        <ScissorsEdge {...props} />
      </svg>
    </ReactFlowProvider>,
  );
}

// xyflow selects an edge while a marquee is still being dragged over it; the
// scissors wait for the release, as the selection plus does (inner#2216).
describe('ScissorsEdge while a marquee is held', () => {
  it('shows the scissors on a selected edge once no marquee is being dragged', () => {
    renderSelectedEdge();
    expect(screen.getByTestId('edge-scissors-e1')).toBeInTheDocument();
  });

  it('hides them while the marquee is held and brings them back on release', () => {
    renderSelectedEdge();
    act(() => {
      storeApi?.setState({ userSelectionActive: true });
    });
    expect(screen.queryByTestId('edge-scissors-e1')).toBeNull();
    act(() => {
      storeApi?.setState({ userSelectionActive: false });
    });
    expect(screen.getByTestId('edge-scissors-e1')).toBeInTheDocument();
  });
});
