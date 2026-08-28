// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The four readings the canvas has of its own render buffer (#2010).
 *
 * The buffer lives inside this hook, so reading it means naming one of these.
 * What each case pins is the difference between them: three of them are what a
 * document write may read, and `onScreen` is the one that still carries a
 * collaborator's in-flight coordinates, because publishing those is its job.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import type { DocumentPlace } from '@web/spaces/canvas/doc-geometry-view';
import type { GestureTable } from '@web/spaces/canvas/gesture-table';
import { useBufferAccess } from '@web/spaces/canvas/use-buffer-access';

const FLYING_ID = 'flying';
const STILL_ID = 'still';

/** Where the document has the node a remote is dragging. */
const DOC_AT = { x: 10, y: 20 };
/** Where that remote's gesture is currently showing it. */
const FLYING_AT = { x: 900, y: 900 };

/**
 * Build a node.
 * @param id - Its id.
 * @param at - Where to put it.
 * @param extra - Anything else to put on it.
 * @returns The node.
 */
function node(
  id: string,
  at: { x: number; y: number },
  extra: Partial<Node> = {},
): Node {
  return {
    id,
    type: 'image',
    position: { ...at },
    data: {},
    measured: { width: 100, height: 100 },
    ...extra,
  };
}

/** The buffer as it stands while a remote drags one of the two nodes. */
const BUFFER: Node[] = [node(FLYING_ID, FLYING_AT), node(STILL_ID, { x: 0, y: 0 })];

/** The same nodes as the document has them. */
const DOCUMENT: DocumentPlace[] = [
  node(FLYING_ID, DOC_AT),
  node(STILL_ID, { x: 0, y: 0 }),
];

/** The remote is moving one node. */
const REMOTE: GestureTable = new Map([
  [FLYING_ID, { ...FLYING_AT, root: FLYING_ID }],
]);

/**
 * Mount the hook over the fixtures above.
 * @returns The readings.
 */
function access(): ReturnType<typeof useBufferAccess> {
  const { result } = renderHook(() => useBufferAccess(BUFFER, DOCUMENT, REMOTE));
  return result.current;
}

describe('useBufferAccess', () => {
  it('settles a remote gesture back to where the document has it', () => {
    const seen = access().settled().find((n) => n.id === FLYING_ID);
    expect(seen?.position).toEqual(DOC_AT);
  });

  it('leaves a node no remote is touching alone', () => {
    const seen = access().settled().find((n) => n.id === STILL_ID);
    expect(seen?.position).toEqual({ x: 0, y: 0 });
  });

  it('leaves a node a remote holds out of the landing candidates', () => {
    expect(access().landing().map((n) => n.id)).toEqual([STILL_ID]);
  });

  it('hands back the document untouched by any gesture', () => {
    // A resize computes member positions from this one, so it must never carry
    // a gesture's geometry the way `settled` and `onScreen` do.
    expect(access().documentPlaces()).toBe(DOCUMENT);
    const flying = access().documentPlaces().find((n) => n.id === FLYING_ID);
    expect(flying?.position).toEqual(DOC_AT);
  });

  it('names the ids remote gestures are holding', () => {
    expect([...access().heldByRemote()]).toEqual([FLYING_ID]);
  });

  it('keeps in-flight coordinates on the reading meant for the wire', () => {
    // The gesture field publishes what the canvas is drawing, so this one is
    // the whole point of being separate from `settled`.
    const seen = access().onScreen().find((n) => n.id === FLYING_ID);
    expect(seen?.position).toEqual(FLYING_AT);
  });

  it('reads the buffer it was handed most recently', () => {
    // Every reading goes through refs the layout effect writes, so a case that
    // only ever mounts once would pass with no effect at all — and production
    // needs the frames after the first one.
    const { result, rerender } = renderHook(
      ({ nodes, doc, gesture }: {
        nodes: Node[];
        doc: DocumentPlace[];
        gesture: GestureTable;
      }) => useBufferAccess(nodes, doc, gesture),
      { initialProps: { nodes: BUFFER, doc: DOCUMENT, gesture: new Map() } },
    );
    rerender({
      nodes: [node(STILL_ID, { x: 7, y: 7 })],
      doc: [node(STILL_ID, { x: 3, y: 3 })],
      gesture: new Map([[STILL_ID, { x: 7, y: 7 }]]),
    });
    // One assertion per ref: the buffer, the gesture table that decides which
    // nodes get replaced, and the document the replacement reads from.
    expect(result.current.onScreen().map((n) => n.id)).toEqual([STILL_ID]);
    expect([...result.current.heldByRemote()]).toEqual([STILL_ID]);
    expect(result.current.settled()[0]?.position).toEqual({ x: 3, y: 3 });
  });

  it('hands back one object for the life of the canvas', () => {
    const { result, rerender } = renderHook(() =>
      useBufferAccess(BUFFER, DOCUMENT, REMOTE),
    );
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useBufferAccess when an entry no longer speaks for its node', () => {
  it('leaves a node the document has taken out of the named Group unheld', () => {
    // A remote holds Group g1 and its batch lists m1 as of the press. This end
    // has since dragged m1 clear, so the entry is about a Group m1 is no longer
    // in: it holds nothing, and every path that asks "is a remote on this node"
    // has to say no.
    const buffer: Node[] = [
      node('g1', { x: 100, y: 0 }, { type: 'group' }),
      node('m1', { x: 900, y: 900 }),
    ];
    const doc: DocumentPlace[] = [
      node('g1', { x: 0, y: 0 }, { type: 'group' }),
      node('m1', { x: 900, y: 900 }),
    ];
    const gestures: GestureTable = new Map([
      ['g1', { x: 100, y: 0, root: 'g1' }],
      ['m1', { x: 124, y: 24, root: 'g1' }],
    ]);
    const { result } = renderHook(() => useBufferAccess(buffer, doc, gestures));
    expect([...result.current.heldByRemote()]).toEqual(['g1']);
  });

  it('holds a member the document still has in that Group', () => {
    const buffer: Node[] = [
      node('g1', { x: 100, y: 0 }, { type: 'group' }),
      node('m1', { x: 24, y: 24 }, { parentId: 'g1' }),
    ];
    const doc: DocumentPlace[] = [
      node('g1', { x: 0, y: 0 }, { type: 'group' }),
      node('m1', { x: 24, y: 24 }, { parentId: 'g1' }),
    ];
    const gestures: GestureTable = new Map([
      ['g1', { x: 100, y: 0, root: 'g1' }],
      ['m1', { x: 124, y: 24, root: 'g1' }],
    ]);
    const { result } = renderHook(() => useBufferAccess(buffer, doc, gestures));
    expect([...result.current.heldByRemote()].sort()).toEqual(['g1', 'm1']);
  });
});

describe('useBufferAccess telling a remote resize from a remote drag', () => {
  it('names only the Groups a remote is resizing', () => {
    // Only a resize publishes a size, so that is what separates the two.
    const buffer: Node[] = [
      node('g1', { x: 0, y: 0 }, { type: 'group' }),
      node('g2', { x: 0, y: 0 }, { type: 'group' }),
    ];
    const gestures: GestureTable = new Map([
      ['g1', { x: 0, y: 0, width: 400, height: 300, root: 'g1' }],
      ['g2', { x: 50, y: 0, root: 'g2' }],
    ]);
    const { result } = renderHook(() => useBufferAccess(buffer, buffer, gestures));
    expect([...result.current.resizedByRemote()]).toEqual(['g1']);
  });
});
