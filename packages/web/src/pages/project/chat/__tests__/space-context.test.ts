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
  it('carries its nodes and links as indented JSON', () => {
    openCanvas();
    addNode(PID, canvas.id, {
      id: 'n1',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { name: 'Hero', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
    });

    const got = read();

    expect(got.current).toMatchObject({ id: 'c1', name: 'Cast', kind: 'canvas', state: 'loaded' });
    const text = got.current?.state === 'loaded' ? got.current.text : '';
    expect(text).toContain('\n  "nodes": [');
    expect(JSON.parse(text)).toMatchObject({ nodes: [{ id: 'n1', type: 'text', data: { name: 'Hero' } }], edges: [] });
  });

  it('keeps its links when its content is cut to the limit', () => {
    openCanvas();
    for (const id of ['n1', 'n2']) {
      addNode(PID, canvas.id, {
        id,
        type: 'text',
        position: { x: 0, y: 0 },
        data: { name: `Node ${id}`, createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
      });
    }
    addEdge(PID, canvas.id, { id: 'e1', source: 'n1', target: 'n2' });

    const cut = clipSpaceContext(read(), { currentSpaceMaxChars: 200, spaceListMaxItems: 200 });

    const current = cut.current_space;
    expect(current?.state === 'loaded' && current.total_chars).toBeGreaterThan(200);
    expect(current?.state === 'loaded' ? current.content : '').toContain('"source": "n1"');
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
    const text = got.current?.state === 'loaded' ? got.current.text : '';
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
