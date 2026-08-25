// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { CollaboratorNamesProvider } from '@web/features/collab-editor/collaborator-names-context';
import type { CollaboratorNames } from '@web/features/collab-editor/use-collaborator-names';
import { CanvasCursorLayer, CanvasCursors } from '@web/spaces/canvas/CanvasCursors';
import type { RemotePointer } from '@web/spaces/canvas/canvas-pointers';

// The portal renders into the canvas viewport, which no unit test has; render
// children in place instead so the cursors can be inspected. `useStore` is the
// zoom the counter-scale reads.
vi.mock('@xyflow/react', () => ({
  ViewportPortal: ({ children }: { children: React.ReactNode }) => children,
  useStore: (select: (state: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
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

  it('picks up a name that lands after the pointer did', () => {
    // Same reason as the node tag row: the roster arrives from a query, and a
    // resolver whose reference never changes would freeze these names at the
    // empty roster the first frame saw.
    const pointers = [ALICE];
    const { rerender } = render(
      <CollaboratorNamesProvider value={roster({})}>
        <CanvasCursors pointers={pointers} zoom={1} />
      </CollaboratorNamesProvider>,
    );
    expect(screen.queryByTestId('canvas-cursors')).not.toBeInTheDocument();

    rerender(
      <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
        <CanvasCursors pointers={pointers} zoom={1} />
      </CollaboratorNamesProvider>,
    );

    expect(screen.getByText('Alice')).toBeInTheDocument();
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

describe('CanvasCursorLayer', () => {
  const open: Array<{ doc: Y.Doc; awareness: Awareness }> = [];

  afterEach(() => {
    // Unmount before tearing the awareness down. Destroying it drops every
    // remote state and announces that, which a layer still on screen would
    // hear — the order a real space closes in, and the one that keeps the
    // teardown out of the component's render path.
    cleanup();
    for (const { doc, awareness } of open.splice(0)) {
      awareness.destroy();
      doc.destroy();
    }
  });

  /**
   * Build a real awareness, plus a second one standing in for a peer.
   * @returns This client's awareness and the peer's client id.
   */
  function makeAwareness(): { awareness: Awareness; peerId: number } {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    open.push({ doc, awareness });
    // A peer is any client id that is not this one.
    return { awareness, peerId: awareness.clientID + 1 };
  }

  /**
   * Put a peer's pointer into the awareness table the way an update does.
   * @param awareness - The awareness to write into.
   * @param clientId - The peer's client id.
   * @param at - Where the peer is pointing, in canvas coordinates.
   */
  function peerPointsAt(
    awareness: Awareness,
    clientId: number,
    at: { x: number; y: number },
  ): void {
    act(() => {
      awareness.states.set(clientId, {
        user: { id: 'u1' },
        pointer: at,
      });
      awareness.emit('change', [
        { added: [], updated: [clientId], removed: [] },
        'remote',
      ]);
    });
  }

  it('holds still while a peer publishes anything other than a pointer', () => {
    // One awareness carries both fields, and the writer republishes the whole
    // state at up to 30fps. A peer rubber-band selecting sends a stream of
    // holding updates with the pointer untouched, and this client's own writes
    // raise `change` here too — none of that may reach the arrows.
    const { awareness, peerId } = makeAwareness();
    let renders = 0;
    act(() => {
      awareness.states.set(peerId, { user: { id: 'u1' }, pointer: { x: 5, y: 6 } });
      render(
        <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
          <React.Profiler id='cursors' onRender={() => { renders += 1; }}>
            <CanvasCursorLayer awareness={awareness} />
          </React.Profiler>
        </CollaboratorNamesProvider>,
      );
    });
    /**
     * Publish a round of holding updates with the pointer standing still.
     * @param count - How many updates to send.
     */
    const holdingUpdates = (count: number): void => {
      act(() => {
        for (let i = 0; i < count; i += 1) {
          awareness.states.set(peerId, {
            user: { id: 'u1' },
            pointer: { x: 5, y: 6 },
            activeNodeIds: [`n${i}`],
          });
          awareness.emit('change', [
            { added: [], updated: [peerId], removed: [] },
            'remote',
          ]);
        }
      });
    };

    // Counted across two rounds of different sizes: React may still render once
    // on its way to bailing out, so what matters is that the count stops
    // growing with the traffic rather than that it never moves at all.
    holdingUpdates(10);
    const afterFirstRound = renders;
    holdingUpdates(30);

    expect(renders).toBe(afterFirstRound);
  });

  it('draws a pointer that was already there when it mounted', () => {
    const { awareness, peerId } = makeAwareness();
    awareness.states.set(peerId, { user: { id: 'u1' }, pointer: { x: 5, y: 6 } });

    act(() => {
      render(
        <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
          <CanvasCursorLayer awareness={awareness} />
        </CollaboratorNamesProvider>,
      );
    });

    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('follows a pointer that moves after it mounted', () => {
    // The subscription is the whole point of this component: without it the
    // cursors freeze at whatever the table held on the first render, and every
    // assertion that only checks a pointer already in place still passes.
    const { awareness, peerId } = makeAwareness();

    act(() => {
      render(
        <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
          <CanvasCursorLayer awareness={awareness} />
        </CollaboratorNamesProvider>,
      );
    });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();

    peerPointsAt(awareness, peerId, { x: 10, y: 20 });
    expect(screen.getByTestId(`canvas-cursor-${peerId}`).style.transform).toContain(
      'translate(10px, 20px)',
    );

    peerPointsAt(awareness, peerId, { x: 30, y: 40 });
    expect(screen.getByTestId(`canvas-cursor-${peerId}`).style.transform).toContain(
      'translate(30px, 40px)',
    );
  });

  it('stops following once it unmounts', () => {
    // Asserted through the awareness rather than the screen: React 18 neither
    // throws nor warns on a setState after unmount, so a layer that kept its
    // listener would look exactly like one that let go — while really holding
    // the space's provider alive for as long as anything referenced it.
    const { awareness, peerId } = makeAwareness();
    const on = vi.spyOn(awareness, 'on');
    const off = vi.spyOn(awareness, 'off');
    const rendered = render(
      <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
        <CanvasCursorLayer awareness={awareness} />
      </CollaboratorNamesProvider>,
    );
    peerPointsAt(awareness, peerId, { x: 10, y: 20 });
    const subscribed = on.mock.calls.find(([event]) => event === 'change')?.[1];
    expect(subscribed).toBeTypeOf('function');

    rendered.unmount();

    // The listener it subscribed, not merely some function: `off` with a
    // different callback removes nothing, and an assertion that takes any
    // function cannot tell the two apart.
    expect(off).toHaveBeenCalledWith('change', subscribed);
  });

  it('draws nothing before the document attaches', () => {
    render(
      <CollaboratorNamesProvider value={roster({ u1: 'Alice' })}>
        <CanvasCursorLayer awareness={null} />
      </CollaboratorNamesProvider>,
    );

    expect(screen.queryByTestId('canvas-cursors')).not.toBeInTheDocument();
  });
});
