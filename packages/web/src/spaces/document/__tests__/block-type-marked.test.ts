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

import { isMarked } from '@web/spaces/document/document-block-model';
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
  return NINE.filter((id) => isMarked(editor, id));
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
