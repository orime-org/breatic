// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import type { Edge, Node } from '@xyflow/react';

import {
  mergeMirroredEdgeSelection,
  reconcileGroupNodes,
  reconcilePlainNodes,
  reconcileSelection,
  sameGroupResizeBounds,
} from '@web/spaces/canvas/mirror-selection';

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

/** One data object shared across a pass, the way the merge hands it down. */
const DATA = { kind: 'image' };

describe('reconcilePlainNodes reference stability (#2010 — 30 frames a second)', () => {
  // A locked node and the focus target come out of `renderNodes` as fresh
  // objects carrying a flag. During a gesture that pass runs every frame, so
  // without reuse those nodes get a new reference 30 times a second while
  // nothing about them changed.
  const plain = (over: Partial<Node> = {}): Node =>
    ({
      id: 'n1',
      type: 'image',
      position: { x: 10, y: 20 },
      draggable: false,
      zIndex: 5,
      data: DATA,
      ...over,
    }) as Node;

  it('reuses the previous reference when nothing render-relevant changed', () => {
    const prev = [plain()];
    expect(reconcilePlainNodes(prev, [plain()])[0]).toBe(prev[0]);
  });

  it('returns a new reference when the flag itself changed', () => {
    const prev = [plain()];
    expect(reconcilePlainNodes(prev, [plain({ zIndex: 9 })])[0]).not.toBe(prev[0]);
  });

  it('returns a new reference when the node moved', () => {
    const prev = [plain()];
    const moved = plain({ position: { x: 11, y: 20 } });
    expect(reconcilePlainNodes(prev, [moved])[0]).toBe(moved);
  });

  it('returns a new reference when the data object changed', () => {
    // A plain node's data is handed down whole, so a new object means new
    // content — the merge already reuses it when nothing changed.
    const prev = [plain()];
    const fresh = plain({ data: { ...DATA } });
    expect(reconcilePlainNodes(prev, [fresh])[0]).toBe(fresh);
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
