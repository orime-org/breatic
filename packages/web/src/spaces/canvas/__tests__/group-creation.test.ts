// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { planGroupCreation } from '@web/spaces/canvas/group-creation';

/**
 * Build a minimal measured flow node for the geometry + selection planning.
 * @param id - Node id.
 * @param x - Position x.
 * @param y - Position y.
 * @param selected - Whether the node is locally selected.
 * @returns A flow node with a fixed 100×100 measured footprint.
 */
function node(id: string, x: number, y: number, selected: boolean): Node {
  return {
    id,
    type: 'text',
    position: { x, y },
    data: {},
    selected,
    measured: { width: 100, height: 100 },
  };
}

describe('planGroupCreation (#1477)', () => {
  it('returns null when fewer than 2 nodes are selected (nothing to group)', () => {
    expect(planGroupCreation([node('a', 0, 0, true)], ['a'])).toBeNull();
    expect(planGroupCreation([], [])).toBeNull();
  });

  // The bug: grouping left the marquee members selected, so the mirror window
  // kept a multi-selection and right-click hit the SELECTION menu. The plan
  // must deselect every grouped member up front.
  it('clears the selection of every grouped member (no multi-select window)', () => {
    const nodes = [
      node('a', 0, 0, true),
      node('b', 200, 0, true),
      node('c', 500, 0, false),
    ];
    const plan = planGroupCreation(nodes, ['a', 'b']);
    expect(plan).not.toBeNull();
    const byId = Object.fromEntries(plan!.nextNodes.map((n) => [n.id, n]));
    expect(byId.a.selected).toBe(false);
    expect(byId.b.selected).toBe(false);
  });

  it('leaves non-member nodes untouched (same reference for referential equality)', () => {
    const nodes = [
      node('a', 0, 0, true),
      node('b', 200, 0, true),
      node('c', 500, 0, false),
    ];
    const plan = planGroupCreation(nodes, ['a', 'b']);
    expect(plan!.nextNodes.find((n) => n.id === 'c')).toBe(nodes[2]);
  });

  it('childIds = the selected ids; position = members bounding-box top-left minus padding', () => {
    const nodes = [node('a', 0, 0, true), node('b', 200, 100, true)];
    const plan = planGroupCreation(nodes, ['a', 'b']);
    expect(plan!.childIds).toEqual(['a', 'b']);
    // computeGroupRect pads by GROUP_PADDING (24): min corner (0,0) → (−24,−24).
    expect(plan!.position).toEqual({ x: -24, y: -24 });
  });
});
