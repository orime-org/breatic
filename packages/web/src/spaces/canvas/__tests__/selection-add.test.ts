// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The selection plus (inner#2216): which selection gets the plus beside it,
 * which nodes it wires into the new node, where the new node lands and when
 * the reference cap refuses the whole build.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import type { NodePlacement } from '@web/data/yjs/canvas-space';
import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import {
  LAYER_STEP_PX,
  ROW_GAP_PX,
  occupiedRects,
  shiftRightPastOccupied,
  withTaskCounts,
} from '@web/spaces/canvas/lib/place-flow';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import { CREATABLE_NODE_TYPES, type CreatableNodeType } from '@web/spaces/canvas/node-factory';
import {
  boundsOf,
  handlesEmphasized,
  orderSources,
  planConnectedNode,
  previewWires,
  resolveSelectionAdd,
  SELECTION_ADD_OFFSET_PX,
  type SelectionAddNode,
} from '@web/spaces/canvas/selection-add';

/**
 * A content node at an absolute position, standard size.
 * @param id - The node id.
 * @param type - Its modality.
 * @param x - Absolute x.
 * @param y - Absolute y.
 * @param parentId - The group it belongs to, if any.
 * @returns The node.
 */
function content(id: string, type: string, x = 0, y = 0, parentId?: string): SelectionAddNode {
  return { id, type, position: { x, y }, width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height, ...(parentId ? { parentId } : {}) };
}

/**
 * A sticky note.
 * @param id - The note id.
 * @returns The note.
 */
function note(id: string): SelectionAddNode {
  return { id, type: 'annotation', position: { x: 0, y: 0 }, width: 40, height: 40 };
}

/**
 * A group.
 * @param id - The group id.
 * @returns The group.
 */
function group(id: string): SelectionAddNode {
  return { id, type: 'group', position: { x: 0, y: 0 }, width: 800, height: 600 };
}

