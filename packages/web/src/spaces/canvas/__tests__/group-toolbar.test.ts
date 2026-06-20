// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { computeGroupToolbar } from '@web/spaces/canvas/group-toolbar';
import type { NodeGroupInfo } from '@web/spaces/canvas/group-toolbar';

/** Build a loose (un-grouped) content node info. */
function loose(id: string): NodeGroupInfo {
  return { id, isGroup: false };
}
/** Build a group node info wrapping the given child ids. */
function group(id: string, childIds: string[]): NodeGroupInfo {
  return { id, isGroup: true, childIds };
}

describe('computeGroupToolbar — selection → floating-toolbar offer', () => {
  it('offers "group" when ≥2 loose nodes are selected', () => {
    const nodes = [loose('a'), loose('b'), loose('c')];
    expect(computeGroupToolbar(['a', 'b'], nodes)).toEqual({ kind: 'group' });
  });

  it('offers nothing for a single loose node (a group needs ≥2)', () => {
    expect(computeGroupToolbar(['a'], [loose('a')])).toEqual({ kind: 'none' });
  });

  it('offers "ungroup" with the group id when exactly one group is selected', () => {
    const nodes = [group('g1', ['a', 'b']), loose('a'), loose('b')];
    expect(computeGroupToolbar(['g1'], nodes)).toEqual({
      kind: 'ungroup',
      groupId: 'g1',
    });
  });

  it('refuses "group" when the selection includes an already-grouped member (组不嵌套 / 只组散节点)', () => {
    const nodes = [group('g1', ['a']), loose('a'), loose('b')];
    // a is already in g1; selecting a + b cannot be grouped.
    expect(computeGroupToolbar(['a', 'b'], nodes)).toEqual({ kind: 'none' });
  });

  it('refuses "group" when the selection includes a group node (组不嵌套)', () => {
    const nodes = [group('g1', ['x']), loose('b')];
    expect(computeGroupToolbar(['g1', 'b'], nodes)).toEqual({ kind: 'none' });
  });

  it('offers nothing for an empty selection', () => {
    expect(computeGroupToolbar([], [loose('a')])).toEqual({ kind: 'none' });
  });

  it('offers no ungroup for a LOCKED group — a locked group cannot be ungrouped', () => {
    const nodes: NodeGroupInfo[] = [
      { id: 'g1', isGroup: true, childIds: ['a', 'b'], locked: true },
      loose('a'),
      loose('b'),
    ];
    expect(computeGroupToolbar(['g1'], nodes)).toEqual({ kind: 'none' });
  });
});
