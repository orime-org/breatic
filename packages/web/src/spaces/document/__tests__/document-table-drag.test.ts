// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A7 and A17: dragging a row or a column to a gap moves it there,
 * with its words, styles and comments; the row a drag started on is followed
 * through other people's edits; a row a merged cell spans cannot be dragged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  canDragFrom,
  dragSourceOf,
  dropGapAt,
  endTableDrag,
  holdDropLineInTableDrags,
  moveToGap,
  startTableDrag,
} from '@web/spaces/document/document-table-drag';
import { insertRow, setCellsAttr } from '@web/spaces/document/document-table-run';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

/** A browser whose drag events tell leaving the window by relatedTarget. */
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/** Safari, whose dragleave relatedTarget is always null: it counts. */
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME);
});

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Opens an editor holding a paragraph and a 3 × 3 table, or the rows given.
 * @param rows - The table's rows.
 * @returns The editor.
 */
function open(
  rows: TableInput['rows'] = [
    { cells: ['a1', 'b1', 'c1'] },
    { cells: ['a2', 'b2', 'c2'] },
    { cells: ['a3', 'b3', 'c3'] },
  ],
): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'reader' },
    tableBlock({ rows }),
  ] as never);
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6)));
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'docTableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * The table as cell texts.
 * @param editor - The editor.
 * @returns One array per row.
 */
function grid(editor: Editor): string[][] {
  const rows: string[][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'docTableRow') {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
      return false;
    }
    return true;
  });
  return rows;
}

describe('which gap the pointer is over', () => {
  // Three rows, 30 tall, from 100.
  const edges = [100, 130, 160, 190];

  it.each([
    [101, 0],
    [114, 0],
    [116, 1],
    [140, 1],
    [146, 2],
    [189, 3],
    [250, 3],
    [40, 0],
  ])('at %d it is gap %d', (pointer, gap) => {
    expect(dropGapAt(edges, pointer)).toBe(gap);
  });
});

