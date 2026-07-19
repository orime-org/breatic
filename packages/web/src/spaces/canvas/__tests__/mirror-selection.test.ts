// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

import {
  mergeMirroredEdgeSelection,
  mergeMirroredSelection,
  reconcileGroupNodes,
  reconcileSelection,
  sameGroupResizeBounds,
} from '@web/spaces/canvas/mirror-selection';

describe('mergeMirroredSelection', () => {
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

    const merged = mergeMirroredSelection(prev, fresh);

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

describe('mergeMirroredSelection reference stability (#1647 — React.memo needs stable refs)', () => {
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

    const merged = mergeMirroredSelection(prev, fresh);
    expect(merged[0]).toBe(prev[0]); // SAME reference → memo bails, `a` not re-rendered
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
    const merged = mergeMirroredSelection(prev, fresh);
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
    expect(mergeMirroredSelection(prevEmpty, freshEmpty)[0]).toBe(prevEmpty[0]);
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
    expect(mergeMirroredSelection(at([cropA]), at([cropA, cropB]))[0]).not.toBe(
      at([cropA])[0],
    );
    const prevAdd = at([cropA]);
    expect(mergeMirroredSelection(prevAdd, at([cropA, cropB]))[0]).not.toBe(
      prevAdd[0],
    );
    // Removed.
    const prevRemove = at([cropA, cropB]);
    expect(mergeMirroredSelection(prevRemove, at([cropB]))[0]).not.toBe(
      prevRemove[0],
    );
    // Replaced element (a different stored object at the same slot).
    const prevReplace = at([cropA]);
    expect(mergeMirroredSelection(prevReplace, at([cropB]))[0]).not.toBe(
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

    const merged = mergeMirroredSelection(prev, fresh);
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

    const merged = mergeMirroredSelection(prev, fresh);
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

    const merged = mergeMirroredSelection(prev, fresh);
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

    const merged = mergeMirroredSelection(prev, fresh);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].parentId).toBe('g');
  });
});

describe('mergeMirroredEdgeSelection', () => {
  it('carries forward the edge selected flag by id across a Yjs re-mirror', () => {
    // Without this, edge selection is wiped on every Yjs change, so the
    // scissors (gated on selected) never shows and Delete has no selected edge.
    const prev = [
      { id: 'e1', source: 'a', target: 'b', selected: true },
      { id: 'e2', source: 'b', target: 'c', selected: false },
    ] as Edge[];
    // Fresh edges from the Yjs mirror carry no selection field.
    const fresh = [
      { id: 'e1', source: 'a', target: 'b', type: 'scissors' },
      { id: 'e2', source: 'b', target: 'c', type: 'scissors' },
      { id: 'e3', source: 'a', target: 'c', type: 'scissors' },
    ] as Edge[];

    const merged = mergeMirroredEdgeSelection(prev, fresh);

    expect(merged.find((e) => e.id === 'e1')?.selected).toBe(true);
    expect(merged.find((e) => e.id === 'e1')?.type).toBe('scissors'); // data from fresh
    expect(merged.find((e) => e.id === 'e2')?.selected).toBe(false);
    // A brand-new edge (not in prev) stays unselected.
    expect(merged.find((e) => e.id === 'e3')?.selected).toBeUndefined();
  });
});

describe('mergeMirroredEdgeSelection reference stability (#1783 — ScissorsEdge.memo needs stable refs)', () => {
  // The edge mirror rebuilds every edge (fresh object + fresh `data:{readOnly}`)
  // on every Yjs change; without reference reuse, ANY doc change re-renders
  // EVERY scissors edge. Unchanged edges must keep their previous reference so
  // React.memo bails — the edge counterpart of the node mirror's #1647 R1 fix.
  const edge = (over: Partial<Edge> = {}): Edge =>
    ({
      id: 'e1',
      source: 'a',
      target: 'b',
      type: 'scissors',
      data: { readOnly: false },
      ...over,
    }) as Edge;

  it('reuses the previous edge reference when nothing render-relevant changed', () => {
    const prev = [edge({ selected: true })];
    // A fresh re-mirror: new objects, new `data:{readOnly}` wrapper, SAME values.
    const fresh = [edge()];
    const merged = mergeMirroredEdgeSelection(prev, fresh);
    expect(merged[0]).toBe(prev[0]); // SAME reference → ScissorsEdge memo bails
  });

  it('returns a NEW reference when data.readOnly actually flips', () => {
    const prev = [edge({ selected: true })];
    const fresh = [edge({ data: { readOnly: true } })];
    const merged = mergeMirroredEdgeSelection(prev, fresh);
    expect(merged[0]).not.toBe(prev[0]); // changed → new ref → re-render
    expect(merged[0].data).toEqual({ readOnly: true });
    expect(merged[0].selected).toBe(true); // local selection still carried
  });

  it('returns a NEW reference when the edge is re-routed (source/target change)', () => {
    const prev = [edge({ selected: false })];
    const fresh = [edge({ target: 'c' })];
    const merged = mergeMirroredEdgeSelection(prev, fresh);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].target).toBe('c');
  });
});

