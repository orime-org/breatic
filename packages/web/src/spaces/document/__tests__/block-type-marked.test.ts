// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which rows the menu ticks, and on what grounds.
 *
 * Rule 1: a row is ticked when EVERY text block in the selection is that item.
 * The four kinds of item are judged differently — a list is the nearest list
 * ancestor while the block itself is a paragraph, so judging lists by the
 * block's own type would tick Text and leave Bullet list blank.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';

import { markedIds, runBlockType } from '@web/spaces/document/document-block-model';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import {
  openBody,
  closeAll,
  selectBlock,
  selectRange,
  selectWholeBody,
} from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

const NINE: BlockTypeId[] = [
  'paragraph',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet-list',
  'ordered-list',
  'task-list',
  'code-block',
  'quote',
];

/**
 * Which of the nine rows are ticked.
 * @param editor - The editor.
 * @returns The ticked ids, in menu order.
 */
function ticked(editor: import('@tiptap/core').Editor): BlockTypeId[] {
  const marked = markedIds(editor);
  return NINE.filter((id) => marked.has(id));
}

describe('rule 1: every block in the selection has to be that item', () => {
  it('ticks Heading 1 where the whole selection is level one', () => {
    const editor = openBody('<h1>one</h1><h1>two</h1>');
    selectWholeBody(editor);
    expect(ticked(editor)).toEqual(['heading-1']);
  });

  it('ticks nothing in the exclusive group where one block differs', () => {
    const editor = openBody('<h1>one</h1><p>two</p>');
    selectWholeBody(editor);
    expect(ticked(editor)).toEqual([]);
  });

  it('gives the same answer whichever end the drag started from', () => {
    const editor = openBody('<h1>one</h1><h1>two</h1>');
    selectRange(editor, 'one', 'two');
    const { from, to } = editor.state.selection;
    const forwards = ticked(editor);

    // The same stretch with the anchor at the far end, which is what a drag
    // upwards leaves. `setTextSelection` normalises its two numbers, so the
    // selection is built directly.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, to, from)),
    );
    expect(editor.state.selection.anchor).toBe(to);
    expect(editor.state.selection.head).toBe(from);
    expect(ticked(editor)).toEqual(forwards);
  });
});

describe('the four kinds of item are judged differently', () => {
  it('judges a list by the nearest list ancestor, not the block itself', () => {
    const editor = openBody('<ul><li><p>item</p></li></ul>');
    selectBlock(editor, 'item');
    expect(ticked(editor)).toEqual(['bullet-list']);
  });

  it('ticks Text only where the paragraph has no list ancestor', () => {
    const editor = openBody('<p>loose</p>');
    selectBlock(editor, 'loose');
    expect(ticked(editor)).toEqual(['paragraph']);
  });

  it('ticks Quote alongside the block type, since they are orthogonal', () => {
    const editor = openBody('<blockquote><p>quoted</p></blockquote>');
    selectBlock(editor, 'quoted');
    expect(ticked(editor)).toEqual(['paragraph', 'quote']);
  });

  it('ticks Quote and the list where a quote holds a list', () => {
    const editor = openBody('<blockquote><ul><li><p>deep</p></li></ul></blockquote>');
    selectBlock(editor, 'deep');
    expect(ticked(editor)).toEqual(['bullet-list', 'quote']);
  });

  it('separates heading levels', () => {
    const editor = openBody('<h2>two</h2>');
    selectBlock(editor, 'two');
    expect(ticked(editor)).toEqual(['heading-2']);
  });

  it('ticks Code block on its own', () => {
    const editor = openBody('<pre><code>code</code></pre>');
    selectBlock(editor, 'code');
    expect(ticked(editor)).toEqual(['code-block']);
  });
});

describe('a selection holding no text block ticks nothing', () => {
  it('leaves all nine blank on an empty document', () => {
    const editor = openBody('');
    editor.commands.setTextSelection({ from: 0, to: 0 });
    expect(ticked(editor)).toEqual([]);
  });
});

describe('a list is the row of its item\'s FIRST block only (user 2026-08-30)', () => {
  // The bullet is drawn on the list item and sits beside its first line, so a
  // later block of the same item carries no marker on screen. Judging it by
  // "is a list somewhere above me" would have the menu report a list where the
  // reader sees none.
  it('ticks the list on the first block', () => {
    const editor = openBody('<ul><li><p>a</p><p>b</p></li></ul>');
    selectBlock(editor, 'a');
    expect(ticked(editor)).toEqual(['bullet-list']);
  });

  it('ticks Text on a later block of the same item', () => {
    const editor = openBody('<ul><li><p>a</p><p>b</p></li></ul>');
    selectBlock(editor, 'b');
    expect(ticked(editor)).toEqual(['paragraph']);
  });

  it('ticks the heading alone where a later block is one', () => {
    const editor = openBody('<ul><li><p>a</p><h1>b</h1></li></ul>');
    selectBlock(editor, 'b');
    expect(ticked(editor)).toEqual(['heading-1']);
  });

  it('ticks the quote and Text on a later block held by a quote', () => {
    const editor = openBody('<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>');
    selectBlock(editor, 'b');
    expect(ticked(editor)).toEqual(['paragraph', 'quote']);
  });
});

describe('at most one exclusive row is ever ticked (A13)', () => {
  // Rule 1 makes a block exactly one of the eight, and §6.0 judges a list by
  // the nearest list ancestor while the block itself stays a paragraph. So a
  // press that leaves a heading or a code block inside a list item has two
  // rows answering for one block. Both starting states below are ones the menu
  // itself writes: §5.3 row 5 (A35) for the first, row 6 (A36) for the second.
  const EXCLUSIVE_ROWS = NINE.filter((id) => id !== 'quote');

  it.each(EXCLUSIVE_ROWS)('holds after %s on a block that cannot leave its item', (id) => {
    const editor = openBody('<ul><li><p>one</p><p>d1</p><ul><li><p>d2</p></li></ul></li></ul>');
    selectBlock(editor, 'd1');
    runBlockType(editor, id);
    selectBlock(editor, 'd1');
    expect(ticked(editor).filter((row) => row !== 'quote')).toHaveLength(1);
  });

  it.each(EXCLUSIVE_ROWS)('holds after %s on a quoted block inside an item', (id) => {
    const editor = openBody('<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>');
    selectBlock(editor, 'b');
    runBlockType(editor, id);
    selectBlock(editor, 'b');
    expect(ticked(editor).filter((row) => row !== 'quote')).toHaveLength(1);
  });
});

describe('a stored heading below level three', () => {
  it('ticks nothing and does not throw', () => {
    const editor = openBody('<h1>x</h1>');
    const { schema, tr } = editor.state;
    const heading = schema.nodes.heading;
    if (!heading) throw new Error('no heading node in the schema');
    editor.view.dispatch(tr.setNodeMarkup(0, heading, { level: 4 }));
    selectBlock(editor, 'x');
    expect(ticked(editor)).toEqual([]);
  });
});
