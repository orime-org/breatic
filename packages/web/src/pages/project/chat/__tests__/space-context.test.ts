// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a message says about the reader's Spaces (inner#1413): read at the
 * press from what this tab already holds -- no document is created and no
 * request is made -- then cut to the limits the server reads.
 */

import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { ModelCatalog } from '@breatic/shared';
import { documentBodyFragment } from '@breatic/shared';

import type { ProjectSpace } from '@web/data/yjs/project-meta';

const synced = vi.hoisted(() => new Set<string>());
const editors = vi.hoisted(() => new Map<string, unknown>());

vi.mock('@web/data/yjs/collab-socket', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDocFacts: (name: string) => ({ hasEverSynced: synced.has(name), authFailure: null }),
}));
vi.mock('@web/spaces/document/document-editor-cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  peekDocumentEditor: (name: string) => editors.get(name),
}));

const { addEdge, addNode } = await import('@web/data/yjs/canvas-space');
const { _resetForTests, docName, getDoc, hasDoc } = await import('@web/data/yjs/manager');
const { modelCatalogQuery } = await import('@web/spaces/canvas/generate/model-catalog-query');
const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { clipSpaceContext, readSpaceContext } = await import('@web/pages/project/chat/space-context');

const PID = 'p1';
const CATALOG = {
  image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1,
} as unknown as ModelCatalog;

const canvas: ProjectSpace = { id: 'c1', name: 'Cast', type: 'canvas', createdAt: 1 };
const doc: ProjectSpace = { id: 'd1', name: 'Storyboard', type: 'document', createdAt: 2 };
const timeline: ProjectSpace = { id: 't1', name: 'Edit', type: 'timeline', createdAt: 3 };
const spaces = [canvas, doc, timeline];

/**
 * A client with the catalog cached, as a canvas that has drawn once holds it.
 * @returns The client.
 */
function warmClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  return client;
}

/**
 * Mark a canvas Space open and synced in this tab.
 * @returns Its document name.
 */
function openCanvas(): string {
  const name = docName.canvasSpace(PID, canvas.id);
  getDoc(name);
  synced.add(name);
  return name;
}

/**
 * Mark a document Space open and synced, with an editor holding some Markdown.
 * @param markdown - What the document holds.
 * @returns Its document name.
 */
async function openDocument(markdown: string): Promise<string> {
  const name = docName.documentSpace(PID, doc.id);
  getDoc(name);
  synced.add(name);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()), extensions: [] });
  if (markdown !== '') editor.replaceBlocks(editor.document, await editor.tryParseMarkdownToBlocks(markdown));
  editors.set(name, { editor });
  return name;
}

/**
 * Read with the defaults most cases share.
 * @param overrides - What this case changes.
 * @returns What was read.
 */
function read(overrides: Partial<Parameters<typeof readSpaceContext>[0]> = {}): ReturnType<typeof readSpaceContext> {
  return readSpaceContext({
    projectId: PID,
    activeSpace: canvas,
    spaces,
    enabled: true,
    queryClient: warmClient(),
    ...overrides,
  });
}

beforeEach(() => {
  _resetForTests();
  synced.clear();
  editors.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the Space list', () => {
  it('lists every Space newest first by name and kind', () => {
    expect(read().spaces).toEqual([
      { id: 't1', name: 'Edit', kind: 'timeline' },
      { id: 'd1', name: 'Storyboard', kind: 'document' },
      { id: 'c1', name: 'Cast', kind: 'canvas' },
    ]);
  });

  it('is sent with no open Space when the reader turned it off', () => {
    openCanvas();
    const got = read({ enabled: false });

    expect(got.spaces).toHaveLength(3);
    expect(got.current).toBeUndefined();
  });

  it('is sent with no open Space when no tab is open', () => {
    const got = read({ activeSpace: undefined });

    expect(got.spaces).toHaveLength(3);
    expect(got.current).toBeUndefined();
  });
});

