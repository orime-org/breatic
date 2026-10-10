// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import { planDuplicateGroupGrowth } from '@web/spaces/canvas/duplicate-group-growth';

// A Group with one member; the member is duplicated, and its copy sits 24px
// below and right of it inside the same Group.
const member: Node = { id: 'm', parentId: 'g', position: { x: 40, y: 40 }, data: {}, measured: { width: 100, height: 80 } };
const copy = { id: 'c', parentId: 'g', position: { x: 64, y: 64 } };
const sourceOf = new Map([['c', 'm']]);

/**
 * The Group node at a canvas position.
 * @param x - Its left.
 * @param y - Its top.
 * @returns The node.
 */
const groupAt = (x: number, y: number): Node => ({
  id: 'g',
  type: 'group',
  position: { x, y },
  data: {},
  width: 400,
  height: 300,
});

describe('planDuplicateGroupGrowth', () => {
  it('measures the members around the Group where it is now', () => {
    // The Group was dragged from (0, 0) to (500, 0) while the duplicate
    // waited on the server; the copy is written into it where it is now.
    const growth = planDuplicateGroupGrowth(sourceOf, [copy], [
      groupAt(500, 0),
      member,
    ]);
    expect(growth).toEqual([]);
  });

  it('grows the Group to keep its padding around a copy at its edge', () => {
    const edge = { id: 'c', parentId: 'g', position: { x: 320, y: 64 } };
    const [growth] = planDuplicateGroupGrowth(sourceOf, [edge], [
      groupAt(500, 0),
      member,
    ]);
    expect(growth?.groupId).toBe('g');
    expect(growth?.width).toBeGreaterThan(400);
    expect(growth?.position.x).toBe(500);
  });
});
