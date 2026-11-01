// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cell paste contracts from inner#1351 / inner#1390, A12–A15 and §5.4.7.
 * Real paste events exercise clipboard reading and placement together.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { toast } from '@web/lib/toast';
import { tableBlock } from './table-fixtures';
import {
  OURS,
  caretIn,
  open,
  paste,
  pasteFormats,
  positionOf,
  select,
  settled,
  unmountAll,
  type Editor,
} from './paste-harness';

const PICTURE = `${OURS}pasted.png`;
const OLD_PICTURE = `${OURS}original.png`;
const SOURCE_TABLE = '<table><tr><td>s1</td><td>s2</td></tr><tr><td>s3</td><td>s4</td></tr></table>';

beforeEach(() => {
  vi.spyOn(toast, 'warning').mockReturnValue('cell-paste-warning');
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

/**
 * Opens a body and lets fixture DOM updates settle before a user selection.
 * @param blocks - The initial body.
 * @returns The mounted body, undo manager and upload sink.
 */
async function openReady(blocks: Parameters<typeof open>[0]): Promise<ReturnType<typeof open>> {
  const opened = open(blocks);
  await act(async () => { await settled(); });
  return opened;
}

/** A node and its position before the node. */
type LocatedNode = { node: PMNode; pos: number };

/**
 * Finds nodes in document order without replacing the editor's read path.
 * @param editor - The mounted editor.
 * @param names - Node types to collect.
 * @returns The matching nodes and their positions.
 */
function nodesOf(editor: Editor, ...names: string[]): LocatedNode[] {
  const found: LocatedNode[] = [];
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (names.includes(node.type.name)) found.push({ node, pos });
    return true;
  });
  return found;
}

/**
 * Reads new-table cells in row order, including header cells.
 * @param editor - The mounted editor.
 * @returns The cells and their positions.
 */
function cellsOf(editor: Editor): LocatedNode[] {
  return nodesOf(editor, 'docTableCell', 'docTableHeader');
}

/**
 * Reads direct sibling blocks in a cell, not flattened descendant text.
 * @param cell - The cell.
 * @returns Each block's type and text or media address.
 */
function blocksOf(cell: PMNode): string[] {
  const blocks: string[] = [];
  cell.forEach((container) => {
    const block = container.firstChild!;
    const content = ['image', 'video', 'audio'].includes(block.type.name)
      ? String(block.attrs['url'])
      : block.textContent;
    blocks.push(`${block.type.name}:${content}`);
  });
  return blocks;
}

/**
 * Reads every table's grid, retaining its actual row and column dimensions.
 * @param editor - The mounted editor.
 * @returns One grid of cell text per table.
 */
function gridsOf(editor: Editor): string[][][] {
  return nodesOf(editor, 'docTable').map(({ node }) => {
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
    });
    return rows;
  });
}

/**
 * Selects a cell rectangle using the same selection class as the table UI.
 * @param editor - The mounted editor.
 * @param anchor - The anchor cell's index in row order.
 * @param head - The head cell's index in row order.
 */
function selectCells(editor: Editor, anchor: number, head: number): void {
  const view = editor.prosemirrorView;
  const cells = cellsOf(editor);
  view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cells[anchor]!.pos, cells[head]!.pos)));
  view.focus();
}

/**
 * Selects a media node as clicking its frame does.
 * @param editor - The mounted editor.
 * @param url - The selected media address.
 * @throws {Error} If the fixture has no matching image.
 */
function selectPicture(editor: Editor, url: string): void {
  const view = editor.prosemirrorView;
  const image = nodesOf(editor, 'image').find(({ node }) => node.attrs['url'] === url);
  if (image === undefined) throw new Error('The fixture must contain the selected image');
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, image.pos)));
  view.focus();
}

