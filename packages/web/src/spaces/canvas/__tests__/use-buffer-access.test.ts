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
const REMOTE: GestureTable = new Map([[FLYING_ID, { ...FLYING_AT }]]);

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

  it('names the ids remote gestures are holding', () => {
    expect([...access().heldByRemote()]).toEqual([FLYING_ID]);
  });

  it('keeps in-flight coordinates on the reading meant for the wire', () => {
    // The gesture field publishes what the canvas is drawing, so this one is
    // the whole point of being separate from `settled`.
    const seen = access().onScreen().find((n) => n.id === FLYING_ID);
    expect(seen?.position).toEqual(FLYING_AT);
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
