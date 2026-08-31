// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Unquoting, on every shape the round-9 adversary reached (§6.3.1).
 *
 * A quote is 0 or 1 levels and never 2 (user 2026-08-31), so a press has to
 * leave every selected block unquoted however deep the lists go, leave every
 * block nobody selected in a quote of its own (A8), and keep the document in
 * the order the reader had it (§6.3).
 *
 * The four steps that used to do this each acted on part of the selection, and
 * every one of these shapes broke on a seam between two of them. One pass over
 * the quote's content answers all three at once.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { TextSelection } from '@tiptap/pm/state';

import { canRunBlockType, runBlockType } from '@web/spaces/document/document-block-press';
import { blockTypeAt, selectedBlocks } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectRange } from './block-type-fixtures';

afterEach(() => { closeAll(); });

/** `c` is the inner list's second item, `z` a second item of the outer list. */
const BURIED = '<blockquote><ul><li><p>a</p>'
  + '<ol><li><p>b</p></li><li><p>c</p></li></ol>'
  + '</li><li><p>z</p></li></ul></blockquote>';

/** The quote holds a list and then a paragraph of its own. */
const WITH_TAIL = '<blockquote><ul><li><p>a</p>'
  + '<ol><li><p>b</p></li><li><p>c</p></li></ol>'
  + '</li></ul><p>tail</p></blockquote>';

describe('unquoting reaches every selected block', () => {
  it('frees both selected lines when they sit in different buried lists', () => {
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li>'
        + '<li><p>z</p><ol><li><p>y</p></li></ol></li></ul></blockquote>',
    );
    selectRange(editor, 'b', 'y');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>'
        + '<ol><li><p>b</p></li></ol>'
        + '<ul><li><p>z</p><ol><li><p>y</p></li></ol></li></ul>',
    );
  });

  it('frees a line that a second selected item follows', () => {
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ol><li><p>c</p></li></ol></li>'
        + '<li><p>z</p></li></ul></blockquote>',
    );
    selectRange(editor, 'c', 'z');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>'
        + '<ol><li><p>c</p></li></ol>'
        + '<ul><li><p>z</p></li></ul>',
    );
  });

  it('strips both levels of a legacy nested quote around a buried line', () => {
    // A22: one press leaves no level. The row is ticked while any quote holds
    // the block, so a press that only takes the inner one off reads as a press
    // that did nothing the reader can see.
    const editor = openBody(`<blockquote>${BURIED}</blockquote>`);
    selectBlock(editor, 'c');
    expect(canRunBlockType(editor, 'quote')).toBe(true);
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul></blockquote></blockquote>'
        + '<ol><li><p>c</p></li></ol>'
        + '<blockquote><blockquote><ul><li><p>z</p></li></ul></blockquote></blockquote>',
    );
  });
});

describe('unquoting leaves the blocks nobody selected quoted', () => {
  it('keeps the sibling item quoted when the selection runs from the item down into its list', () => {
    const editor = openBody(BURIED);
    selectRange(editor, 'a', 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><ol><li><p>b</p></li><li><p>c</p></li></ol></li></ul>'
        + '<blockquote><ul><li><p>z</p></li></ul></blockquote>',
    );
  });

  it('keeps an item\'s own first line quoted when only its second line is picked', () => {
    // `one` carries the bullet the reader can see. It is not selected, so it
    // stays where it was — and `two`, which never had a marker, comes out
    // without one (rule 3: Quote leaves the block type alone).
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ul><li><p>one</p><p>two</p></li></ul></li></ul></blockquote>',
    );
    selectBlock(editor, 'two');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ul><li><p>one</p></li></ul></li></ul></blockquote>'
        + '<p>two</p>',
    );
  });
});

describe('unquoting keeps the document in order', () => {
  it('leaves the item that follows the freed one behind it', () => {
    // `b` is the inner list's FIRST item, so `c` follows it. Freeing `b` must
    // not move `c` above it. `c` cannot stay inside the outer item — what would
    // be left of that item opens with a list, and `listItem` is
    // `paragraph block*` — so it rises to sit directly in the quote.
    const editor = openBody(BURIED);
    selectBlock(editor, 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>'
        + '<ol><li><p>b</p></li></ol>'
        + '<blockquote><ol><li><p>c</p></li></ol><ul><li><p>z</p></li></ul></blockquote>',
    );
  });

  it('leaves the quote\'s own trailing paragraph below the freed line', () => {
    const editor = openBody(WITH_TAIL);
    selectBlock(editor, 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul></blockquote>'
        + '<ol><li><p>c</p></li></ol>'
        + '<blockquote><p>tail</p></blockquote>',
    );
  });

  it('leaves the trailing paragraph below even where the freed line was the list\'s only item', () => {
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul><p>tail</p></blockquote>',
    );
    selectBlock(editor, 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>'
        + '<ol><li><p>b</p></li></ol>'
        + '<blockquote><p>tail</p></blockquote>',
    );
  });

  it('keeps three levels of nesting in order', () => {
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ul><li><p>b</p>'
        + '<ul><li><p>c</p></li><li><p>d</p></li></ul>'
        + '</li></ul></li></ul></blockquote>',
    );
    selectBlock(editor, 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul></blockquote>'
        + '<ul><li><p>c</p></li></ul>'
        + '<blockquote><ul><li><p>d</p></li></ul></blockquote>',
    );
  });
});