describe('ordinary blocks pasted into a docTable cell (A13)', () => {
  it('keeps words, an image and words in order between the two halves of the cell text', async () => {
    const { editor } = await openReady([
      { type: 'paragraph', content: 'outside before' },
      tableBlock({ rows: [{ cells: ['abcd', 'neighbour'] }, { cells: ['lower left', 'lower right'] }] }),
      { type: 'paragraph', content: 'outside after' },
    ]);
    const before = editor.prosemirrorView.state.doc;
    const untouched = cellsOf(editor).slice(1).map(({ node }) => node.toJSON());
    select(editor, positionOf(editor, 'abcd', 2));

    paste(editor, `<p>first</p><img src="${PICTURE}"><p>last</p>`, 'first\nlast');
    await settled();

    const cells = cellsOf(editor);
    expect(blocksOf(cells[0]!.node)).toEqual(['paragraph:abfirst', `image:${PICTURE}`, 'paragraph:lastcd']);
    expect(cells.slice(1).map(({ node }) => node.toJSON())).toEqual(untouched);
    const { doc, selection } = editor.prosemirrorView.state;
    expect(doc.firstChild!.firstChild!.eq(before.firstChild!.firstChild!)).toBe(true);
    expect(doc.firstChild!.lastChild!.eq(before.firstChild!.lastChild!)).toBe(true);
    expect(nodesOf(editor, 'docTable')).toHaveLength(1);
    expect(selection.empty).toBe(true);
    expect(selection.$head.parent.textContent).toBe('lastcd');
    expect(selection.$head.parentOffset).toBe(4);
    expect(selection.head).toBeGreaterThan(cells[0]!.pos);
    expect(selection.head).toBeLessThan(cells[0]!.pos + cells[0]!.node.nodeSize);
    expect(() => doc.check()).not.toThrow();
  });

  it('opens the caret paragraph inside the cell when an image ends its last line', async () => {
    const { editor } = await openReady([
      tableBlock({ rows: [{ cells: ['abcd', 'neighbour'] }] }),
      { type: 'paragraph', content: 'outside after' },
    ]);
    const before = editor.prosemirrorView.state.doc;
    const neighbour = cellsOf(editor)[1]!.node;
    select(editor, positionOf(editor, 'abcd', 4));

    paste(editor, `<img src="${PICTURE}">`, '');
    await settled();

    const cell = cellsOf(editor)[0]!;
    expect(blocksOf(cell.node)).toEqual(['paragraph:abcd', `image:${PICTURE}`, 'paragraph:']);
    expect(cellsOf(editor)[1]!.node.eq(neighbour)).toBe(true);
    expect(editor.prosemirrorView.state.doc.firstChild!.lastChild!.eq(before.firstChild!.lastChild!)).toBe(true);
    const selection = editor.prosemirrorView.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$head.parent.type.name).toBe('paragraph');
    expect(selection.$head.parent.textContent).toBe('');
    expect(selection.head).toBeGreaterThan(cell.pos);
    expect(selection.head).toBeLessThan(cell.pos + cell.node.nodeSize);
  });

  it('preserves headings, list items and dividers as sibling blocks in the cell', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: ['', 'neighbour'] }] })]);
    const cell = cellsOf(editor)[0]!;
    // Cell -> blockContainer -> paragraph -> its text position.
    select(editor, cell.pos + 3);

    paste(editor, '<hr><h2>Title</h2><ul><li>Item</li></ul><hr><p>last</p>', 'Title\nItem\nlast');
    await settled();

    const cells = cellsOf(editor);
    expect(blocksOf(cells[0]!.node)).toEqual([
      'divider:', 'heading:Title', 'bulletListItem:Item', 'divider:', 'paragraph:last',
    ]);
    expect(cells[0]!.node.child(1).firstChild!.attrs['level']).toBe(2);
    expect(blocksOf(cells[1]!.node)).toEqual(['paragraph:neighbour']);
    expect(nodesOf(editor, 'docTable')).toHaveLength(1);
    expect(() => editor.prosemirrorView.state.doc.check()).not.toThrow();
  });

  it('replaces a selected cell image without joining the surrounding paragraphs', async () => {
    const { editor } = await openReady([
      tableBlock({ rows: [{ cells: [
        { blocks: [
          { type: 'paragraph', content: 'before' },
          { type: 'image', props: { url: OLD_PICTURE } },
          { type: 'paragraph', content: 'after' },
        ] },
        'neighbour',
      ] }] }),
      { type: 'paragraph', content: 'outside' },
    ]);
    const neighbour = cellsOf(editor)[1]!.node;
    selectPicture(editor, OLD_PICTURE);

    paste(editor, `<p>first</p><img src="${PICTURE}"><p>last</p>`, 'first\nlast');
    await settled();

    expect(blocksOf(cellsOf(editor)[0]!.node)).toEqual([
      'paragraph:before', 'paragraph:first', `image:${PICTURE}`, 'paragraph:last', 'paragraph:after',
    ]);
    expect(cellsOf(editor)[1]!.node.eq(neighbour)).toBe(true);
    expect(nodesOf(editor, 'image').map(({ node }) => node.attrs['url'])).toEqual([PICTURE]);
    expect(gridsOf(editor)).toEqual([[['beforefirstlastafter', 'neighbour']]]);
    expect(editor.prosemirrorView.state.doc.firstChild!.lastChild!.textContent).toBe('outside');
  });

  it('gives every repeated block a unique id when ordinary content fills a CellSelection', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })]);
    selectCells(editor, 0, 3);
    const html = editor.blocksToFullHTML([
      { id: 'source-heading', type: 'heading', props: { level: 2 }, content: 'Title' },
      { id: 'source-divider', type: 'divider' },
      { id: 'source-paragraph', type: 'paragraph', content: 'last' },
    ] as never);

    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'Title\nlast' });
    await settled();

    expect(cellsOf(editor).map(({ node }) => blocksOf(node))).toEqual(
      Array.from({ length: 4 }, () => ['heading:Title', 'divider:', 'paragraph:last']),
    );
    const ids: string[] = [];
    editor.prosemirrorView.state.doc.descendants((node) => {
      if (typeof node.attrs['id'] === 'string') ids.push(node.attrs['id']);
      return true;
    });
    const blockIds = nodesOf(editor, 'blockContainer').map(({ node }) => node.attrs['id'] as unknown);
    expect(blockIds).toHaveLength(12);
    blockIds.forEach((id) => expect(id).toEqual(expect.any(String)));
    expect(ids).not.toContain('');
    expect(new Set(ids).size).toBe(ids.length);
    const { selection } = editor.prosemirrorView.state;
    const first = cellsOf(editor)[0]!;
    expect(selection.empty).toBe(true);
    expect(selection.$head.parent.textContent).toBe('last');
    expect(selection.$head.parentOffset).toBe(4);
    expect(selection.head).toBeGreaterThan(first.pos);
    expect(selection.head).toBeLessThan(first.pos + first.node.nodeSize);
  });
});

