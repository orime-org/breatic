// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reading one document's receipt state for the document a caller holds
 * (#1411 design 5.3): a write placed into a canvas that is not open waits for
 * collab to confirm it, and a document rebuilt or torn down meanwhile is
 * answered as gone rather than as confirmed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/message-socket')).messageSocketModule(await importOriginal()));

import {
  authenticatedFrame, idle, recordingSockets, statelessFrame, step1Frame, step2Frame, type RecordingSocket,
} from '@web/data/yjs/__tests__/helpers/message-socket';
import { acquireDocProvider, hasDocUnsyncedEdits, releaseDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';

const CANVAS = docName.canvasSpace('p1', 's1');
const OTHER = docName.canvasSpace('p1', 's2');

/**
 * Open the canvas and finish its handshake.
 * @param name - Canonical document name.
 * @returns The document and the shared socket.
 * @throws {Error} When no socket was built.
 */
async function open(name: string): Promise<{ doc: Y.Doc; socket: RecordingSocket }> {
  const doc = getDoc(name);
  acquireDocProvider(name, doc);
  const socket = recordingSockets.at(-1);
  if (socket === undefined) throw new Error('no socket');
  const server = new Y.Doc();
  socket.open();
  await Promise.resolve();
  socket.receive(authenticatedFrame(name));
  socket.receive(step1Frame(name, server));
  socket.receive(step2Frame(name, server, doc));
  await idle();
  return { doc, socket };
}

beforeEach(() => { recordingSockets.length = 0; });
afterEach(() => { _resetCollabSocketForTests(); clearAllDocSizes(); _resetForTests(); });

describe('hasDocUnsyncedEdits', () => {
  it('is pending after a write and confirmed after its receipt, for that document only', async () => {
    const { doc, socket } = await open(CANVAS);
    const mark = socket.frames.length;
    doc.transact(() => { doc.getMap('nodesMap').set('n1', new Y.Map()); });
    await idle();
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('pending');
    const request = socket.frames.slice(mark).find((frame) => frame.name === CANVAS && frame.kind === 'stateless');
    const { id } = JSON.parse(request?.kind === 'stateless' ? request.payload : '{}') as { id: string };
    socket.receive(statelessFrame(CANVAS, JSON.stringify({ type: 'sync:confirmed', id, ok: true })));
    await idle();
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('confirmed');
  });

  it('is gone for a document that is not registered, or a different generation of it', async () => {
    expect(hasDocUnsyncedEdits(OTHER, new Y.Doc())).toBe('gone');
    const { doc } = await open(CANVAS);
    expect(hasDocUnsyncedEdits(CANVAS, new Y.Doc())).toBe('gone');
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('confirmed');
  });

  it('is gone once the document is torn down while a write waited, never confirmed', async () => {
    const { doc } = await open(CANVAS);
    doc.transact(() => { doc.getMap('nodesMap').set('n1', new Y.Map()); });
    await idle();
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('pending');
    _resetCollabSocketForTests();
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('gone');
    const next = getDoc(CANVAS);
    acquireDocProvider(CANVAS, next);
    expect(hasDocUnsyncedEdits(CANVAS, doc)).toBe('gone');
    releaseDocProvider(CANVAS, next);
  });
});