/**
 * Sorts ids so two id lists compare as sets.
 * @param ids - The ids.
 * @returns A sorted copy.
 */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe('resolveSelectionAdd — where the plus shows (design 4.2)', () => {
  it('shows nothing for an empty selection', () => {
    expect(resolveSelectionAdd([], [content('a', 'image')])).toEqual({ kind: 'none' });
  });

  it('shows nothing when only notes are selected', () => {
    expect(resolveSelectionAdd(['n1', 'n2'], [note('n1'), note('n2')])).toEqual({ kind: 'none' });
  });

  it('leaves one content node to its own handles', () => {
    expect(resolveSelectionAdd(['a'], [content('a', 'image'), content('b', 'video')])).toEqual({
      kind: 'single',
      nodeId: 'a',
    });
  });

  it('leaves one content node to its own handles when a note is selected with it', () => {
    expect(resolveSelectionAdd(['a', 'n1'], [content('a', 'image'), note('n1')])).toEqual({
      kind: 'single',
      nodeId: 'a',
    });
  });

  it('hangs the plus on a lone group and wires its edge-taking members', () => {
    const nodes = [
      group('g'),
      content('m1', 'image', 10, 10, 'g'),
      content('m2', 'video', 10, 300, 'g'),
      content('m3', '3d', 400, 10, 'g'),
      content('outside', 'image', 2000, 0),
    ];
    const result = resolveSelectionAdd(['g'], nodes);
    expect(result.kind).toBe('add');
    if (result.kind !== 'add') return;
    expect(result.anchorIds).toEqual(['g']);
    expect(sorted(result.sourceIds)).toEqual(['m1', 'm2', 'm3']);
  });

  it('hangs the plus on a lone group when a note is selected with it', () => {
    const nodes = [group('g'), content('m1', 'image', 10, 10, 'g'), note('n1')];
    const result = resolveSelectionAdd(['g', 'n1'], nodes);
    expect(result).toEqual({ kind: 'add', anchorIds: ['g'], sourceIds: ['m1'] });
  });

  it('hangs the plus on two or more content nodes and wires all of them', () => {
    const nodes = [content('a', 'image'), content('b', 'audio', 0, 300), content('c', 'video', 0, 600)];
    const result = resolveSelectionAdd(['a', 'b', 'c'], nodes);
    expect(result.kind).toBe('add');
    if (result.kind !== 'add') return;
    expect(sorted(result.anchorIds)).toEqual(['a', 'b', 'c']);
    expect(sorted(result.sourceIds)).toEqual(['a', 'b', 'c']);
  });

  it('drops notes from both the anchors and the sources of a multi-selection', () => {
    const nodes = [content('a', 'image'), content('b', 'text', 0, 300), note('n1')];
    const result = resolveSelectionAdd(['a', 'n1', 'b'], nodes);
    expect(result.kind).toBe('add');
    if (result.kind !== 'add') return;
    expect(sorted(result.anchorIds)).toEqual(['a', 'b']);
    expect(sorted(result.sourceIds)).toEqual(['a', 'b']);
  });

  it('wires a selected group through its members when picked with loose nodes', () => {
    const nodes = [group('g'), content('m1', 'image', 10, 10, 'g'), content('m2', 'text', 10, 300, 'g'), content('a', 'video', 1200, 0)];
    const result = resolveSelectionAdd(['g', 'a'], nodes);
    expect(result.kind).toBe('add');
    if (result.kind !== 'add') return;
    expect(sorted(result.anchorIds)).toEqual(['a', 'g']);
    expect(sorted(result.sourceIds)).toEqual(['a', 'm1', 'm2']);
  });

  it('never lists a note, a group or the same node twice among the sources', () => {
    const kinds = ['text', 'image', 'video', 'audio', '3d', 'web', 'annotation', 'group'] as const;
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind: fc.constantFrom(...kinds), inGroup: fc.nat(2), selected: fc.boolean() }), { maxLength: 12 }),
        (specs) => {
          // Groups g0 and g1 always exist; members point at one of them, or none.
          const nodes: SelectionAddNode[] = [group('g0'), group('g1')];
          const selected: string[] = [];
          specs.forEach((spec, index) => {
            const id = `n${index}`;
            if (spec.kind === 'annotation') nodes.push(note(id));
            else if (spec.kind === 'group') nodes.push(group(id));
            else nodes.push(content(id, spec.kind, index * 10, index * 10, spec.inGroup < 2 ? `g${spec.inGroup}` : undefined));
            if (spec.selected) selected.push(id);
          });
          selected.push('g0');
          const result = resolveSelectionAdd(selected, nodes);
          if (result.kind !== 'add') return;
          const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
          expect(new Set(result.sourceIds).size).toBe(result.sourceIds.length);
          for (const id of result.sourceIds) {
            expect(['annotation', 'group']).not.toContain(typeOf.get(id));
          }
          for (const id of result.anchorIds) {
            expect(typeOf.get(id)).not.toBe('annotation');
          }
        },
      ),
    );
  });
});

describe('handlesEmphasized — when a node shows the plus on its handles (design 4.1)', () => {
  it('shows the plus only on the lone selected, connectable node with no mini tool open', () => {
    for (const lone of [true, false]) {
      for (const connectable of [true, false]) {
        for (const miniToolOpen of [true, false]) {
          expect(
            handlesEmphasized({ lone, connectable, miniToolOpen }),
            JSON.stringify({ lone, connectable, miniToolOpen }),
          ).toBe(lone && connectable && !miniToolOpen);
        }
      }
    }
  });
});

