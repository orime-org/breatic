// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Deciding where every node is drawn (#2010, design §5.5).
 *
 * Every cell of the merge stage's transition table is a case here. The three
 * states are not stored anywhere — they are what the arbitration works out
 * afresh each pass — so each case sets up the inputs that produce the state and
 * checks the geometry that comes out.
 */

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import type { GestureGeometry, GestureTable } from '@web/spaces/canvas/gesture-table';
import type { MergeInput } from '@web/spaces/canvas/merge-canvas-nodes';
import { mergeCanvasNodes } from '@web/spaces/canvas/merge-canvas-nodes';

/** Nothing held, nobody gesturing. */
const QUIET: MergeInput = {
  occupants: new Map(),
  remoteGesture: new Map(),
  localGestureIds: new Set(),
};

/**
 * Build a render-buffer node.
 * @param id - Its id.
 * @param x - Its x.
 * @param y - Its y.
 * @param extra - Anything else to put on it.
 * @returns The node.
 */
function node(id: string, x: number, y: number, extra: Partial<Node> = {}): Node {
  return { id, type: 'image', position: { x, y }, data: {}, ...extra };
}

/**
 * Build a remote gesture table.
 * @param entries - Node id to absolute geometry.
 * @returns The table.
 */
function gesturing(
  ...entries: Array<[string, GestureGeometry]>
): GestureTable {
  return new Map(entries);
}

describe('mergeCanvasNodes, this client gesturing (LOCAL)', () => {
  it('keeps the geometry ReactFlow is giving a node being dragged', () => {
    const prev = [node('n1', 500, 500)];
    const fresh = [node('n1', 0, 0)];
    const [merged] = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      localGestureIds: new Set(['n1']),
    });
    expect(merged?.position).toEqual({ x: 500, y: 500 });
  });

  it('holds a dragged node still when the document changes underneath', () => {
    const prev = [node('n1', 500, 500)];
    const docMoved = [node('n1', 42, 42)];
    const [merged] = mergeCanvasNodes(prev, docMoved, {
      ...QUIET,
      localGestureIds: new Set(['n1']),
    });
    expect(merged?.position).toEqual({ x: 500, y: 500 });
  });

  it('gives up the held geometry when the node changed Group', () => {
    // A member's position is measured against its Group; a top-level node's is
    // absolute. A collaborator ungrouping mid-drag moves this node between
    // those two, and the number ReactFlow is holding was measured in the one it
    // just left — drawing it would put the node somewhere nobody placed it, and
    // the drag stop would then write that.
    const prev = [node('m1', 24, 24, { parentId: 'g1' })];
    const ungrouped = [node('m1', 224, 224)];
    const [merged] = mergeCanvasNodes(prev, ungrouped, {
      ...QUIET,
      localGestureIds: new Set(['m1']),
    });
    expect(merged?.position).toEqual({ x: 224, y: 224 });
  });

  it('holds a dragged node still when a remote reaches for the same node', () => {
    const prev = [node('n1', 500, 500)];
    const fresh = [node('n1', 0, 0)];
    const [merged] = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      localGestureIds: new Set(['n1']),
      remoteGesture: gesturing(['n1', { x: 999, y: 999 }]),
    });
    expect(merged?.position).toEqual({ x: 500, y: 500 });
  });

  it('keeps the size a Group is being resized to', () => {
    const prev = [node('g1', 0, 0, { type: 'group', width: 800, height: 600 })];
    const fresh = [node('g1', 0, 0, { type: 'group', width: 400, height: 300 })];
    const [merged] = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      localGestureIds: new Set(['g1']),
    });
    expect(merged?.width).toBe(800);
    expect(merged?.height).toBe(600);
  });

  it('takes the document geometry once the gesture lets go', () => {
    const prev = [node('n1', 500, 500)];
    const fresh = [node('n1', 500, 500)];
    const [settled] = mergeCanvasNodes(prev, fresh, QUIET);
    expect(settled?.position).toEqual({ x: 500, y: 500 });
    const [moved] = mergeCanvasNodes(prev, [node('n1', 42, 42)], QUIET);
    expect(moved?.position).toEqual({ x: 42, y: 42 });
  });

  it('hands a node still held by a remote over to that remote when the local gesture ends', () => {
    const prev = [node('n1', 500, 500)];
    const fresh = [node('n1', 500, 500)];
    const [merged] = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 700, y: 700 }]),
    });
    expect(merged?.position).toEqual({ x: 700, y: 700 });
  });
});