describe('a single table pasted into a docTable cell (A12)', () => {
  it.each(['caret', 'smaller CellSelection'] as const)(
    'fills the source rectangle once and adds both rows and columns from a %s',
    async (selection) => {
      const { editor } = await openReady([
        { type: 'paragraph', content: 'before' },
        tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'target'] }] }),
        { type: 'paragraph', content: 'after' },
      ]);
      if (selection === 'caret') select(editor, positionOf(editor, 'target', 3));
      else selectCells(editor, 3, 3);

      paste(editor, SOURCE_TABLE, 's1\ts2\ns3\ts4');
      await settled();

      expect(gridsOf(editor)).toEqual([[['a', 'b', ''], ['c', 's1', 's2'], ['', 's3', 's4']]]);
      const { doc, selection: result } = editor.prosemirrorView.state;
      expect(doc.firstChild!.firstChild!.textContent).toBe('before');
      expect(doc.firstChild!.lastChild!.textContent).toBe('after');
      expect(result).toBeInstanceOf(CellSelection);
      const cells = cellsOf(editor);
      expect(result.toJSON()).toEqual(CellSelection.create(doc, cells[4]!.pos, cells[8]!.pos).toJSON());
      expect(toast.warning).not.toHaveBeenCalled();
      expect(() => doc.check()).not.toThrow();
    },
  );

  it.each([
    ['a line break', '<p><br></p>'],
    ['a no-break space', '<p>&nbsp;</p>'],
    ['spaces and a line break', '<p> <br> </p>'],
  ])('fills a table followed by a line holding only %s, as a table alone', async (_name, blank) => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: ['', 'n'] }, { cells: ['c', 'd'] }] })]);
    select(editor, cellsOf(editor)[0]!.pos + 3);

    paste(editor, `${blank}<table><tr><td>s1</td><td>s2</td></tr></table>${blank}`, 's1 s2');
    await settled();

    expect(gridsOf(editor)).toEqual([[['s1', 's2'], ['c', 'd']]]);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('fills only once from the top-left of a larger reversed CellSelection', async () => {
    const { editor } = await openReady([tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['c', 'd'] }] })]);
    selectCells(editor, 3, 0);

    paste(editor, '<p></p><table><tr><td>only</td></tr></table><p></p>', 'only');
    await settled();

    expect(gridsOf(editor)).toEqual([[['only', 'b'], ['c', 'd']]]);
    const { doc, selection } = editor.prosemirrorView.state;
    const cell = cellsOf(editor)[0]!;
    expect(selection).toBeInstanceOf(CellSelection);
    expect(selection.toJSON()).toEqual(CellSelection.create(doc, cell.pos, cell.pos).toJSON());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

