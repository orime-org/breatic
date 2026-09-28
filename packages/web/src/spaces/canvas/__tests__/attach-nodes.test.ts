// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas hands the chat when nodes are added to the agent.
 *
 * Each node goes as a snapshot of its data with its words as plain text; a
 * group goes as its members; kinds that are not canvas features are left out.
 */
import { describe, expect, it } from 'vitest';

import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { itemsForNodes } from '@web/spaces/canvas/attach-nodes';

/**
 * A node on the canvas.
 * @param id - Its id.
 * @param data - Its view data.
 * @param parentId - The group it sits in.
 * @returns The node.
 */
function node(id: string, data: Record<string, unknown>, parentId?: string): CanvasNodeView {
  return {
    id,
    type: data.kind as CanvasNodeView['type'],
    position: { x: 0, y: 0 },
    ...(parentId ? { parentId } : {}),
    data: data as unknown as CanvasNodeView['data'],
  };
}

const IMAGE = node('i1', { kind: 'image', name: 'Cover', content: 'https://cdn.example/c.png' });
const TEXT = node('t1', { kind: 'text', name: 'Script' });
const GROUP = node('g1', { kind: 'group', name: 'Shots' });
const IN_GROUP = node('v1', { kind: 'video', name: 'Opening' }, 'g1');
const MODEL = node('m1', { kind: '3d', name: 'Model' });
const NOTE = node('a1', { kind: 'annotation', content: 'Check the colours here', replies: [] });
const ALL = [IMAGE, TEXT, GROUP, IN_GROUP, MODEL, NOTE];

const readers = {
  bodyOf: (id: string) => (id === 't1' ? 'Line one\nLine two' : undefined),
  promptOf: (id: string) => (id === 'i1' ? 'a red car at dusk' : undefined),
};

describe('nodes handed to the agent', () => {
  it('sends a node as a snapshot of its data, its prompt as plain text', () => {
    const [item] = itemsForNodes(ALL, ['i1'], readers);

    expect(item).toEqual({
      id: 'i1',
      name: 'Cover',
      type: 'image',
      status: 'ready',
      chip: {
        id: 'i1',
        type: 'image',
        name: 'Cover',
        data_snapshot: {
          kind: 'image',
          name: 'Cover',
          content: 'https://cdn.example/c.png',
          prompt: 'a red car at dusk',
        },
      },
    });
  });

  it('carries a text node its words as plain text', () => {
    const [item] = itemsForNodes(ALL, ['t1'], readers);

    expect(item?.chip?.data_snapshot).toMatchObject({ text: 'Line one\nLine two' });
  });

  it('hands a group over as its members', () => {
    expect(itemsForNodes(ALL, ['g1'], readers).map((i) => i.id)).toEqual(['v1']);
  });

  it('names each node once, even when picked alone and inside its group', () => {
    expect(itemsForNodes(ALL, ['v1', 'g1'], readers).map((i) => i.id)).toEqual(['v1']);
  });

  it('leaves out kinds that are not canvas features', () => {
    expect(itemsForNodes(ALL, ['m1'], readers)).toEqual([]);
  });

  it('names a note by its own words, having no name', () => {
    const [item] = itemsForNodes(ALL, ['a1'], readers);

    expect(item).toMatchObject({ type: 'annotation', name: 'Check the colours here' });
  });

  it('skips an id no longer on the canvas', () => {
    expect(itemsForNodes(ALL, ['gone'], readers)).toEqual([]);
  });
});
