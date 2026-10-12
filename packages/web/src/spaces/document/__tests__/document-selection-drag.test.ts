// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1: dragging what is selected hands the browser a preview of the
 * whole blocks the selection touches, or the rows of a cell selection, or the
 * caption line whose words are dragged — scaled like every other preview,
 * anchored at its top left, and taken off the page when the drag ends
 * (design §4).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { BodyEdgeSelection } from '@web/spaces/document/document-body-edge-selection';
import { rowHasLanded, rowIsFlying } from '@web/spaces/document/document-drag-drop';
import { captionPreviewContent } from '@web/spaces/document/document-drag-preview';
import { startRowDrag } from '@web/spaces/document/document-row-drag';
import { selectionDragKind, selectionPreviewContent } from '@web/spaces/document/document-selection-drag';
import { endTableDrag, startTableDrag } from '@web/spaces/document/document-table-drag';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
const ends: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const end of ends.splice(0)) end();
  rowHasLanded();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding the blocks given.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where a node holding some text starts, by its type.
 * @param editor - The editor.
 * @param type - The node type.
 * @param text - Its text.
 * @returns Its position.
 */
function nodeOf(editor: Editor, type: string, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === type && node.textContent === text) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no ${type} holding "${text}"`);
  return at;
}

/**
 * Selects text from one string to another.
 * @param editor - The editor.
 * @param from - The text the selection starts in, and the offset in it.
 * @param to - The text it ends in, and the offset in it.
 */
function selectText(editor: Editor, from: [string, number], to: [string, number]): void {
  const view = editor.prosemirrorView!;
  const start = textPos(editor, from[0]) + from[1];
  const end = textPos(editor, to[0]) + to[1];
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));
}

/**
 * Where a run of text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns Its position.
 */
function textPos(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text === text) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no text "${text}"`);
  return at;
}

/**
 * The texts of the top-level blocks in some preview content, in order.
 * @param content - The content.
 * @returns One string per block.
 */
function blockTexts(content: HTMLElement): string[] {
  return [...content.querySelectorAll(':scope > .bn-block-outer')].map((outer) =>
    (outer.querySelector('.bn-inline-content')?.textContent ?? '').trim(),
  );
}

/**
 * Selects the cells between two cells.
 * @param editor - The editor.
 * @param anchor - The anchor cell's text.
 * @param head - The head cell's text.
 */
function selectCells(editor: Editor, anchor: string, head: string): void {
  const view = editor.prosemirrorView!;
  const doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(CellSelection.create(doc, nodeOf(editor, 'tableCell', anchor), nodeOf(editor, 'tableCell', head))));
}

/**
 * The rows of a table preview: per row, each cell's text, colspan and rowspan.
 * @param content - The preview content.
 * @returns One array per row.
 */
function rowsOf(content: HTMLElement): string[][] {
  return [...content.querySelectorAll('tr')].map((tr) =>
    [...tr.querySelectorAll('td, th')].map((cell) => {
      const text = (cell.textContent ?? '').trim();
      const colspan = cell.getAttribute('colspan') ?? '1';
      const rowspan = cell.getAttribute('rowspan') ?? '1';
      return `${text === '' ? '∅' : text}:${colspan}x${rowspan}`;
    }),
  );
}

/**
 * A table block from rows.
 * @param rows - The rows.
 * @returns The block.
 */
function table(rows: unknown[]): unknown {
  return { type: 'table', content: { type: 'tableContent', rows } };
}

/**
 * A merged cell.
 * @param content - Its text.
 * @param props - Its spans.
 * @returns The cell.
 */
function merged(content: string, props: { rowspan?: number; colspan?: number }): unknown {
  return { type: 'tableCell', content, props };
}

/**
 * A dragstart with a data transfer that records the image it is handed.
 * @returns The event and the recorded calls.
 */