const MIXED_CONTENT = [
  ['a table and words', `${SOURCE_TABLE}<p>extra words</p>`],
  ['a table and an image', `${SOURCE_TABLE}<img src="https://external.example/picture.png">`],
  ['two tables', `${SOURCE_TABLE}<table><tr><td>second</td></tr></table>`],
] as const;

describe.each(['caret', 'text selection', 'media NodeSelection', 'CellSelection'] as const)(
  'unsupported cell content over a %s (A14)',
  (selection) => {
    it.each(MIXED_CONTENT)('rejects %s without changing the document, selection or undo stack and warns once', async (_name, html) => {
      const { editor, manager, sink } = await openReady([
        tableBlock({ rows: [
          { cells: [{ blocks: [
            { type: 'paragraph', content: 'abcd' },
            { type: 'image', props: { url: OLD_PICTURE } },
          ] }, 'neighbour'] },
          { cells: ['lower left', 'lower right'] },
        ] }),
      ]);
      if (selection === 'CellSelection') selectCells(editor, 3, 0);
      else if (selection === 'media NodeSelection') selectPicture(editor, OLD_PICTURE);
      else select(editor, positionOf(editor, 'abcd', 1), positionOf(editor, 'abcd', selection === 'caret' ? 1 : 3));
      const before = editor.prosemirrorView.state;
      const undo = manager.undoStack.slice();
      const redo = manager.redoStack.slice();

      paste(editor, html, 'copied content');
      await settled();

      expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.doc.toJSON());
      expect(editor.prosemirrorView.state.selection.toJSON()).toEqual(before.selection.toJSON());
      expect(manager.undoStack).toEqual(undo);
      expect(manager.redoStack).toEqual(redo);
      expect(toast.warning).toHaveBeenCalledTimes(1);
      expect(sink.start).not.toHaveBeenCalled();
      expect(sink.onLeftOut).not.toHaveBeenCalled();
    });
  },
);

const PIPE_TABLE = '| h1 | h2 |\n| --- | --- |\n| c1 | c2 |';

