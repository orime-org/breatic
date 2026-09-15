// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AnnotationNodeView } from '@web/data/yjs/node-view';
import { AnnotationNamesContext } from '@web/spaces/canvas/annotation/names';
import { AnnotationNode } from '@web/spaces/canvas/nodes/AnnotationNode';
import { NodeIdContext } from '@web/spaces/canvas/nodes/_shared/node-id-context';
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
 * Mount one note on the board.
 * @param data - The note to draw.
 * @returns The render result.
 */
function mount(data: AnnotationNodeView = note()): ReturnType<typeof render> {
  return render(
    <AnnotationNamesContext.Provider value={NAMES}>
      <NodeIdContext.Provider value='n1'>
        <AnnotationNode data={data} />
      </NodeIdContext.Provider>
    </AnnotationNamesContext.Provider>,
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
