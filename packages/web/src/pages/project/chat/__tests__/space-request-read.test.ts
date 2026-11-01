// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading the Spaces an Agent asked to look at, once the reader allowed it
 * (inner#1552, design 4.4, DD 5.3).
 *
 * Each requested Space ends in one of five states and the Agent is told each
 * one. A Space this tab already holds synced is read as it stands, with no
 * connection; any other is read over a socket of the read's own, one new
 * Y.Doc and provider per Space, never through the tab's registry, and every
 * one of them is destroyed however the read ends. A part of a Space is read
 * with the numbering the whole would have.
 *
 * The transport is a spy, as in `collab-socket.test.tsx`: the test plays the
 * server by filling a provider's document and emitting its events.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { blocksToYXmlFragment } from '@blocknote/core/yjs';
import { documentBodyFragment, READ_ONLY_COLLAB_TOKEN, spaceAnswerMismatch, spaceRequestAnswerSchema } from '@breatic/shared';
import type { ModelCatalog } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';

interface FakeSocket {
  destroy: ReturnType<typeof vi.fn>;
  config: Record<string, unknown>;
}

interface FakeProvider {
  destroy: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
  emit: (event: string, data?: unknown) => void;
  config: Record<string, unknown>;
}

const { wsInstances, providerInstances, destroyedDocs, editors } = vi.hoisted(() => ({
  wsInstances: [] as FakeSocket[],
  providerInstances: [] as FakeProvider[],
  destroyedDocs: new WeakSet<object>(),
  editors: new Map<string, unknown>(),
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProviderWebsocket: class {
    destroy = vi.fn();
    receivedOnOpenPayload?: Event = undefined;
    listeners: Record<string, Array<(data?: unknown) => void>> = {};
    on(event: string, cb: (data?: unknown) => void): void {
      (this.listeners[event] ??= []).push(cb);
    }
    off(event: string, cb: (data?: unknown) => void): void {
      this.listeners[event] = (this.listeners[event] ?? []).filter((listener) => listener !== cb);
    }
    emit(event: string, data?: unknown): void {
      for (const cb of [...(this.listeners[event] ?? [])]) cb(data);
    }
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      wsInstances.push(this);
    }
  },
  HocuspocusProvider: class {
    destroy = vi.fn();
    attach = vi.fn();
    detach = vi.fn();
    onOpen = vi.fn();
    isAuthenticated = false;
    authorizedScope: string | undefined = undefined;
    listeners: Record<string, Array<(data?: unknown) => void>> = {};
    on = vi.fn((event: string, cb: (data?: unknown) => void) => {
      (this.listeners[event] ??= []).push(cb);
    });
    off = vi.fn((event: string, cb: (data?: unknown) => void) => {
      this.listeners[event] = (this.listeners[event] ?? []).filter((listener) => listener !== cb);
    });
    emit(event: string, data?: unknown): void {
      for (const cb of [...(this.listeners[event] ?? [])]) cb(data);
    }
    config: Record<string, unknown>;
    document: unknown;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      this.document = config.document;
      const doc = config.document as { on?: (event: string, cb: () => void) => void } | undefined;
      doc?.on?.('destroy', () => destroyedDocs.add(doc));
      providerInstances.push(this);
    }
  },
}));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/spaces/document/document-editor-cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  peekDocumentEditor: (name: string) => editors.get(name),
}));

const { addNode } = await import('@web/data/yjs/canvas-space');
const { _resetForTests, docName, getDoc, hasDoc } = await import('@web/data/yjs/manager');
const { _resetCollabSocketForTests, acquireDocProvider, readDocProvider } = await import('@web/data/yjs/collab-socket');
const { ChunkingWebSocket } = await import('@web/data/yjs/chunking-websocket');
const { modelCatalogQuery } = await import('@web/spaces/canvas/generate/model-catalog-query');
const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { clipSpaceContext, readSpaceContext } = await import('@web/pages/project/chat/space-context');
const { readRequestedSpaces } = await import('@web/pages/project/chat/space-request-read');

type Requested = Parameters<typeof readRequestedSpaces>[0]['requested'];
type Got = Awaited<ReturnType<typeof readRequestedSpaces>>;