describe('plain text pasted into a code block inside a docTable cell (A7)', () => {
  it.each([
    ['a pipe table', PIPE_TABLE],
    ['a pipe table with surrounding prose', `Introduction\n\n${PIPE_TABLE}\n\nConclusion`],
  ] as const)('inserts %s verbatim without changing the outer table', async (_name, text) => {
    const { editor, sink } = await openReady([
      { type: 'paragraph', content: 'before' },
      tableBlock({ rows: [
        { cells: [{ blocks: [{ type: 'codeBlock', props: { language: 'text' }, content: 'startend' }] }, 'neighbour'] },
        { cells: ['lower left', 'lower right'] },
      ] }),
      { type: 'paragraph', content: 'after' },
    ]);
    select(editor, positionOf(editor, 'startend', 5));
    const expected = editor.prosemirrorView.state.tr.insertText(text).doc;

    pasteFormats(editor, { 'text/plain': text });
    await settled();

    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(expected.toJSON());
    expect(blocksOf(cellsOf(editor)[0]!.node)).toEqual([`codeBlock:start${text}end`]);
    expect(gridsOf(editor)).toEqual([[[`start${text}end`, 'neighbour'], ['lower left', 'lower right']]]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(sink.start).not.toHaveBeenCalled();
    expect(sink.onLeftOut).not.toHaveBeenCalled();
  });
});

describe('cell paste over a short table', () => {
  it('evens the target before filling cells and restores the short row in one undo', async () => {
    const { editor, manager } = await openReady([
      tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['target'] }] }),
    ]);
    expect(gridsOf(editor)).toEqual([[['a', 'b'], ['target']]]);
    select(editor, positionOf(editor, 'target', 3));
    const before = editor.prosemirrorView.state.doc;

    paste(editor, '<table><tr><td>only</td></tr></table>', 'only');
    await settled();

    expect(gridsOf(editor)).toEqual([[['a', 'b'], ['only', '']]]);
    expect(manager.undoStack).toHaveLength(1);
    manager.undo();
    await settled();
    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('leaves a short row unchanged when mixed content is refused', async () => {
    const { editor, manager, sink } = await openReady([
      tableBlock({ rows: [{ cells: ['a', 'b'] }, { cells: ['target'] }] }),
    ]);
    select(editor, positionOf(editor, 'target', 3));
    const before = editor.prosemirrorView.state;

    paste(editor, `${SOURCE_TABLE}<p>mixed</p>`, 'mixed');
    await settled();

    expect(editor.prosemirrorView.state.doc.toJSON()).toEqual(before.doc.toJSON());
    expect(editor.prosemirrorView.state.selection.toJSON()).toEqual(before.selection.toJSON());
    expect(manager.undoStack).toHaveLength(0);
    expect(sink.start).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

it('shares one pending upload id across repeated cell content while keeping block ids unique', async () => {
  const { editor, sink } = await openReady([
    tableBlock({ rows: [{ cells: ['a', 'b'] }] }),
  ]);
  selectCells(editor, 0, 1);
  const html = editor.blocksToFullHTML([
    { type: 'image', props: { uploadId: 'shared-upload', url: '', name: 'Pending', caption: 'Caption' } },
  ] as never);

  pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'Pending' });
  await settled();

  const images = nodesOf(editor, 'image');
  expect(images.map(({ node }) => [node.attrs['uploadId'], node.attrs['url'], node.attrs['caption']])).toEqual([
    ['shared-upload', '', 'Caption'], ['shared-upload', '', 'Caption'],
  ]);
  const mediaBlocks = nodesOf(editor, 'blockContainer').filter(({ node }) => node.firstChild?.type.name === 'image');
  expect(new Set(mediaBlocks.map(({ node }) => node.attrs['id'])).size).toBe(2);
  expect(sink.start).not.toHaveBeenCalled();
});

it.each([
  ['heading', '<h2>Title</h2>', 'Title'],
  ['bulletListItem', '<ul><li>Item</li></ul>', 'Item'],
  ['numberedListItem', '<ol><li>Step</li></ol>', 'Step'],
] as const)('preserves a trailing %s after media pasted into an empty cell', async (type, html, text) => {
  const { editor } = await openReady([tableBlock({ rows: [{ cells: ['', 'neighbour'] }] })]);
  select(editor, cellsOf(editor)[0]!.pos + 3);

  paste(editor, `<img src="${PICTURE}">${html}`, text);
  await settled();

  expect(blocksOf(cellsOf(editor)[0]!.node)).toEqual([`image:${PICTURE}`, `${type}:${text}`]);
  expect(blocksOf(cellsOf(editor)[1]!.node)).toEqual(['paragraph:neighbour']);
  expect(editor.prosemirrorView.state.selection.$head.parent.type.name).toBe(type);
});

/**
 * Labels the body's top-level blocks by type and words or media address.
 * @param editor - The mounted editor.
 * @returns One label per top-level block.
 */
function bodyBlocks(editor: Editor): string[] {
  const out: string[] = [];
  editor.prosemirrorView.state.doc.firstChild!.forEach((container) => {
    const block = container.firstChild!;
    out.push(`${block.type.name}:${block.type.name === 'image' ? String(block.attrs['url']) : block.textContent}`);
  });
  return out;
}

it.each([
  ['heading', '<h2>Title</h2>', 'Title'],
  ['bulletListItem', '<ul><li>Item</li></ul>', 'Item'],
  ['numberedListItem', '<ol><li>Step</li></ol>', 'Step'],
] as const)('preserves a trailing %s after media pasted into an empty body paragraph', async (type, html, text) => {
  const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
  const lineId = (editor.document as { id: string }[])[1]!.id;
  caretIn(editor, 1);

  paste(editor, `<img src="${PICTURE}">${html}`, text);
  await settled();

  expect(bodyBlocks(editor)).toEqual(['paragraph:lead', `image:${PICTURE}`, `${type}:${text}`]);
  expect((editor.document as { id: string }[])[2]!.id).toBe(lineId);
  expect(editor.prosemirrorView.state.selection.$head.parent.type.name).toBe(type);
});

/**
 * The nested blocks' words under a block, in order.
 * @param container - The block's container.
 * @returns One label per nested block.
 */
function nestedOf(container: PMNode): string[] {
  if (container.childCount < 2) return [];
  const out: string[] = [];
  container.lastChild!.forEach((child) => out.push(`${child.firstChild!.type.name}:${child.firstChild!.textContent}`));
  return out;
}

const NESTED_LIST = '<ul><li>a<ul><li>b</li></ul></li></ul>';

it('takes the empty body paragraph with a trailing list item that has nested items', async () => {
  const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
  const lineId = (editor.document as { id: string }[])[1]!.id;
  caretIn(editor, 1);

  paste(editor, `<img src="${PICTURE}">${NESTED_LIST}`, 'a b');
  await settled();

  expect(bodyBlocks(editor)).toEqual(['paragraph:lead', `image:${PICTURE}`, 'bulletListItem:a']);
  const last = editor.prosemirrorView.state.doc.firstChild!.lastChild!;
  expect({ id: last.attrs['id'], nested: nestedOf(last) }).toEqual({ id: lineId, nested: ['bulletListItem:b'] });
  const { $head } = editor.prosemirrorView.state.selection;
  expect({ parent: $head.parent.textContent, at: $head.parentOffset }).toEqual({ parent: 'b', at: 1 });
});

it('hands an empty body paragraph\'s own nested blocks to the trailing line that takes it', async () => {
  const { editor } = await openReady([
    { type: 'paragraph', content: 'lead' },
    { type: 'paragraph', children: [{ type: 'paragraph', content: 'kid' }] },
  ]);
  caretIn(editor, 1);

  paste(editor, `<img src="${PICTURE}"><h2>Title</h2>`, 'Title');
  await settled();

  const last = editor.prosemirrorView.state.doc.firstChild!.lastChild!;
  expect(bodyBlocks(editor)).toEqual(['paragraph:lead', `image:${PICTURE}`, 'heading:Title']);
  expect(nestedOf(last)).toEqual(['paragraph:kid']);
  expect(editor.prosemirrorView.state.selection.$head.parent.textContent).toBe('Title');
});

it.each([
  ['one block', `<ul><li>x<img src="${PICTURE}"></li></ul>`],
  ['words, then that block', `<p>a</p><ul><li>x<img src="${PICTURE}"></li></ul>`],
])('leaves an empty body paragraph for the caret when content ending in a nested picture is pasted as %s', async (_name, html) => {
  const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }, { type: 'paragraph', content: 'tail' }]);
  const lineId = (editor.document as { id: string }[])[1]!.id;
  caretIn(editor, 1);

  paste(editor, html, 'x');
  await settled();

  const blocks = editor.document as { id: string; type: string }[];
  const kept = blocks[blocks.length - 2]!;
  expect({ id: kept.id, type: kept.type, last: bodyBlocks(editor).at(-1) }).toEqual({ id: lineId, type: 'paragraph', last: 'paragraph:tail' });
  const { $head } = editor.prosemirrorView.state.selection;
  expect({ parent: $head.parent.textContent, depth: $head.depth }).toEqual({ parent: '', depth: 3 });
});