describe('mergeCanvasNodes, a remote gesturing (REMOTE)', () => {
  it('draws a node at the geometry the remote is showing', () => {
    const [merged] = mergeCanvasNodes([node('n1', 0, 0)], [node('n1', 0, 0)], {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 300, y: 400 }]),
    });
    expect(merged?.position).toEqual({ x: 300, y: 400 });
  });

  it('holds it there when the document changes underneath', () => {
    const [merged] = mergeCanvasNodes([node('n1', 0, 0)], [node('n1', 42, 42)], {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 300, y: 400 }]),
    });
    expect(merged?.position).toEqual({ x: 300, y: 400 });
  });

  it('takes the size a remote is resizing a Group to', () => {
    const fresh = [node('g1', 0, 0, { type: 'group', width: 400, height: 300 })];
    const [merged] = mergeCanvasNodes(fresh, fresh, {
      ...QUIET,
      remoteGesture: gesturing(['g1', { x: 10, y: 20, width: 800, height: 600 }]),
    });
    expect(merged?.position).toEqual({ x: 10, y: 20 });
    expect(merged?.width).toBe(800);
    expect(merged?.height).toBe(600);
  });

  it('returns to the document when the remote gesture ends', () => {
    const held = [node('n1', 300, 400)];
    const [merged] = mergeCanvasNodes(held, [node('n1', 300, 400)], QUIET);
    expect(merged?.position).toEqual({ x: 300, y: 400 });
  });

  it('returns to the document when the remote is evicted', () => {
    const held = [node('n1', 300, 400)];
    const [merged] = mergeCanvasNodes(held, [node('n1', 0, 0)], QUIET);
    expect(merged?.position).toEqual({ x: 0, y: 0 });
  });

  it('leaves a node no gesture names on the document geometry', () => {
    const [merged] = mergeCanvasNodes([node('n1', 0, 0)], [node('n1', 7, 8)], {
      ...QUIET,
      remoteGesture: gesturing(['n2', { x: 300, y: 400 }]),
    });
    expect(merged?.position).toEqual({ x: 7, y: 8 });
  });
});

