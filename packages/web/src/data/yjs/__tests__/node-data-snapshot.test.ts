// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A node's stored data travels through the clipboard as plain JSON and is
 * written back into a fresh node (inner#1349, design 5.2 and 5.3).
 *
 * The nested Yjs structures — a text body, per-mode prompts and lyrics, shots,
 * focus crops, sticky replies — become a schema-free tree, and the paste fills
 * them into the containers the fresh node was born with. Those containers are
 * never replaced: every mode's container has to exist from birth (#1880).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  nodeDataMap,
  writeSnapshotNodes,
} from '@web/data/yjs/canvas-space';
import { snapshotNodeData } from '@web/data/yjs/node-data-snapshot';

const PID = 'p1';
const SID = 's1';

/**
 * The canvas document under test.
 * @returns The doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * A paragraph holding the given runs, as the editor stores it.
 * @param runs - Text runs, each with optional marks.
 * @returns The paragraph element.
 */
function paragraph(...runs: Array<{ text: string; marks?: Record<string, unknown> }>): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  for (const run of runs) {
    const t = new Y.XmlText();
    t.insert(0, run.text, run.marks ?? {});
    p.push([t]);
  }
  return p;
}

/**
 * Fill a source node with every nested structure the clipboard has to carry.
 * @param id - The node id.
 * @param type - The node type.
 */
function seedSource(id: string, type: 'text' | 'video' | 'audio' | 'annotation'): void {
  addNode(PID, SID, {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { name: id, createdAt: 1, createdBy: 'u', locked: false } as never,
  });
  const data = nodeDataMap(doc(), id) as Y.Map<unknown>;
  doc().transact(() => {
    if (type === 'text') {
      const body = data.get('body') as Y.XmlFragment;
      body.delete(0, body.length);
      body.push([paragraph({ text: 'bold', marks: { bold: true } }, { text: ' plain' }), paragraph({ text: 'second' })]);
    }
    if (type === 'video' || type === 'audio') {
      const prompts = data.get('prompts') as Y.Map<Y.XmlFragment>;
      const modes = [...prompts.keys()];
      const mention = new Y.XmlElement('referenceMention');
      mention.setAttribute('sourceNodeId', 'up-1');
      mention.setAttribute('label', 'Up');
      const p = paragraph({ text: 'see ' });
      p.push([mention]);
      prompts.get(modes[0] as string)?.push([p]);
      prompts.get(modes[1] as string)?.push([paragraph({ text: 'other mode' })]);
      (data.get('focusImages') as Y.Array<unknown>).push([{ id: 'c1', url: 'https://x/c1.png' }]);
    }
    if (type === 'audio') {
      const lyrics = data.get('lyrics') as Y.Map<Y.XmlFragment>;
      lyrics.get([...lyrics.keys()][0] as string)?.push([paragraph({ text: 'la la' })]);
    }
    if (type === 'video') {
      const shot = new Y.Map<unknown>();
      const prompt = new Y.XmlFragment();
      shot.set('id', 's1');
      shot.set('prompt', prompt);
      shot.set('duration', 5);
      (data.get('shots') as Y.Array<Y.Map<unknown>>).push([shot]);
      prompt.push([paragraph({ text: 'shot one' })]);
    }
    if (type === 'annotation') {
      const reply = new Y.Map<unknown>();
      reply.set('id', 'r1');
      reply.set('body', 'a reply');
      (data.get('replies') as Y.Array<Y.Map<unknown>>).push([reply]);
    }
  });
}

/**
 * Snapshot a node, send it through JSON, and write it back under a new id.
 * @param from - The source node id.
 * @param to - The id the copy is written under.
 * @param type - The node type.
 */
function roundTrip(from: string, to: string, type: string): void {
  const snapshot = JSON.parse(JSON.stringify(snapshotNodeData(nodeDataMap(doc(), from) as Y.Map<unknown>)));
  writeSnapshotNodes(doc(), [{ id: to, type, position: { x: 50, y: 50 }, data: snapshot }], []);
}

describe('node data snapshot', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('carries a formatted text body without a leading empty paragraph', () => {
    seedSource('a', 'text');
    roundTrip('a', 'b', 'text');
    const body = nodeDataMap(doc(), 'b')?.get('body') as Y.XmlFragment;
    expect(body.length).toBe(2);
    expect(body.toString()).toBe((nodeDataMap(doc(), 'a')?.get('body') as Y.XmlFragment).toString());
    const first = (body.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    expect(first.toDelta()[0]).toEqual({ insert: 'bold', attributes: { bold: true } });
  });

  it('fills every mode of prompts in place, keeping mentions', () => {
    seedSource('a', 'video');
    roundTrip('a', 'b', 'video');
    const src = nodeDataMap(doc(), 'a')?.get('prompts') as Y.Map<Y.XmlFragment>;
    const copy = nodeDataMap(doc(), 'b')?.get('prompts') as Y.Map<Y.XmlFragment>;
    expect([...copy.keys()].sort()).toEqual([...src.keys()].sort());
    for (const mode of src.keys()) {
      expect(copy.get(mode)?.toString()).toBe(src.get(mode)?.toString());
    }
    expect(copy.get([...src.keys()][0] as string)?.toString()).toContain('sourceNodeId="up-1"');
  });

  it('keeps a container for every mode, even one the snapshot lacks', () => {
    seedSource('a', 'video');
    const snapshot = snapshotNodeData(nodeDataMap(doc(), 'a') as Y.Map<unknown>);
    const entries = (snapshot.prompts as { entries: Record<string, unknown> }).entries;
    const dropped = Object.keys(entries)[0] as string;
    delete entries[dropped];
    writeSnapshotNodes(doc(), [{ id: 'b', type: 'video', position: { x: 0, y: 0 }, data: snapshot }], []);
    const copy = nodeDataMap(doc(), 'b')?.get('prompts') as Y.Map<Y.XmlFragment>;
    expect(copy.get(dropped)).toBeInstanceOf(Y.XmlFragment);
  });

  it('carries shots, lyrics and focus crops once each', () => {
    seedSource('v', 'video');
    seedSource('m', 'audio');
    roundTrip('v', 'v2', 'video');
    roundTrip('m', 'm2', 'audio');
    const shots = nodeDataMap(doc(), 'v2')?.get('shots') as Y.Array<Y.Map<unknown>>;
    expect(shots.length).toBe(1);
    expect((shots.get(0).get('prompt') as Y.XmlFragment).toString()).toContain('shot one');
    expect(shots.get(0).get('duration')).toBe(5);
    expect((nodeDataMap(doc(), 'v2')?.get('focusImages') as Y.Array<unknown>).toJSON()).toEqual([
      { id: 'c1', url: 'https://x/c1.png' },
    ]);
    const lyrics = nodeDataMap(doc(), 'm2')?.get('lyrics') as Y.Map<Y.XmlFragment>;
    expect([...lyrics.values()].map((f) => f.toString()).join('')).toContain('la la');
  });

  it('carries sticky replies as entries of the seeded array', () => {
    seedSource('s', 'annotation');
    roundTrip('s', 's2', 'annotation');
    const replies = nodeDataMap(doc(), 's2')?.get('replies') as Y.Array<Y.Map<unknown>>;
    expect(replies.length).toBe(1);
    expect(replies.get(0)).toBeInstanceOf(Y.Map);
    expect(replies.get(0).toJSON()).toEqual({ id: 'r1', body: 'a reply' });
  });
});
