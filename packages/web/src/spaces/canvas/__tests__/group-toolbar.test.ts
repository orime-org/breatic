// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import { computeGroupToolbar } from '@web/spaces/canvas/group-toolbar';
import type { NodeGroupInfo } from '@web/spaces/canvas/group-toolbar';

/** Build a loose (un-grouped) content node info. */
function loose(id: string): NodeGroupInfo {
  return { id, isGroup: false };
}
/** Build a collapsed annotation's info: a node no Group may hold. */
function note(id: string): NodeGroupInfo {
  return { id, isGroup: false, isNote: true };
}
/** Build a Group node info (optionally locked), shaped the way production is. */
function group(id: string, locked = false): NodeGroupInfo {
  // CanvasSpace fills every field for every node; a fixture that omits one
  // stops seeing what production actually hands the rule.
  return { id, isGroup: true, isNote: false, locked };
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

  it('offers nothing when a Group is selected alongside two loose nodes', () => {
    // No nesting: a Group in the selection takes the offer away, however many
    // loose nodes are picked with it.
    expect(
      computeGroupToolbar(['g1', 'b', 'c'], [group('g1'), loose('b'), loose('c')]),
    ).toEqual({ kind: 'none' });
  });

  it('still offers "group" when a note is caught in the selection', () => {
    // Notes stay out of groups (user 2026-09-15) and stay selectable, so a
    // marquee that sweeps one up groups everything else and leaves it where
    // it is — `planGroupCreation` drops it the same way.
    expect(
      computeGroupToolbar(['a', 'b', 'note'], [loose('a'), loose('b'), note('note')]),
    ).toEqual({ kind: 'group' });
  });

  it('offers nothing when a note and one other node are all that is selected', () => {
    expect(
      computeGroupToolbar(['a', 'note'], [loose('a'), note('note')]),
    ).toEqual({ kind: 'none' });
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