function dragStart(): { event: Event; setDragImage: ReturnType<typeof vi.fn> } {
  const setDragImage = vi.fn();
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
  Object.defineProperty(event, 'dataTransfer', {
    value: { setDragImage, setData: vi.fn(), clearData: vi.fn(), getData: vi.fn(() => ''), files: [], effectAllowed: 'all' },
  });
  return { event, setDragImage };
}

describe('which drag gets the selection preview (design §4, in this order)', () => {
  it('the caption field\'s words, even while the media block is selected', () => {
    const editor = open([{ type: 'paragraph', content: 'a' }]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodeOf(editor, 'blockContainer', 'a'))));
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'doc-media-caption-input');
    view.dom.append(input);
    expect(selectionDragKind(view, { target: input }, null)).toBe('caption');
  });

  it('not a row drag, a medium\'s included', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }]);
    const view = editor.prosemirrorView!;
    selectText(editor, ['one', 0], ['two', 3]);
    rowIsFlying('x', undefined);
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'one') + 1)).toBe(null);
  });

  it('not a table row or column drag', () => {
    const editor = open([table([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }])]);
    const view = editor.prosemirrorView!;
    selectText(editor, ['a1', 0], ['a1', 2]);
    startTableDrag(view, 'row', nodeOf(editor, 'tableCell', 'a1'));
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'a1') + 1)).toBe(null);
    endTableDrag(view);
  });

  it('not with an empty selection, nor with a press outside it (ProseMirror\'s own rule)', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }]);
    const view = editor.prosemirrorView!;
    selectText(editor, ['one', 1], ['one', 1]);
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'one') + 1)).toBe(null);
    selectText(editor, ['one', 0], ['one', 2]);
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'two') + 1)).toBe(null);
    expect(selectionDragKind(view, { target: view.dom }, null)).toBe(null);
  });

  it('a press inside a text selection, across blocks too', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }, { type: 'paragraph', content: 'two' }]);
    const view = editor.prosemirrorView!;
    selectText(editor, ['one', 1], ['two', 2]);
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'two') + 1)).toBe('selection');
  });

  it('a press on a selected divider, and inside a cell selection\'s head cell, the range ProseMirror reads as the selection', () => {
    const editor = open([
      { type: 'paragraph', content: 'one' },
      { type: 'divider' },
      table([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }]),
    ]);
    const view = editor.prosemirrorView!;
    let divider = -1;
    view.state.doc.descendants((node, pos) => {
      if (divider < 0 && node.type.name === 'divider') divider = pos;
      return divider < 0;
    });
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, divider)));
    expect(selectionDragKind(view, { target: view.dom }, divider)).toBe('selection');
    selectCells(editor, 'a1', 'b2');
    // A cell selection's from and to are its head cell's (prosemirror-tables
    // `CellSelection`, `ranges[0]`): ProseMirror drags it from there only.
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'b2'))).toBe('selection');
    expect(selectionDragKind(view, { target: view.dom }, textPos(editor, 'b1'))).toBe(null);
  });
});

