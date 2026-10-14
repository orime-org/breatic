// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which of a canvas node's fields an over-limit canvas keeps, by the field
 * and the node's kind (inner#1413 design 6.7.2).
 */

import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, ModelCatalog, NodeType, ParamDescriptor } from '@breatic/shared';

import { addNode, getLyricsFragment, getPromptFragment, getTextBody, readEdges, readNodes } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { setStoryboardShots } from '@web/data/yjs/node-storyboard';
import { snapshotOfPick } from '@web/spaces/canvas/attach-nodes';
import { pickReaders } from '@web/spaces/canvas/pick-for-agent';
import { ARRAY_FIELD_RULES, FIELD_RULES, fitPartsOf } from '@web/pages/project/chat/canvas-fields';

const PID = 'p1';
const SID = 's1';
const URL = 'https://assets.example.com/a.png';
const CATALOG = { image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1 } as unknown as ModelCatalog;

/**
 * Types a paragraph into a fragment.
 * @param fragment - Where to type.
 * @param text - What to type.
 */
function typeInto(fragment: Y.XmlFragment | null, text: string): void {
  if (!fragment) throw new Error('no fragment');
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

/** Every stored field a node can carry, filled. */
const EVERY_FIELD: CanvasNodeFields['data'] = {
  name: 'Node',
  createdAt: 1,
  createdBy: 'u1',
  locked: false,
  taskCounts: { running: 0, done: 1, failed: 0, expired: 0 },
  taskResultEventId: '1700-3',
  content: URL,
  coverUrl: URL,
  width: 10,
  height: 10,
  mediaWidth: 10,
  mediaHeight: 10,
  duration: 3,
  mimeType: 'image/png',
  size: 1,
  sourceNodeId: 'n0',
  operation: 'upscale',
  operationParams: { scale: 2 },
  mode: 't2v',
  model: 'm1',
  modelByMode: { t2v: 'm1' },
  paramsByModel: { m1: { seed: 1 } },
  styleImageUrls: [URL],
  firstFrameUrl: URL,
  endFrameUrl: URL,
  characterImageUrl: URL,
  drivingVideo: { url: URL, cover: URL },
  drivingAudio: { url: URL },
  refAudio: { url: URL },
  sourceVideo: { url: URL },
  leftAudio: { url: URL },
  rightAudio: { url: URL },
  musicSong: { url: URL },
  coverSong: { url: URL },
  musicMelody: { url: URL },
  musicVocal: { url: URL },
  soundVideo: { url: URL },
  moodImageUrl: URL,
  focusImages: [{ id: 'f1', url: URL, name: 'face', width: 1, height: 1 }],
  editedAt: 2,
  replies: [{ id: 'r1', content: 'agreed', createdBy: 'u2', createdAt: 3, editedAt: 4 }],
  backgroundColor: 'red',
  attachments: [{ id: 'a1', url: URL, name: 'deck', mimeType: 'application/pdf', size: 1, uploadedAt: '2026-10-11T00:00:00.000Z' }],
};

beforeEach(() => {
  _resetForTests();
});

describe('the field table', () => {
  it('names every field a real node of every kind is handed over with', () => {
    const kinds: NodeType[] = ['text', 'image', 'video', 'audio', 'annotation', 'group'];
    for (const [i, type] of kinds.entries()) {
      addNode(PID, SID, { id: `n${String(i)}`, type, position: { x: 0, y: 0 }, data: { ...EVERY_FIELD } });
    }
    typeInto(getPromptFragment(PID, SID, 'n2', 't2v'), 'a boat');
    typeInto(getLyricsFragment(PID, SID, 'n3', 't2m'), 'la la');
    typeInto(getTextBody(PID, SID, 'n0'), 'the hero arrives');
    typeInto(setStoryboardShots(PID, SID, 'n2', [3])[0] ?? null, 'shot one');
    const doc = getDoc(docName.canvasSpace(PID, SID));
    const nodes = readNodes(doc);
    const snapshot = snapshotOfPick({ nodes, edges: readEdges(doc) }, nodes.map((n) => n.id), pickReaders(new QueryClient(), CATALOG, doc));

    const unnamed: string[] = [];
    for (const entry of snapshot?.nodes ?? []) {
      const data = entry.data as Record<string, unknown>;
      for (const [key, value] of Object.entries(data)) {
        if (!(key in FIELD_RULES)) unnamed.push(`${String(entry.type)}.${key}`);
        const element = ARRAY_FIELD_RULES[key as keyof typeof ARRAY_FIELD_RULES];
        if (element !== undefined && Array.isArray(value)) {
          for (const item of value as Array<Record<string, unknown>>) {
            for (const sub of Object.keys(item)) if (!(sub in element)) unnamed.push(`${String(entry.type)}.${key}[].${sub}`);
          }
        }
      }
    }
    expect(snapshot?.nodes).toHaveLength(kinds.length);
    expect(unnamed).toEqual([]);
  });
});

/** A snapshot entry shaped as `snapshotOfPick` makes one. */
type Entry = Record<string, unknown> & { id: string };

/**
 * A node entry with the given data.
 * @param type - Its kind.
 * @param data - Its data.
 * @param current - What it would run, if it generates.
 * @returns The entry.
 */
function entryOf(type: string, data: Record<string, unknown>, current?: Record<string, unknown>): Entry {
  return {
    id: 'n1',
    type,
    position: { x: 5, y: 5 },
    parentId: 'g1',
    data: { name: 'Shot', createdAt: 1, createdBy: 'u1', ...data },
    ...(current ? { current } : {}),
  };
}

describe('a slim entry', () => {
  it('keeps who it is, what it points at and what it says, and nothing else', () => {
    const { slim } = fitPartsOf(
      entryOf('image', { content: URL, prompt: 'a boat', paramsByModel: { m1: { seed: 1 } }, modelByMode: { t2i: 'm1' } }),
      undefined,
    );

    expect(slim).toEqual({ id: 'n1', type: 'image', parentId: 'g1', data: { name: 'Shot', content: URL, prompt: 'a boat' } });
  });

  it('reads a content field by the node kind: an address on a picture, words on a sticky, nothing on a text node', () => {
    expect(fitPartsOf(entryOf('image', { content: URL }), undefined).texts).toEqual([]);
    expect(fitPartsOf(entryOf('annotation', { content: 'move this left' }), undefined).texts).toEqual([
      { path: ['data', 'content'], text: 'move this left' },
    ]);
    expect(fitPartsOf(entryOf('text', { content: 'old words', body: 'new words' }), undefined).slim).toEqual({
      id: 'n1',
      type: 'text',
      parentId: 'g1',
      data: { name: 'Shot', body: 'new words' },
    });
  });

  it('keeps only the prompt, lyrics and shots of the mode in effect', () => {
    const { slim, texts } = fitPartsOf(
      entryOf(
        'video',
        { mode: 't2v', prompts: { t2v: 'a boat', i2v: 'a car' }, shots: [{ id: 's1', prompt: 'one', duration: 3 }] },
        { mode: 't2v', model: 'm1', params: {} },
      ),
      {},
    );

    expect((slim.data as Record<string, unknown>).prompts).toEqual({ t2v: 'a boat' });
    expect(slim.data).not.toHaveProperty('shots');
    expect(texts).toEqual([{ path: ['data', 'prompts', 't2v'], text: 'a boat' }]);
  });

  it('keeps the multi-shot mode shots with their prompts as words', () => {
    const { slim, texts } = fitPartsOf(
      entryOf('video', { shots: [{ id: 's1', prompt: 'one', duration: 3 }] }, { mode: 'multi_shot', model: 'm1', params: {} }),
      {},
    );

    expect((slim.data as Record<string, unknown>).shots).toEqual([{ id: 's1', prompt: 'one', duration: 3 }]);
    expect(texts).toEqual([{ path: ['data', 'shots', 0, 'prompt'], text: 'one' }]);
  });

  it('keeps the mode and model the reader picked when nothing would run', () => {
    const { slim } = fitPartsOf(entryOf('image', { mode: 't2i', model: 'm1', prompts: { t2i: 'a boat' } }), undefined);

    expect(slim.data).toMatchObject({ mode: 't2i', model: 'm1', prompts: { t2i: 'a boat' } });
  });

  it('reads a run setting by what the model says it is', () => {
    const params: Record<string, ParamDescriptor> = {
      voice: { default: 'v1' },
      script: { type: 'text' },
      pronunciation_dict: { type: 'items', fields: { text: { type: 'text' }, pronunciation: { type: 'text' } } },
      speakers: { type: 'items', fields: { speaker: { type: 'text' }, voice: { values: ['v1'] } } },
    } as unknown as Record<string, ParamDescriptor>;
    const { slim, texts } = fitPartsOf(
      entryOf('audio', {}, {
        mode: 'tts',
        model: 'm1',
        params: {
          voice: 'Chinese (Mandarin)_Unrestrained_Young_Man',
          script: 'hello there',
          pronunciation_dict: [{ text: 'Orime', pronunciation: 'or-eem' }],
          speakers: [{ speaker: 'Ann', voice: 'v1' }],
        },
      }),
      params,
    );

    expect(slim.current).toEqual({
      mode: 'tts',
      model: 'm1',
      params: {
        voice: 'Chinese (Mandarin)_Unrestrained_Young_Man',
        script: 'hello there',
        pronunciation_dict: [{ text: 'Orime', pronunciation: 'or-eem' }],
        speakers: [{ speaker: 'Ann', voice: 'v1' }],
      },
    });
    expect(texts.map((t) => t.path)).toEqual([
      ['current', 'params', 'script'],
      ['current', 'params', 'pronunciation_dict', 0, 'text'],
      ['current', 'params', 'pronunciation_dict', 0, 'pronunciation'],
      ['current', 'params', 'speakers', 0, 'speaker'],
    ]);
  });
});

describe('a names-only entry', () => {
  it('is the id, kind, group and name', () => {
    expect(fitPartsOf(entryOf('image', { prompt: 'a boat' }), undefined).named).toEqual({
      id: 'n1',
      type: 'image',
      parentId: 'g1',
      name: 'Shot',
    });
  });

  it('names a sticky by the start of what it says', () => {
    const words = 'move the hero to the left of the frame please';

    expect(fitPartsOf(entryOf('annotation', { name: 'Note', content: words }), undefined).named.name).toBe(words.slice(0, 40));
  });

  it('is what a group goes as once it is slim', () => {
    const parts = fitPartsOf(entryOf('group', { backgroundColor: 'red', width: 10 }), undefined);

    expect(parts.slim).toEqual(parts.named);
  });
});