describe('moving a row or a column to a gap (A7)', () => {
  it.each([
    [0, 3, [['a2', 'b2', 'c2'], ['a3', 'b3', 'c3'], ['a1', 'b1', 'c1']]],
    [2, 0, [['a3', 'b3', 'c3'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']]],
    [1, 1, [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2'], ['a3', 'b3', 'c3']]],
    [1, 2, [['a1', 'b1', 'c1'], ['a2', 'b2', 'c2'], ['a3', 'b3', 'c3']]],
  ] as const)('row %d to gap %d', (row, gap, expected) => {
    const editor = open();
    const source = cellOf(editor, ['a1', 'a2', 'a3'][row]!);

    moveToGap(editor, source, 'row', gap);

    expect(grid(editor)).toEqual(expected);
  });

  it('moves a column', () => {
    const editor = open();

    moveToGap(editor, cellOf(editor, 'a1'), 'column', 2);

    expect(grid(editor)).toEqual([
      ['b1', 'a1', 'c1'],
      ['b2', 'a2', 'c2'],
      ['b3', 'a3', 'c3'],
    ]);
  });

  it('carries the marks on the words and leaves the reader where they were', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const b1 = cellOf(editor, 'b1') + 2;
    view.dispatch(view.state.tr.addMark(b1, b1 + 2, view.state.schema.marks['bold']!.create()));

    moveToGap(editor, cellOf(editor, 'a1'), 'row', 3);

    let bold = '';
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) bold = node.text ?? '';
      return true;
    });
    expect(bold).toBe('b1');
    expect(grid(editor)[2]).toEqual(['a1', 'b1', 'c1']);
    const { selection } = editor.prosemirrorState;
    expect([selection.$head.parent.textContent, selection.$head.parentOffset]).toEqual(['reader', 3]);
  });
});

describe('the row a drag started on', () => {
  it('is followed when a row lands above it during the drag (A17)', () => {
    const editor = open();
    startTableDrag(editor.prosemirrorView!, 'row', cellOf(editor, 'a2'));

    insertRow(editor, cellOf(editor, 'a1'), 'above');
    const source = dragSourceOf(editor.prosemirrorState)!;
    moveToGap(editor, source.cellPos, 'row', 0);

    expect(grid(editor)[0]).toEqual(['a2', 'b2', 'c2']);
  });

  it('is followed when the cell it started on takes a new fill', () => {
    const editor = open();
    startTableDrag(editor.prosemirrorView!, 'row', cellOf(editor, 'a2'));

    setCellsAttr(editor, cellOf(editor, 'a2'), 'cell', 'backgroundColor', 'red');
    const source = dragSourceOf(editor.prosemirrorState);

    expect(source).not.toBeNull();
    expect(editor.prosemirrorState.doc.nodeAt(source!.cellPos)?.textContent).toBe('a2');
  });

  it('cannot be a row a merged cell spans', () => {
    const editor = open([
      { cells: [{ type: 'docTableCell', content: 'tall', props: { rowspan: 2 } }, 'b1'] },
      { cells: ['b2'] },
    ]);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'row')).toBe(false);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'column')).toBe(true);
  });

  it('cannot be the lower row of a cell merged across two rows either, which a drop would move with the upper one', () => {
    // A1:A2 merged. `moveRow` takes both rows (`getSelectionRangeInRow`), so a
    // row drag from the second row would move more than its preview shows.
    const editor = open([
      { cells: [{ type: 'docTableCell', content: 'tall', props: { rowspan: 2 } }, 'b1', 'c1'] },
      { cells: ['b2', 'c2'] },
      { cells: ['a3', 'b3', 'c3'] },
    ]);
    const { doc } = editor.prosemirrorState;
    expect(canDragFrom(doc, cellOf(editor, 'b1'), 'row')).toBe(false);
    expect(canDragFrom(doc, cellOf(editor, 'b2'), 'row')).toBe(false);
    expect(canDragFrom(doc, cellOf(editor, 'b3'), 'row')).toBe(true);
    expect(canDragFrom(doc, cellOf(editor, 'tall'), 'column')).toBe(true);
    expect(canDragFrom(doc, cellOf(editor, 'b2'), 'column')).toBe(true);
  });

  it('cannot be either column of a cell merged across two columns', () => {
    // A1:B1 merged: the merged cell reaches across B's left edge from A.
    const editor = open([
      { cells: [{ type: 'docTableCell', content: 'wide', props: { colspan: 2 } }, 'c1'] },
      { cells: ['a2', 'b2', 'c2'] },
      { cells: ['a3', 'b3', 'c3'] },
    ]);
    const { doc } = editor.prosemirrorState;
    expect(canDragFrom(doc, cellOf(editor, 'a2'), 'column')).toBe(false);
    expect(canDragFrom(doc, cellOf(editor, 'b2'), 'column')).toBe(false);
    expect(canDragFrom(doc, cellOf(editor, 'c2'), 'column')).toBe(true);
    expect(canDragFrom(doc, cellOf(editor, 'wide'), 'row')).toBe(true);
    expect(canDragFrom(doc, cellOf(editor, 'b2'), 'row')).toBe(true);
  });
});

describe('the editor\'s drop line during a row or column drag', () => {
  it('is held back while a row or a column is dragged, and drawn as before otherwise', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const line = { pos: 3, orientation: 'inline' as const };
    const next = vi.fn(() => line);
    const position = holdDropLineInTableDrags(next);
    const context = { editor, view, event: new MouseEvent('dragover'), defaultPosition: line } as never;
    expect(position(context)).toBe(line);
    for (const orientation of ['row', 'column'] as const) {
      startTableDrag(view, orientation, cellOf(editor, 'b2'));
      expect(position(context)).toBeNull();
      endTableDrag(view);
    }
    expect(position(context)).toBe(line);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe('the drop of a dragged row (inner#1350 round 2)', () => {
  it('lands at the gap under the pointer when it is released, though the rows moved since the last dragover', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    let shift = 0;
    // Rows 30 tall from the top, by their place in the table: the editor can
    // draw them again during the drag.
    vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLTableRowElement) {
      const i = [...this.parentElement!.children].indexOf(this);
      return { top: i * 30 - shift, bottom: (i + 1) * 30 - shift, left: 0, right: 300 } as DOMRect;
    });
    // The editor holds the pointer, as it does over a table on screen; a test
    // page lays nothing out, and BlockNote clamps a pointer outside the editor
    // into it (`SideMenu.ts` `dispatchSyntheticEvent`).
    const page = (): DOMRect => ({ top: -200, bottom: 600, left: 0, right: 600, x: 0, y: -200, width: 600, height: 800 }) as DOMRect;
    view.dom.getBoundingClientRect = page;
    (view.dom.firstChild as HTMLElement).getBoundingClientRect = page;
    startTableDrag(view, 'row', cellOf(editor, 'a1'));
    const at = (type: string): void => {
      view.dom.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: 20 }));
    };
    // Over the lower half of the first row: the gap under it, where the row is.
    at('dragover');
    // The body scrolls under a pointer that does not move: no dragover comes,
    // and the pointer is over the lower half of the last row.
    shift = 60;
    at('drop');
    vi.restoreAllMocks();
    expect(grid(editor).map((row) => row[0])).toEqual(['a2', 'a3', 'a1']);
  });
});

