// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Canvas text pasted into the chat box becomes an attachment.

import { describe, it, expect } from 'vitest';

import { pastedCanvas } from '@web/pages/project/chat/paste-canvas';
import type { ClipboardNode } from '@web/spaces/canvas/node-clipboard';

const picture: ClipboardNode = {
  type: 'image',
  position: { x: 0, y: 0 },
  name: 'Neon street',
  content: 'https://img.example/neon.jpg',
  external: true,
};
const group: ClipboardNode = { type: 'group', position: { x: 0, y: 0 }, name: 'Shots', id: 'g1' };
const member: ClipboardNode = { type: 'text', position: { x: 10, y: 10 }, content: 'hi', id: 'n1', parentId: 'g1' };
const loose: ClipboardNode = { type: 'image', position: { x: 50, y: 0 }, content: 'https://cdn/x.png', id: 'n2' };

describe('canvas text pasted into the chat box', () => {
  it('makes a picture copied from a reply an image attachment', () => {
    const pasted = pastedCanvas([picture], () => false);

    expect(pasted?.kind).toBe('item');
    if (pasted?.kind !== 'item') return;
    expect(pasted.item.type).toBe('image');
    expect(pasted.item.name).toBe('Neon street');
    expect(pasted.item.chip?.data_snapshot).toEqual({ url: 'https://img.example/neon.jpg' });
    expect(pastedCanvas([picture], () => false)).toEqual(pasted);
  });

  it('hands nodes still on the canvas to the agent as a pick of the top-level ones', () => {
    expect(pastedCanvas([group, member, loose], () => true)).toEqual({ kind: 'onCanvas', ids: ['g1', 'n2'] });
  });

  it('snapshots nodes the canvas does not have, named after a lone top-level one', () => {
    const pasted = pastedCanvas([group, member], (id) => id !== 'g1');

    expect(pasted?.kind).toBe('item');
    if (pasted?.kind !== 'item') return;
    expect(pasted.item.type).toBe('canvas');
    expect(pasted.item.name).toBe('Shots');
    expect(pasted.item.chip?.data_snapshot).toEqual({
      nodes: [
        { id: 'g1', type: 'group', position: { x: 0, y: 0 }, data: { kind: 'group', name: 'Shots' } },
        { id: 'n1', type: 'text', position: { x: 10, y: 10 }, parentId: 'g1', data: { kind: 'text', body: 'hi' } },
      ],
      edges: [],
    });
    expect(pastedCanvas([group, member], () => false)).toEqual(pasted);
  });

  it('names a picture with no title after the file in its address', () => {
    const bare = { ...picture, name: undefined, content: 'https://img.example/path/neon-night.jpg?w=64' };
    const pasted = pastedCanvas([bare], () => false);

    expect(pasted?.kind === 'item' ? pasted.item.name : null).toBe('neon-night.jpg');
  });

  it('gives nothing for an empty payload', () => {
    expect(pastedCanvas([], () => true)).toBeNull();
  });
});