it('leaves an empty cell paragraph for the caret when content ending in a nested picture is pasted', async () => {
  const { editor } = await openReady([tableBlock({ rows: [{ cells: ['', 'neighbour'] }] })]);
  select(editor, cellsOf(editor)[0]!.pos + 3);

  paste(editor, `<p>a</p><ul><li>x<img src="${PICTURE}"></li></ul>`, 'a x');
  await settled();

  const cell = cellsOf(editor)[0]!.node;
  expect(blocksOf(cell)).toEqual(['paragraph:a', 'bulletListItem:x', 'paragraph:']);
  const { $head } = editor.prosemirrorView.state.selection;
  expect({ parent: $head.parent.textContent, sameCell: $head.node($head.depth - 2) === cell }).toEqual({ parent: '', sameCell: true });
});

it('takes an empty body paragraph with one pasted list item whose nested words come last', async () => {
  const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'paragraph' }]);
  const lineId = (editor.document as { id: string }[])[1]!.id;
  caretIn(editor, 1);

  paste(editor, `<ul><li>x<img src="${PICTURE}"><ul><li>y</li></ul></li></ul>`, 'x y');
  await settled();

  const last = (editor.document as { id: string; type: string }[]).at(-1)!;
  expect({ id: last.id, type: last.type }).toEqual({ id: lineId, type: 'bulletListItem' });
  const { $head } = editor.prosemirrorView.state.selection;
  expect({ parent: $head.parent.textContent, at: $head.parentOffset }).toEqual({ parent: 'y', at: 1 });
});

