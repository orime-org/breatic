// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1314 design §5.1 entry table: columns never stand in a column, at
 * any depth, nor under another block. Pasting or dragging a column group, or
 * a table holding one in a cell, into a column or a nested group is refused
 * with a warning and writes nothing; into the body or a cell it lands.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '@breatic/shared';

import { toast } from '@web/lib/toast';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';
import { open, pasteFormats, positionOf, select, settled, unmountAll, type Editor } from '@web/spaces/document/__tests__/paste-harness';

beforeEach(() => {
  vi.spyOn(toast, 'warning').mockReturnValue('column-entry-warning');
});

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

/**
 * Opens a body and waits for it to settle.
 * @param blocks - The document.
 * @returns The editor.
 */
async function openReady(blocks: unknown[]): Promise<Editor> {
  const { editor } = open(blocks);
  await act(async () => {
    await settled();
  });
  return editor;
}

/**
 * Pastes blocks the way a copy inside the body puts them on the clipboard.
 * @param editor - The editor.
 * @param blocks - The copied blocks.
 */
async function pasteBlocks(editor: Editor, blocks: unknown[]): Promise<void> {
  const html = editor.blocksToFullHTML(blocks as never);
  pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'x' });
  await settled();
}

/**
 * Puts the caret in some words.
 * @param editor - The editor.
 * @param words - The words.
 */
function caretAt(editor: Editor, words: string): void {
  select(editor, positionOf(editor, words, words.length));
}

/**
 * How many column groups the document holds, at any depth.
 * @param editor - The editor.
 * @returns The count.
 */
function groups(editor: Editor): number {
  let count = 0;
  editor.prosemirrorView.state.doc.descendants((node) => {
    if (node.type.name === 'docColumnList') count += 1;
    return true;
  });
  return count;
}

/** A table whose first cell holds a column group. */
const tableWithColumns = (): unknown =>
  tableBlock({ rows: [{ cells: [{ blocks: [columnsBlock(['p'], ['q'])] }, 'r'] }] });

const refusal = (): string => t('spaces.document.columns.unavailable');

