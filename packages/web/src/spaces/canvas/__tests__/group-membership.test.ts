// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import {
  rectContains,
  resolveGroupDrop,
  type GroupBox,
} from '@web/spaces/canvas/group-membership';

const RECT = { x: 0, y: 0, width: 100, height: 100 };

describe('rectContains — point-in-rect', () => {
  it('is true for an interior point', () => {
    expect(rectContains(RECT, { x: 50, y: 50 })).toBe(true);
  });
  it('is true on the edge (inclusive)', () => {
    expect(rectContains(RECT, { x: 0, y: 100 })).toBe(true);
  });
  it('is false outside', () => {
    expect(rectContains(RECT, { x: 150, y: 50 })).toBe(false);
  });
});

/** A group at the unit rect with the given members. */
function box(id: string, childIds: string[], rect = RECT): GroupBox {
  return { id, rect, childIds };
}

describe('resolveGroupDrop — drag-end membership change', () => {
  it('adds a loose node dropped inside a group', () => {
    const groups = [box('g1', ['x'])];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'add',
      groupId: 'g1',
    });
  });

  it('does nothing for a loose node dropped on empty canvas', () => {
    const groups = [box('g1', ['x'])];
    expect(resolveGroupDrop('n', { x: 999, y: 999 }, groups)).toEqual({
      action: 'none',
    });
  });

  it('removes a member dragged out of its group', () => {
    const groups = [box('g1', ['n', 'x'])];
    expect(resolveGroupDrop('n', { x: 999, y: 999 }, groups)).toEqual({
      action: 'remove',
      groupId: 'g1',
    });
  });

  it('does nothing when a member stays inside its own group', () => {
    const groups = [box('g1', ['n', 'x'])];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'none',
    });
  });

  it('moves a member dropped into a different group (add to the new one)', () => {
    const groups = [
      box('g1', ['n'], { x: 0, y: 0, width: 100, height: 100 }),
      box('g2', ['y'], { x: 200, y: 0, width: 100, height: 100 }),
    ];
    expect(resolveGroupDrop('n', { x: 250, y: 50 }, groups)).toEqual({
      action: 'add',
      groupId: 'g2',
    });
  });

  it('does NOT add a node dropped into a LOCKED group (frozen membership)', () => {
    const groups: GroupBox[] = [
      { id: 'g1', rect: RECT, childIds: ['x'], locked: true },
    ];
    expect(resolveGroupDrop('n', { x: 50, y: 50 }, groups)).toEqual({
      action: 'none',
    });
  });
});
