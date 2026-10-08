// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A6: the row and column handles, as the reader meets them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { deleteRowAt, insertRow } from '@web/spaces/document/document-table-run';
import { tableTargetOf } from '@web/spaces/document/document-table-target';

type Editor = ReturnType<typeof buildDocumentEditor>;

const side = vi.hoisted(() => ({
  editor: undefined as unknown,
  state: undefined as unknown,
  frozen: 0,
  unfrozen: 0,
}));

vi.mock('@blocknote/react', () => ({
  useBlockNoteEditor: () => side.editor,
  useExtension: () => ({
    freezeHandles: () => {
      side.frozen += 1;
    },
    unfreezeHandles: () => {
      side.unfrozen += 1;
    },
  }),
  useExtensionState: () => side.state,
}));

const { setBubbleBarUp } = await import('@web/spaces/document/document-bars');
const { DocumentTableHandle } = await import(
  '@web/spaces/document/DocumentTableHandles'
);

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  side.frozen = 0;
  side.unfrozen = 0;
});

/**
 * Opens an editor holding a paragraph and a 2 × 2 table, with the pointer over one cell.
 * @param rowIndex - The row the pointer is over.
 * @param colIndex - The column the pointer is over.
 * @returns The editor.
 */
function openOver(rowIndex: number, colIndex: number): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'reader' },
    {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] },
    },
  ] as never);
  side.editor = editor;
  side.state = { show: true, block: editor.document[1], rowIndex, colIndex };
  return editor;
}

/**
 * The table, as cell texts, header cells marked with `#`.
 * @param editor - The editor.
 * @returns One array per row.
 */
function grid(editor: Editor): string[][] {
  let table: PMNode | null = null;
  editor.prosemirrorState.doc.descendants((node) => {
    if (table === null && node.type.name === 'table') table = node;
    return table === null;
  });
  if (table === null) return [];
  const rows: string[][] = [];
  (table as PMNode).forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => cells.push(`${cell.type.name === 'tableHeader' ? '#' : ''}${cell.textContent}`));
    rows.push(cells);
  });
  return rows;
}

/**
 * The open menu's rows.
 * @param stem - Their test id stem.
 * @returns Their ids, `(off)` on the greyed ones.
 */
function rows(stem: string): string[] {
  return Array.from(document.querySelectorAll(`[data-testid^="${stem}"]`))
    .filter((el) => el.getAttribute('role') === 'menuitem')
    .map((el) => `${el.getAttribute('data-testid')!.replace(stem, '')}${el.getAttribute('aria-disabled') === 'true' ? '(off)' : ''}`);
}

