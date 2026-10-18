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
import { COMMENT_MARK } from '@web/spaces/document/document-comment-extension';

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

const { addNode, readEdges, readNodes, setNodeName } = await import('@web/data/yjs/canvas-space');
const { itemForPick } = await import('@web/spaces/canvas/attach-nodes');
const { pickReaders } = await import('@web/spaces/canvas/pick-for-agent');
const { canvasGraphs } = await import('@web/stores/canvas-graph');
const { _resetForTests, docName, getDoc, hasDoc } = await import('@web/data/yjs/manager');
const { modelCatalogQuery } = await import('@web/spaces/canvas/generate/model-catalog-query');
const { buildDocumentEditor } = await import('@web/spaces/document/build-document-editor');
const { clipSpaceContext, readSpaceContext } = await import('@web/pages/project/chat/space-context');
type ReadBlock = import('@web/spaces/document/document-blocks-read').ReadBlock;
type DocumentEditor = ReturnType<typeof buildDocumentEditor>;

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
    const canvasDoc = getDoc(docName.canvasSpace(PID, canvas.id));
    const item = itemForPick(
      { nodes: readNodes(canvasDoc), edges: readEdges(canvasDoc) },
      ids,
      pickReaders(warmClient(), CATALOG, canvasDoc),
    );
    if (item?.chip === undefined) throw new Error('nothing to attach');
    return item.chip;
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
    expect(entryOf(current, 'a')).toHaveProperty('selected', true);
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
  /**
   * The blocks read from the open document.
   * @returns What each top-level block holds.
   */
  const readBlocks = (): ReadBlock[] => {
    const got = read({ activeSpace: doc }).current;
    return got?.state === 'loaded' && 'blocks' in got ? got.blocks : [];
  };

  it('carries each top-level block as Markdown with its id, type and plain text', async () => {
    const name = await openDocument('# Scene 1\n\nThe **hero** reads [the map](https://example.com).');
    const ids = (editors.get(name) as { editor: { document: Array<{ id: string }> } }).editor.document.map((b) => b.id);

    const blocks = readBlocks();

    expect(blocks.map((b) => [b.id, b.type, b.text])).toEqual([
      [ids[0], 'heading', 'Scene 1'],
      [ids[1], 'paragraph', 'The hero reads the map.'],
    ]);
    expect(blocks[0]?.markdown).toBe('# Scene 1');
    expect(blocks[1]?.markdown).toContain('**hero**');
  });

  it('reads a table cell by cell and a list item with the items under it', async () => {
    await openDocument('| Shot | Action |\n| --- | --- |\n| Close | She turns |\n\n* Props\n  * A map');

    expect(readBlocks().map((b) => b.text)).toEqual(['Shot\nAction\nClose\nShe turns', 'Props\nA map']);
  });

  it('numbers each item of an ordered list as the editor shows it', async () => {
    await openDocument('1. Wide\n2. Medium\n3. Close');

    expect(readBlocks().map((b) => b.markdown)).toEqual(['1. Wide', '2. Medium', '3. Close']);
  });

  it('marks a block whose colour, alignment or underline Markdown cannot carry', async () => {
    const name = await openDocument('Plain **bold** words\n\nColoured\n\nCentred\n\nUnderlined');
    const editor = (editors.get(name) as { editor: DocumentEditor }).editor;
    const [, coloured, centred, underlined] = editor.document;
    editor.updateBlock(coloured!, { props: { textColor: 'red' } } as never);
    editor.updateBlock(centred!, { props: { textAlignment: 'center' } } as never);
    editor.updateBlock(underlined!, { content: [{ type: 'text', text: 'Underlined', styles: { underline: true } }] } as never);

    expect(readBlocks().map((b) => b.lossy)).toEqual([false, true, true, true]);
  });

  it('marks a table with a column width and a passage with a comment on it', async () => {
    const name = await openDocument('| A | B |\n| --- | --- |\n| 1 | 2 |\n\nCommented words');
    const editor = (editors.get(name) as { editor: DocumentEditor }).editor;
    const view = editor.prosemirrorView!;
    let cellAt = -1;
    let wordsAt = -1;
    view.state.doc.descendants((node, pos) => {
      if (cellAt < 0 && (node.type.name === 'docTableHeader' || node.type.name === 'docTableCell')) cellAt = pos;
      if (wordsAt < 0 && node.isText && node.text === 'Commented words') wordsAt = pos;
      return true;
    });
    const cell = view.state.doc.nodeAt(cellAt)!;
    const comment = view.state.schema.marks[COMMENT_MARK]!.create({ threadId: 't1', orphan: false });
    view.dispatch(
      view.state.tr
        .setNodeMarkup(cellAt, undefined, { ...cell.attrs, colwidth: [240] })
        .addMark(wordsAt, wordsAt + 'Commented words'.length, comment),
    );

    expect(readBlocks().map((b) => b.lossy)).toEqual([true, true]);
  });

  it('marks a table with merged cells, which Markdown splits apart', async () => {
    const name = await openDocument('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| C | D |\n| --- | --- |\n| 3 | 4 |');
    const editor = (editors.get(name) as { editor: DocumentEditor }).editor;
    const view = editor.prosemirrorView!;
    let cellAt = -1;
    view.state.doc.descendants((node, pos) => {
      if (cellAt < 0 && (node.type.name === 'docTableHeader' || node.type.name === 'docTableCell')) cellAt = pos;
      return cellAt < 0;
    });
    const cell = view.state.doc.nodeAt(cellAt)!;
    view.dispatch(view.state.tr.setNodeMarkup(cellAt, undefined, { ...cell.attrs, colspan: 2 }));

    expect(readBlocks().map((b) => b.lossy)).toEqual([true, false]);
  });

  it('leaves out blocks that hold nothing', async () => {
    await openDocument('Before\n\n\n\nAfter');
    const name = docName.documentSpace(PID, doc.id);
    const editor = (editors.get(name) as { editor: DocumentEditor }).editor;
    editor.insertBlocks([{ type: 'paragraph' }] as never, editor.document[0]!, 'after');

    expect(readBlocks().map((b) => b.text)).toEqual(['Before', 'After']);
  });

  it('holds no blocks when it holds only whitespace', async () => {
    await openDocument('');

    expect(read({ activeSpace: doc }).current).toMatchObject({ state: 'loaded', blocks: [] });
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

  /**
   * A read block, its plain text standing in for its Markdown.
   * @param id - Its id.
   * @param markdown - What it reads as.
   * @returns The block.
   */
  const block = (id: string, markdown: string): ReadBlock => ({ id, type: 'paragraph', markdown, text: markdown, lossy: false });

  /**
   * A document cut to a limit.
   * @param blocks - What the document holds.
   * @param max - The limit.
   * @returns The open Space as it goes.
   */
  const cutDocument = (blocks: ReadBlock[], max: number): ChatSpaceContext['current_space'] =>
    clipSpaceContext(
      { spaces: [], current: { id: 'd1', name: 'Storyboard', kind: 'document', state: 'loaded', blocks } },
      { currentSpaceMaxChars: max, spaceListMaxItems: 2 },
      [],
    ).current_space;

  it('numbers each block in the content and lists the blocks it shows', () => {
    const got = cutDocument([block('a', 'One'), block('b', 'Two')], 1000);

    expect(got).toEqual({
      id: 'd1',
      name: 'Storyboard',
      kind: 'document',
      state: 'loaded',
      content: '<!-- b:1 -->\nOne\n\n<!-- b:2 -->\nTwo',
      total_chars: 34,
      blocks: [
        { id: 'a', type: 'paragraph', text: 'One', lossy: false, partial: false },
        { id: 'b', type: 'paragraph', text: 'Two', lossy: false, partial: false },
      ],
    });
  });

  it('cuts the block that crosses the limit, whichever it is, and sends none after it', () => {
    const got = cutDocument([block('a', 'One'), block('b', 'A long second block'), block('c', 'Three')], 33);

    expect(got).toMatchObject({ content: '<!-- b:1 -->\nOne\n\n<!-- b:2 -->\nA ', total_chars: 70 });
    expect(got?.state === 'loaded' ? got.blocks : undefined).toEqual([
      { id: 'a', type: 'paragraph', text: 'One', lossy: false, partial: false },
      { id: 'b', type: 'paragraph', text: '', lossy: false, partial: true },
    ]);
  });

  it('cuts the first block when it alone is over the limit', () => {
    const got = cutDocument([block('a', '分镜表格子很长'), block('b', 'Two')], 16);

    expect(got).toMatchObject({ content: '<!-- b:1 -->\n分镜表' });
    expect(got?.state === 'loaded' ? got.blocks : undefined).toEqual([
      { id: 'a', type: 'paragraph', text: '', lossy: false, partial: true },
    ]);
  });

  it('sends nothing of a block whose marker the limit cuts through', () => {
    const got = cutDocument([block('a', 'One'), block('b', 'Two')], 20);

    expect(got).toMatchObject({ content: '<!-- b:1 -->\nOne', total_chars: 34 });
    expect(got?.state === 'loaded' ? got.blocks?.map((b) => b.id) : undefined).toEqual(['a']);
  });

  it('does not leave half of a character when the limit falls inside one', () => {
    const got = cutDocument([block('a', 'abc😀d')], 17);

    expect(got).toMatchObject({ content: '<!-- b:1 -->\nabc' });
  });

  it('goes as empty when it holds no blocks', () => {
    expect(cutDocument([], 10)).toMatchObject({ content: '', total_chars: 0, blocks: [] });
  });

  it('passes the server check', () => {
    const current = cutDocument([block('a', 'One')], 1000);

    expect(
      chatMessageSchema.safeParse({
        message: 'hi',
        project_id: '11111111-1111-4111-8111-111111111111',
        conversation_id: '22222222-2222-4222-8222-222222222222',
        current_space: current,
      }).success,
    ).toBe(true);
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