const PID = 'p1';
const URL_PATH = '/ws';
const CATALOG = {
  image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1,
} as unknown as ModelCatalog;

const canvas: ProjectSpace = { id: 'c1', name: 'Cast', type: 'canvas', createdAt: 1 };
const doc: ProjectSpace = { id: 'd1', name: 'Storyboard', type: 'document', createdAt: 2 };
const timeline: ProjectSpace = { id: 't1', name: 'Edit', type: 'timeline', createdAt: 3 };
const doc2: ProjectSpace = { id: 'd2', name: 'Notes', type: 'document', createdAt: 4 };
const spaces = [canvas, doc, timeline, doc2];

/**
 * A client with the model catalog cached and never stale, as a canvas that
 * has drawn once holds it.
 * @returns The client.
 */
function warmClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  return client;
}

/**
 * Start a read with the defaults most cases share.
 * @param requested - The Spaces asked for, as the tool input carries them.
 * @param overrides - What this case changes.
 * @returns The read.
 */
function read(
  requested: Requested,
  overrides: Partial<Parameters<typeof readRequestedSpaces>[0]> = {},
): Promise<Got> {
  return readRequestedSpaces({
    projectId: PID,
    spaces,
    requested,
    queryClient: warmClient(),
    url: URL_PATH,
    limits: { currentSpaceMaxChars: 100_000, spaceReadTimeoutMs: 5_000 },
    ...overrides,
  });
}

/**
 * Whether the read results pass as the answer the server takes.
 * @param requested - What was asked for.
 * @param got - What was read.
 * @returns True when the answer parses and matches the request's structure.
 */
function accepted(requested: Requested, got: Got): boolean {
  const parsed = spaceRequestAnswerSchema.safeParse({ toolCallId: 'call-1', decision: 'shared', spaces: got });
  return parsed.success && spaceAnswerMismatch({ reason: 'r', spaces: requested }, parsed.data) === null;
}

/**
 * The state a canvas holding these text nodes encodes to.
 * @param ids - The nodes.
 * @returns The update.
 */
function canvasUpdate(ids: readonly string[]): Uint8Array {
  const seed = `seed-${Math.random().toString(36).slice(2)}`;
  for (const id of ids) {
    addNode(seed, 'src', {
      id,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { name: `Node ${id}`, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });
  }
  return Y.encodeStateAsUpdate(getDoc(docName.canvasSpace(seed, 'src')));
}

/** A document's content as the server would hand it, and an editor holding the same blocks. */
interface DocumentSeed {
  update: Uint8Array;
  editor: ReturnType<typeof buildDocumentEditor>;
}

/**
 * A document body holding this Markdown, as stored state and as an editor.
 * @param markdown - What it holds.
 * @param trailingEmpty - Whether it ends in an empty block.
 * @returns The seed.
 */
async function documentSeed(markdown: string, trailingEmpty = false): Promise<DocumentSeed> {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()), extensions: [] });
  const parsed = await editor.tryParseMarkdownToBlocks(markdown);
  editor.replaceBlocks(editor.document, trailingEmpty ? [...parsed, { type: 'paragraph' }] as never : parsed);
  const source = new Y.Doc();
  blocksToYXmlFragment(editor as never, editor.document as never, documentBodyFragment(source));
  return { update: Y.encodeStateAsUpdate(source), editor };
}

/**
 * Open a Space in this tab the way a tab does and hear the server sync it.
 * @param name - Its document name.
 * @param update - What the server holds for it.
 * @returns The tab's provider.
 */
function holdSynced(name: string, update: Uint8Array): FakeProvider {
  const tabDoc = getDoc(name);
  Y.applyUpdate(tabDoc, update);
  const provider = acquireDocProvider(name, tabDoc, URL_PATH) as unknown as FakeProvider;
  provider.emit('synced', { state: true });
  return provider;
}

/**
 * The provider the read opened for a document, once it has.
 * @param name - The document name.
 * @param tab - Providers the tab opened, which are not the read's.
 * @returns It.
 */
async function readerFor(name: string, tab: readonly FakeProvider[] = []): Promise<FakeProvider> {
  let found: FakeProvider | undefined;
  await vi.waitFor(() => {
    found = providerInstances.find((p) => p.config.name === name && !tab.includes(p));
    expect(found).toBeDefined();
  });
  return found!;
}