describe('orderSources — reference order, top to bottom then left to right', () => {
  it('orders by y first and x second', () => {
    const nodes = [content('low', 'image', 0, 100), content('right', 'image', 50, 0), content('left', 'image', 10, 0)];
    expect(orderSources(nodes).map((n) => n.id)).toEqual(['left', 'right', 'low']);
  });

  it('returns a permutation sorted by (y, x) for any positions', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ x: fc.integer({ min: -5000, max: 5000 }), y: fc.integer({ min: -5000, max: 5000 }) }), { maxLength: 20 }), (points) => {
        const nodes = points.map((p, i) => content(`n${i}`, 'image', p.x, p.y));
        const out = orderSources(nodes);
        expect(sorted(out.map((n) => n.id))).toEqual(sorted(nodes.map((n) => n.id)));
        for (let i = 1; i < out.length; i += 1) {
          const a = out[i - 1].position;
          const b = out[i].position;
          expect(a.y < b.y || (a.y === b.y && a.x <= b.x)).toBe(true);
        }
      }),
    );
  });
});

describe('planConnectedNode — what one pick builds (design 4.4)', () => {
  const bounds = { x: 0, y: 0, width: 288, height: 492 };
  const nothingAround = { selectionIds: [], placements: [], measuredOf: (): undefined => undefined };
  // A content node sitting flush with the selection's right edge, level with
  // the new node: its task counts reach 68px past that edge, into the gap
  // padding round the spot, so as an obstacle it pushes the new node right.
  const flush: NodePlacement = { id: 'img', type: 'image', x: 0, y: 150 };
  const measuredFlush = (id: string): { width: number; height: number } | undefined =>
    id === 'img' || id === 'm1' ? { width: 288, height: 192 } : undefined;
  const spot = { x: 360, y: 150, width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height };

  it('keeps the 72px column between the selection and the new node', () => {
    expect(LAYER_STEP_PX - EMPTY_NODE_SIZE.width).toBe(72);
  });

  it('places the new node 72px past the selection, centred on it, when nothing is in the way', () => {
    const sources = [content('img', 'image', 0, 0), content('vid', 'video', 0, 300)];
    const plan = planConnectedNode({ type: 'image', sources, selectionBounds: bounds, ...nothingAround, cap: 50 });
    expect(plan).toEqual({
      kind: 'ok',
      // left edge 288 + 72 = 360, top 246 - 96 = 150; centre = left/top + half size
      center: { x: 360 + EMPTY_NODE_SIZE.width / 2, y: 246 },
      sourceIds: ['img'],
    });
  });

  it('moves right past a node outside the selection that the spot would cover', () => {
    const sources = [content('img', 'image', 0, 0)];
    // A group takes exactly its own rect, so the obstacle is this rect.
    const obstacle = { x: 400, y: 100, width: 300, height: 200 };
    const placements: NodePlacement[] = [{ id: 'other', type: 'group', ...obstacle }];
    const plan = planConnectedNode({
      type: 'video',
      sources,
      selectionBounds: bounds,
      selectionIds: ['img'],
      placements,
      measuredOf: () => undefined,
      cap: 50,
    });
    const rect = { x: 360, y: 150, width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height };
    const shift = shiftRightPastOccupied(withTaskCounts(rect), [obstacle], ROW_GAP_PX);
    expect(shift).toBe(388);
    expect(plan).toEqual({
      kind: 'ok',
      center: { x: rect.x + shift + EMPTY_NODE_SIZE.width / 2, y: 246 },
      sourceIds: ['img'],
    });
  });

  it('stays put when the only other node sits clear above the spot', () => {
    const sources = [content('img', 'image', 0, 0)];
    const placements: NodePlacement[] = [{ id: 'other', type: 'image', x: 360, y: -1000 }];
    const plan = planConnectedNode({
      type: 'video',
      sources,
      selectionBounds: bounds,
      selectionIds: ['img'],
      placements,
      measuredOf: () => undefined,
      cap: 50,
    });
    expect(plan).toEqual({ kind: 'ok', center: { x: 504, y: 246 }, sourceIds: ['img'] });
  });

  it('pins the fixture: the flush node would push the spot right as an obstacle', () => {
    const shift = shiftRightPastOccupied(withTaskCounts(spot), occupiedRects([flush], measuredFlush), ROW_GAP_PX);
    expect(shift).toBeGreaterThan(0);
  });

  it('leaves a selected node out of the obstacles: the spot stays 72px past the bounds', () => {
    const plan = planConnectedNode({
      type: 'video',
      sources: [content('img', 'image', 0, 150)],
      selectionBounds: bounds,
      selectionIds: ['img'],
      placements: [flush],
      measuredOf: measuredFlush,
      cap: 50,
    });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.center.x - EMPTY_NODE_SIZE.width / 2).toBe(bounds.x + bounds.width + 72);
  });

  it('leaves a selected group and the members listed with it out of the obstacles', () => {
    const placements: NodePlacement[] = [
      { id: 'g', type: 'group', x: 0, y: 0, width: 288, height: 492 },
      { id: 'm1', type: 'image', x: 0, y: 150 },
    ];
    const plan = planConnectedNode({
      type: 'video',
      sources: [content('m1', 'image', 0, 150, 'g')],
      selectionBounds: bounds,
      selectionIds: ['g', 'm1'],
      placements,
      measuredOf: measuredFlush,
      cap: 50,
    });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.center.x - EMPTY_NODE_SIZE.width / 2).toBe(bounds.x + bounds.width + 72);
  });

  it('still moves right past the same node when it is not in the selection', () => {
    const shift = shiftRightPastOccupied(withTaskCounts(spot), occupiedRects([flush], measuredFlush), ROW_GAP_PX);
    const plan = planConnectedNode({
      type: 'video',
      sources: [content('a', 'image', 0, 0)],
      selectionBounds: bounds,
      selectionIds: ['a'],
      placements: [flush],
      measuredOf: measuredFlush,
      cap: 50,
    });
    expect(plan).toEqual({
      kind: 'ok',
      center: { x: spot.x + shift + EMPTY_NODE_SIZE.width / 2, y: 246 },
      sourceIds: ['a'],
    });
  });

  it('never moves for an unselected note in the way', () => {
    const pin: NodePlacement = { id: 'pin', type: 'annotation', x: 360, y: 150 };
    const plan = planConnectedNode({
      type: 'video',
      sources: [content('a', 'image', 0, 0)],
      selectionBounds: bounds,
      selectionIds: ['a'],
      placements: [pin],
      measuredOf: () => ({ width: 288, height: 192 }),
      cap: 50,
    });
    expect(plan).toEqual({ kind: 'ok', center: { x: 504, y: 246 }, sourceIds: ['a'] });
  });

  it('wires only the sources that connect into the picked type, in reference order', () => {
    const sources = [
      content('audio-top', 'audio', 0, 0),
      content('img-low', 'image', 0, 600),
      content('text-mid-right', 'text', 300, 300),
      content('text-mid-left', 'text', 0, 300),
    ];
    const plan = planConnectedNode({ type: 'image', sources, selectionBounds: bounds, ...nothingAround, cap: 50 });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    // audio does not feed an image node; the rest read top to bottom, left to right.
    expect(plan.sourceIds).toEqual(['text-mid-left', 'text-mid-right', 'img-low']);
  });

  it('refuses the whole build when the connectable sources exceed the reference cap', () => {
    const sources = [content('a', 'image', 0, 0), content('b', 'image', 0, 300), content('c', 'image', 0, 600)];
    expect(planConnectedNode({ type: 'video', sources, selectionBounds: bounds, ...nothingAround, cap: 2 })).toEqual({ kind: 'full', cap: 2 });
  });

  it('builds when the connectable sources fill the cap exactly', () => {
    const sources = [content('a', 'image', 0, 0), content('b', 'image', 0, 300), content('c', 'image', 0, 600)];
    const plan = planConnectedNode({ type: 'video', sources, selectionBounds: bounds, ...nothingAround, cap: 3 });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.sourceIds).toEqual(['a', 'b', 'c']);
  });

  it('counts only the sources that connect against the cap', () => {
    const sources = [content('a', 'image', 0, 0), content('b', 'image', 0, 300), content('c', 'audio', 0, 600)];
    const plan = planConnectedNode({ type: 'image', sources, selectionBounds: bounds, ...nothingAround, cap: 2 });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.sourceIds).toEqual(['a', 'b']);
  });

  it('has no cap when the cap is unknown', () => {
    const sources = Array.from({ length: 80 }, (_, i) => content(`n${i}`, 'text', 0, i * 10));
    const plan = planConnectedNode({ type: 'video', sources, selectionBounds: bounds, ...nothingAround, cap: null });
    expect(plan.kind).toBe('ok');
    if (plan.kind !== 'ok') return;
    expect(plan.sourceIds).toHaveLength(80);
  });

  // Properties over any selection: the wiring is exactly the ordered,
  // connectable sources; the cap is never crossed; the spot is never left of
  // the 72px column and always level with the selection's middle.
  it('holds its invariants for any selection, type, cap and surrounding nodes', () => {
    const kinds = ['text', 'image', 'video', 'audio', '3d', 'web'] as const;
    const rect = fc.record({
      x: fc.integer({ min: -3000, max: 3000 }),
      y: fc.integer({ min: -3000, max: 3000 }),
      width: fc.integer({ min: 1, max: 1000 }),
      height: fc.integer({ min: 1, max: 1000 }),
    });
    const around = fc.record({
      type: fc.constantFrom('text', 'image', 'video', 'audio', 'group', 'annotation'),
      selected: fc.boolean(),
      box: rect,
    });
    fc.assert(
      fc.property(
        fc.array(fc.record({ kind: fc.constantFrom(...kinds), x: fc.integer({ min: -3000, max: 3000 }), y: fc.integer({ min: -3000, max: 3000 }) }), { maxLength: 15 }),
        fc.constantFrom<CreatableNodeType>(...CREATABLE_NODE_TYPES),
        fc.option(fc.nat(10), { nil: null }),
        rect,
        fc.array(around, { maxLength: 6 }),
        (specs, type, cap, selectionBounds, others) => {
          const sources = specs.map((s, i) => content(`s${i}`, s.kind, s.x, s.y));
          const placements: NodePlacement[] = others.map((o, i) => ({ id: `p${i}`, type: o.type, ...o.box }));
          const selectionIds = others.flatMap((o, i) => (o.selected ? [`p${i}`] : []));
          const box = new Map(others.map((o, i) => [`p${i}`, { width: o.box.width, height: o.box.height }]));
          const measuredOf = (id: string): { width: number; height: number } | undefined => box.get(id);
          const plan = planConnectedNode({ type, sources, selectionBounds, selectionIds, placements, measuredOf, cap });
          // A selected node never moves the spot: dropping every selected
          // placement plans the same build.
          const unselected = placements.filter((p) => !selectionIds.includes(p.id));
          expect(planConnectedNode({ type, sources, selectionBounds, selectionIds: [], placements: unselected, measuredOf, cap })).toEqual(plan);
          const connectable = orderSources(sources).filter((s) => canConnect(s.type, type)).map((s) => s.id);
          if (cap !== null && connectable.length > cap) {
            expect(plan).toEqual({ kind: 'full', cap });
            return;
          }
          expect(plan.kind).toBe('ok');
          if (plan.kind !== 'ok') return;
          expect(plan.sourceIds).toEqual(connectable);
          const typeOf = new Map(sources.map((s) => [s.id, s.type]));
          for (const id of plan.sourceIds) expect(canConnect(typeOf.get(id) ?? '', type)).toBe(true);
          const left = plan.center.x - EMPTY_NODE_SIZE.width / 2;
          expect(left).toBeGreaterThanOrEqual(selectionBounds.x + selectionBounds.width + 72);
          expect(plan.center.y).toBe(selectionBounds.y + selectionBounds.height / 2);
        },
      ),
    );
  });
});