describe('mergeCanvasNodes, Group member coordinates', () => {
  it('turns an absolute remote position back into one relative to the Group', () => {
    const buffer = [
      node('g1', 100, 200, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const merged = mergeCanvasNodes(buffer, buffer, {
      ...QUIET,
      remoteGesture: gesturing(['m1', { x: 130, y: 250 }]),
    });
    expect(merged[1]?.position).toEqual({ x: 30, y: 50 });
  });

  it('measures from the Group new position when the Group is in the same batch', () => {
    const buffer = [
      node('g1', 100, 200, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const merged = mergeCanvasNodes(buffer, buffer, {
      ...QUIET,
      remoteGesture: gesturing(
        ['g1', { x: 500, y: 600 }],
        ['m1', { x: 530, y: 650 }],
      ),
    });
    expect(merged[0]?.position).toEqual({ x: 500, y: 600 });
    expect(merged[1]?.position).toEqual({ x: 30, y: 50 });
  });

  it('measures from where this client is dragging the Group, not where the document has it', () => {
    // The three places a Group's origin could come from are given three
    // different values, so the case says which one was used.
    const prev = [
      node('g1', 100, 200, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const fresh = [
      node('g1', 700, 800, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      localGestureIds: new Set(['g1']),
      remoteGesture: gesturing(['m1', { x: 130, y: 250 }]),
    });
    // Measured against the local drag's 100,200 — the document's 700,800 would
    // give -570,-550.
    expect(merged[1]?.position).toEqual({ x: 30, y: 50 });
  });

  it('measures from the document when nobody is holding the Group', () => {
    const prev = [
      node('g1', 100, 200, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const fresh = [
      node('g1', 700, 800, { type: 'group', width: 400, height: 300 }),
      node('m1', 0, 0, { parentId: 'g1' }),
    ];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      remoteGesture: gesturing(['m1', { x: 730, y: 850 }]),
    });
    expect(merged[1]?.position).toEqual({ x: 30, y: 50 });
  });

  it('leaves a member alone when its Group has not arrived', () => {
    const buffer = [node('m1', 5, 6, { parentId: 'g1' })];
    const merged = mergeCanvasNodes(buffer, buffer, {
      ...QUIET,
      remoteGesture: gesturing(['m1', { x: 130, y: 250 }]),
    });
    expect(merged[0]?.position).toEqual({ x: 5, y: 6 });
  });
});

describe('mergeCanvasNodes, local-only state', () => {
  it('carries selection and the drag flag across the rebuild', () => {
    const prev = [node('n1', 0, 0, { selected: true, dragging: true })];
    const [merged] = mergeCanvasNodes(prev, [node('n1', 0, 0)], QUIET);
    expect(merged?.selected).toBe(true);
    expect(merged?.dragging).toBe(true);
  });

  it('carries the resize flag across the rebuild', () => {
    const prev = [node('g1', 0, 0, { type: 'group', resizing: true })];
    const [merged] = mergeCanvasNodes(prev, [node('g1', 0, 0, { type: 'group' })], QUIET);
    expect(merged?.resizing).toBe(true);
  });

  it('keeps measured on every node, however it is being drawn', () => {
    const measured = { width: 640, height: 480 };
    const prev = [
      node('quiet', 0, 0, { measured }),
      node('mine', 0, 0, { measured }),
      node('theirs', 0, 0, { measured }),
    ];
    const fresh = [node('quiet', 1, 1), node('mine', 1, 1), node('theirs', 1, 1)];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      localGestureIds: new Set(['mine']),
      remoteGesture: gesturing(['theirs', { x: 9, y: 9 }]),
    });
    expect(merged.map((n) => n.measured)).toEqual([measured, measured, measured]);
  });

  it('leaves a brand-new node as the document gave it', () => {
    const merged = mergeCanvasNodes([], [node('n1', 3, 4)], QUIET);
    expect(merged[0]?.position).toEqual({ x: 3, y: 4 });
    expect(merged[0]?.selected).toBeUndefined();
  });

  it('drops a node the document no longer has', () => {
    const prev = [node('n1', 0, 0), node('n2', 0, 0)];
    const merged = mergeCanvasNodes(prev, [node('n1', 0, 0)], QUIET);
    expect(merged.map((n) => n.id)).toEqual(['n1']);
  });
});

describe('mergeCanvasNodes, occupants', () => {
  it('puts the holders on the node', () => {
    const [merged] = mergeCanvasNodes([node('n1', 0, 0)], [node('n1', 0, 0)], {
      ...QUIET,
      occupants: new Map([['n1', ['alice']]]),
    });
    expect((merged?.data as { occupants?: readonly string[] }).occupants).toEqual(['alice']);
  });

  it('takes them off again when the holder lets go', () => {
    const held = mergeCanvasNodes([node('n1', 0, 0)], [node('n1', 0, 0)], {
      ...QUIET,
      occupants: new Map([['n1', ['alice']]]),
    });
    const [released] = mergeCanvasNodes(held, [node('n1', 0, 0)], QUIET);
    expect((released?.data as { occupants?: readonly string[] }).occupants).toBeUndefined();
  });

  it('leaves a dragged node where it is when the holders change', () => {
    const prev = [node('n1', 500, 500)];
    const [merged] = mergeCanvasNodes(prev, [node('n1', 0, 0)], {
      ...QUIET,
      localGestureIds: new Set(['n1']),
      occupants: new Map([['n1', ['alice']]]),
    });
    expect(merged?.position).toEqual({ x: 500, y: 500 });
    expect((merged?.data as { occupants?: readonly string[] }).occupants).toEqual(['alice']);
  });
});

describe('mergeCanvasNodes, reference stability', () => {
  it('hands back the same array when nothing moved', () => {
    const buffer = [node('n1', 0, 0), node('n2', 5, 5)];
    expect(mergeCanvasNodes(buffer, [node('n1', 0, 0), node('n2', 5, 5)], QUIET)).toBe(
      buffer,
    );
  });

  it('keeps every other node object when one node moves', () => {
    const buffer = [node('n1', 0, 0), node('n2', 5, 5)];
    const merged = mergeCanvasNodes(buffer, [node('n1', 9, 9), node('n2', 5, 5)], QUIET);
    expect(merged[0]).not.toBe(buffer[0]);
    expect(merged[1]).toBe(buffer[1]);
  });

  it('keeps every other node object when one remote gesture moves', () => {
    const buffer = [node('n1', 0, 0), node('n2', 5, 5)];
    const first = mergeCanvasNodes(buffer, buffer, {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 10, y: 10 }]),
    });
    const second = mergeCanvasNodes(first, buffer, {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 11, y: 11 }]),
    });
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('hands back the same array when a remote gesture holds still', () => {
    const buffer = [node('n1', 0, 0)];
    const held = mergeCanvasNodes(buffer, buffer, {
      ...QUIET,
      remoteGesture: gesturing(['n1', { x: 10, y: 10 }]),
    });
    expect(
      mergeCanvasNodes(held, buffer, {
        ...QUIET,
        remoteGesture: gesturing(['n1', { x: 10, y: 10 }]),
      }),
    ).toBe(held);
  });

  it('hands back the same array when a dragged node holds still', () => {
    const buffer = [node('n1', 500, 500)];
    expect(
      mergeCanvasNodes(buffer, [node('n1', 0, 0)], {
        ...QUIET,
        localGestureIds: new Set(['n1']),
      }),
    ).toBe(buffer);
  });
});