describe('pasting columns', () => {
  it('lands a copied group in the body', async () => {
    const editor = await openReady([para('lead'), para('')]);
    caretAt(editor, 'lead');
    select(editor, editor.prosemirrorView.state.doc.content.size - 3);
    await pasteBlocks(editor, [columnsBlock(['x'], ['y'])]);
    expect(groups(editor)).toBe(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('refuses a copied group in a column, writing nothing', async () => {
    const editor = await openReady([columnsBlock(['a'], ['c'])]);
    const before = editor.prosemirrorView.state.doc;
    caretAt(editor, 'a');
    await pasteBlocks(editor, [columnsBlock(['x'], ['y'])]);
    expect(editor.prosemirrorView.state.doc.eq(before)).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(refusal());
  });

  it('refuses a copied group under a list item', async () => {
    const editor = await openReady([{ type: 'bulletListItem', content: 'item', children: [para('child')] }]);
    const before = editor.prosemirrorView.state.doc;
    caretAt(editor, 'child');
    await pasteBlocks(editor, [columnsBlock(['x'], ['y'])]);
    expect(editor.prosemirrorView.state.doc.eq(before)).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(refusal());
  });

  it('refuses a table holding columns in a column', async () => {
    const editor = await openReady([columnsBlock(['a'], ['c'])]);
    const before = editor.prosemirrorView.state.doc;
    caretAt(editor, 'a');
    await pasteBlocks(editor, [tableWithColumns()]);
    expect(editor.prosemirrorView.state.doc.eq(before)).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(refusal());
  });

  it('drops a column whose only block is a medium left out, and the group with it', async () => {
    const { editor, sink } = open([para('lead'), para('')]);
    await act(async () => {
      await settled();
    });
    select(editor, editor.prosemirrorView.state.doc.content.size - 3);
    await pasteBlocks(editor, [
      columnsBlock(['x'], { blocks: [{ type: 'image', props: { url: 'http://elsewhere.example/a.png' } }] }),
    ]);
    expect(groups(editor)).toBe(0);
    expect(editor.prosemirrorView.state.doc.textContent).toContain('x');
    expect(sink.onLeftOut).toHaveBeenCalledWith(1);
  });

  it('lands a copied group in a cell of a table nested under a list item', async () => {
    const editor = await openReady([
      { type: 'bulletListItem', content: 'item', children: [tableBlock({ rows: [{ cells: [{ blocks: [para('')] }, 'b'] }] })] },
    ]);
    let empty = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (empty < 0 && node.type.name === 'paragraph' && node.content.size === 0) empty = pos + 1;
      return empty < 0;
    });
    select(editor, empty);
    await pasteBlocks(editor, [columnsBlock(['x'], ['y'])]);
    expect(groups(editor)).toBe(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('lands a copied group in a cell', async () => {
    const editor = await openReady([tableBlock({ rows: [{ cells: [{ blocks: [para('')] }, 'b'] }] })]);
    let empty = -1;
    editor.prosemirrorView.state.doc.descendants((node, pos) => {
      if (empty < 0 && node.type.name === 'paragraph' && node.content.size === 0) empty = pos + 1;
      return empty < 0;
    });
    select(editor, empty);
    await pasteBlocks(editor, [columnsBlock(['x'], ['y'])]);
    expect(groups(editor)).toBe(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('dragging a table holding columns', () => {
  it('refuses it into a column, writing nothing', async () => {
    const editor = await openReady([columnsBlock(['a'], ['c']), tableWithColumns()]);
    const view = editor.prosemirrorView;
    const before = view.state.doc;
    const table = (editor.document as unknown as { id: string; type: string }[]).find((block) => block.type === 'docTable')!;
    moveRowTo(view, table.id, positionOf(editor, 'a', 1));
    expect(view.state.doc.eq(before)).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(refusal());
    expect(shapeOf(editor.document as never)).toEqual(['[a|c]', 'docTable']);
  });
});

describe('a copy across columns', () => {
  /**
   * Copies a range with the editor's own copy.
   * @param editor - The editor.
   * @param from - Where the range starts.
   * @param to - Where it ends.
   * @returns The clipboard formats written.
   */
  function copied(editor: Editor, from: number, to: number): Record<string, string> {
    const data: Record<string, string> = {};
    select(editor, from, to);
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => (data[type] = value), clearData: () => undefined, getData: (type: string) => data[type] ?? '' },
    });
    editor.prosemirrorView.dom.dispatchEvent(event);
    return data;
  }

  it('pastes in the body as a group of the parts copied', async () => {
    const source = await openReady([columnsBlock(['alpha', 'beta'], ['gamma', 'delta'])]);
    const formats = copied(source, positionOf(source, 'beta', 0), positionOf(source, 'gamma', 5));
    const editor = await openReady([para('lead'), para('')]);
    select(editor, editor.prosemirrorView.state.doc.content.size - 3);
    pasteFormats(editor, formats);
    await settled();
    // A block pasted on the last line leaves a line to carry on, as a table does.
    expect(shapeOf(editor.document as never)).toEqual(['lead', '[beta|gamma]', '¶']);
  });

  it('is refused in a column', async () => {
    const source = await openReady([columnsBlock(['alpha', 'beta'], ['gamma', 'delta'])]);
    const formats = copied(source, positionOf(source, 'beta', 0), positionOf(source, 'gamma', 5));
    const editor = await openReady([columnsBlock(['x'], ['y'])]);
    const before = editor.prosemirrorView.state.doc;
    caretAt(editor, 'x');
    pasteFormats(editor, formats);
    await settled();
    expect(editor.prosemirrorView.state.doc.eq(before)).toBe(true);
    expect(toast.warning).toHaveBeenCalledWith(refusal());
  });
});
