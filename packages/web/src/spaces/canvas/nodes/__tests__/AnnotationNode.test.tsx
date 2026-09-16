// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import userEvent from '@testing-library/user-event';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
import { PIN_SCREEN_SIZE } from '@web/spaces/canvas/annotation/pin-geometry';
import { useCanvasStore } from '@web/stores/canvas';

const NAMES = new Map([
  ['u-me', { id: 'u-me', name: 'Mika', email: '', avatarUrl: 'mika.png' }],
]);

/**
 * A note, with whatever the case needs changed.
 * @param over - Fields to override.
 * @returns The node view the component renders.
 */
const note = (over: Partial<AnnotationNodeView> = {}): AnnotationNodeView => ({
  kind: 'annotation',
  content: 'a cooler shot here',
  createdBy: 'u-me',
  createdAt: 1_757_000_000_000,
  replies: [],
  ...over,
});

/**
 * Put xyflow's own viewport at a zoom, the way a wheel or a pinch does.
 * @param root0 - Component props.
 * @param root0.to - The zoom to hold.
 * @returns Nothing; it only writes to the flow store.
 */
function AtZoom({ to }: { to: number }): null {
  const store = useStoreApi();
  React.useEffect(() => {
    store.setState({ transform: [0, 0, to] });
  }, [store, to]);
  return null;
}

/**
 * Mount one note on the board.
 * @param data - The note to draw.
 * @param zoom - The zoom xyflow's viewport holds.
 * @returns The render result.
 */
function mount(
  data: AnnotationNodeView = note(),
  zoom = 1,
): ReturnType<typeof render> {
  return render(
    // The pin reads the live zoom off xyflow's own transform, which is what a
    // node has around it on a real canvas.
    <ReactFlowProvider>
      <AtZoom to={zoom} />
      <AnnotationNamesContext.Provider value={NAMES}>
        <NodeIdContext.Provider value='n1'>
          <AnnotationNode data={data} />
        </NodeIdContext.Provider>
      </AnnotationNamesContext.Provider>
    </ReactFlowProvider>,
  );
}

describe('what an annotation is on the canvas', () => {
  beforeEach(() => {
    useCanvasStore.getState().reset();
  });

  it('is a pin, and the sticky is not on the board with it', () => {
    // Being the pin is what gives a note dragging, selection, marquee and
    // Delete: they are the canvas's own, and a 200px sticky covered in
    // `nodrag` was the one thing on the board that could not be moved.
    mount();
    expect(screen.getByTestId('annotation-pin')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-sticky')).toBeNull();
  });

  it('sizes its box off xyflow live transform, not the canvas store mirror', () => {
    // The mirror is written by an effect, so during a continuous pinch or
    // wheel zoom it is a frame behind — and the box it sizes is the only
    // thing xyflow measures, so a stale one puts the pin at the wrong size
    // and the wrong place. Here the two disagree on purpose.
    useCanvasStore.getState().setZoom(1);
    mount(note(), 4);
    const pin = screen.getByTestId('annotation-pin');
    expect(pin.style.width).toBe(`${PIN_SCREEN_SIZE / 4}px`);
    expect(pin.style.height).toBe(`${PIN_SCREEN_SIZE / 4}px`);
  });

  it('carries the author it will keep wearing, and what has been said', () => {
    mount(
      note({
        replies: [
          { id: 'r1', content: 'ok', createdBy: 'u-me', createdAt: 1 },
          { id: 'r2', content: 'on it', createdBy: 'u-me', createdAt: 2 },
        ],
      }),
    );
    expect(screen.getByTestId('annotation-pin-count')).toHaveTextContent('2');
    expect(screen.getByTestId('annotation-pin-avatar')).toBeInTheDocument();
  });

  it('opens its sticky into the one exclusive panel slot', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId('annotation-pin'));
    const s = useCanvasStore.getState();
    expect(s.panelHostId).toBe('n1');
    expect(s.panelKind).toBe('annotation');
  });

  it('closes it again when pressed a second time', async () => {
    const user = userEvent.setup();
    mount();
    const pin = screen.getByTestId('annotation-pin');
    await user.click(pin);
    await user.click(pin);
    expect(useCanvasStore.getState().panelKind).toBeNull();
  });
});
