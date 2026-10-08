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
import type { ModelCatalog, ModelEntry } from '@breatic/shared';

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
const IN_GROUP = node('v1', { kind: 'video', name: 'Opening', mode: 't2v', model: 'kling' }, 'g1');
const MODEL = node('m1', { kind: '3d', name: 'Model' });
const NOTE = node('a1', { kind: 'annotation', content: 'Check the colours here', replies: [] });
const SPEECH = node('s1', { kind: 'audio', name: 'Voice', mode: 'tts' });
const ALL = [IMAGE, TEXT, GROUP, IN_GROUP, MODEL, NOTE, SPEECH];

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
 * A note, as a proposal or a template writes one at the top of a prompt.
 * @param label - What it says.
 * @returns The block.
 */
function note(label: string): Y.XmlElement {
  const element = new Y.XmlElement('promptNote');
  element.setAttribute('label', label);
  return element;
}

/**
 * A fragment holding some blocks.
 * @param blocks - What it holds.
 * @returns The fragment, not yet attached.
 */
function fragment(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const out = new Y.XmlFragment();
  out.insert(0, blocks);
  return out;
}

/**
 * A map holding the given entries.
 * @param entries - Its keys and values.
 * @returns The map, not yet attached.
 */
function ymap(entries: Record<string, unknown>): Y.Map<unknown> {
  const out = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) out.set(key, value);
  return out;
}

/**
 * Each node's stored data map, attached to one document so it can be read.
 * @returns A reader by node id.
 */
function dataMaps(): (id: string) => Y.Map<unknown> | null {
  const doc = new Y.Doc();
  const root = doc.getMap<Y.Map<unknown>>('data');
  const styled = paragraph('Use ');
  styled.insert(1, [mention('Image 1'), new Y.XmlText(' as the style')]);
  root.set('i1', ymap({
    prompts: ymap({ t2i: fragment(paragraph('a red car at dusk')), i2i: fragment(note('Pick the photo in the panel'), paragraph('make it blue')) }),
  }));
  root.set('t1', ymap({ body: fragment(paragraph('Line one'), paragraph('Line two')) }));
  const shots = new Y.Array<Y.Map<unknown>>();
  shots.push([ymap({ id: 's1', prompt: fragment(paragraph('a paper boat')), duration: 3 })]);
  root.set('v1', ymap({
    mode: 't2v',
    model: 'kling',
    prompts: ymap({ t2v: fragment(styled) }),
    shots,
  }));
  return (id) => root.get(id) ?? null;
}

/**
 * A video model serving text to video, with or without the multi-shot mode.
 * @param name - Its id.
 * @param storyboard - Whether it takes shots in the multi-shot mode.
 * @returns The entry.
 */
function videoModel(name: string, storyboard: boolean): ModelEntry {
  return {
    name,
    display_name: name,
    modality: 'video',
    mode: storyboard ? ['t2v', 'multi_shot'] : ['t2v'],
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params: {
      duration: { description: '', default: 5, values: [3, 5], fill: 'panel' },
      ...(storyboard
        ? {
          multi_prompt: {
            description: '',
            default: null,
            type: 'items',
            max_items: 6,
            modes: ['multi_shot'],
            fill: 'storyboard',
            fields: { prompt: { type: 'text' }, duration: { values: [1, 2, 3, 4, 5] } },
          },
          shot_type: { description: '', default: null, values: ['customize'], modes: ['multi_shot'], fill: 'storyboard' },
        }
        : {}),
    },
    providers: [],
  } as ModelEntry;
}

const SPEECH_MODEL = {
  ...videoModel('speech', false),
  modality: 'audio',
  mode: ['tts'],
  params: { voice_id: { description: '', default: null, remote_source: 'voices' } },
} as ModelEntry;

const CATALOG = {
  image: [], video: [videoModel('kling', true)], audio: [SPEECH_MODEL], tts: [], three_d: [], total: 2, credit_multiplier: 1,
} as unknown as ModelCatalog;

const readers = { dataOf: dataMaps(), catalog: CATALOG, firstVoiceOf: () => undefined };

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

    expect(text?.data).toEqual({ kind: 'text', name: 'Script', body: 'Line one\nLine two' });
  });

  it('turns every fragment into plain text, mentions read as their label', () => {
    const item = itemForPick(GRAPH, ['v1'], readers);

    expect(JSON.stringify(item?.chip?.data_snapshot)).not.toContain('<paragraph>');
    expect(JSON.stringify(item?.chip?.data_snapshot)).toContain('Use @Image 1 as the style');
  });

  it('gives the prompt of every mode, not only the one in use', () => {
    const [image] = snapshot(['i1']).nodes;

    expect(image?.data).toMatchObject({ prompts: { t2i: 'a red car at dusk', i2i: expect.stringContaining('make it blue') } });
  });

  it('gives the agent the notes at the top of a prompt too', () => {
    const [image] = snapshot(['i1']).nodes;

    expect(image?.data).toMatchObject({ prompts: { i2i: '(💡 Pick the photo in the panel)\nmake it blue' } });
  });

  it('gives the node its shots', () => {
    const [video] = snapshot(['v1']).nodes;

    expect(video?.data).toMatchObject({ shots: [{ id: 's1', prompt: 'a paper boat', duration: 3 }] });
  });

  it('says what the node would run right now', () => {
    const [video] = snapshot(['v1']).nodes;

    expect(video?.current).toEqual({ mode: 't2v', model: 'kling', params: { duration: 5 } });
  });

  it('says an audio node with no voice picked would send the first voice of its model', () => {
    const voiced = { ...readers, firstVoiceOf: (model: string) => (model === 'speech' ? { id: 'first' } : undefined) };
    const item = itemForPick(GRAPH, ['s1'], voiced);
    const [speech] = (item?.chip?.data_snapshot as { nodes: Array<Record<string, unknown>> }).nodes;

    expect(speech?.current).toMatchObject({ mode: 'tts', model: 'speech', params: { voice_id: 'first' } });
  });

  it('gives no current generation to a node that does not generate', () => {
    expect(snapshot(['t1']).nodes[0]).not.toHaveProperty('current');
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
