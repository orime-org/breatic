// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';
import type { Node } from '@xyflow/react';

import {
  applyOccupants,
  attachOccupants,
} from '@web/spaces/canvas/attach-occupants';

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

describe('applyOccupants', () => {
  it('leaves every position alone', () => {
    // The reason this exists: presence arriving on its own must not send a
    // node back to the position Yjs still has for it, which is where it was
    // before the drag now in progress.
    const dragged = {
      ...node('n1'),
      position: { x: 400, y: 250 },
      dragging: true,
    };

    const [after] = applyOccupants([dragged], new Map([['n1', ['alice']]]));

    expect(after?.position).toEqual({ x: 400, y: 250 });
    expect(after?.dragging).toBe(true);
    expect(after?.data.occupants).toEqual(['alice']);
  });

  it('takes the holders off a node nobody holds any more', () => {
    const held = attachOccupants(node('n1'), new Map([['n1', ['alice']]]));

    const [after] = applyOccupants([held], new Map());

    expect(after?.data).not.toHaveProperty('occupants');
    expect(after?.data.name).toBe('a');
  });

  it('hands back the same array when no holdings changed', () => {
    // A remote pointer moves thirty times a second and the table it produces
    // is compared by value upstream, but an unrelated change still arrives
    // here: publishing a fresh array for it would re-render every node.
    const buffer = [node('n1'), attachOccupants(node('n2'), new Map([['n2', ['alice']]]))];

    expect(applyOccupants(buffer, new Map([['n2', ['alice']]]))).toBe(buffer);
  });

  it('keeps the object of every node whose holders did not change', () => {
    const untouched = node('n1');
    const buffer = [untouched, node('n2')];

    const after = applyOccupants(buffer, new Map([['n2', ['alice']]]));

    expect(after[0]).toBe(untouched);
    expect(after[1]).not.toBe(buffer[1]);
  });

  it('sees a node change hands', () => {
    const held = attachOccupants(node('n1'), new Map([['n1', ['alice']]]));

    const [after] = applyOccupants([held], new Map([['n1', ['bob']]]));

    expect(after?.data.occupants).toEqual(['bob']);
  });

  it('compares holders by value, so a rebuilt list is not a change', () => {
    // `collectNodeOccupants` builds fresh arrays every read; comparing them by
    // identity would call every node changed on every awareness frame.
    const held = attachOccupants(node('n1'), new Map([['n1', ['alice']]]));

    expect(applyOccupants([held], new Map([['n1', ['alice']]]))[0]).toBe(held);
  });
});
