// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// Canvas text pasted into the chat box becomes an attachment (inner#1349,
// design 5.7): the card a paste makes is the card "Add to Agent" makes on the
// same nodes, because both come out of `pickForAgent`.

import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type ModelCatalog } from '@breatic/shared';

import { addEdge, addNode, nodeDataMap, readEdges } from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { snapshotNodeData } from '@web/data/yjs/node-data-snapshot';
import { pastedCanvas } from '@web/pages/project/chat/paste-canvas';
import {
  captureClipboard,
  type CaptureNode,
  type ClipboardNode,
  type ClipboardPayload,
} from '@web/spaces/canvas/node-clipboard';
import { pickForAgent } from '@web/spaces/canvas/pick-for-agent';

const PID = 'p1';
const SID = 's1';
const CATALOG = { image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1 } as unknown as ModelCatalog;

const picture: ClipboardNode = {
  id: 'x1',
  type: 'image',
  position: { x: 0, y: 0 },
  data: { name: 'Neon street', content: 'https://img.example/neon.jpg' },
  external: true,
};

/**
 * A payload of the given nodes.
 * @param nodes - Its nodes.
 * @returns The payload.
 */
function payloadOf(nodes: ClipboardNode[]): ClipboardPayload {
  return { version: 2, picked: nodes.map((n) => n.id), nodes, edges: [] };
}

/**
 * The open canvas document.
 * @returns The doc.
 */
function canvas(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * A group with a text member, an image upstream of it, and a sticky with a
 * reply, all on the open canvas.
 */
function seedCanvas(): void {
  const base = { createdAt: 1, createdBy: 'u', locked: false, attachments: [] };
  addNode(PID, SID, { id: 'g1', type: 'group', position: { x: 100, y: 50 }, data: { ...base, name: 'Shots', width: 400, height: 300 } as never });
  addNode(PID, SID, { id: 'n1', type: 'text', parentId: 'g1', position: { x: 10, y: 10 }, data: { ...base, name: 'Note', content: 'hello\nworld' } as never });
  addNode(PID, SID, { id: 'i1', type: 'image', position: { x: 500, y: 0 }, data: { ...base, name: 'Pic', content: 'https://cdn/x.png' } as never });
  addNode(PID, SID, { id: 's1', type: 'annotation', position: { x: 900, y: 0 }, data: { ...base, name: 'Note', content: 'a note' } as never });
  canvas().transact(() => {
    const reply = new Y.Map<unknown>();
    reply.set('id', 'r1');
    reply.set('body', 'yes');
    (nodeDataMap(canvas(), 's1')?.get('replies') as Y.Array<Y.Map<unknown>>).push([reply]);
  });
  addEdge(PID, SID, { id: 'i1->n1', source: 'i1', target: 'n1', createdAt: 7 });
}

/**
 * Copy the given ids off the open canvas, as Cmd+C does.
 * @param ids - The selection.
 * @returns The payload.
 */
function copy(ids: string[]): ClipboardPayload {
  const doc = canvas();
  const nodes: CaptureNode[] = [];
  doc.getMap<Y.Map<unknown>>(CANVAS_NODES_KEY).forEach((map) => {
    const parentId = map.get('parentId');
    nodes.push({
      id: map.get('id') as string,
      type: map.get('type') as string,
      position: map.get('position') as { x: number; y: number },
      ...(typeof parentId === 'string' ? { parentId } : {}),
    });
  });
  return captureClipboard(ids, nodes, (id) => snapshotNodeData(nodeDataMap(doc, id) as Y.Map<unknown>), readEdges(doc), {
    projectId: PID,
    spaceId: SID,
  });
}

/**
 * The card a pick makes on a document.
 * @param doc - The document.
 * @param ids - The pick.
 * @returns The card's item.
 */
async function card(doc: Y.Doc, ids: readonly string[]): Promise<unknown> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const item = await pickForAgent(client, CATALOG, doc, ids);
  return { name: item?.name, snapshot: item?.chip?.data_snapshot };
}

describe('canvas text pasted into the chat box', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('makes a picture copied from a reply an image attachment', () => {
    const pasted = pastedCanvas(payloadOf([picture]), undefined);
    expect(pasted?.kind).toBe('item');
    if (pasted?.kind !== 'item') return;
    expect(pasted.item.type).toBe('image');
    expect(pasted.item.name).toBe('Neon street');
    expect(pasted.item.chip?.data_snapshot).toEqual({ url: 'https://img.example/neon.jpg' });
  });

  it('leaves a picture with no title unnamed', () => {
    const bare = { ...picture, data: { content: 'https://imgs.search.example/sig/aHR0cHM' } };
    const pasted = pastedCanvas(payloadOf([bare]), undefined);
    expect(pasted?.kind === 'item' ? pasted.item.name : null).toBe('');
  });

  it('gives nothing for an empty payload', () => {
    expect(pastedCanvas(payloadOf([]), undefined)).toBeNull();
  });

  it('hands the picked nodes over from the open canvas when they are all there', () => {
    seedCanvas();
    const payload = copy(['g1', 'n1', 'i1']);
    const pasted = pastedCanvas(payload, canvas());
    expect(pasted).toEqual({ kind: 'nodes', doc: canvas(), ids: ['g1', 'n1', 'i1'] });
  });

  it('makes the same card as "Add to Agent" for nodes the open canvas does not have', async () => {
    seedCanvas();
    for (const pick of [['g1', 'i1', 's1'], ['g1', 'n1', 'i1'], ['n1'], ['g1']]) {
      const payload = copy(pick);
      const pasted = pastedCanvas(payload, undefined);
      expect(pasted?.kind).toBe('nodes');
      if (pasted?.kind !== 'nodes') return;
      expect(await card(pasted.doc, pasted.ids)).toEqual(await card(canvas(), pick));
    }
  });
});
