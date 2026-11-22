// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The page's pending focus crops (#1580 test spec area E; design §2.4, §5.2).
 *
 * The server adds an uploaded crop to its node's pool. The page keeps the
 * crop's pending entry, counted by every pool-cap gate, until an image with
 * the same id appears in that pool, and drops it with its node when the node
 * leaves the document, as a canvas upload's state goes with its node.
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { CANVAS_NODES_KEY } from '@breatic/shared';
import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { watchPendingFocusUploads } from '@web/spaces/canvas/focus/pending-focus-uploads';

/** A canvas document holding the given nodes, each with an empty pool. */
function canvasDoc(nodeIds: string[]): Y.Doc {
  const doc = new Y.Doc();
  const nodes = doc.getMap(CANVAS_NODES_KEY);
  for (const id of nodeIds) {
    const node = new Y.Map<unknown>();
    const data = new Y.Map<unknown>();
    node.set('type', 'image');
    node.set('data', data);
    nodes.set(id, node);
    data.set('focusImages', new Y.Array<unknown>());
  }
  return doc;
}

/** Apply `change` as a remote update arriving at `doc`. */
function remote(doc: Y.Doc, change: (peer: Y.Doc) => void): void {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  change(peer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)));
}

/** Push an image into a node's pool on `doc`. */
function addImage(doc: Y.Doc, nodeId: string, id: string): void {
  const data = (doc.getMap(CANVAS_NODES_KEY).get(nodeId) as Y.Map<unknown>).get('data') as Y.Map<unknown>;
  (data.get('focusImages') as Y.Array<unknown>).push([{ id, url: 'https://cdn.test/x.png', name: 'S', width: 10, height: 10 }]);
}

/** The pending entries still held for `nodeId`. */
function pendingFor(session: ReturnType<typeof createCanvasSessionStore>, nodeId: string): string[] {
  return session.getState().pendingFocusUploads.filter((p) => p.nodeId === nodeId).map((p) => p.id);
}

/** The images in a node's pool. */
function poolSize(doc: Y.Doc, nodeId: string): number {
  const data = (doc.getMap(CANVAS_NODES_KEY).get(nodeId) as Y.Map<unknown> | undefined)?.get('data') as Y.Map<unknown> | undefined;
  return (data?.get('focusImages') as Y.Array<unknown> | undefined)?.length ?? 0;
}

describe('watchPendingFocusUploads', () => {
  it('E-04 drops the pending entry in the same update that brings its image into the pool', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    const seen: number[] = [];
    doc.on('afterTransaction', () => seen.push(pendingFor(session, 'n1').length + poolSize(doc, 'n1')));
    remote(doc, (peer) => addImage(peer, 'n1', 'crop-1'));
    expect(pendingFor(session, 'n1')).toEqual([]);
    expect(poolSize(doc, 'n1')).toBe(1);
    expect(seen.every((n) => n === 1)).toBe(true);
    stop();
  });

  it('keeps an entry whose image has not arrived when another image lands', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    remote(doc, (peer) => addImage(peer, 'n1', 'someone-else'));
    expect(pendingFor(session, 'n1')).toEqual(['crop-1']);
    stop();
  });

  it('E-05 drops the entries of a node deleted here, and only that node', () => {
    const doc = canvasDoc(['n1', 'n2']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    session.getState().addPendingFocusUpload({ id: 'crop-2', nodeId: 'n2', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    doc.getMap(CANVAS_NODES_KEY).delete('n1');
    expect(pendingFor(session, 'n1')).toEqual([]);
    expect(pendingFor(session, 'n2')).toEqual(['crop-2']);
    stop();
  });

  it('E-06 drops the entries of a node a collaborator deleted', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    remote(doc, (peer) => peer.getMap(CANVAS_NODES_KEY).delete('n1'));
    expect(pendingFor(session, 'n1')).toEqual([]);
    stop();
  });

  it('E-07 does not bring the entry back when the deleted node is restored, and the late image still shows', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    const undo = new Y.UndoManager(doc.getMap(CANVAS_NODES_KEY));
    doc.getMap(CANVAS_NODES_KEY).delete('n1');
    undo.undo();
    expect(doc.getMap(CANVAS_NODES_KEY).has('n1')).toBe(true);
    expect(pendingFor(session, 'n1')).toEqual([]);
    remote(doc, (peer) => addImage(peer, 'n1', 'crop-1'));
    expect(poolSize(doc, 'n1')).toBe(1);
    stop();
  });

  it('E-13 keeps the entry while nothing arrives, and drops it when a later sync brings the image', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    const offline = new Y.Doc();
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(doc));
    addImage(offline, 'n1', 'crop-1');
    expect(pendingFor(session, 'n1')).toEqual(['crop-1']);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(doc)));
    expect(pendingFor(session, 'n1')).toEqual([]);
    stop();
  });

  it('E-15 and E-17 leave the entries alone on an unrelated update, an entry that never had a key included', () => {
    const doc = canvasDoc(['n1', 'n2']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    session.getState().addPendingFocusUpload({ id: 'crop-dedup', nodeId: 'n2', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    remote(doc, (peer) => addImage(peer, 'n1', 'crop-1'));
    expect(() => remote(doc, (peer) => ((peer.getMap(CANVAS_NODES_KEY).get('n2') as Y.Map<unknown>).get('data') as Y.Map<unknown>).set('prompt', 'x'))).not.toThrow();
    expect(pendingFor(session, 'n1')).toEqual([]);
    expect(pendingFor(session, 'n2')).toEqual(['crop-dedup']);
    stop();
  });

  it('E-12 stops watching when stopped', () => {
    const doc = canvasDoc(['n1']);
    const session = createCanvasSessionStore();
    session.getState().addPendingFocusUpload({ id: 'crop-1', nodeId: 'n1', name: 'S' });
    const stop = watchPendingFocusUploads(doc, session);
    stop();
    remote(doc, (peer) => addImage(peer, 'n1', 'crop-1'));
    expect(pendingFor(session, 'n1')).toEqual(['crop-1']);
  });
});
