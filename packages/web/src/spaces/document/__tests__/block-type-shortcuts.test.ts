// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The keys the menu prints do what pressing the row does.
 *
 * Eight bindings arrive from tiptap's own extensions and have to be taken over,
 * so each case here presses the key on a fixture where the old behaviour and
 * the new one differ — a comparison alone would go green with no takeover at
 * all.
 *
 * With a caret and no selection a key acts on the whole paragraph the caret is
 * in, and the caret stays where it was.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';

import { runBlockType } from '@web/spaces/document/document-block-type';
import type { BlockTypeId } from '@web/spaces/document/document-block-type';

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
 * while the model keeps whichever the press does not name.
 */
const CONTESTED = '<blockquote><ul><li><p>x</p></li></ul></blockquote>';

describe('the eight bindings are ours', () => {
  it.each(BINDINGS)('%s gives the model result, not the stock one', (id, chord) => {
    const viaRow = openBody(CONTESTED);
    selectWholeBody(viaRow);
    runBlockType(viaRow, id);

    const viaKey = openBody(CONTESTED);
    selectWholeBody(viaKey);
    press(viaKey, chord);

    expect(viaKey.getHTML()).toBe(viaRow.getHTML());
  });
});

describe('a caret with no selection', () => {
  it('acts on the whole paragraph the caret is in', () => {
    const editor = openBody('<p>first</p><p>second</p>');
    let inSecond = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'second') inSecond = pos + 3;
      return true;
    });
    editor.commands.setTextSelection({ from: inSecond, to: inSecond });
    press(editor, { key: '1', ctrlKey: true, altKey: true });
    expect(editor.getHTML()).toBe('<p>first</p><h1>second</h1>');
  });

  it('leaves the caret on the same character', () => {
    const editor = openBody('<p>first</p><p>second</p>');
    let inSecond = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'second') inSecond = pos + 3;
      return true;
    });
    editor.commands.setTextSelection({ from: inSecond, to: inSecond });
    const charBefore = editor.state.doc.textBetween(inSecond - 1, inSecond);
    press(editor, { key: '1', ctrlKey: true, altKey: true });
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