describe('the blocks a selection preview draws', () => {
  it('a word in a heading: the whole heading, with its level', () => {
    const editor = open([{ type: 'heading', props: { level: 2 }, content: 'Title words' }, { type: 'paragraph', content: 'after' }]);
    selectText(editor, ['Title words', 6], ['Title words', 11]);
    const content = selectionPreviewContent(editor.prosemirrorView!)!;
    expect(blockTexts(content)).toEqual(['Title words']);
    const heading = content.querySelector('[data-content-type="heading"]')!;
    expect(heading.getAttribute('data-level')).toBe('2');
  });

  it('a selection across three paragraphs: those three', () => {
    const editor = open(['one', 'two', 'three', 'four'].map((content) => ({ type: 'paragraph', content })));
    selectText(editor, ['one', 1], ['three', 2]);
    expect(blockTexts(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual(['one', 'two', 'three']);
  });

  it('from a list item\'s child to the next item: the level holding both ends, each item with its children', () => {
    const editor = open([
      { type: 'bulletListItem', content: 'item one', children: [{ type: 'bulletListItem', content: 'child' }] },
      { type: 'bulletListItem', content: 'item two' },
    ]);
    selectText(editor, ['child', 1], ['item two', 3]);
    const content = selectionPreviewContent(editor.prosemirrorView!)!;
    expect(blockTexts(content)).toEqual(['item one', 'item two']);
    expect(content.textContent).toContain('child');
  });

  it('the whole body (two Cmd+A, or from the top edge to the bottom edge): every top-level block', () => {
    const editor = open(['one', 'two', 'three'].map((content) => ({ type: 'paragraph', content })));
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
    expect(blockTexts(selectionPreviewContent(view)!)).toEqual(['one', 'two', 'three']);
  });

  it('a body edge selection ending on the last block: up to the last top-level block, with its children', () => {
    const editor = open([
      { type: 'paragraph', content: 'one' },
      { type: 'bulletListItem', content: 'last', children: [{ type: 'bulletListItem', content: 'nested' }] },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.create(view.state.doc, textPos(editor, 'one') + 1, 'end')));
    const content = selectionPreviewContent(view)!;
    expect(blockTexts(content)).toEqual(['one', 'last']);
    expect(content.textContent).toContain('nested');
  });

  it('a few words in a table cell: the table block, its table alone', () => {
    const editor = open([table([{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }])]);
    selectText(editor, ['a1', 0], ['a1', 2]);
    const content = selectionPreviewContent(editor.prosemirrorView!)!;
    const block = content.querySelector('[data-content-type="table"]')!;
    expect([...block.children].map((child) => child.tagName)).toEqual(['TABLE']);
    expect(rowsOf(content)).toEqual([['a1:1x1', 'b1:1x1'], ['a2:1x1', 'b2:1x1']]);
  });
});

describe('the rows a cell selection preview draws (design §4)', () => {
  it('the selected cells\' rows, every column', () => {
    const editor = open([table([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', 'b2', 'c2'] }, { cells: ['a3', 'b3', 'c3'] }])]);
    selectCells(editor, 'b2', 'c3');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([
      ['a2:1x1', 'b2:1x1', 'c2:1x1'],
      ['a3:1x1', 'b3:1x1', 'c3:1x1'],
    ]);
  });

  it('A1:A2 merged, B2:C2 selected: row 2 alone, the merged cell an empty cell of its size', () => {
    const editor = open([table([{ cells: [merged('tall', { rowspan: 2 }), 'b1', 'c1'] }, { cells: ['b2', 'c2'] }])]);
    selectCells(editor, 'b2', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([['∅:1x1', 'b2:1x1', 'c2:1x1']]);
  });

  it('A2:A3 merged, B2:C2 selected: its rowspan cut to 1, its words kept', () => {
    const editor = open([
      table([{ cells: ['a1', 'b1', 'c1'] }, { cells: [merged('tall', { rowspan: 2 }), 'b2', 'c2'] }, { cells: ['b3', 'c3'] }]),
    ]);
    selectCells(editor, 'b2', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([['tall:1x1', 'b2:1x1', 'c2:1x1']]);
  });

  it('A2:B2 merged, B1:C2 selected: rows 1 and 2, the merged cell whole with its words', () => {
    const editor = open([table([{ cells: ['a1', 'b1', 'c1'] }, { cells: [merged('wide', { colspan: 2 }), 'c2'] }])]);
    selectCells(editor, 'b1', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([
      ['a1:1x1', 'b1:1x1', 'c1:1x1'],
      ['wide:2x1', 'c2:1x1'],
    ]);
  });

  it('B1:B2 merged, A2:C2 selected: row 2 alone, the B cell empty with a rowspan of 1', () => {
    const editor = open([table([{ cells: ['a1', merged('tall', { rowspan: 2 }), 'c1'] }, { cells: ['a2', 'c2'] }])]);
    selectCells(editor, 'a2', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([['a2:1x1', '∅:1x1', 'c2:1x1']]);
  });

  it('A1:B2 merged, from B3 to C2: rows 2 and 3, the merged cell empty, two columns wide, one row tall', () => {
    const editor = open([
      table([
        { cells: [merged('big', { rowspan: 2, colspan: 2 }), 'c1'] },
        { cells: ['c2'] },
        { cells: ['a3', 'b3', 'c3'] },
      ]),
    ]);
    selectCells(editor, 'b3', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([
      ['∅:2x1', 'c2:1x1'],
      ['a3:1x1', 'b3:1x1', 'c3:1x1'],
    ]);
  });

  it('B2:C2 merged, A2:B3 selected: rows 2 and 3, the merged cell whole with its words', () => {
    const editor = open([
      table([{ cells: ['a1', 'b1', 'c1'] }, { cells: ['a2', merged('wide', { colspan: 2 })] }, { cells: ['a3', 'b3', 'c3'] }]),
    ]);
    selectCells(editor, 'a2', 'b3');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([
      ['a2:1x1', 'wide:2x1'],
      ['a3:1x1', 'b3:1x1', 'c3:1x1'],
    ]);
  });

  it('A2:B2 merged, C1:C2 selected: rows 1 and 2, the merged cell whole with its words', () => {
    const editor = open([table([{ cells: ['a1', 'b1', 'c1'] }, { cells: [merged('wide', { colspan: 2 }), 'c2'] }])]);
    selectCells(editor, 'c1', 'c2');
    expect(rowsOf(selectionPreviewContent(editor.prosemirrorView!)!)).toEqual([
      ['a1:1x1', 'b1:1x1', 'c1:1x1'],
      ['wide:2x1', 'c2:1x1'],
    ]);
  });
});

describe('the caption preview', () => {
  it('is the caption field with what it holds now, without the space above it', () => {
    const input = document.createElement('input');
    input.className = 'mt-1.5 w-full text-center';
    input.value = 'a caption being typed';
    document.body.append(input);
    const content = captionPreviewContent(input) as HTMLInputElement;
    expect(content).not.toBe(input);
    expect(content.value).toBe('a caption being typed');
    expect(content.style.marginTop).toBe('0px');
  });
});

describe('a selection drag on the page', () => {
  it('hands the browser the preview at its top left corner, and takes it off the page a frame later', async () => {
    const editor = open(['one', 'two', 'three'].map((content) => ({ type: 'paragraph', content })));
    const view = editor.prosemirrorView!;
    selectText(editor, ['one', 1], ['two', 2]);
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: textPos(editor, 'two') + 1, inside: -1 });
    const { event, setDragImage } = dragStart();
    view.dom.dispatchEvent(event);
    const call = setDragImage.mock.calls.at(-1) as [HTMLElement, number, number];
    expect(call[1]).toBe(0);
    expect(call[2]).toBe(0);
    expect(call[0].isConnected).toBe(true);
    expect(call[0].textContent).toContain('one');
    expect(call[0].textContent).not.toContain('three');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(call[0].isConnected).toBe(false);
  });
});

describe('a handle drag while several blocks are selected', () => {
  it('previews the row whose handle was pressed, the one the drop moves', () => {
    const editor = open(['one', 'two', 'three'].map((content) => ({ type: 'paragraph', content })));
    selectText(editor, ['one', 0], ['three', 5]);
    const { setDragImage } = dragStart();
    const dataTransfer = { setDragImage, setData: vi.fn(), clearData: vi.fn(), effectAllowed: 'all' } as unknown as DataTransfer;
    const middle = (editor.document[1] as unknown as { id: string }).id;
    ends.push(startRowDrag(editor as never, { dataTransfer, clientY: 0 }, middle));
    const [element] = setDragImage.mock.calls.at(-1) as [HTMLElement];
    expect(element.textContent).toContain('two');
    expect(element.textContent).not.toContain('one');
    expect(element.textContent).not.toContain('three');
  });
});
