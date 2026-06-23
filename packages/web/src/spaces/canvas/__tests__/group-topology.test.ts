// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { topoSortByParent } from '@web/spaces/canvas/group-topology';

describe('topoSortByParent', () => {
  it('keeps root-only nodes in their original order', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(topoSortByParent(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('places a Group before its members even when the Group is listed last', () => {
    const nodes = [
      { id: 'm1', parentId: 'group' },
      { id: 'm2', parentId: 'group' },
      { id: 'group' },
    ];
    const order = topoSortByParent(nodes).map((n) => n.id);
    expect(order.indexOf('group')).toBeLessThan(order.indexOf('m1'));
    expect(order.indexOf('group')).toBeLessThan(order.indexOf('m2'));
  });

  it('preserves every node — no drops, no duplicates', () => {
    const nodes = [{ id: 'm', parentId: 'f' }, { id: 'f' }, { id: 'x' }];
    const out = topoSortByParent(nodes);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((n) => n.id))).toEqual(new Set(['m', 'f', 'x']));
  });

  it('treats a dangling parentId (parent absent from the set) as a root', () => {
    const nodes = [{ id: 'm', parentId: 'ghost' }];
    expect(topoSortByParent(nodes).map((n) => n.id)).toEqual(['m']);
  });

  it('does not infinite-loop on a cycle (defensive — nesting is forbidden)', () => {
    const nodes = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    const out = topoSortByParent(nodes);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((n) => n.id))).toEqual(new Set(['a', 'b']));
  });
});
