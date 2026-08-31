// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys the menu prints do what pressing the row does.
 *
 * Eight bindings arrive from tiptap's own extensions and have to be taken over,
 * so each case here presses the key on a fixture where the old behaviour and
 * the new one differ — a comparison alone would go green with no takeover at
 * all. No single fixture is contested by all eight: a quoted list settles the
 * six that name a block type, and the two list keys need a quoted heading,
 * whose own quote the stock list commands strip (measured,
 * `demo/2026-08-29-impl-adversary-r1-probe-output.txt`).
 *
 * With a caret and no selection a key acts on the whole paragraph the caret is
 * in, and the caret stays where it was.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

import { runBlockType } from '@web/spaces/document/document-block-press';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

/** jsdom reports a pc platform, so `Mod` is Ctrl here. */
interface Chord {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Sends a chord to the editor's keymap.
 * @param editor - The editor.
 * @param chord - Which keys.
 */
function press(editor: Editor, chord: Chord): void {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...chord,
  });
  editor.view.someProp('handleKeyDown', (f) => f(editor.view, event));
}

/** The eight bindings the menu stands behind. */
const BINDINGS: Array<[BlockTypeId, Chord]> = [
  ['paragraph', { key: '0', ctrlKey: true, altKey: true }],
  ['heading-1', { key: '1', ctrlKey: true, altKey: true }],
  ['heading-2', { key: '2', ctrlKey: true, altKey: true }],
  ['heading-3', { key: '3', ctrlKey: true, altKey: true }],
  ['bullet-list', { key: '8', ctrlKey: true, shiftKey: true }],
  ['ordered-list', { key: '7', ctrlKey: true, shiftKey: true }],
  ['code-block', { key: 'c', ctrlKey: true, altKey: true }],
  ['quote', { key: 'b', ctrlKey: true, shiftKey: true }],
];

/**
 * A document where the old binding and the new transition disagree.
 *
 * A quoted list: the stock commands strip the quote or the list along with it,
 * while the model keeps whichever the press does not name. On this one the two
 * list keys agree with their stock commands, so they take the second fixture.
 */
const CONTESTED = '<blockquote><ul><li><p>x</p></li></ul></blockquote>';

/**
 * Where the two list keys disagree with their stock commands.
 *
 * A quoted heading: `toggleBulletList` and `toggleOrderedList` take the quote
 * off along with the heading, while the model keeps it.
 */
const CONTESTED_FOR_LISTS = '<blockquote><h1>x</h1></blockquote>';

/** Which fixture each chord is contested on. */
const FIXTURE_FOR: Partial<Record<BlockTypeId, string>> = {
  'bullet-list': CONTESTED_FOR_LISTS,
  'ordered-list': CONTESTED_FOR_LISTS,
};

describe('the eight bindings are ours', () => {
  it.each(BINDINGS)('%s gives the model result, not the stock one', (id, chord) => {
    const body = FIXTURE_FOR[id] ?? CONTESTED;
    const viaRow = openBody(body);
    selectWholeBody(viaRow);
    runBlockType(viaRow, id);

    const viaKey = openBody(body);
    selectWholeBody(viaKey);
    press(viaKey, chord);

    expect(viaKey.getHTML()).toBe(viaRow.getHTML());
  });
});

describe('a caret with no selection', () => {
  /**
   * A two paragraph document with the caret three characters into the second.
   * @returns The editor and where the caret sits.
   */
  function openWithCaret(): { editor: Editor; at: number } {
    const editor = openBody('<p>first</p><p>second</p>');
    let at = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'second') at = pos + 3;
      return true;
    });
    editor.commands.setTextSelection({ from: at, to: at });
    return { editor, at };
  }

  const EXPECTED: Record<BlockTypeId, string> = {
    paragraph: '<p>first</p><p>second</p>',
    'heading-1': '<p>first</p><h1>second</h1>',
    'heading-2': '<p>first</p><h2>second</h2>',
    'heading-3': '<p>first</p><h3>second</h3>',
    'bullet-list': '<p>first</p><ul><li><p>second</p></li></ul>',
    'ordered-list': '<p>first</p><ol><li><p>second</p></li></ol>',
    'code-block': '<p>first</p><pre><code>second</code></pre>',
    quote: '<p>first</p><blockquote><p>second</p></blockquote>',
    'task-list': '',
  };

  it.each(BINDINGS)('%s acts on the whole paragraph the caret is in', (id, chord) => {
    const { editor } = openWithCaret();
    press(editor, chord);
    expect(editor.getHTML()).toBe(EXPECTED[id]);
  });

  it.each(BINDINGS)('%s leaves the caret on the same character', (id, chord) => {
    const { editor, at } = openWithCaret();
    const charBefore = editor.state.doc.textBetween(at - 1, at);
    press(editor, chord);
    const { selection } = editor.state;
    expect(selection.empty).toBe(true);
    expect(editor.state.doc.textBetween(selection.from - 1, selection.from)).toBe(
      charBefore,
    );
  });
});

describe('a selection', () => {
  it('acts on the selection, matching the row', () => {
    const editor = openBody('<p>one</p><p>two</p>');
    selectBlock(editor, 'two');
    press(editor, { key: '2', ctrlKey: true, altKey: true });
    expect(editor.getHTML()).toBe('<p>one</p><h2>two</h2>');
  });
});