/**
 * Play the server syncing a read's document.
 * @param provider - The read's provider.
 * @param update - What the server holds.
 */
function serve(provider: FakeProvider, update: Uint8Array): void {
  Y.applyUpdate(provider.config.document as Y.Doc, update);
  provider.emit('synced', { state: true });
}

/**
 * Whether a read's provider, its Y.Doc and its socket were all destroyed.
 * @param provider - The read's provider.
 * @returns True when all three were.
 */
function torndown(provider: FakeProvider): boolean {
  const socket = provider.config.websocketProvider as FakeSocket;
  return (
    provider.destroy.mock.calls.length > 0 &&
    destroyedDocs.has(provider.config.document as object) &&
    socket.destroy.mock.calls.length > 0
  );
}

beforeEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  editors.clear();
  wsInstances.length = 0;
  providerInstances.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a Space that cannot be read over a connection', () => {
  it('is gone, with no name and no kind, when the project no longer lists it', async () => {
    const got = await read([{ id: 'missing' }]);

    expect(got).toEqual([{ id: 'missing', state: 'gone' }]);
    expect(wsInstances).toHaveLength(0);
    expect(providerInstances).toHaveLength(0);
  });

  it('is unreadable when its kind holds nothing the Agent can be given', async () => {
    const got = await read([{ id: 't1' }]);

    expect(got).toEqual([{ id: 't1', name: 'Edit', kind: 'timeline', state: 'unreadable' }]);
    expect(wsInstances).toHaveLength(0);
    expect(providerInstances).toHaveLength(0);
  });
});

