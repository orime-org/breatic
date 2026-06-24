// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { computeGroupToolbar } from '@web/spaces/canvas/group-toolbar';
import type { NodeGroupInfo } from '@web/spaces/canvas/group-toolbar';

/** Build a loose (un-grouped) content node info. */
function loose(id: string): NodeGroupInfo {
  return { id, isGroup: false };
}
/** Build a Group node info (optionally locked). */
function group(id: string, locked = false): NodeGroupInfo {
  return { id, isGroup: true, locked };
}
/** Build a content node that is a member of Group `parentId`. */
function member(id: string, parentId: string): NodeGroupInfo {
  return { id, isGroup: false, parentId };
}

describe('computeGroupToolbar — selection → floating-toolbar offer', () => {
  it('offers "group" when ≥2 loose nodes are selected', () => {
    const nodes = [loose('a'), loose('b'), loose('c')];
    expect(computeGroupToolbar(['a', 'b'], nodes)).toEqual({ kind: 'group' });
  });

  it('offers nothing for a single loose node (a group needs ≥2)', () => {
    expect(computeGroupToolbar(['a'], [loose('a')])).toEqual({ kind: 'none' });
  });

  it('offers "ungroup" with the Group id when exactly one Group is selected', () => {
    const nodes = [group('g1'), member('a', 'g1'), member('b', 'g1')];
    expect(computeGroupToolbar(['g1'], nodes)).toEqual({
      kind: 'ungroup',
      groupId: 'g1',
    });
  });

  it('refuses "group" when the selection includes an already-grouped member (Group 不嵌套 / 只组散节点)', () => {
    const nodes = [group('g1'), member('a', 'g1'), loose('b')];
    // a is already in g1 (parentId); selecting a + b cannot be grouped.
    expect(computeGroupToolbar(['a', 'b'], nodes)).toEqual({ kind: 'none' });
  });

  it('refuses "group" when the selection includes a Group node (Group 不嵌套)', () => {
    const nodes = [group('g1'), member('x', 'g1'), loose('b')];
    expect(computeGroupToolbar(['g1', 'b'], nodes)).toEqual({ kind: 'none' });
  });

  it('offers nothing for an empty selection', () => {
    expect(computeGroupToolbar([], [loose('a')])).toEqual({ kind: 'none' });
  });

  it('offers no ungroup for a LOCKED Group — a locked Group cannot be ungrouped', () => {
    const nodes = [group('g1', true), member('a', 'g1'), member('b', 'g1')];
    expect(computeGroupToolbar(['g1'], nodes)).toEqual({ kind: 'none' });
  });
});
