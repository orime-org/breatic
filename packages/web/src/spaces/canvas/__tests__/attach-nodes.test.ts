// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas hands the chat when nodes are added to the agent.
 *
 * One press hands over one item: the picked piece of the canvas as it is --
 * its nodes, where they sit, the groups they are in and the links between them.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { CanvasEdge, CanvasNodeView } from '@web/data/yjs/canvas-space';
import { itemForPick } from '@web/spaces/canvas/attach-nodes';

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

const EDGES: CanvasEdge[] = [
  { id: 'e1', source: 'i1', target: 'v1' },
  { id: 'e2', source: 't1', target: 'x9' },
];
const GRAPH = { nodes: ALL, edges: EDGES };

/**
 * The snapshot of one pick.
 * @param picked - The ids picked.
 * @returns The data handed over.
 */
function snapshot(picked: string[]): { nodes: Array<Record<string, unknown>>; edges: CanvasEdge[] } {
  const item = itemForPick(GRAPH, picked, readers);
  return item?.chip?.data_snapshot as { nodes: Array<Record<string, unknown>>; edges: CanvasEdge[] };
}

describe('a piece of the canvas handed to the agent', () => {
  it('goes as one item however many nodes were picked', () => {
    const item = itemForPick(GRAPH, ['i1', 't1', 'v1'], readers);

    expect(item).toMatchObject({ type: 'canvas', status: 'ready', name: '' });
    expect(snapshot(['i1', 't1', 'v1']).nodes.map((n) => n.id)).toEqual(['i1', 't1', 'v1']);
  });

  it('keeps where each node sits and the group it is in', () => {
    const [video] = snapshot(['v1']).nodes;

    expect(video).toMatchObject({ id: 'v1', type: 'video', position: { x: 0, y: 0 }, parentId: 'g1' });
  });

  it('keeps the links between the picked nodes, and only those', () => {
    expect(snapshot(['i1', 't1', 'v1']).edges).toEqual([{ id: 'e1', source: 'i1', target: 'v1' }]);
  });

  it('carries each node its data with its words as plain text', () => {
    const [text] = snapshot(['t1']).nodes;

    expect(text?.data).toEqual({ kind: 'text', name: 'Script', body: 'Line one\nLine two', prompt: '' });
  });

  it('turns every fragment into plain text, mentions read as their label', () => {
    const withMarkup = node('v1', {
      kind: 'video',
      name: 'Opening',
      prompt: '<paragraph>stale</paragraph>',
      lyrics: '<paragraph>stale</paragraph>',
    });
    const item = itemForPick({ nodes: [withMarkup], edges: [] }, ['v1'], readers);

    expect(JSON.stringify(item?.chip?.data_snapshot)).not.toContain('<paragraph>');
    expect(JSON.stringify(item?.chip?.data_snapshot)).toContain('Use @Image 1 as the style');
  });

  it('names a single node by its own name', () => {
    expect(itemForPick(GRAPH, ['i1'], readers)).toMatchObject({ name: 'Cover' });
  });

  it('hands a group over with its members, named after the group', () => {
    const item = itemForPick(GRAPH, ['g1'], readers);

    expect(item).toMatchObject({ name: 'Shots' });
    expect(snapshot(['g1']).nodes.map((n) => n.id)).toEqual(['g1', 'v1']);
  });

  it('names each node once, even when picked alone and inside its group', () => {
    expect(snapshot(['v1', 'g1']).nodes.map((n) => n.id)).toEqual(['v1', 'g1']);
  });

  it('leaves out kinds that are not canvas features', () => {
    expect(snapshot(['i1', 'm1']).nodes.map((n) => n.id)).toEqual(['i1']);
  });

  it('hands nothing over when nothing picked can be', () => {
    expect(itemForPick(GRAPH, ['m1', 'gone'], readers)).toBeNull();
  });

  it('gives the same pick the same id, in any order', () => {
    expect(itemForPick(GRAPH, ['t1', 'i1'], readers)?.id).toBe(itemForPick(GRAPH, ['i1', 't1'], readers)?.id);
    expect(itemForPick(GRAPH, ['i1'], readers)?.id).not.toBe(itemForPick(GRAPH, ['t1'], readers)?.id);
  });

  it('names a note by its own words, having no name', () => {
    expect(itemForPick(GRAPH, ['a1'], readers)).toMatchObject({ name: 'Check the colours here' });
  });

  it('places a group member where it sits on the canvas, keeping its group', () => {
    const group = { ...node('g2', { kind: 'group', name: 'Scene' }), position: { x: 1000, y: 1000 } };
    const member = { ...node('i2', { kind: 'image', name: 'Shot' }, 'g2'), position: { x: 24, y: 40 } };
    const loose = { ...node('i3', { kind: 'image', name: 'Loose' }), position: { x: 1030, y: 1050 } };
    const item = itemForPick({ nodes: [group, member, loose], edges: [] }, ['i2', 'i3'], readers);
    const nodes = (item?.chip?.data_snapshot as { nodes: Array<Record<string, unknown>> }).nodes;

    expect(nodes[0]).toMatchObject({ id: 'i2', position: { x: 1024, y: 1040 }, parentId: 'g2' });
    expect(nodes[1]).toMatchObject({ id: 'i3', position: { x: 1030, y: 1050 } });
  });
});
