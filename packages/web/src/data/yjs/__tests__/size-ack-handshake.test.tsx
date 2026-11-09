// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap (inner#1790 web spec 23.1 to 23.3,
 * design 5.1 and 5.6): on a provider that finished its handshake (`H7`),
 * the receipt waits out the provider's own send window, so one operation's
 * writes leave as one Update ahead of it (the order comes from
 * `SpaceProvider.sendStateless` flushing first, spec 24.1); every
 * `doc:size` push is acknowledged at once with its `seq`, after any Update
 * already written (W8-01); every collab socket carries `size_ack=1`.
 *
 * Transport: production `acquireDocProvider` on the real Hocuspocus provider
 * and socket; only the browser `WebSocket` is a scripted server
 * (`helpers/handshake-server.ts`).
 */

import { QueryClient } from '@tanstack/react-query';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const h7 = await vi.hoisted(async () => {
  const m = await import('@web/data/yjs/__tests__/helpers/handshake-server');
  m.installScriptedWebSocket();
  return m;
});

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { COLLAB_DOCUMENT_TOO_LARGE_REASON, DocSizeSeenSchema, type ModelCatalog } from '@breatic/shared';
import { P_FULL, P_NORMAL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import {
  acquireDocProvider, hasProjectUnsyncedEdits, readDocProvider, _resetCollabSocketForTests,
} from '@web/data/yjs/collab-socket';
import { clearAllDocSizes, readDocSize } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import type { ProjectSpace } from '@web/data/yjs/project-meta';
import { readRequestedSpaces } from '@web/pages/project/chat/space-request-read';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';

const { expectHandshake, resetServer, settle } = h7;
type ScriptedServer = InstanceType<typeof h7.ScriptedServer>;
type HandshakeProvider = Parameters<typeof expectHandshake>[2];

const PID = 'p1';
const CANVAS = docName.canvasSpace(PID, 's1');
const DOCUMENT = docName.documentSpace(PID, 'd1');
const TIMELINE = docName.timelineSpace(PID, 't1');
const SCENE = docName.threeDSpace(PID, 'x1');
const META = docName.projectMeta(PID);

let server: ScriptedServer;

/** One document opened over the scripted server. */
interface Opened {
  name: string;
  doc: Y.Doc;
  provider: HandshakeProvider & { receiveStateless: (payload: string) => void };
}

/**
 * Opens a registered document with its production provider and waits for the `H7` handshake.
 * @param name - Canonical document name.
 * @param options - What the handshake expects.
 * @param options.scope - The scope the server authorizes.
 * @returns The opened document.
 * @throws {AssertionError} When a precondition does not hold.
 */
async function open(name: string, options: { scope?: string } = {}): Promise<Opened> {
  if (options.scope !== undefined) server.scopes.set(name, options.scope);
  const doc = getDoc(name);
  const provider = acquireDocProvider(name, doc) as unknown as Opened['provider'];
  const kind = name === CANVAS || name === DOCUMENT ? 'confirms' : 'silent';
  await expectHandshake(name, doc, provider, { scope: options.scope, confirms: kind === 'confirms' && options.scope !== 'readonly' });
  return { name, doc, provider };
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

/**
 * The kinds of update and receipt frames of one document since a mark.
 * @param name - Canonical document name.
 * @param mark - The first frame index.
 * @returns The kinds.
 * @throws {never} Never.
 */
function updatesAndConfirms(name: string, mark: number): string[] {
  return server.kinds(name, mark).filter((kind) => kind === 'update' || kind === 'confirm');
}

/**
 * The `seen` frames of one document since a mark.
 * @param name - Canonical document name.
 * @param mark - The first frame index.
 * @returns The kinds.
 * @throws {never} Never.
 */
function seen(name: string, mark: number): string[] {
  return server.kinds(name, mark).filter((kind) => kind.startsWith('seen('));
}

beforeEach(() => {
  server = resetServer();
});

afterEach(() => {
  vi.useRealTimers();
  _resetCollabSocketForTests();
  clearAllDocSizes();
  _resetForTests();
});

afterAll(() => {
  h7.uninstallScriptedWebSocket();
});

describe('23.1 one operation, one message, on a handshaken provider', () => {
  it('W7-03 a write and a follow-up in a microtask of the same task leave as [update, confirm], not [update, confirm, update]', async () => {
    const { doc } = await open(CANVAS);
    const mark = server.mark();
    writeNode(doc, 'a');
    queueMicrotask(() => writeNode(doc, 'b'));
    await settle();
    expect(updatesAndConfirms(CANVAS, mark)).toEqual(['update', 'confirm']);
    const [only] = server.updates(CANVAS, mark);
    const mirror = new Y.Doc();
    Y.applyUpdate(mirror, Y.encodeStateAsUpdate(server.docOf(CANVAS)));
    expect([...mirror.getMap('nodesMap').keys()].sort()).toEqual(['a', 'b']);
    expect(only?.shape).toBe('S');
  });

  it('W7-04 with fake timers: nothing leaves before flushDelay; after 1 ms the update and then its confirm', async () => {
    const { doc } = await open(CANVAS);
    vi.useFakeTimers();
    const mark = server.mark();
    writeNode(doc, 'n1');
    await Promise.resolve();
    await Promise.resolve();
    expect(updatesAndConfirms(CANVAS, mark)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(updatesAndConfirms(CANVAS, mark)).toEqual(['update', 'confirm']);
  });

  it.each([
    ['SD-01', CANVAS],
    ['SD-02', DOCUMENT],
  ] as const)('W7-06 %s on a handshaken provider: the Update goes before the sync:confirm, whose receipt clears the unsynced edits', async (_id, name) => {
    const { doc } = await open(name);
    const mark = server.mark();
    if (name === CANVAS) writeNode(doc, 'n1');
    else {
      doc.transact(() => { doc.getMap('probe').set('a', 1); });
      doc.transact(() => { doc.getMap('probe').set('b', 2); });
    }
    await settle();
    expect(updatesAndConfirms(name, mark)).toEqual(['update', 'confirm']);
    expect(hasProjectUnsyncedEdits(PID)).toBe(false);
  });
});

describe('23.2 a push is acknowledged at once', () => {
  it.each([
    ['canvas', CANVAS],
    ['document', DOCUMENT],
    ['3d', SCENE],
    ['timeline', TIMELINE],
  ] as const)('W7-07 %s: seen(7) leaves inside the stateless callback, after setDocSize', async (_label, name) => {
    await open(name);
    const phases: string[] = [];
    server.onFrame = (frame): void => {
      if (frame.kind === 'stateless' && frame.payload.includes('doc:size-seen')) phases.push(readDocSize(name).phase);
    };
    const mark = server.mark();
    server.push(name, P_FULL, 7);
    // The push was delivered synchronously: whatever the callback sent is recorded now.
    const frames = server.frames.slice(mark).filter(({ frame }) => frame.name === name);
    expect(frames.map(({ frame }) => h7.kindOf(frame))).toEqual(['seen(7)']);
    const [first] = frames;
    expect(first?.frame.kind === 'stateless' && first.frame.payload).toBe('{"type":"doc:size-seen","seq":7}');
    expect(DocSizeSeenSchema.safeParse(JSON.parse(first?.frame.kind === 'stateless' ? first.frame.payload : '{}')).success).toBe(true);
    expect(phases).toEqual(['full']);
  });

  it.each([
    ['canvas', CANVAS],
    ['document', DOCUMENT],
    ['3d', SCENE],
    ['timeline', TIMELINE],
  ] as const)('W7-08 %s: pushes 3, 4, 4, 9 are acknowledged once each, in order', async (_label, name) => {
    await open(name);
    const mark = server.mark();
    for (const seq of [3, 4, 4, 9]) server.push(name, P_WARNING, seq);
    await settle();
    expect(seen(name, mark)).toEqual(['seen(3)', 'seen(4)', 'seen(4)', 'seen(9)']);
  });

  it.each([
    ['canvas', CANVAS],
    ['document', DOCUMENT],
    ['3d', SCENE],
    ['timeline', TIMELINE],
  ] as const)('W7-09 %s: an invalid push is not acknowledged and leaves the size alone', async (_label, name) => {
    await open(name);
    server.push(name, P_WARNING, 1);
    await settle();
    const before = readDocSize(name);
    const mark = server.mark();
    const { seq: _seq, ...noSeq } = { seq: 0, ...P_FULL };
    for (const payload of [
      JSON.stringify({ type: 'doc:size', ...noSeq }),
      JSON.stringify({ type: 'doc:size', seq: -1, ...P_FULL }),
      JSON.stringify({ type: 'doc:size', seq: 2, ...P_FULL, phase: 'over' }),
      'not json',
      JSON.stringify({ type: 'sync:confirmed', id: '33333333-3333-4333-8333-333333333333', ok: true }),
    ]) server.pushRaw(name, payload);
    await settle();
    expect(seen(name, mark)).toEqual([]);
    expect(readDocSize(name)).toEqual(before);
    // The valid push before them was acknowledged: the channel works.
    expect(before.phase).toBe('warning');
  });

  it('W7-10 a valid doc:size on the meta document is not acknowledged', async () => {
    await open(META);
    const mark = server.mark();
    server.push(META, P_FULL, 1);
    await settle();
    expect(seen(META, mark)).toEqual([]);
    // Control: a Space document on the same socket acknowledges.
    await open(CANVAS);
    const canvasMark = server.mark();
    server.push(CANVAS, P_FULL, 1);
    expect(seen(CANVAS, canvasMark)).toEqual(['seen(1)']);
  });

  it('W7-11 a read-only member acknowledges a valid push too', async () => {
    await open(CANVAS, { scope: 'readonly' });
    const mark = server.mark();
    server.push(CANVAS, P_FULL, 1);
    expect(seen(CANVAS, mark)).toEqual(['seen(1)']);
  });

  it('W7-12 after a refusal rebuilt the document, the retired provider does not acknowledge; the new one does', async () => {
    const { provider: old } = await open(CANVAS);
    server.closeDocument(CANVAS, COLLAB_DOCUMENT_TOO_LARGE_REASON);
    await settle();
    expect(readDocProvider(CANVAS)).toBeNull();
    const mark = server.mark();
    old.receiveStateless(JSON.stringify({ type: 'doc:size', seq: 5, ...P_FULL }));
    expect(seen(CANVAS, mark)).toEqual([]);
    const doc = getDoc(CANVAS);
    const fresh = acquireDocProvider(CANVAS, doc) as unknown as HandshakeProvider;
    await expectHandshake(CANVAS, doc, fresh);
    const freshMark = server.mark();
    server.push(CANVAS, P_NORMAL, 6);
    expect(seen(CANVAS, freshMark)).toEqual(['seen(6)']);
  });
});

describe('23.3 the connection parameter', () => {
  it('W7-13 the shared socket opened by the first acquireDocProvider carries size_ack=1', async () => {
    await open(CANVAS);
    expect(server.sockets).toHaveLength(1);
    expect(new URL(server.sockets[0]!.url).searchParams.get('size_ack')).toBe('1');
  });

  it('W7-14 the socket readRequestedSpaces opens (createCollabSocket) carries size_ack=1', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(modelCatalogQuery().queryKey, {
      image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1,
    } as unknown as ModelCatalog);
    const spaces: ProjectSpace[] = [{ id: 'c9', name: 'Cast', type: 'canvas', createdAt: 1 }];
    await readRequestedSpaces({
      projectId: PID,
      spaces,
      requested: [{ id: 'c9' }] as never,
      queryClient: client,
      url: '/ws',
      limits: { currentSpaceMaxChars: 100_000, spaceReadTimeoutMs: 2_000 },
    });
    expect(server.sockets.length).toBeGreaterThanOrEqual(1);
    for (const socket of server.sockets) expect(new URL(socket.url).searchParams.get('size_ack')).toBe('1');
  });

  it('W7-15 new HocuspocusProviderWebsocket appears only in createCollabSocket of data/yjs/collab-socket.tsx', () => {
    const root = resolve(import.meta.dirname, '../../..');
    /**
     * Every production source file under a directory.
     * @param dir - The directory.
     * @returns The files.
     */
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : walk(path);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });
    const hits: string[] = [];
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('new HocuspocusProviderWebsocket')) hits.push(relative(root, file));
    }
    expect(hits).toEqual(['data/yjs/collab-socket.tsx']);
    const source = readFileSync(join(root, 'data/yjs/collab-socket.tsx'), 'utf8');
    const body = source.slice(source.indexOf('export function createCollabSocket'));
    const end = body.indexOf('\n}\n');
    expect(body.slice(0, end)).toContain('new HocuspocusProviderWebsocket');
    expect(source.split('new HocuspocusProviderWebsocket')).toHaveLength(2);
  });
});
