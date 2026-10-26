// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A10 and A11: the button on the cell the pointer is over, and its
 * menu (inner#1619 T13).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { setBubbleBarUp } from '@web/spaces/document/document-bars';
import { deleteRowAt } from '@web/spaces/document/document-table-run';
import { DocumentTableCellButton } from '@web/spaces/document/DocumentTableCellButton';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding a paragraph and a table.
 * @param rows - The table's rows, each cell text or a merged cell.
 * @returns The editor and the viewport the button draws into.
 */
function open(rows: TableInput['rows'] = [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }]): { editor: Editor; viewport: HTMLElement } {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const viewport = document.createElement('div');
  const root = document.createElement('div');
  viewport.appendChild(root);
  document.body.appendChild(viewport);
  editor.mount(root);
  mounted.push(editor);
  // A reader working in the body: the body holds the focus, which the caret
  // needs before it raises anything (inner#1127 A20).
  editor.prosemirrorView!.dom.focus();
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'reader' },
    tableBlock({ rows }),
  ] as never);
  return { editor, viewport };
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
 * Puts the caret into a cell, or selects text there.
 * @param editor - The editor.
 * @param text - The cell's text.
 * @param span - How many characters to select.
 */
function caretIn(editor: Editor, text: string, span = 0): void {
  const view = editor.prosemirrorView!;
  const at = cellOf(editor, text) + 3;
  act(() => {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at, at + span)));
  });
}

/**
 * Moves the pointer over a cell's words.
 * @param editor - The editor.
 * @param text - The cell's text.
 */
function pointIn(editor: Editor, text: string): void {
  const cell = [...editor.prosemirrorView!.dom.querySelectorAll('td, th')].find((td) => td.textContent === text)!;
  const words = [...cell.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent === text)!;
  act(() => {
    words.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 }));
  });
}

/**
 * Moves the pointer onto an element outside the body.
 * @param element - The element.
 */
function pointOnto(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 900, clientY: 900 }));
  });
}

/**
 * One attribute of every cell, row by row.
 * @param editor - The editor.
 * @param name - The attribute.
 * @returns The values.
 */
function attrs(editor: Editor, name: string): unknown[][] {
  const out: unknown[][] = [];
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (node.type.name === 'docTableRow') {
      const row: unknown[] = [];
      node.forEach((cell) => row.push(cell.attrs[name]));
      out.push(row);
      return false;
    }
    return true;
  });
  return out;
}

/**
 * The alignment of the first block of every cell.
 * @param editor - The editor.
 * @returns One array per row.
 */
function blockAligns(editor: Editor): unknown[][] {
  const out: unknown[][] = [];
  editor.prosemirrorState.doc.descendants((node: PMNode) => {
    if (node.type.name !== 'docTableRow') return true;
    const row: unknown[] = [];
    node.forEach((cell) => row.push(cell.firstChild?.firstChild?.attrs['textAlignment']));
    out.push(row);
    return false;
  });
  return out;
}

/**
 * The open menu's rows.
 * @returns Their ids, `(off)` on the greyed ones.
 */
function rows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid^="doc-table-cell-"]'))
    .filter((el) => el.getAttribute('role') === 'menuitem')
    .map((el) => `${el.getAttribute('data-testid')!.replace('doc-table-cell-', '')}${el.getAttribute('aria-disabled') === 'true' ? '(off)' : ''}`);
}