describe('an open canvas', () => {
  /**
   * Put text nodes on the open canvas.
   * @param ids - Their ids.
   */
  const addNodes = (ids: readonly string[]): void => {
    for (const id of ids) {
      addNode(PID, canvas.id, {
        id,
        type: 'text',
        position: { x: 0, y: 0 },
        data: { name: `Node ${id}`, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
      });
    }
  };

  /**
   * The open canvas as one message carries it, cut to a limit.
   * @param max - How many characters may go.
   * @returns The content and its full length.
   */
  const sent = (max: number): { content: string; total: number } => {
    const current = clipSpaceContext(read(), { currentSpaceMaxChars: max, spaceListMaxItems: 200 }).current_space;
    return current?.state === 'loaded' ? { content: current.content, total: current.total_chars } : { content: '', total: -1 };
  };

  it('carries its nodes and links as compact JSON', () => {
    openCanvas();
    addNodes(['n1']);

    const { content, total } = sent(100_000);

    expect(content).not.toContain('\n');
    expect(total).toBe(content.length);
    expect(JSON.parse(content)).toMatchObject({ edges: [], nodes: [{ id: 'n1', type: 'text', data: { name: 'Node n1' } }] });
  });

  /** A canvas text as parsed back. */
  interface Parsed {
    nodes: Array<{ id: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
  }

  /**
   * The text the cut should send when it keeps exactly these nodes and links.
   * @param full - The whole canvas, parsed.
   * @param nodeIds - The nodes kept.
   * @param edgeIds - The links kept.
   * @returns The compact JSON.
   */
  const keeping = (full: Parsed, nodeIds: readonly string[], edgeIds: readonly string[]): string =>
    JSON.stringify({
      edges: full.edges.filter((e) => edgeIds.includes(e.id)),
      nodes: full.nodes.filter((n) => nodeIds.includes(n.id)),
    });

  /**
   * Put a text node whose name is `size` characters long on the open canvas.
   * @param id - Its id.
   * @param size - How long its name is.
   */
  const addBigNode = (id: string, size: number): void => {
    addNode(PID, canvas.id, {
      id,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { name: 'x'.repeat(size), createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });
  };

  it('keeps every node that fits in order, and the links between them, when cut to the limit', () => {
    openCanvas();
    addNodes(['n1', 'n2', 'n3']);
    addEdge(PID, canvas.id, { id: 'e1', source: 'n1', target: 'n2' });
    addEdge(PID, canvas.id, { id: 'e2', source: 'n2', target: 'n3' });
    const full = sent(100_000);
    const parsed = JSON.parse(full.content) as Parsed;
    const two = keeping(parsed, ['n1', 'n2'], ['e1']);

    expect(sent(two.length)).toEqual({ content: two, total: full.total });
    // n2 no longer fits with its link to n1; n3 has no link to n1 and does.
    expect(sent(two.length - 1)).toEqual({ content: keeping(parsed, ['n1', 'n3'], []), total: full.total });
  });

  it('stays within the limit when a node closes several links at once', () => {
    openCanvas();
    addNodes(['n1', 'n2', 'n3']);
    addEdge(PID, canvas.id, { id: 'e1', source: 'n1', target: 'n2' });
    addEdge(PID, canvas.id, { id: 'e2', source: 'n2', target: 'n3' });
    addEdge(PID, canvas.id, { id: 'e3', source: 'n1', target: 'n3' });
    const full = sent(100_000);
    const parsed = JSON.parse(full.content) as Parsed;

    expect(sent(full.total - 1)).toEqual({ content: keeping(parsed, ['n1', 'n2'], ['e1']), total: full.total });
  });

  it('skips a node too big for the limit and keeps every node after it that fits', () => {
    openCanvas();
    addBigNode('big', 5_000);
    addNodes(['n1', 'n2', 'n3']);
    addEdge(PID, canvas.id, { id: 'e1', source: 'big', target: 'n1' });
    addEdge(PID, canvas.id, { id: 'e2', source: 'n1', target: 'n2' });
    addEdge(PID, canvas.id, { id: 'e3', source: 'n3', target: 'n3' });
    const full = sent(100_000);
    const parsed = JSON.parse(full.content) as Parsed;

    expect(sent(2_000)).toEqual({ content: keeping(parsed, ['n1', 'n2', 'n3'], ['e2', 'e3']), total: full.total });
  });

  it('skips a node too big for the limit in the middle of the canvas', () => {
    openCanvas();
    addNodes(['n1']);
    addBigNode('big', 5_000);
    addNodes(['n2']);
    addEdge(PID, canvas.id, { id: 'e1', source: 'n1', target: 'n2' });
    const full = sent(100_000);
    const parsed = JSON.parse(full.content) as Parsed;

    expect(sent(2_000)).toEqual({ content: keeping(parsed, ['n1', 'n2'], ['e1']), total: full.total });
  });

  it('sends no nodes when the only node is too big for the limit', () => {
    openCanvas();
    addBigNode('big', 5_000);
    const full = sent(100_000);

    expect(sent(2_000)).toEqual({ content: '{"edges":[],"nodes":[]}', total: full.total });
  });

  it('still carries nodes when its links alone would fill the limit', () => {
    openCanvas();
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    addNodes(ids);
    for (const source of ids) {
      for (const target of ids) {
        if (source !== target) addEdge(PID, canvas.id, { id: `${source}-${target}`, source, target });
      }
    }
    const linksOnly = JSON.stringify(JSON.parse(sent(100_000).content).edges).length;

    const { content } = sent(Math.floor(linksOnly / 2));

    expect((JSON.parse(content) as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
  });

  it('is empty when it holds nothing that can be handed over', () => {
    openCanvas();

    expect(read().current).toMatchObject({ state: 'loaded', text: '' });
  });

  it('has not loaded while its document has not synced', () => {
    getDoc(docName.canvasSpace(PID, canvas.id));

    expect(read().current).toMatchObject({ kind: 'canvas', state: 'loading' });
  });

  it('has not loaded while the model catalog is not cached, and asks for nothing', () => {
    openCanvas();
    const client = new QueryClient();
    const fetchQuery = vi.spyOn(client, 'fetchQuery');

    expect(read({ queryClient: client }).current).toMatchObject({ state: 'loading' });
    expect(fetchQuery).not.toHaveBeenCalled();
  });

  it('creates no document for a Space this tab does not hold', () => {
    expect(read().current).toMatchObject({ state: 'loading' });
    expect(hasDoc(docName.canvasSpace(PID, canvas.id))).toBe(false);
  });
});

describe('an open document', () => {
  it('carries its text as Markdown', async () => {
    await openDocument('# Scene 1\n\nThe hero arrives.');

    const got = read({ activeSpace: doc });

    expect(got.current).toMatchObject({ id: 'd1', kind: 'document', state: 'loaded' });
    const text = got.current?.state === 'loaded' && 'text' in got.current ? got.current.text : '';
    expect(text).toContain('# Scene 1');
    expect(text).toContain('The hero arrives.');
  });

  it('is empty when it holds only whitespace', async () => {
    await openDocument('');

    expect(read({ activeSpace: doc }).current).toMatchObject({ state: 'loaded', text: '' });
  });

  it('has not loaded while there is no editor for it', () => {
    const name = docName.documentSpace(PID, doc.id);
    getDoc(name);
    synced.add(name);

    expect(read({ activeSpace: doc }).current).toMatchObject({ state: 'loading' });
  });

  it('has not loaded while its document has not synced', async () => {
    const name = await openDocument('# Scene 1');
    synced.delete(name);

    expect(read({ activeSpace: doc }).current).toMatchObject({ state: 'loading' });
  });
});

describe('an open timeline', () => {
  it('cannot be read', () => {
    expect(read({ activeSpace: timeline }).current).toEqual({
      id: 't1',
      name: 'Edit',
      kind: 'timeline',
      state: 'unreadable',
    });
  });
});

describe('cutting what was read to the limits', () => {
  const limits = { currentSpaceMaxChars: 4, spaceListMaxItems: 2 };

  it('keeps the newest Spaces and says how many there are', () => {
    const cut = clipSpaceContext(read({ enabled: false }), limits);

    expect(cut.spaces?.map((s) => s.id)).toEqual(['t1', 'd1']);
    expect(cut.spaces_total).toBe(3);
    expect(cut).not.toHaveProperty('current_space');
  });

  it('keeps the start of the open Space content and says how long it was', () => {
    const cut = clipSpaceContext(
      { spaces: [], current: { id: 'd1', name: 'Storyboard', kind: 'document', state: 'loaded', text: 'abcdef' } },
      limits,
    );

    expect(cut.current_space).toEqual({
      id: 'd1',
      name: 'Storyboard',
      kind: 'document',
      state: 'loaded',
      content: 'abcd',
      total_chars: 6,
    });
  });

  it('passes an open Space that has not loaded as it is', () => {
    const cut = clipSpaceContext(
      { spaces: [], current: { id: 'c1', name: 'Cast', kind: 'canvas', state: 'loading' } },
      limits,
    );

    expect(cut.current_space).toEqual({ id: 'c1', name: 'Cast', kind: 'canvas', state: 'loading' });
  });
});