describe('mergeCanvasNodes, what the mirror merge always did', () => {
  it('carries forward selected + dragging by id while taking data/position from the fresh nodes', () => {
    const prev = [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {},
        selected: true,
        dragging: true,
      },
      { id: 'b', type: 'image', position: { x: 0, y: 0 }, data: {}, selected: false },
    ] as Node[];
    // Fresh nodes come straight from the Yjs mirror — no selection field, and
    // `a` has moved (a collaborator dragged it).
    const fresh = [
      { id: 'a', type: 'text', position: { x: 9, y: 9 }, data: { name: 'A' } },
      { id: 'b', type: 'image', position: { x: 0, y: 0 }, data: {} },
      { id: 'c', type: 'audio', position: { x: 5, y: 5 }, data: {} },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);

    const a = merged.find((n) => n.id === 'a');
    expect(a?.selected).toBe(true); // selection survives the mirror rebuild
    expect(a?.dragging).toBe(true);
    expect(a?.position).toEqual({ x: 9, y: 9 }); // position still from Yjs
    expect((a?.data as { name?: string }).name).toBe('A');

    expect(merged.find((n) => n.id === 'b')?.selected).toBe(false);
    // A brand-new node (just created) is left unselected here; the auto-select
    // effect selects it explicitly once it appears.
    expect(merged.find((n) => n.id === 'c')?.selected).toBeUndefined();
  });
});