describe('the cell button (A11)', () => {
  it('is on the cell the pointer is over, and steps aside for the bubble bar (inner#1127)', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    expect(screen.queryByTestId('doc-table-cell-button')).toBeNull();

    pointIn(editor, 'b2');
    expect(screen.getByTestId('doc-table-cell-button')).toBeTruthy();

    act(() => {
      setBubbleBarUp(editor, true);
    });
    expect(screen.queryByTestId('doc-table-cell-button')).toBeNull();
  });

  it('is not raised by the caret alone', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);

    caretIn(editor, 'b2');

    expect(screen.queryByTestId('doc-table-cell-button')).toBeNull();
  });

  it('goes when the pointer leaves the body, and stays while it is on the button (inner#1402)', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    pointIn(editor, 'b2');

    pointOnto(screen.getByTestId('doc-table-cell-button'));
    expect(screen.getByTestId('doc-table-cell-button')).toBeTruthy();

    pointOnto(document.body);
    expect(screen.queryByTestId('doc-table-cell-button')).toBeNull();
  });

  it('follows the pointer to another cell when it was already over a cell as the button mounted', async () => {
    // The button's first cell is known on its very first render when the
    // pointer was already over a cell.
    const boxes: Record<string, DOMRect> = { a1: new DOMRect(0, 0, 100, 40), b2: new DOMRect(100, 40, 100, 40) };
    const measure = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      // Everything else is a roomy ancestor, so nothing clips the cell.
      return (this.tagName === 'TD' && boxes[this.textContent ?? '']) || new DOMRect(0, 0, 1000, 1000);
    };
    const html = document.documentElement;
    Object.defineProperty(html, 'clientWidth', { configurable: true, value: 1000 });
    Object.defineProperty(html, 'clientHeight', { configurable: true, value: 1000 });
    try {
      /** Where the button is drawn now. */
      const at = (): string => (screen.getByTestId('doc-table-cell-button').closest('[style]') as HTMLElement).style.transform;
      // Where a button mounted with the pointer already over b2 is drawn.
      const fresh = open();
      pointIn(fresh.editor, 'b2');
      const first = render(<DocumentTableCellButton editor={fresh.editor} viewport={fresh.viewport} />);
      await act(async () => {});
      const onB2 = at();
      first.unmount();

      const { editor, viewport } = open();
      pointIn(editor, 'a1');
      render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
      await act(async () => {});
      const onA1 = at();
      expect(onA1).not.toBe(onB2);

      pointIn(editor, 'b2');
      await act(async () => {});

      expect(at()).toBe(onB2);
    } finally {
      Element.prototype.getBoundingClientRect = measure;
      delete (html as unknown as Record<string, unknown>)['clientWidth'];
      delete (html as unknown as Record<string, unknown>)['clientHeight'];
    }
  });

  it('offers alignment, fill and split, split greyed on a cell never merged', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    pointIn(editor, 'b2');

    fireEvent.click(screen.getByTestId('doc-table-cell-button'));

    expect(rows()).toEqual(['align', 'fill', 'split(off)']);
  });

  it('aligns the one cell', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    pointIn(editor, 'b2');
    fireEvent.click(screen.getByTestId('doc-table-cell-button'));
    fireEvent.click(screen.getByTestId('doc-table-cell-align'));

    fireEvent.click(screen.getByTestId('doc-table-cell-align-center'));

    expect(attrs(editor, 'textAlignment').flat().every((value) => value === undefined)).toBe(true);
    expect(blockAligns(editor)).toEqual([
      ['left', 'left'],
      ['left', 'center'],
    ]);
  });

  it('splits a merged cell back, its text in the top-left cell (A10)', () => {
    const { editor, viewport } = open([
      { cells: [{ type: 'docTableCell', content: 'ab', props: { colspan: 2 } }] },
      { cells: ['a2', 'b2'] },
    ]);
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    pointIn(editor, 'ab');
    fireEvent.click(screen.getByTestId('doc-table-cell-button'));
    expect(rows()).toEqual(['align', 'fill', 'split']);

    fireEvent.click(screen.getByTestId('doc-table-cell-split'));

    expect(attrs(editor, 'colspan')).toEqual([
      [1, 1],
      [1, 1],
    ]);
    const first: string[] = [];
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'docTableRow') {
        node.forEach((cell) => first.push(cell.textContent));
        return false;
      }
      return true;
    });
    expect(first.slice(0, 2)).toEqual(['ab', '']);
  });

  it('closes its menu when its cell is deleted', () => {
    const { editor, viewport } = open();
    render(<DocumentTableCellButton editor={editor} viewport={viewport} />);
    pointIn(editor, 'b2');
    fireEvent.click(screen.getByTestId('doc-table-cell-button'));
    expect(screen.getByTestId('doc-table-cell-align')).toBeTruthy();

    act(() => {
      deleteRowAt(editor, cellOf(editor, 'a2'));
    });

    expect(screen.queryByTestId('doc-table-cell-align')).toBeNull();
  });
});