describe('a Space this tab already holds synced', () => {
  it('is read as it stands, without opening a connection', async () => {
    holdSynced(docName.canvasSpace(PID, canvas.id), canvasUpdate(['a', 'b']));
    const socketsBefore = wsInstances.length;
    const providersBefore = providerInstances.length;

    const got = await read([{ id: 'c1' }]);

    expect(got[0]).toMatchObject({ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read' });
    expect((JSON.parse((got[0] as { content: string }).content) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(wsInstances).toHaveLength(socketsBefore);
    expect(providerInstances).toHaveLength(providersBefore);
  });

  it('reads a held document from what the tab holds, without opening a connection', async () => {
    const name = docName.documentSpace(PID, doc.id);
    const seed = await documentSeed('One\n\nTwo');
    holdSynced(name, seed.update);
    editors.set(name, { editor: seed.editor });
    const providersBefore = providerInstances.length;

    const got = await read([{ id: 'd1' }]);

    expect(got).toEqual([
      { id: 'd1', name: 'Storyboard', kind: 'document', state: 'read', content: '<!-- b:1 -->\nOne\n\n<!-- b:2 -->\nTwo', total_chars: 34 },
    ]);
    expect(providerInstances).toHaveLength(providersBefore);
  });
});

describe('a Space this tab does not hold', () => {
  it('is read over a socket of its own, built from the same address as the shared one', async () => {
    const pending = read([{ id: 'c1' }], { url: 'wss://collab.example/ws' });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    const socket = reader.config.websocketProvider as FakeSocket;

    expect(wsInstances).toContain(socket);
    expect(socket.config.url).toBe('wss://collab.example/ws');
    expect(socket.config.WebSocketPolyfill).toBe(ChunkingWebSocket);

    serve(reader, canvasUpdate(['a']));
    await pending;
  });

  it('builds a same-origin path into the address the shared socket dials', async () => {
    const pending = read([{ id: 'c1' }], { url: '/ws' });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    const readSocket = reader.config.websocketProvider as FakeSocket;
    serve(reader, canvasUpdate(['a']));
    await pending;

    const tab = acquireDocProvider('project-p1/meta', getDoc('project-p1/meta'), '/ws') as unknown as FakeProvider;
    const sharedSocket = tab.config.websocketProvider as FakeSocket;

    expect(sharedSocket).not.toBe(readSocket);
    expect(readSocket.config.url).toBe(sharedSocket.config.url);
    expect(readSocket.config.url).toBe(`ws://${window.location.host}/ws`);
  });

  it('connects read-only, attaches its provider, and stays out of the tab registry and document cache', async () => {
    const name = docName.canvasSpace(PID, canvas.id);
    const pending = read([{ id: 'c1' }]);
    const reader = await readerFor(name);
    expect(typeof READ_ONLY_COLLAB_TOKEN).toBe('string');
    expect(reader.config.token).toBe(READ_ONLY_COLLAB_TOKEN);
    expect(reader.attach).toHaveBeenCalled();
    expect(reader.config.document).toBeInstanceOf(Y.Doc);
    expect(readDocProvider(name)).toBeNull();
    expect(hasDoc(name)).toBe(false);

    serve(reader, canvasUpdate(['a']));
    await pending;
  });

  it('is read once synced, and its provider, Y.Doc and socket are destroyed', async () => {
    const requested = [{ id: 'c1' }];
    const pending = read(requested);
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    serve(reader, canvasUpdate(['a', 'b']));

    const got = await pending;

    expect(got[0]).toMatchObject({ id: 'c1', name: 'Cast', kind: 'canvas', state: 'read', detail: { slim: false } });
    expect(got[0]).not.toHaveProperty('nodes_missing');
    expect(got[0]).not.toHaveProperty('blocks_total');
    expect(torndown(reader)).toBe(true);
    expect(accepted(requested, got)).toBe(true);
  });

  it('reads a closed document from its stored blocks', async () => {
    const pending = read([{ id: 'd1' }]);
    const reader = await readerFor(docName.documentSpace(PID, doc.id));
    serve(reader, (await documentSeed('# Scene 1\n\nThe hero walks.')).update);

    const got = await pending;

    expect(got).toEqual([
      {
        id: 'd1',
        name: 'Storyboard',
        kind: 'document',
        state: 'read',
        content: '<!-- b:1 -->\n# Scene 1\n\n<!-- b:2 -->\nThe hero walks.',
        total_chars: '<!-- b:1 -->\n# Scene 1\n\n<!-- b:2 -->\nThe hero walks.'.length,
      },
    ]);
    expect(torndown(reader)).toBe(true);
  });

  it('opens one socket for the whole request, one provider and Y.Doc per Space', async () => {
    const pending = read([{ id: 'd1' }, { id: 'd2' }]);
    const first = await readerFor(docName.documentSpace(PID, doc.id));
    serve(first, (await documentSeed('One')).update);
    const second = await readerFor(docName.documentSpace(PID, doc2.id));
    serve(second, (await documentSeed('Two')).update);

    const got = await pending;

    expect(got.map((s) => [s.id, s.state])).toEqual([['d1', 'read'], ['d2', 'read']]);
    expect(first.config.websocketProvider).toBe(second.config.websocketProvider);
    expect(wsInstances).toHaveLength(1);
    expect(first.config.document).not.toBe(second.config.document);
    expect(torndown(first) && torndown(second)).toBe(true);
  });

  it('is gone, named and kinded, when the server refuses the connection', async () => {
    const pending = read([{ id: 'c1' }]);
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    reader.emit('authenticationFailed', { reason: 'Forbidden' });

    expect(await pending).toEqual([{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'gone' }]);
    expect(torndown(reader)).toBe(true);
  });

  it('times out when it never syncs within the read timeout', async () => {
    const pending = read([{ id: 'c1' }], { limits: { currentSpaceMaxChars: 100_000, spaceReadTimeoutMs: 30 } });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));

    expect(await pending).toEqual([{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'timed_out' }]);
    expect(torndown(reader)).toBe(true);
  });

  it('failed when it synced but could not be packed', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(client, 'fetchQuery').mockRejectedValue(new Error('catalog down'));
    vi.spyOn(client, 'ensureQueryData').mockRejectedValue(new Error('catalog down'));
    const pending = read([{ id: 'c1' }], { queryClient: client });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    serve(reader, canvasUpdate(['a']));

    expect(await pending).toEqual([{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'failed' }]);
    expect(torndown(reader)).toBe(true);
  });

  it('ignores a sync that arrives after it timed out', async () => {
    const pending = read([{ id: 'c1' }], { limits: { currentSpaceMaxChars: 100_000, spaceReadTimeoutMs: 30 } });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    const got = await pending;

    serve(reader, canvasUpdate(['a']));

    expect(got).toEqual([{ id: 'c1', name: 'Cast', kind: 'canvas', state: 'timed_out' }]);
  });

  it('destroys its provider, Y.Doc and socket when the read is voided', async () => {
    const stop = new AbortController();
    const pending = read([{ id: 'c1' }], { signal: stop.signal });
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));

    stop.abort();
    await pending.catch(() => undefined);

    expect(torndown(reader)).toBe(true);
  });

  it('leaves a tab that opens the same Space mid-read untouched', async () => {
    const name = docName.canvasSpace(PID, canvas.id);
    const pending = read([{ id: 'c1' }]);
    const reader = await readerFor(name);
    const tab = acquireDocProvider(name, getDoc(name), URL_PATH) as unknown as FakeProvider;
    const sharedSocket = tab.config.websocketProvider as FakeSocket;

    serve(reader, canvasUpdate(['a']));
    const got = await pending;

    expect(got[0]).toMatchObject({ state: 'read' });
    expect(sharedSocket).not.toBe(reader.config.websocketProvider);
    expect(reader.config.document).not.toBe(getDoc(name));
    expect(tab.destroy).not.toHaveBeenCalled();
    expect(sharedSocket.destroy).not.toHaveBeenCalled();
    expect(readDocProvider(name)).toBe(tab);
    expect(destroyedDocs.has(getDoc(name))).toBe(false);
  });

  it('gives every requested Space its own ending, in the order asked', async () => {
    const pending = read([{ id: 'missing' }, { id: 't1' }, { id: 'c1' }]);
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    serve(reader, canvasUpdate(['a']));

    const got = await pending;

    expect(got.map((s) => [s.id, s.state])).toEqual([['missing', 'gone'], ['t1', 'unreadable'], ['c1', 'read']]);
  });
});