describe('unquoting keeps what the reader was holding', () => {
  it('leaves the selection on the line that was pressed', () => {
    // An empty selection takes the bubble bar off screen
    // (`SelectionBubbleBar`'s `isWarranted`), so the bar the reader pressed the
    // row in would vanish on the press.
    const editor = openBody(BURIED);
    selectBlock(editor, 'c');
    runBlockType(editor, 'quote');
    const { selection, doc } = editor.state;
    expect(selection.empty, 'the selection collapsed').toBe(false);
    expect(doc.textBetween(selection.from, selection.to)).toBe('c');
  });

  it('leaves a multi-block selection over the same blocks', () => {
    const editor = openBody(BURIED);
    selectRange(editor, 'b', 'c');
    runBlockType(editor, 'quote');
    const { selection, doc } = editor.state;
    expect(selection.empty).toBe(false);
    expect(doc.textBetween(selection.from, selection.to, '\n')).toBe('b\nc');
  });
});

describe('unquoting rebuilds the lists it takes apart', () => {
  it('keeps the freed items in one list of the type and numbering they had', () => {
    // `z` and `w` follow an item whose own buried list is freed first, so the
    // list they belong to has to be rebuilt around them after that one is
    // handed up. One list, not two, or their numbering restarts.
    const editor = openBody(
      '<blockquote><ol start="5"><li><p>a</p><ul><li><p>c</p></li></ul></li>'
        + '<li><p>z</p></li><li><p>w</p></li></ol></blockquote>',
    );
    selectRange(editor, 'c', 'w');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ol start="5"><li><p>a</p></li></ol></blockquote>'
        + '<ul><li><p>c</p></li></ul>'
        + '<ol start="5"><li><p>z</p></li><li><p>w</p></li></ol>',
    );
  });

  it('keeps a freed item in a list of its own type', () => {
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><ol start="3">'
        + '<li><p>b</p></li><li><p>c</p></li></ol></li></ul></blockquote>',
    );
    selectBlock(editor, 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ol start="3"><li><p>b</p></li></ol></li></ul></blockquote>'
        + '<ol start="3"><li><p>c</p></li></ol>',
    );
  });
});

describe('unquoting leaves the block type alone (rule 3)', () => {
  it('brings a continuation line out without a marker', () => {
    // `two` is the item's second block: no bullet is drawn beside it. A press
    // that gives it one has changed what the block is, which Quote never does.
    const editor = openBody('<blockquote><ul><li><p>one</p><p>two</p></li></ul></blockquote>');
    selectBlock(editor, 'two');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>one</p></li></ul></blockquote><p>two</p>',
    );
    const at = selectedBlocks(editor.state)[0] ?? 0;
    expect(blockTypeAt(editor.state.doc, at), 'the freed line grew a marker').toBe('paragraph');
  });

  it('brings a continuation line out of an ordered list without a number', () => {
    const editor = openBody(
      '<blockquote><ol><li><p>a</p><p>b</p></li><li><p>c</p></li></ol></blockquote>',
    );
    selectBlock(editor, 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ol><li><p>a</p></li></ol></blockquote>'
        + '<p>b</p>'
        + '<blockquote><ol><li><p>c</p></li></ol></blockquote>',
    );
  });

  it('leaves a heading in that slot a heading, as it always did', () => {
    const editor = openBody('<blockquote><ul><li><p>a</p><h2>H</h2></li></ul></blockquote>');
    selectBlock(editor, 'H');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote><h2>H</h2>',
    );
  });
});

describe('unquoting reaches a quote buried in an item that travels whole', () => {
  it('takes both levels off when the item\'s own line is picked too', () => {
    // Rule 5 sends the whole item out when its first line is picked, and
    // everything indented under it goes along — including a block that was
    // quoted a second time inside it. A press leaving that block quoted breaks
    // the 0-or-1 rule, and the reader cannot fix it with a second press: the
    // tick is off by then, so pressing again wraps.
    const editor = openBody(
      '<blockquote><ul><li><p>a</p><blockquote><p>q</p></blockquote></li>'
        + '<li><p>z</p></li></ul></blockquote>',
    );
    selectRange(editor, 'a', 'q');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><p>q</p></li></ul>'
        + '<blockquote><ul><li><p>z</p></li></ul></blockquote>',
    );
  });
});

describe('unquoting keeps the caret where the reader put it', () => {
  it('holds a collapsed caret on the same character', () => {
    // The bubble bar never opens on a caret, so the chord is the only way in
    // and the only path this can be seen on (A21).
    const editor = openBody('<blockquote><p>hello world</p></blockquote>');
    const start = selectedBlocks(editor.state)[0] ?? 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start + 5)),
    );
    runBlockType(editor, 'quote');
    const { selection, doc } = editor.state;
    expect(selection.empty).toBe(true);
    expect(doc.textBetween(selection.from - 1, selection.from)).toBe('o');
  });

  it('holds a range that covers part of one block', () => {
    const editor = openBody('<blockquote><p>hello world</p></blockquote>');
    const start = selectedBlocks(editor.state)[0] ?? 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, start + 1, start + 4)),
    );
    runBlockType(editor, 'quote');
    const { selection, doc } = editor.state;
    expect(doc.textBetween(selection.from, selection.to)).toBe('ell');
  });
});