it('takes an empty cell with a trailing list item that has nested items', async () => {
  const { editor } = await openReady([tableBlock({ rows: [{ cells: ['', 'neighbour'] }] })]);
  select(editor, cellsOf(editor)[0]!.pos + 3);

  paste(editor, `<img src="${PICTURE}">${NESTED_LIST}`, 'a b');
  await settled();

  const cell = cellsOf(editor)[0]!.node;
  expect(blocksOf(cell)).toEqual([`image:${PICTURE}`, 'bulletListItem:a']);
  expect(nestedOf(cell.lastChild!)).toEqual(['bulletListItem:b']);
  const { $head } = editor.prosemirrorView.state.selection;
  expect({ parent: $head.parent.textContent, at: $head.parentOffset }).toEqual({ parent: 'b', at: 1 });
});

it('keeps an empty heading line its own type when media and words land on it', async () => {
  const { editor } = await openReady([{ type: 'paragraph', content: 'lead' }, { type: 'heading', props: { level: 2 } }]);
  caretIn(editor, 1);

  paste(editor, `<img src="${PICTURE}"><ul><li>Item</li></ul>`, 'Item');
  await settled();

  expect(bodyBlocks(editor)).toEqual(['paragraph:lead', `image:${PICTURE}`, 'heading:Item']);
});