describe('mergeCanvasNodes reference stability (#1647 — React.memo needs stable refs)', () => {
  // The Yjs mirror rebuilds the whole node array on every doc change, so every
  // node gets a fresh object. Without reference stability, a change to one node
  // hands ALL nodes new `data` references, defeating React.memo (every node
  // re-renders). The merge must reuse the previous object reference for any node
  // whose render inputs (type / parentId / position / size / selection / data)
  // are unchanged, so only the node that actually changed re-renders.

  it('reuses the previous object reference when nothing render-relevant changed', () => {
    const prev = [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { content: 'hi', status: 'idle' },
        selected: false,
      },
    ] as Node[];
    // A different node changed elsewhere → the mirror rebuilt `a` fresh, but `a`
    // itself is identical.
    const fresh = [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { content: 'hi', status: 'idle' },
      },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).toBe(prev[0]); // SAME reference → memo bails, `a` not re-rendered
  });

  it('sees a generation changing hands', () => {
    // The starter's id rides in `data` alongside the derived status, and a
    // handover keeps that status at `handling` — so the status compare says
    // nothing changed and only the id itself can catch it. Reuse the previous
    // reference here and the node keeps naming the wrong person.
    //
    // The comparison is by own keys, so a flat field on `data` is covered the
    // moment it exists; this pins that the projection keeps putting it there.
    const at = (userId: string): Node[] =>
      [
        {
          id: 'a',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { status: 'handling', handlingByUserId: userId },
          selected: false,
        },
      ] as Node[];
    const prev = at('alice');
    expect(mergeCanvasNodes(prev, at('bob'), QUIET)[0]).not.toBe(prev[0]);
    expect(mergeCanvasNodes(prev, at('alice'), QUIET)[0]).toBe(prev[0]);
  });

  it('carries the holders the occupant table brings with it', () => {
    // The holders are put on each node by the merge itself, so a node that
    // gained or lost them has to count as changed: `data` is compared by own
    // keys, which is what makes the presence field visible here at all.
    const plain = (): Node[] =>
      [
        {
          id: 'a',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { status: 'idle' },
          selected: false,
        },
      ] as Node[];
    const unheld = mergeCanvasNodes(plain(), plain(), QUIET);

    const nowHeld = mergeCanvasNodes(unheld, plain(), {
      ...QUIET,
      occupants: new Map([['a', ['alice']]]),
    });
    expect(nowHeld[0]).not.toBe(unheld[0]);
    expect((nowHeld[0]?.data as { occupants?: readonly string[] }).occupants).toEqual(['alice']);

    expect(mergeCanvasNodes(nowHeld, plain(), QUIET)[0]).not.toBe(nowHeld[0]);
  });

  it('a fresh-but-equal focusImages array does not defeat reference reuse (Y.Array toJSON freshness)', () => {
    // The Yjs mirror serializes the focusImages Y.Array to a FRESH plain
    // array on every dataMap.toJSON() call (Y.Array.toJSON maps a new
    // array; its ELEMENTS keep their stored references). Whole-array
    // Object.is would read every eager-seeded node as changed on every
    // doc change — reverting #1647 R1 canvas-wide (encoding adversary
    // 2026-07-17).
    const cropRef = { id: 'f1', url: 'u', name: 'n', width: 1, height: 1 };
    const prev = [
      {
        id: 'a',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { content: 'x.png', status: 'idle', focusImages: [cropRef] },
        selected: false,
      },
    ] as Node[];
    const fresh = [
      {
        id: 'a',
        type: 'image',
        position: { x: 0, y: 0 },
        // A fresh array wrapper around the SAME element references —
        // exactly what toJSON hands the mirror when nothing changed.
        data: { content: 'x.png', status: 'idle', focusImages: [cropRef] },
      },
    ] as Node[];
    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).toBe(prev[0]);
    // The eager-seeded EMPTY array is the canvas-wide case: every content
    // node carries focusImages: [], rebuilt fresh each doc change.
    const prevEmpty = [
      {
        id: 'b',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { content: 'y.png', focusImages: [] },
        selected: false,
      },
    ] as Node[];
    const freshEmpty = [
      {
        id: 'b',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { content: 'y.png', focusImages: [] },
      },
    ] as Node[];
    expect(mergeCanvasNodes(prevEmpty, freshEmpty, QUIET)[0]).toBe(prevEmpty[0]);
  });

  it('returns a new reference when a crop was actually added / removed / replaced', () => {
    const cropA = { id: 'f1', url: 'u1', name: 'n', width: 1, height: 1 };
    const cropB = { id: 'f2', url: 'u2', name: 'n', width: 1, height: 1 };
    const at = (focusImages: unknown): Node[] =>
      [
        {
          id: 'a',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { focusImages },
        },
      ] as Node[];
    // Added.
    expect(mergeCanvasNodes(at([cropA]), at([cropA, cropB]), QUIET)[0]).not.toBe(
      at([cropA])[0],
    );
    const prevAdd = at([cropA]);
    expect(mergeCanvasNodes(prevAdd, at([cropA, cropB]), QUIET)[0]).not.toBe(
      prevAdd[0],
    );
    // Removed.
    const prevRemove = at([cropA, cropB]);
    expect(mergeCanvasNodes(prevRemove, at([cropB]), QUIET)[0]).not.toBe(
      prevRemove[0],
    );
    // Replaced element (a different stored object at the same slot).
    const prevReplace = at([cropA]);
    expect(mergeCanvasNodes(prevReplace, at([cropB]), QUIET)[0]).not.toBe(
      prevReplace[0],
    );
  });

  it('returns a new reference when the node data changed', () => {
    const prev = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { content: 'hi' } },
    ] as Node[];
    const fresh = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { content: 'bye' } },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).not.toBe(prev[0]);
    expect((merged[0].data as { content: string }).content).toBe('bye');
  });

  it('returns a new reference when the position changed', () => {
    const prev = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} },
    ] as Node[];
    const fresh = [
      { id: 'a', type: 'text', position: { x: 5, y: 7 }, data: {} },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].position).toEqual({ x: 5, y: 7 });
  });

  it('returns a new reference when a group node was resized (width/height changed)', () => {
    const prev = [
      {
        id: 'g',
        type: 'group',
        position: { x: 0, y: 0 },
        width: 200,
        height: 100,
        data: {},
      },
    ] as Node[];
    const fresh = [
      {
        id: 'g',
        type: 'group',
        position: { x: 0, y: 0 },
        width: 300,
        height: 100,
        data: {},
      },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].width).toBe(300);
  });

  it('returns a new reference when a node was reparented into a group', () => {
    const prev = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {} },
    ] as Node[];
    const fresh = [
      { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: {}, parentId: 'g' },
    ] as Node[];

    const merged = mergeCanvasNodes(prev, fresh, QUIET);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].parentId).toBe('g');
  });
});

