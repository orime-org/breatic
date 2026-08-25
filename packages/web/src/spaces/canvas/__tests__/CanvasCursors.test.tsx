// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import { CanvasCursors } from '@web/spaces/canvas/CanvasCursors';
import type { RemotePointer } from '@web/spaces/canvas/canvas-pointers';

// The portal renders into the canvas viewport, which no unit test has; render
// children in place instead so the cursors can be inspected.
vi.mock('@xyflow/react', () => ({
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
}));

/**
 * Build a roster that answers from a plain map.
 * @param names - User id to display name; a missing id resolves to null,
 * which is what `resolveNameFrom` answers for someone it cannot name.
 * @returns The roster bundle the provider publishes.
 */
function roster(names: Record<string, string>): CollaboratorNames {
  return { resolve: (userId: string) => names[userId] ?? null, members: [] };
}

/**
 * Render the cursor layer inside a roster.
 * @param pointers - Where the peers are.
 * @param names - The roster to resolve them against.
 * @param zoom - The canvas zoom the counter-scale works from.
 */
function renderCursors(
  pointers: RemotePointer[],
  names: Record<string, string>,
  zoom = 1,
): void {
  render(
    <CollaboratorNamesProvider value={roster(names)}>
      <CanvasCursors pointers={pointers} zoom={zoom} />
    </CollaboratorNamesProvider>,
  );
}

const ALICE: RemotePointer = { clientId: 2, userId: 'u1', x: 120, y: 60 };

describe('CanvasCursors', () => {
  it('puts an arrow at the canvas position with the name beside it', () => {
    renderCursors([ALICE], { u1: 'Alice' });

    const cursor = screen.getByTestId('canvas-cursor-2');
    expect(cursor.style.transform).toContain('translate(120px, 60px)');
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('draws one cursor per connection', () => {
    // Two tabs of the same account are two pointers in two places.
    renderCursors(
      [ALICE, { clientId: 3, userId: 'u1', x: 400, y: 400 }],
      { u1: 'Alice' },
    );

    expect(screen.getByTestId('canvas-cursor-2')).toBeInTheDocument();
    expect(screen.getByTestId('canvas-cursor-3')).toBeInTheDocument();
  });

  it('leaves out a peer the roster cannot name', () => {
    renderCursors([ALICE, { clientId: 3, userId: 'ghost', x: 1, y: 1 }], { u1: 'Alice' });

    expect(screen.getByTestId('canvas-cursor-2')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas-cursor-3')).not.toBeInTheDocument();
  });

  it('renders nothing when nobody else is on the canvas', () => {
    renderCursors([], { u1: 'Alice' });

    expect(screen.queryByTestId('canvas-cursors')).not.toBeInTheDocument();
  });

  it('counter-scales so the arrow keeps its screen size', () => {
    renderCursors([ALICE], { u1: 'Alice' }, 0.5);

    // At 50% zoom the layer scales by 2 to come back to screen size.
    expect(screen.getByTestId('canvas-cursor-2').style.transform).toContain('scale(2)');
  });

  it('sits above the nodes that carry a positive z-index', () => {
    // A selected node is at 1000 and a focus crop target at 1002; the portal's
    // own div has no z-index, so without one here the arrow hides behind them.
    renderCursors([ALICE], { u1: 'Alice' });

    expect(screen.getByTestId('canvas-cursors')).toHaveStyle({ zIndex: '1100' });
  });

  it('takes no pointer events', () => {
    renderCursors([ALICE], { u1: 'Alice' });

    expect(screen.getByTestId('canvas-cursors').className).toContain('pointer-events-none');
  });
});