describe('a part of a document', () => {
  /**
   * Read a closed document holding these paragraphs, asking for some blocks.
   * @param blocks - The range asked for.
   * @param markdown - What it holds.
   * @param trailingEmpty - Whether it ends in an empty block.
   * @returns What was read for it.
   */
  const readRange = async (
    blocks: { from: number; to?: number },
    markdown = 'One\n\nTwo\n\nThree\n\nFour',
    trailingEmpty = false,
  ): Promise<Got[number] & { content?: string; blocks_total?: number; total_chars?: number }> => {
    const requested = [{ id: 'd1', blocks }];
    const pending = read(requested);
    const reader = await readerFor(docName.documentSpace(PID, doc.id));
    serve(reader, (await documentSeed(markdown, trailingEmpty)).update);
    const got = await pending;
    expect(accepted(requested, got)).toBe(true);
    return got[0] as Got[number] & { content?: string; blocks_total?: number; total_chars?: number };
  };

  it('keeps the blocks their original numbers and says how many the document has', async () => {
    const got = await readRange({ from: 2, to: 3 });

    expect(got).toMatchObject({ id: 'd1', state: 'read', content: '<!-- b:2 -->\nTwo\n\n<!-- b:3 -->\nThree', blocks_total: 4 });
    expect(got.total_chars).toBe(got.content?.length);
  });

  it('reads from a block to the end when no end is given', async () => {
    const got = await readRange({ from: 3 });

    expect(got).toMatchObject({ content: '<!-- b:3 -->\nThree\n\n<!-- b:4 -->\nFour', blocks_total: 4 });
  });

  it('gives what there is when the range runs past the end', async () => {
    const got = await readRange({ from: 3, to: 10 });

    expect(got).toMatchObject({ content: '<!-- b:3 -->\nThree\n\n<!-- b:4 -->\nFour', blocks_total: 4 });
  });

  it('is empty, with the real block count, when the range lies wholly past the end', async () => {
    const got = await readRange({ from: 10, to: 12 });

    expect(got).toMatchObject({ state: 'read', content: '', total_chars: 0, blocks_total: 4 });
  });

  it('counts the blocks the way the markers number them when the document ends in an empty block', async () => {
    const got = await readRange({ from: 1 }, 'One\n\nTwo\n\nThree', true);
    const markers = [...(got.content ?? '').matchAll(/<!-- b:(\d+) -->/g)].map((m) => Number(m[1]));

    expect(Math.max(...markers)).toBe(3);
    expect(got.blocks_total).toBe(3);
  });

  it('cuts each Space to the per-Space limit', async () => {
    const pending = read([{ id: 'd1' }, { id: 'd2' }], { limits: { currentSpaceMaxChars: 20, spaceReadTimeoutMs: 5_000 } });
    const first = await readerFor(docName.documentSpace(PID, doc.id));
    serve(first, (await documentSeed('First paragraph here\n\nSecond paragraph here')).update);
    const second = await readerFor(docName.documentSpace(PID, doc2.id));
    serve(second, (await documentSeed('Another long paragraph\n\nAnd one more')).update);

    const got = (await pending) as Array<{ content: string; total_chars: number }>;

    for (const space of got) {
      expect(space.content.length).toBeLessThanOrEqual(20);
      expect(space.total_chars).toBeGreaterThan(20);
    }
  });
});