describe('the row handle (A6)', () => {
  it('offers the row commands, header only on the first row', () => {
    openOver(1, 0);
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);

    fireEvent.click(screen.getByTestId('doc-table-row-handle'));

    expect(rows('doc-table-row-')).toEqual([
      'insertAbove',
      'insertBelow',
      'header(off)',
      'align',
      'fill',
      'delete',
    ]);
  });

  it('marks the row it acts on while its menu is open, and the column handle its column', () => {
    openOver(1, 1);
    const marked = (): string[] =>
      Array.from(document.querySelectorAll('.doc-table-target')).map((cell) => cell.textContent ?? '');
    const row = render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));
    expect(marked()).toEqual(['a2', 'b2']);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));
    expect(marked()).toEqual([]);
    row.unmount();

    render(<DocumentTableHandle orientation='column' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-col-handle'));
    expect(marked()).toEqual(['b1', 'b2']);
  });

  it('holds the hovered cell, freezes the handles, and lets go when it closes', () => {
    const editor = openOver(1, 1);
    const hide = vi.fn();
    render(<DocumentTableHandle orientation='row' hideOtherElements={hide} />);

    fireEvent.click(screen.getByTestId('doc-table-row-handle'));
    const target = tableTargetOf(editor.prosemirrorState);
    expect(target === null ? null : editor.prosemirrorState.doc.nodeAt(target)?.textContent).toBe('b2');
    expect(side.frozen).toBe(1);
    expect(hide).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('doc-table-row-insertBelow'));
    expect(grid(editor)).toEqual([['a1', 'b1'], ['a2', 'b2'], ['', '']]);
    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();
    expect(side.unfrozen).toBe(1);
    expect(hide).toHaveBeenLastCalledWith(false);
  });

  it('deletes the row it was opened on after a row lands above it', () => {
    const editor = openOver(1, 0);
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));

    let a1 = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (a1 < 0 && node.type.name === 'tableCell' && node.textContent === 'a1') a1 = pos;
      return a1 < 0;
    });
    insertRow(editor, a1, 'above');
    fireEvent.click(screen.getByTestId('doc-table-row-delete'));

    expect(grid(editor)).toEqual([['', ''], ['a1', 'b1']]);
  });

  it('turns the first row into headers', () => {
    const editor = openOver(0, 0);
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));

    fireEvent.click(screen.getByTestId('doc-table-row-header'));

    expect(grid(editor)).toEqual([['#a1', '#b1'], ['a2', 'b2']]);
  });

  it('lets go of the handles when it leaves while its menu is open', () => {
    openOver(0, 0);
    const view = render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));

    view.unmount();

    expect(side.unfrozen).toBe(1);
  });

  // A Space switched away from is hidden, and hiding runs the cleanup that
  // lets the handles go (inner#1235 C5). The menu goes with them, the way a
  // menu closes when focus leaves it.
  it('closes its menu when its Space is hidden', () => {
    const editor = openOver(1, 1);
    const inSpace = (mode: 'visible' | 'hidden'): React.JSX.Element => (
      <React.Activity mode={mode}>
        <DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />
      </React.Activity>
    );
    const view = render(inSpace('visible'));
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));
    expect(rows('doc-table-row-')).not.toEqual([]);

    act(() => view.rerender(inSpace('hidden')));
    act(() => view.rerender(inSpace('visible')));

    expect(rows('doc-table-row-')).toEqual([]);
    expect(tableTargetOf(editor.prosemirrorState)).toBeNull();
  });

  it('closes its menu when the row it was opened on is deleted', () => {
    const editor = openOver(1, 0);
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-row-handle'));
    expect(screen.getByTestId('doc-table-row-delete')).toBeTruthy();

    let a2 = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (a2 < 0 && node.type.name === 'tableCell' && node.textContent === 'a2') a2 = pos;
      return a2 < 0;
    });
    act(() => {
      deleteRowAt(editor, a2);
    });

    expect(screen.queryByTestId('doc-table-row-delete')).toBeNull();
    expect(side.unfrozen).toBe(1);
  });

  it('is not there while the bubble bar is up (inner#1127)', () => {
    const editor = openOver(0, 0);
    act(() => {
      setBubbleBarUp(editor, true);
    });
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);

    expect(screen.queryByTestId('doc-table-row-handle')).toBeNull();
  });

  it('is there over a selection the body let go of, with no bubble bar up (inner#1127)', () => {
    const editor = openOver(0, 0);
    const pm = editor.prosemirrorView!;
    pm.dispatch(pm.state.tr.setSelection(TextSelection.create(pm.state.doc, 2, 4)));
    render(<DocumentTableHandle orientation='row' hideOtherElements={() => undefined} />);

    expect(screen.queryByTestId('doc-table-row-handle')).not.toBeNull();
  });
});

describe('the column handle (A6)', () => {
  it('offers the column commands and deletes the column', () => {
    const editor = openOver(0, 1);
    render(<DocumentTableHandle orientation='column' hideOtherElements={() => undefined} />);
    fireEvent.click(screen.getByTestId('doc-table-col-handle'));

    expect(rows('doc-table-col-')).toEqual([
      'insertLeft',
      'insertRight',
      'header(off)',
      'align',
      'fill',
      'delete',
    ]);

    fireEvent.click(screen.getByTestId('doc-table-col-delete'));
    expect(grid(editor)).toEqual([['a1'], ['a2']]);
  });
});
