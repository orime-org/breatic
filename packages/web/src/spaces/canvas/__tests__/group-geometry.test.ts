// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  GROUP_PADDING,
  applyGroupGeometry,
  computeGroupRect,
} from '@web/spaces/canvas/group-geometry';
import type { GeoNode } from '@web/spaces/canvas/group-geometry';

/** Build a measured geo node at (x,y) sized w×h. */
function node(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  extra: Partial<GeoNode> = {},
): GeoNode {
  return { id, position: { x, y }, measured: { width: w, height: h }, ...extra };
}

describe('computeGroupRect — bounding box of members + padding', () => {
  it('returns null for no members', () => {
    expect(computeGroupRect([])).toBeNull();
  });

  it('wraps a single member with padding on every side', () => {
    const rect = computeGroupRect([node('a', 100, 100, 80, 40)]);
    expect(rect).toEqual({
      x: 100 - GROUP_PADDING,
      y: 100 - GROUP_PADDING,
      width: 80 + 2 * GROUP_PADDING,
      height: 40 + 2 * GROUP_PADDING,
    });
  });

  it('spans two diagonal members', () => {
    const rect = computeGroupRect([
      node('a', 0, 0, 100, 50),
      node('b', 300, 200, 100, 50),
    ]);
    // bounds: x 0..400, y 0..250
    expect(rect).toEqual({
      x: -GROUP_PADDING,
      y: -GROUP_PADDING,
      width: 400 + 2 * GROUP_PADDING,
      height: 250 + 2 * GROUP_PADDING,
    });
  });

  it('falls back to a default cell size before a member is measured', () => {
    const rect = computeGroupRect([{ id: 'a', position: { x: 0, y: 0 } }]);
    // unmeasured → non-zero default footprint, so the group still wraps
    expect(rect).not.toBeNull();
    expect(rect!.width).toBeGreaterThan(2 * GROUP_PADDING);
    expect(rect!.height).toBeGreaterThan(2 * GROUP_PADDING);
  });
});

describe('applyGroupGeometry — size group nodes to wrap their members', () => {
  it('sets a group node position + style size from its members', () => {
    const nodes = [
      { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { childIds: ['a', 'b'] } },
      node('a', 0, 0, 100, 50),
      node('b', 300, 200, 100, 50),
    ];
    const out = applyGroupGeometry(nodes);
    const g = out.find((n) => n.id === 'g')!;
    expect(g.position).toEqual({ x: -GROUP_PADDING, y: -GROUP_PADDING });
    expect(g.style?.width).toBe(400 + 2 * GROUP_PADDING);
    expect(g.style?.height).toBe(250 + 2 * GROUP_PADDING);
  });

  it('leaves non-group nodes untouched (same reference)', () => {
    const a = node('a', 10, 10, 80, 40);
    const out = applyGroupGeometry([a]);
    expect(out[0]).toBe(a);
  });

  it('leaves a group with no resolvable members untouched', () => {
    const g = {
      id: 'g',
      type: 'group',
      position: { x: 5, y: 5 },
      data: { childIds: ['missing'] },
    };
    const out = applyGroupGeometry([g]);
    expect(out[0]).toBe(g);
  });

  it('ignores the group id itself when resolving members (组不嵌套)', () => {
    const nodes = [
      { id: 'g', type: 'group', position: { x: 0, y: 0 }, data: { childIds: ['g', 'a'] } },
      node('a', 100, 100, 80, 40),
    ];
    const out = applyGroupGeometry(nodes);
    const g = out.find((n) => n.id === 'g')!;
    // only 'a' contributes (the self-reference resolves to the group, skipped)
    expect(g.position).toEqual({ x: 100 - GROUP_PADDING, y: 100 - GROUP_PADDING });
  });
});