/**
 * A node of any size at an absolute position.
 * @param id - The node id.
 * @param x - Absolute x.
 * @param y - Absolute y.
 * @param width - Its width.
 * @param height - Its height.
 * @returns The node.
 */
function sized(id: string, x: number, y: number, width: number, height: number): SelectionAddNode {
  return { id, type: 'image', position: { x, y }, width, height };
}

const sizedNode = fc.record({
  x: fc.integer({ min: -5000, max: 5000 }),
  y: fc.integer({ min: -5000, max: 5000 }),
  width: fc.integer({ min: 1, max: 2000 }),
  height: fc.integer({ min: 1, max: 2000 }),
});

// boundsOf hands the nodes to groupRectForMembers with no padding
// (group-geometry's own tests cover the union); this guards the adapter.
describe('boundsOf — the rect the plus sits beside (design 4.2)', () => {
  it('is the union of the nodes\' position and size, and null for no nodes', () => {
    expect(boundsOf([])).toBeNull();
    const nodes = [sized('a', 0, 100, 200, 100), sized('b', 50, -40, 300, 80), sized('c', -30, 400, 100, 250)];
    // left -30, top -40, right 350 (b), bottom 650 (c)
    expect(boundsOf(nodes)).toEqual({ x: -30, y: -40, width: 380, height: 690 });
  });
});