// reconcileSelection backs the panel⇄selection binding's programmatic writes
// (host assert / pane-click deselect). Reference stability is load-bearing:
// these run on high-frequency paths and a no-op write must NOT publish a new
// buffer identity (round-1 adversarial: every idle pane click re-rendered the
// whole canvas).
describe('reconcileSelection', () => {
  it('selects only the target and deselects the rest', () => {
    const nodes = [
      { id: 'a', selected: true },
      { id: 'b' },
      { id: 'c', selected: false },
    ];
    const out = reconcileSelection(nodes, (n) => n.id === 'b');
    expect(out.map((n) => [n.id, n.selected === true])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
  });

  it('returns the SAME array reference when nothing changes (no-op write)', () => {
    const nodes = [{ id: 'a', selected: true }, { id: 'b', selected: false }];
    expect(reconcileSelection(nodes, (n) => n.id === 'a')).toBe(nodes);
    const none = [{ id: 'a' }, { id: 'b', selected: false }];
    expect(reconcileSelection(none, () => false)).toBe(none);
  });

  it('reuses untouched item references so React.memo still bails', () => {
    const a = { id: 'a', selected: false };
    const b = { id: 'b', selected: true };
    const out = reconcileSelection([a, b], () => false);
    expect(out[0]).toBe(a); // untouched keeps its reference
    expect(out[1]).not.toBe(b); // rewritten item is a fresh object
    expect(out[1].selected).toBe(false);
  });
});

describe('sameGroupResizeBounds (#1783)', () => {
  it('is true for equal-length arrays of field-wise equal records', () => {
    expect(
      sameGroupResizeBounds(
        [{ minWidth: 10, minHeight: 20 }],
        [{ minWidth: 10, minHeight: 20 }],
      ),
    ).toBe(true);
  });

  it('is false when a bound value differs, the length differs, or a value is not an array', () => {
    expect(
      sameGroupResizeBounds(
        [{ minWidth: 10, minHeight: 20 }],
        [{ minWidth: 99, minHeight: 20 }],
      ),
    ).toBe(false);
    expect(sameGroupResizeBounds([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(sameGroupResizeBounds([{ a: 1 }], undefined)).toBe(false);
  });
});

describe('reconcileGroupNodes reference stability (#1783 — GroupNode.memo needs stable refs)', () => {
  // renderNodes rebuilds every group's `data` (with a fresh `groupResizeBounds`
  // array) on every canvas mutation; without reuse, a change to ANY node
  // re-renders EVERY group. Unchanged groups must keep their previous reference.
  const group = (over: Partial<Node> = {}): Node =>
    ({
      id: 'g1',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 100,
      height: 100,
      draggable: true,
      zIndex: 0,
      data: { kind: 'group', groupResizeBounds: [{ minWidth: 10, minHeight: 10 }] },
      ...over,
    }) as Node;

  it('reuses the previous group reference when nothing render-relevant changed', () => {
    const prev = [group()];
    // A fresh pass: new node object, new data object, new bounds ARRAY — SAME values.
    const fresh = [
      group({
        data: {
          kind: 'group',
          groupResizeBounds: [{ minWidth: 10, minHeight: 10 }],
        },
      }),
    ];
    const merged = reconcileGroupNodes(prev, fresh);
    expect(merged[0]).toBe(prev[0]); // SAME reference → GroupNode memo bails
  });

  it('returns a NEW reference when the resize bounds actually change', () => {
    const prev = [group()];
    const fresh = [
      group({
        data: {
          kind: 'group',
          groupResizeBounds: [{ minWidth: 42, minHeight: 10 }],
        },
      }),
    ];
    const merged = reconcileGroupNodes(prev, fresh);
    expect(merged[0]).not.toBe(prev[0]);
  });

  it('returns a NEW reference when the group moves', () => {
    const prev = [group()];
    const fresh = [group({ position: { x: 50, y: 0 } })];
    const merged = reconcileGroupNodes(prev, fresh);
    expect(merged[0]).not.toBe(prev[0]);
    expect(merged[0].position.x).toBe(50);
  });
});
