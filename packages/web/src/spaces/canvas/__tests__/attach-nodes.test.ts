// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas hands the chat when nodes are added to the agent.
 *
 * Each node goes as a snapshot of its data with its words as plain text; a
 * group goes as its members; kinds that are not canvas features are left out.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

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

/**
 * A paragraph of text, as the editors write one.
 * @param text - Its words; none for a blank line.
 * @returns The block.
 */
function paragraph(text?: string): Y.XmlElement {
  const block = new Y.XmlElement('paragraph');
  if (text) block.insert(0, [new Y.XmlText(text)]);
  return block;
}

/**
 * A reference mention, as the prompt editor writes one.
 * @param label - The name of the node it points at.
 * @returns The element.
 */
function mention(label: string): Y.XmlElement {
  const element = new Y.XmlElement('referenceMention');
  element.setAttribute('label', label);
  element.setAttribute('kind', 'image');
  return element;
}

/**
 * The fragments each node holds, attached to one document so they can be read.
 * @returns A reader by node id.
 */
function fragments(): (id: string) => Record<string, Y.XmlFragment> {
  const doc = new Y.Doc();
  const byNode: Record<string, Record<string, Y.XmlFragment>> = {};
  /**
   * Attach a fragment holding some blocks.
   * @param id - The node.
   * @param key - The field it sits under.
   * @param blocks - What it holds.
   */
  const put = (id: string, key: string, blocks: Y.XmlElement[]): void => {
    const fragment = doc.getXmlFragment(`${id}.${key}`);
    fragment.insert(0, blocks);
    byNode[id] = { ...byNode[id], [key]: fragment };
  };
  put('i1', 'prompt', [paragraph('a red car at dusk')]);
  put('t1', 'body', [paragraph('Line one'), paragraph('Line two')]);
  put('t1', 'prompt', [paragraph()]);
  const styled = paragraph('Use ');
  styled.insert(1, [mention('Image 1'), new Y.XmlText(' as the style')]);
  put('v1', 'prompt', [styled]);
  put('v1', 'lyrics', [paragraph('La la')]);
  return (id) => byNode[id] ?? {};
}

const readers = { fragmentsOf: fragments() };

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

  it('carries a text node its words as plain text, once', () => {
    const [item] = itemsForNodes(ALL, ['t1'], readers);

    expect(item?.chip?.data_snapshot).toEqual({
      kind: 'text',
      name: 'Script',
      body: 'Line one\nLine two',
      prompt: '',
    });
  });

  it('turns every fragment a node holds into plain text, markup and all', () => {
    const withMarkup = node('v1', {
      kind: 'video',
      name: 'Opening',
      prompt: '<paragraph>stale</paragraph>',
      lyrics: '<paragraph>stale</paragraph>',
    });
    const [item] = itemsForNodes([withMarkup], ['v1'], readers);

    expect(item?.chip?.data_snapshot).toMatchObject({ prompt: 'Use @Image 1 as the style', lyrics: 'La la' });
    expect(JSON.stringify(item?.chip?.data_snapshot)).not.toContain('<paragraph>');
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