describe('a dragged line over the gutter beside the body (inner#1350 round 3)', () => {
  /**
   * Puts the editor in a body scroller with a gutter beside the text column,
   * and lays its columns out 100 wide from the left.
   * @param editor - The editor.
   * @returns The gutter.
   */
  function inScroller(editor: Editor): HTMLElement {
    const view = editor.prosemirrorView!;
    const scroller = document.createElement('div');
    scroller.setAttribute('data-radix-scroll-area-viewport', '');
    const gutter = document.createElement('div');
    const host = [...document.body.children].find((child) => child.contains(view.dom))!;
    document.body.append(scroller);
    scroller.append(host, gutter);
    vi.spyOn(HTMLTableCellElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLTableCellElement) {
      const i = [...this.parentElement!.children].indexOf(this);
      return { top: 0, bottom: 30, left: i * 100, right: (i + 1) * 100 } as DOMRect;
    });
    // The table's frame shows the whole table.
    const frame = view.dom.querySelector('table')!.closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    frame.getBoundingClientRect = (): DOMRect => ({ top: 0, bottom: 90, left: 0, right: 300 }) as DOMRect;
    return gutter;
  }

  /**
   * Dispatches a cancelable drag event.
   * @param target - Where.
   * @param type - Which.
   * @param clientX - Across.
   * @param clientY - Down.
   * @returns The event.
   */
  function fire(target: EventTarget, type: string, clientX: number, clientY = 10): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
    target.dispatchEvent(event);
    return event;
  }

  it('takes the drop in the gutter and lands the column at the nearest end', () => {
    const editor = open();
    const gutter = inScroller(editor);
    startTableDrag(editor.prosemirrorView!, 'column', cellOf(editor, 'a1'));
    expect(fire(gutter, 'dragover', 900).defaultPrevented).toBe(true);
    expect(fire(gutter, 'drop', 900).defaultPrevented).toBe(true);
    vi.restoreAllMocks();
    expect(grid(editor)[0]).toEqual(['b1', 'c1', 'a1']);
  });

  it('lands at the nearest edge the table frame shows, though a nearer one sits clipped beyond it', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    // The frame shows the table from 0 to 260: the last edge (300) is clipped,
    // 40 past the frame, nearer its right side than the shown edge at 200.
    const frame = (view.nodeDOM(cellOf(editor, 'a1')) as HTMLElement).closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
    frame.getBoundingClientRect = (): DOMRect => ({ top: 0, bottom: 90, left: 0, right: 260 }) as DOMRect;
    startTableDrag(view, 'column', cellOf(editor, 'a1'));
    fire(gutter, 'dragover', 900);
    fire(gutter, 'drop', 900);
    vi.restoreAllMocks();
    expect(grid(editor)[0]).toEqual(['b1', 'a1', 'c1']);
  });

  it('reads a row drop among the rows the body scroller shows', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLTableRowElement) {
      const i = [...this.parentElement!.children].indexOf(this);
      return { top: i * 30, bottom: (i + 1) * 30, left: 0, right: 300 } as DOMRect;
    });
    // The body scroller starts at 40, under the top bar: the edge at 30 is
    // hidden, as near to the pointer at 45 as the shown one at 60.
    gutter.parentElement!.getBoundingClientRect = (): DOMRect => ({ top: 40, bottom: 600, left: 0, right: 1000 }) as DOMRect;
    startTableDrag(view, 'row', cellOf(editor, 'a1'));
    fire(gutter, 'dragover', 900, 45);
    fire(gutter, 'drop', 900, 45);
    vi.restoreAllMocks();
    expect(grid(editor).map((row) => row[0])).toEqual(['a2', 'a1', 'a3']);
  });

  it('takes the drop line away when the pointer leaves the body scroller, and drops nothing there', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    const outside = document.createElement('div');
    document.body.append(outside);
    startTableDrag(view, 'column', cellOf(editor, 'a1'));
    fire(gutter, 'dragover', 900);
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-column"]').length).toBeGreaterThan(0);
    // Over the Agent column beside the body: the browser leaves the gutter
    // for it first.
    gutter.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: outside }));
    fire(outside, 'dragover', 900);
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-column"]').length).toBe(0);
    fire(outside, 'drop', 900);
    vi.restoreAllMocks();
    expect(grid(editor)[0]).toEqual(['a1', 'b1', 'c1']);
  });

  /**
   * Lays the rows out 30 tall from the top, and the body scroller from top to
   * bottom.
   * @param gutter - The gutter, whose parent is the body scroller.
   * @param top - The scroller's top.
   * @param rowsFrom - Where the first row starts.
   */
  function layRows(gutter: HTMLElement, top: number, rowsFrom = 0): void {
    vi.spyOn(HTMLTableRowElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLTableRowElement) {
      const i = [...this.parentElement!.children].indexOf(this);
      return { top: rowsFrom + i * 30, bottom: rowsFrom + (i + 1) * 30, left: 0, right: 300 } as DOMRect;
    });
    gutter.parentElement!.getBoundingClientRect = (): DOMRect => ({ top, bottom: 600, left: 0, right: 1000 }) as DOMRect;
  }

  it('takes the drop line away when the pointer leaves the window, and drops nothing outside it', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    layRows(gutter, 0);
    startTableDrag(view, 'row', cellOf(editor, 'a1'));
    fire(gutter, 'dragover', 900, 80);
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-row"]').length).toBeGreaterThan(0);
    gutter.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }));
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-row"]').length).toBe(0);
    view.dom.ownerDocument.dispatchEvent(new Event('dragend'));
    vi.restoreAllMocks();
    expect(grid(editor).map((row) => row[0])).toEqual(['a1', 'a2', 'a3']);
  });

  it('takes the drop on the update the pointer crosses into the gutter, which only fires a dragenter', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    startTableDrag(view, 'column', cellOf(editor, 'a1'));
    expect(fire(gutter, 'dragenter', 900).defaultPrevented).toBe(true);
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-column"]').length).toBeGreaterThan(0);
  });

  it('in Safari keeps the line while the pointer crosses elements, and takes it away when the count leaves the window', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI);
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    layRows(gutter, 0);
    startTableDrag(view, 'row', cellOf(editor, 'a1'));
    const lines = (): number => view.dom.querySelectorAll('[class*="doc-table-drop-row"]').length;
    gutter.dispatchEvent(new Event('dragstart', { bubbles: true }));
    fire(gutter, 'dragenter', 900, 80);
    fire(gutter, 'dragover', 900, 80);
    expect(lines()).toBeGreaterThan(0);
    // From the gutter onto a cell: Safari enters the cell, then leaves the gutter for null.
    const cell = view.nodeDOM(cellOf(editor, 'b2')) as HTMLElement;
    fire(cell, 'dragenter', 50, 80);
    gutter.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }));
    expect(lines()).toBeGreaterThan(0);
    // Off the cell and out of the window: nothing is entered.
    cell.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, relatedTarget: null }));
    expect(lines()).toBe(0);
  });

  it('draws no line and drops nothing while every edge of the table is out of view', () => {
    const editor = open();
    const gutter = inScroller(editor);
    const view = editor.prosemirrorView!;
    // The rows sit 0–90; the body scroller starts at 400: the table scrolled out above.
    layRows(gutter, 400);
    startTableDrag(view, 'row', cellOf(editor, 'a1'));
    fire(gutter, 'dragover', 900, 500);
    expect(view.dom.querySelectorAll('[class*="doc-table-drop-row"]').length).toBe(0);
    fire(gutter, 'drop', 900, 500);
    vi.restoreAllMocks();
    expect(grid(editor).map((row) => row[0])).toEqual(['a1', 'a2', 'a3']);
  });

  it('leaves a drop outside the body scroller to the browser', () => {
    const editor = open();
    inScroller(editor);
    const outside = document.createElement('div');
    document.body.append(outside);
    startTableDrag(editor.prosemirrorView!, 'column', cellOf(editor, 'a1'));
    expect(fire(outside, 'dragover', 900).defaultPrevented).toBe(false);
    fire(outside, 'drop', 900);
    vi.restoreAllMocks();
    expect(grid(editor)[0]).toEqual(['a1', 'b1', 'c1']);
  });
});