describe('mergeCanvasNodes, a gesture entry that rode in on a Group', () => {
  it('stops speaking for a member the document has taken out of that Group', () => {
    // A remote holds Group `g`, so its batch carries every member's absolute
    // place as of the press. While that runs, THIS user drags one member clear
    // and the document takes it to the top level at 44. The batch still lists
    // the member at 404, where it sat inside the Group — a place the document
    // has never had it and the user never released it at. That entry rode in on
    // `g`, so it says nothing about a node no longer in `g`.
    const prev = [
      node('g', 380, 200, { type: 'group' }),
      node('m', 24, 24, { parentId: 'g' }),
    ];
    const fresh = [node('g', 200, 200, { type: 'group' }), node('m', 44, 224)];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      remoteGesture: gesturing(
        ['g', { x: 380, y: 200, root: 'g' }],
        ['m', { x: 404, y: 224, root: 'g' }],
      ),
    });
    expect(merged.find((n) => n.id === 'm')?.position).toEqual({ x: 44, y: 224 });
    // The Group itself is what the remote has hold of, so it still moves.
    expect(merged.find((n) => n.id === 'g')?.position).toEqual({ x: 380, y: 200 });
  });

  it('still moves a member that is still in the Group', () => {
    const prev = [
      node('g', 380, 200, { type: 'group' }),
      node('m', 24, 24, { parentId: 'g' }),
    ];
    const fresh = [
      node('g', 200, 200, { type: 'group' }),
      node('m', 24, 24, { parentId: 'g' }),
    ];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      remoteGesture: gesturing(
        ['g', { x: 380, y: 200, root: 'g' }],
        ['m', { x: 404, y: 224, root: 'g' }],
      ),
    });
    // Relative to the Group's gesture origin: 404 - 380 = 24.
    expect(merged.find((n) => n.id === 'm')?.position).toEqual({ x: 24, y: 24 });
  });

  it('moves a top-level node the remote is dragging directly', () => {
    const prev = [node('n', 0, 0)];
    const fresh = [node('n', 0, 0)];
    const merged = mergeCanvasNodes(prev, fresh, {
      ...QUIET,
      remoteGesture: gesturing(['n', { x: 700, y: 700, root: 'n' }]),
    });
    expect(merged[0]?.position).toEqual({ x: 700, y: 700 });
  });
});