describe('previewWires — the wires drawn while the plus menu is open (design 4.5)', () => {
  // bounds: left 0, top 0, right 350, bottom 500 -> middle y 250
  const a = sized('a', 0, 0, 200, 100);
  const b = sized('b', 50, 300, 300, 200);
  const bounds = { x: 0, y: 0, width: 350, height: 500 };

  it('runs from each source right edge middle to the plus left edge middle at zoom 1', () => {
    expect(previewWires([a, b], bounds, 1)).toEqual([
      { sourceId: 'a', from: { x: 200, y: 50 }, to: { x: 366, y: 250 } },
      { sourceId: 'b', from: { x: 350, y: 400 }, to: { x: 366, y: 250 } },
    ]);
  });

  it('widens the 16 screen px gap to 32 flow px at zoom 0.5', () => {
    expect(previewWires([a, b], bounds, 0.5)).toEqual([
      { sourceId: 'a', from: { x: 200, y: 50 }, to: { x: 382, y: 250 } },
      { sourceId: 'b', from: { x: 350, y: 400 }, to: { x: 382, y: 250 } },
    ]);
  });

  it('narrows the 16 screen px gap to 8 flow px at zoom 2', () => {
    expect(previewWires([a, b], bounds, 2)).toEqual([
      { sourceId: 'a', from: { x: 200, y: 50 }, to: { x: 358, y: 250 } },
      { sourceId: 'b', from: { x: 350, y: 400 }, to: { x: 358, y: 250 } },
    ]);
  });

  it('keeps the given source order', () => {
    expect(previewWires([b, a], bounds, 1).map((w) => w.sourceId)).toEqual(['b', 'a']);
  });

  it('draws no wires for no sources', () => {
    expect(previewWires([], bounds, 1)).toEqual([]);
  });

  it('ends every wire at the bounds right edge plus 16/zoom, level with the bounds middle, for any input', () => {
    fc.assert(
      fc.property(
        fc.array(sizedNode, { maxLength: 15 }),
        sizedNode,
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        (rects, box, zoom) => {
          const sources = rects.map((r, i) => sized(`s${i}`, r.x, r.y, r.width, r.height));
          const wires = previewWires(sources, box, zoom);
          expect(wires.map((w) => w.sourceId)).toEqual(sources.map((s) => s.id));
          wires.forEach((wire, i) => {
            const s = sources[i];
            expect(wire.from).toEqual({ x: s.position.x + s.width, y: s.position.y + s.height / 2 });
            expect(wire.to).toEqual({ x: box.x + box.width + SELECTION_ADD_OFFSET_PX / zoom, y: box.y + box.height / 2 });
          });
        },
      ),
    );
  });
});
