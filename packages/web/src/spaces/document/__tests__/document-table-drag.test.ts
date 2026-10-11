// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A7 and A17: dragging a row or a column to a gap moves it there,
 * with its words, styles and comments; the row a drag started on is followed
 * through other people's edits; a row a merged cell spans cannot be dragged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
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

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

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
  rows: unknown[] = [
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
    { type: 'table', content: { type: 'tableContent', rows } },
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
    if (at < 0 && node.type.name === 'tableCell' && node.textContent === text) at = pos;
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
    if (node.type.name === 'tableRow') {
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
      { cells: [{ type: 'tableCell', content: 'tall', props: { rowspan: 2 } }, 'b1'] },
      { cells: ['b2'] },
    ]);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'row')).toBe(false);
    expect(canDragFrom(editor.prosemirrorState.doc, cellOf(editor, 'b1'), 'column')).toBe(true);
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
    return gutter;
  }

  /**
   * Dispatches a cancelable drag event.
   * @param target - Where.
   * @param type - Which.
   * @param clientX - Across.
   * @returns The event.
   */
  function fire(target: EventTarget, type: string, clientX: number): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10 });
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
