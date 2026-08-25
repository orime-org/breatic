// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import { attachOccupants } from '@web/spaces/canvas/attach-occupants';

/**
 * Build a flow node the way `toFlowNode` hands one over.
 * @param id - The node id.
 * @param data - Its data record.
 * @returns The node.
 */
function node(id: string, data: Record<string, unknown> = { name: 'a' }): Node {
  return { id, type: 'image', position: { x: 0, y: 0 }, data };
}

describe('attachOccupants', () => {
  it('puts the holders on the node', () => {
    const attached = attachOccupants(node('n1'), new Map([['n1', ['alice']]]));

    expect(attached.data.occupants).toEqual(['alice']);
  });

  it('keeps everything else in data', () => {
    const attached = attachOccupants(
      node('n1', { name: 'poster', status: 'idle' }),
      new Map([['n1', ['alice']]]),
    );

    expect(attached.data.name).toBe('poster');
    expect(attached.data.status).toBe('idle');
  });

  it('hands back the same node when nobody is holding it', () => {
    // Reference identity is what lets the mirror reuse the previous object and
    // React.memo bail. Almost every node on a canvas is in this branch.
    const original = node('n1');

    expect(attachOccupants(original, new Map())).toBe(original);
  });

  it('hands back the same node when the table holds only other nodes', () => {
    const original = node('n1');

    expect(attachOccupants(original, new Map([['n2', ['alice']]]))).toBe(original);
  });

  it('leaves the original untouched', () => {
    const original = node('n1');

    attachOccupants(original, new Map([['n1', ['alice']]]));

    expect(original.data.occupants).toBeUndefined();
  });
});
