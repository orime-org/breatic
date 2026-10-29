// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A9 and A10: the bubble bar over table cells — it comes up over
 * any selection of cells, empty ones too; the link is greyed; the colour
 * panel gains a cell fill row; merging is one more button, there only while
 * cells are selected. A cell holds blocks (inner#1619 T2), so the block type
 * works there as in the body.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import {
  closeShared,
  focusBody,
  hoverOpenSlot,
  mountDocumentEditor,
  openSharedBody,
  waitForBar,
  type HarnessEditor,
} from './bubble-bar-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

afterEach(() => {
  closeShared();
});

/**
 * Opens a mounted editor holding a 2 × 2 table.
 * @param cells - The four cells' text.
 * @returns The editor.
 */
function openTable(cells: readonly [string, string, string, string]): HarnessEditor {
  const editor = openSharedBody('');
  mountDocumentEditor(editor);
  act(() => {
    editor.replaceBlocks(editor.document, [
      tableBlock({
        rows: [{ cells: [cells[0], cells[1]] }, { cells: [cells[2], cells[3]] }],
      }),
    ] as never);
  });
  focusBody(editor);
  return editor;
}

/**
 * The positions before the table's cells, in order.
 * @param editor - The editor.
 * @returns Them.
 */
function cells(editor: HarnessEditor): number[] {
  const out: number[] = [];
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.name === 'docTableCell') out.push(pos);
    return true;
  });
  return out;
}

/**
 * Selects cells by their index.
 * @param editor - The editor.
 * @param anchor - The anchor cell.
 * @param head - The head cell.
 */
function selectCells(editor: HarnessEditor, anchor: number, head: number): void {
  const view = editor.prosemirrorView!;
  const at = cells(editor);
  act(() => {
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, at[anchor]!, at[head]!)));
  });
}

describe('the bubble bar over selected cells', () => {
  it('comes up over empty cells, the link greyed and the block type live', async () => {
    const editor = openTable(['', '', '', '']);
    selectCells(editor, 0, 1);

    await waitForBar();

    expect(screen.getByTestId('doc-bubble-block-type').getAttribute('aria-disabled')).not.toBe('true');
    expect((screen.getByTestId('doc-bubble-tool-link') as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns the blocks of every selected cell into the type picked', async () => {
    const editor = openTable(['a1', 'b1', 'a2', 'b2']);
    selectCells(editor, 0, 1);
    await waitForBar();

    const menu = await hoverOpenSlot('doc-bubble-block-type');
    await act(async () => {
      fireEvent.click(menu.querySelector('[data-testid="doc-bubble-block-type-item-heading-1"]')!);
    });

    const types: string[] = [];
    editor.prosemirrorState.doc.descendants((node, _pos, parent) => {
      if (parent?.type.name === 'blockContainer' && node.isTextblock) types.push(`${node.type.name}:${node.textContent}`);
      return true;
    });
    expect(types).toEqual(['heading:a1', 'heading:b1', 'paragraph:a2', 'paragraph:b2']);
  });

  it('turns words selected in one cell into the type picked, in that cell', async () => {
    const editor = openTable(['hello', 'b1', 'a2', 'b2']);
    let start = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (start < 0 && node.isText && node.text === 'hello') start = pos;
      return start < 0;
    });
    const view = editor.prosemirrorView!;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, start + 3)));
    });
    await waitForBar();
    expect(screen.getByTestId('doc-bubble-block-type').getAttribute('aria-disabled')).not.toBe('true');

    const menu = await hoverOpenSlot('doc-bubble-block-type');
    await act(async () => {
      fireEvent.click(menu.querySelector('[data-testid="doc-bubble-block-type-item-bullet-list"]')!);
    });

    let cellOfList = '';
    editor.prosemirrorState.doc.descendants((node, _pos, parent) => {
      if (node.type.name === 'bulletListItem' && parent !== null) cellOfList = node.textContent;
      return true;
    });
    expect(cellOfList).toBe('hello');
    let tables = 0;
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'docTable') tables += 1;
      return true;
    });
    expect(tables).toBe(1);
  });

  it('offers merging while cells are selected, and merges them', async () => {
    const editor = openTable(['a1', 'b1', 'a2', 'b2']);
    selectCells(editor, 0, 1);
    await waitForBar();

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-bubble-tool-mergeCells'));
    });

    expect(cells(editor)).toHaveLength(3);
  });

  it('has no merge button over words in one cell', async () => {
    const editor = openTable(['a1', 'b1', 'a2', 'b2']);
    const view = editor.prosemirrorView!;
    const first = cells(editor)[0]! + 2;
    act(() => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, first, first + 2)));
    });
    await waitForBar();

    expect(screen.queryByTestId('doc-bubble-tool-mergeCells')).toBeNull();
  });

  it('fills the selected cells from the colour panel', async () => {
    const editor = openTable(['', '', '', '']);
    selectCells(editor, 2, 3);
    await waitForBar();

    await hoverOpenSlot('doc-bubble-color');
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-bubble-color-cell-green'));
    });

    const fills = cells(editor).map((pos) => editor.prosemirrorState.doc.nodeAt(pos)?.attrs['backgroundColor']);
    expect(fills).toEqual(['default', 'default', 'green', 'green']);
  });
});