describe('some nodes of a canvas', () => {
  /**
   * Read a closed canvas holding nodes a, b and c, asking for some of them.
   * @param nodeIds - The nodes asked for.
   * @returns What was read for it.
   */
  const readNodes = async (nodeIds: string[]): Promise<{ content: string; nodes_missing?: number; detail?: unknown; state: string }> => {
    const requested = [{ id: 'c1', node_ids: nodeIds }];
    const pending = read(requested);
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    serve(reader, canvasUpdate(['a', 'b', 'c']));
    const got = await pending;
    expect(accepted(requested, got)).toBe(true);
    return got[0] as { content: string; nodes_missing?: number; detail?: unknown; state: string };
  };

  it('packs only the nodes asked for and counts the ones no longer there', async () => {
    const got = await readNodes(['a', 'c', 'gone-node']);
    const ids = (JSON.parse(got.content) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id).sort();

    expect(got.state).toBe('read');
    expect(ids).toEqual(['a', 'c']);
    expect(got.nodes_missing).toBe(1);
    expect(got.detail).toBeDefined();
  });

  it('is empty, every one missing, when none of the nodes asked for is there', async () => {
    const got = await readNodes(['x', 'y']);

    expect(got).toMatchObject({ state: 'read', content: '', nodes_missing: 2 });
  });

  it('says none is missing when every node asked for is there', async () => {
    const got = await readNodes(['b']);

    expect(got.nodes_missing).toBe(0);
  });
});

describe('the open Space and a requested Space read the same way', () => {
  it('packs a canvas identically on both paths', async () => {
    const update = canvasUpdate(['a', 'b']);
    const pending = read([{ id: 'c1' }]);
    const reader = await readerFor(docName.canvasSpace(PID, canvas.id));
    serve(reader, update);
    const requested = (await pending)[0] as { content: string; total_chars: number; detail: unknown };

    holdSynced(docName.canvasSpace(PID, canvas.id), update);
    const current = clipSpaceContext(
      readSpaceContext({ projectId: PID, activeSpace: canvas, spaces, enabled: true, queryClient: warmClient() }),
      { currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 },
      [],
    ).current_space as { content: string; total_chars: number; detail: unknown };

    expect(requested.content).toBe(current.content);
    expect(requested.total_chars).toBe(current.total_chars);
    expect(requested.detail).toEqual(current.detail);
  });

  it('packs a document identically on both paths', async () => {
    const seed = await documentSeed('# Scene 1\n\n* Props\n  * A map\n\n1. Wide\n2. Close');
    const pending = read([{ id: 'd1' }]);
    const reader = await readerFor(docName.documentSpace(PID, doc.id));
    serve(reader, seed.update);
    const requested = (await pending)[0] as { content: string; total_chars: number };

    const name = docName.documentSpace(PID, doc.id);
    holdSynced(name, seed.update);
    editors.set(name, { editor: seed.editor });
    const current = clipSpaceContext(
      readSpaceContext({ projectId: PID, activeSpace: doc, spaces, enabled: true, queryClient: warmClient() }),
      { currentSpaceMaxChars: 100_000, spaceListMaxItems: 200 },
      [],
    ).current_space as { content: string; total_chars: number };

    expect(requested.content).toBe(current.content);
    expect(requested.total_chars).toBe(current.total_chars);
  });
});
