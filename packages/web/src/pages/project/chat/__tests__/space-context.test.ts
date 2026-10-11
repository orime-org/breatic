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
import type { ChatAttachedChip, ChatSpaceContext, ModelCatalog } from '@breatic/shared';
import { chatMessageSchema, documentBodyFragment } from '@breatic/shared';

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

const { addNode, setNodeName } = await import('@web/data/yjs/canvas-space');
const { canvasGraphs } = await import('@web/stores/canvas-graph');
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
    const current = clipSpaceContext(read(), { currentSpaceMaxChars: max, spaceListMaxItems: 200 }, []).current_space;
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

  /**
   * The open canvas as one message carries it, with the attachments it goes with.
   * @param max - How many characters may go.
   * @param attached - The message's attachments.
   * @param overrides - What the read changes.
   * @returns What goes for the open Space.
   */
  const sentWith = (
    max: number,
    attached: readonly ChatAttachedChip[] = [],
    overrides: Partial<Parameters<typeof readSpaceContext>[0]> = {},
  ): ChatSpaceContext['current_space'] =>
    clipSpaceContext(read(overrides), { currentSpaceMaxChars: max, spaceListMaxItems: 200 }, attached).current_space;

  /**
   * Mark nodes selected on a canvas, as the canvas does when the reader selects them.
   * @param spaceId - The canvas.
   * @param ids - The selected nodes.
   */
  const select = (spaceId: string, ids: readonly string[]): void => {
    canvasGraphs.of(spaceId).getState().setFlowNodes(() =>
      ids.map((id) => ({ id, position: { x: 0, y: 0 }, data: {}, selected: true })),
    );
  };

  /**
   * Put a node with a long prompt on the open canvas.
   * @param id - Its id.
   * @param createdAt - When it was made.
   * @param parentId - Its group, if any.
   */
  const addLongNode = (id: string, createdAt: number, parentId?: string): void => {
    addNode(PID, canvas.id, {
      id,
      type: 'text',
      position: { x: 0, y: 0 },
      ...(parentId ? { parentId } : {}),
      data: { name: `Node ${id}`, createdAt, createdBy: 'u1', locked: false, attachments: [], prompt: 'a quiet street '.repeat(60) } as never,
    });
  };

  /**
   * What went for one node.
   * @param current - What went for the open Space.
   * @param id - The node.
   * @returns Its entry.
   */
  const entryOf = (current: ChatSpaceContext['current_space'], id: string): Record<string, unknown> | undefined =>
    current?.state === 'loaded'
      ? (JSON.parse(current.content) as { nodes: Array<Record<string, unknown>> }).nodes.find((n) => n.id === id)
      : undefined;

  /**
   * Whether what went for the open Space is a message the server takes.
   * @param current - What went.
   * @returns True when it parses.
   */
  const accepted = (current: ChatSpaceContext['current_space']): boolean =>
    chatMessageSchema.safeParse({
      message: 'hi',
      project_id: '11111111-1111-4111-8111-111111111111',
      conversation_id: '22222222-2222-4222-8222-222222222222',
      current_space: current,
    }).success;

  it('says nothing was done when the canvas fits', () => {
    openCanvas();
    addNodes(['n1']);

    const current = sentWith(100_000);

    expect(current).toMatchObject({ state: 'loaded', detail: { slim: false, texts_cut: 0, nodes_not_listed: 0 } });
    expect(accepted(current)).toBe(true);
  });

  it('keeps the nodes the reader selected whole while the others go slim', () => {
    openCanvas();
    addLongNode('a', 1);
    addLongNode('b', 2);
    addLongNode('c', 3);
    select(canvas.id, ['b']);
    const whole = sentWith(100_000);
    const total = whole?.state === 'loaded' ? whole.total_chars : 0;

    const current = sentWith(total - 50);

    expect(current).toMatchObject({ detail: { selected_total: 1, selected_whole: 1, slim: true } });
    expect(entryOf(current, 'b')).toEqual(entryOf(whole, 'b'));
    expect(entryOf(current, 'a')).not.toHaveProperty('position');
    expect(accepted(current)).toBe(true);
  });

  it('reads the selection of the canvas that is open, not of one the reader looked at before', () => {
    openCanvas();
    addLongNode('a', 1);
    addLongNode('b', 2);
    select(canvas.id, ['a']);
    select('elsewhere', ['b']);

    expect(sentWith(100_000)).toMatchObject({ detail: { selected_total: 1, selected_whole: 1 } });
  });

  it('counts a selected group with its members', () => {
    openCanvas();
    addNode(PID, canvas.id, {
      id: 'g',
      type: 'group',
      position: { x: 0, y: 0 },
      data: { name: 'Group', createdAt: 0, createdBy: 'u1', locked: false, attachments: [] },
    });
    addLongNode('a', 1, 'g');
    addLongNode('b', 2);
    select(canvas.id, ['g']);

    expect(sentWith(100_000)).toMatchObject({ detail: { selected_total: 2, selected_whole: 2 } });
  });

  /**
   * A canvas attachment holding these nodes as they stand now.
   * @param ids - The nodes.
   * @returns The chip.
   */
  const attachmentOf = (ids: readonly string[]): ChatAttachedChip => {
    const current = sentWith(100_000);
    const nodes = ids.map((id) => entryOf(current, id));
    return { id: 'canvas-1', type: 'canvas', name: '', data_snapshot: { nodes, edges: [] } };
  };

  it('sends a selected node the attachments already hold unchanged with the rest', () => {
    openCanvas();
    addLongNode('a', 1);
    addLongNode('b', 2);
    select(canvas.id, ['a']);
    const chip = attachmentOf(['a']);
    const whole = sentWith(100_000);
    const total = whole?.state === 'loaded' ? whole.total_chars : 0;

    const current = sentWith(total - 50, [chip]);

    expect(current).toMatchObject({ detail: { selected_total: 1, selected_attached: 1, selected_whole: 0 } });
    expect(entryOf(current, 'a')).not.toHaveProperty('position');
  });

  it('keeps a selected node first when it changed after it was attached', () => {
    openCanvas();
    addLongNode('a', 1);
    addLongNode('b', 2);
    select(canvas.id, ['a']);
    const chip = attachmentOf(['a']);
    setNodeName(PID, canvas.id, 'a', 'Renamed');
    const whole = sentWith(100_000);
    const total = whole?.state === 'loaded' ? whole.total_chars : 0;

    const current = sentWith(total - 50, [chip]);

    expect(current).toMatchObject({ detail: { selected_total: 1, selected_attached: 0, selected_whole: 1 } });
    expect(entryOf(current, 'a')).toMatchObject({ data: { name: 'Renamed' } });
  });

  it('is empty, and says nothing was done, when it holds nothing that can be handed over', () => {
    openCanvas();

    const current = sentWith(100_000);

    expect(current).toMatchObject({ state: 'loaded', content: '', total_chars: 0, detail: { selected_total: 0, slim: false } });
    expect(accepted(current)).toBe(true);
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
    const cut = clipSpaceContext(read({ enabled: false }), limits, []);

    expect(cut.spaces?.map((s) => s.id)).toEqual(['t1', 'd1']);
    expect(cut.spaces_total).toBe(3);
    expect(cut).not.toHaveProperty('current_space');
  });

  it('keeps the start of the open Space content and says how long it was', () => {
    const cut = clipSpaceContext(
      { spaces: [], current: { id: 'd1', name: 'Storyboard', kind: 'document', state: 'loaded', text: 'abcdef' } },
      limits,
      [],
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

  /**
   * A document's content cut to the limit.
   * @param text - What the document holds.
   * @returns What goes and how long it was.
   */
  const cutDocument = (text: string): { content: string; total: number } => {
    const current = clipSpaceContext(
      { spaces: [], current: { id: 'd1', name: 'Storyboard', kind: 'document', state: 'loaded', text } },
      limits,
      [],
    ).current_space;
    return current?.state === 'loaded' ? { content: current.content, total: current.total_chars } : { content: '', total: -1 };
  };

  it('keeps a document within the limit whole', () => {
    expect(cutDocument('abc')).toEqual({ content: 'abc', total: 3 });
  });

  it('counts UTF-16 code units, as the message length is counted', () => {
    expect(cutDocument('分镜表格子')).toEqual({ content: '分镜表格', total: 5 });
  });

  it('does not leave half of a character when the limit falls inside one', () => {
    expect(cutDocument('abc😀d')).toEqual({ content: 'abc', total: 6 });
  });

  it('passes an open Space that has not loaded as it is', () => {
    const cut = clipSpaceContext(
      { spaces: [], current: { id: 'c1', name: 'Cast', kind: 'canvas', state: 'loading' } },
      limits,
      [],
    );

    expect(cut.current_space).toEqual({ id: 'c1', name: 'Cast', kind: 'canvas', state: 'loading' });
  });
});
