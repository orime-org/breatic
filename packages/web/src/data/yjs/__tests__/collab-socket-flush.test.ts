// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, round 6 (inner#1790 web spec 21.2, design 5.6):
 * when the provider built by `acquireDocProvider` sends what it buffered.
 * The provider is the real `HocuspocusProvider` with the configuration
 * production gives it; only the shared WebSocket is a recording stand-in
 * (`helpers/message-socket.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/message-socket')).messageSocketModule(await importOriginal()));

import {
  authenticatedFrame, idle, recordingSockets, statelessFrame, step1Frame, step2Frame,
  type RealProvider, type RecordingSocket, type SentFrame,
} from '@web/data/yjs/__tests__/helpers/message-socket';
import {
  acquireDocProvider, hasProjectUnsyncedEdits, releaseDocProvider, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';

const CANVAS = docName.canvasSpace('p1', 's1');
const DOCUMENT = docName.documentSpace('p1', 'd1');
const TIMELINE = docName.timelineSpace('p1', 't1');

/** One opened document. */
interface Opened {
  name: string;
  doc: Y.Doc;
  provider: RealProvider;
  socket: RecordingSocket;
}

/**
 * Opens a Space document the way a tab does.
 * @param name - Canonical document name.
 * @returns The document, its real provider and the shared socket.
 * @throws {Error} When no socket was built.
 */
function open(name: string): Opened {
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc) as unknown as RealProvider;
  const socket = recordingSockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  return { name, doc, provider, socket };
}

/**
 * Opens the socket, authenticates read-write and completes the handshake
 * with a server copy equal to the document.
 * @param opened - The document.
 * @returns The server's copy.
 * @throws {never} Never.
 */
async function connect(opened: Opened): Promise<Y.Doc> {
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(opened.doc));
  opened.socket.open();
  await Promise.resolve();
  opened.socket.receive(authenticatedFrame(opened.name));
  opened.socket.receive(step1Frame(opened.name, server));
  opened.socket.receive(step2Frame(opened.name, server, opened.doc));
  await idle();
  return server;
}

/**
 * The frames of one document since an index, as kinds.
 * @param socket - The socket.
 * @param name - Canonical document name.
 * @param from - The first index.
 * @returns The frames.
 * @throws {never} Never.
 */
function framesOf(socket: RecordingSocket, name: string, from: number): SentFrame[] {
  return socket.frames.slice(from).filter((frame) => frame.name === name);
}

/**
 * Update and stateless frames, as kinds in order.
 * @param frames - The frames.
 * @returns The kinds.
 * @throws {never} Never.
 */
function updateAndStateless(frames: SentFrame[]): string[] {
  return frames.filter((frame) => frame.kind === 'update' || frame.kind === 'stateless').map((frame) => frame.kind);
}

/**
 * Writes one local canvas node.
 * @param doc - The canvas document.
 * @param id - Node id.
 * @throws {never} Never.
 */
function writeNode(doc: Y.Doc, id: string): void {
  doc.transact(() => { doc.getMap('nodesMap').set(id, new Y.Map()); });
}

beforeEach(() => {
  recordingSockets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  _resetForTests();
});

describe('21.2 when buffered updates are sent', () => {
  it('SD-01 a canvas write is sent before the sync:confirm that covers it (provider flushDelay 1)', async () => {
    const opened = open(CANVAS);
    expect(opened.provider.configuration.flushDelay).toBe(1);
    await connect(opened);
    const mark = opened.socket.frames.length;
    writeNode(opened.doc, 'n1');
    await idle();
    const frames = framesOf(opened.socket, CANVAS, mark);
    expect(updateAndStateless(frames)).toEqual(['update', 'stateless']);
    const stateless = frames.find((frame) => frame.kind === 'stateless');
    expect(stateless?.kind === 'stateless' && (JSON.parse(stateless.payload) as { type: string }).type).toBe('sync:confirm');
    const update = frames.find((frame) => frame.kind === 'update');
    const mirror = new Y.Doc();
    if (update?.kind === 'update') Y.applyUpdate(mirror, update.update);
    expect(mirror.getMap('nodesMap').has('n1')).toBe(true);
  });

  it('SD-02 two writes in one task of a document send one Update, then one sync:confirm; its receipt clears the unsynced edits', async () => {
    const opened = open(DOCUMENT);
    await connect(opened);
    const mark = opened.socket.frames.length;
    opened.doc.transact(() => { opened.doc.getMap('probe').set('a', 1); });
    opened.doc.transact(() => { opened.doc.getMap('probe').set('b', 2); });
    await idle();
    const frames = framesOf(opened.socket, DOCUMENT, mark);
    expect(updateAndStateless(frames)).toEqual(['update', 'stateless']);
    expect(hasProjectUnsyncedEdits('p1')).toBe(true);
    const request = frames.find((frame) => frame.kind === 'stateless');
    const { id } = JSON.parse(request?.kind === 'stateless' ? request.payload : '{}') as { id: string };
    opened.socket.receive(statelessFrame(DOCUMENT, JSON.stringify({ type: 'sync:confirmed', id, ok: true })));
    await idle();
    expect(hasProjectUnsyncedEdits('p1')).toBe(false);
  });

  it('SD-03 pagehide sends what canvas, document and timeline providers buffered, without the timers advancing', () => {
    vi.useFakeTimers();
    const all = [open(CANVAS), open(DOCUMENT), open(TIMELINE)];
    const socket = all[0]!.socket;
    for (const opened of all) expect(opened.provider.configuration.flushDelay).toBe(1);
    const mark = socket.frames.length;
    writeNode(all[0]!.doc, 'n1');
    all[1]!.doc.transact(() => { all[1]!.doc.getMap('probe').set('a', 1); });
    all[2]!.doc.transact(() => { all[2]!.doc.getMap('clips').set('c', 1); });
    // Still buffered: nothing went out before the page is hidden.
    expect(socket.frames.slice(mark).filter((frame) => frame.kind === 'update')).toHaveLength(0);
    window.dispatchEvent(new Event('pagehide'));
    const sent = socket.frames.slice(mark).filter((frame) => frame.kind === 'update').map((frame) => frame.name);
    expect(sent.sort()).toEqual([CANVAS, DOCUMENT, TIMELINE].sort());
  });

  it('SD-04 the production provider merges two writes in one task and one in a microtask into one Update', async () => {
    const opened = open(CANVAS);
    expect(opened.provider.configuration.flushDelay).toBe(1);
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(opened.doc));
    const mark = opened.socket.frames.length;
    writeNode(opened.doc, 'a');
    writeNode(opened.doc, 'b');
    queueMicrotask(() => writeNode(opened.doc, 'c'));
    await idle();
    const updates = framesOf(opened.socket, CANVAS, mark).filter((frame) => frame.kind === 'update');
    expect(updates).toHaveLength(1);
    if (updates[0]?.kind === 'update') Y.applyUpdate(mirror, updates[0].update);
    expect([...mirror.getMap('nodesMap').keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('SD-05 closing the Space tab sends the buffered Update before the provider is gone', () => {
    vi.useFakeTimers();
    const opened = open(CANVAS);
    const mark = opened.socket.frames.length;
    writeNode(opened.doc, 'n1');
    expect(framesOf(opened.socket, CANVAS, mark).filter((frame) => frame.kind === 'update')).toHaveLength(0);
    releaseDocProvider(CANVAS);
    vi.advanceTimersByTime(0);
    const kinds = framesOf(opened.socket, CANVAS, mark).map((frame) => frame.kind);
    expect(kinds).toContain('update');
    expect(kinds).toContain('close');
    expect(kinds.indexOf('update')).toBeLessThan(kinds.indexOf('close'));
    const update = framesOf(opened.socket, CANVAS, mark).find((frame) => frame.kind === 'update');
    const mirror = new Y.Doc();
    if (update?.kind === 'update') Y.applyUpdate(mirror, update.update);
    expect(mirror.getMap('nodesMap').has('n1')).toBe(true);
  });

  it('SD-06 a write the provider dropped with its buffer on disconnect reaches the server in the SyncStep2 after reconnecting', async () => {
    const opened = open(CANVAS);
    const server = await connect(opened);
    const mark = opened.socket.frames.length;
    writeNode(opened.doc, 'n1');
    // Buffered when the socket drops.
    expect(framesOf(opened.socket, CANVAS, mark).filter((frame) => frame.kind === 'update')).toHaveLength(0);
    opened.socket.drop();
    await idle();
    expect(framesOf(opened.socket, CANVAS, mark).filter((frame) => frame.kind === 'update')).toHaveLength(0);
    const reconnect = opened.socket.frames.length;
    opened.socket.open();
    await Promise.resolve();
    opened.socket.receive(authenticatedFrame(CANVAS));
    opened.socket.receive(step1Frame(CANVAS, server));
    await idle();
    const step2 = framesOf(opened.socket, CANVAS, reconnect).filter((frame) => frame.kind === 'step2').at(-1);
    expect(step2).toBeDefined();
    if (step2?.kind === 'step2') Y.applyUpdate(server, step2.update);
    expect(server.getMap('nodesMap').has('n1')).toBe(true);
    expect(Y.equalSnapshots(Y.snapshot(server), Y.snapshot(opened.doc))).toBe(true);
  });
});
