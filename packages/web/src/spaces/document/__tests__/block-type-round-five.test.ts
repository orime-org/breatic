// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a press promises about the blocks it was not given.
 *
 * Round five found six ways a press reached past its own selection or landed
 * somewhere other than where it was pressed. Each one here names the shape
 * that reaches it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { AllSelection, NodeSelection } from '@tiptap/pm/state';

import { canRunBlockType, runBlockType } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectRange } from './block-type-fixtures';

afterEach(() => {
  closeAll();
});

describe('an item that opens a sub-list', () => {
  // The item cannot give up its first block on its own — an item opens with a
  // paragraph, and what would be left opens with the sub-list. The item comes
  // apart, its blocks land where it stood, and the sub-list becomes a list of
  // its own.
  const NESTED = '<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>';

  it.each([
    ['paragraph', '<p>one</p><ul><li><p>deep</p></li></ul>'],
    ['heading-1', '<h1>one</h1><ul><li><p>deep</p></li></ul>'],
    ['ordered-list', '<ol><li><p>one</p></li></ol><ul><li><p>deep</p></li></ul>'],
  ] as const)('takes it apart when %s is pressed', (id, expected) => {
    const editor = openBody(NESTED);
    selectBlock(editor, 'one');
    runBlockType(editor, id);
    expect(editor.getHTML()).toBe(expected);
  });

  it.each(['paragraph', 'heading-1', 'heading-2', 'heading-3',
    'bullet-list', 'ordered-list', 'code-block', 'quote'] as const)(
    'reaches %s', (id) => {
      const editor = openBody(NESTED);
      selectBlock(editor, 'one');
      expect(canRunBlockType(editor, id)).toBe(true);
    },
  );
});

describe('a node selection over a list', () => {
  // A Mod+click leaves one. Every step of a press used to re-read the blocks
  // off the transaction's own selection, and lifting the first item deletes
  // the node the selection sat on, so the steps after it saw one block where
  // the reader had the whole list (A9, §6.2).
  const START = '<h1>a</h1><ul><li><p>b</p></li><li><p>d</p></li></ul>';

  /** Puts a node selection on the list. @param editor - The editor. */
  function selectTheList(editor: ReturnType<typeof openBody>): void {
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'bulletList') at = pos;
      return at < 0;
    });
    editor.view.dispatch(editor.state.tr.setSelection(
      NodeSelection.create(editor.state.doc, at),
    ));
  }

  it('gives the same document as selecting the same blocks as text', () => {
    const viaNode = openBody(START);
    selectTheList(viaNode);
    runBlockType(viaNode, 'heading-1');

    const viaText = openBody(START);
    selectRange(viaText, 'b', 'd');
    runBlockType(viaText, 'heading-1');

    expect(viaNode.getHTML()).toBe(viaText.getHTML());
    expect(viaNode.getHTML()).toBe('<h1>a</h1><h1>b</h1><h1>d</h1>');
  });

  it('reaches every row the same text selection reaches', () => {
    const viaNode = openBody(START);
    selectTheList(viaNode);
    const viaText = openBody(START);
    selectRange(viaText, 'b', 'd');

    for (const id of ['paragraph', 'heading-1', 'bullet-list', 'ordered-list',
      'code-block', 'quote'] as const) {
      expect([id, canRunBlockType(viaNode, id)])
        .toEqual([id, canRunBlockType(viaText, id)]);
    }
  });
});

describe('a new list the press makes', () => {
  // §5.3's second row keeps the tail a list of its own, and the demo the same
  // reading was measured against (§5.2's note on 2026-08-29) refuses to weld
  // runs the reader did not select onto the run they did. A press makes its
  // own list and takes nothing else into it.
  it('stays a list of its own beside a list of the same kind', () => {
    const editor = openBody('<ol><li><p>one</p></li></ol><p>two</p>');
    selectBlock(editor, 'two');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ol><li><p>one</p></li></ol><ol><li><p>two</p></li></ol>',
    );
  });

  it('stays a list of its own beside a list of the other kind', () => {
    const editor = openBody('<ul><li><p>one</p></li></ul><p>two</p>');
    selectBlock(editor, 'two');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p></li></ul><ol><li><p>two</p></li></ol>',
    );
  });
});

describe('Quote over an item that holds more than one block', () => {
  it('leaves the items after it outside the quote', () => {
    const editor = openBody(
      '<ul><li><p>a</p></li><li><p>b</p><p>bb</p></li><li><p>d</p></li></ul>',
    );
    selectRange(editor, 'b', 'bb');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p></li></ul>'
        + '<blockquote><ul><li><p>b</p><p>bb</p></li></ul></blockquote>'
        + '<ul><li><p>d</p></li></ul>',
    );
  });

  it('leaves the items before it outside when the run opens on a later block', () => {
    const editor = openBody(
      '<ul><li><p>a</p><p>aa</p></li><li><p>b</p></li><li><p>d</p></li></ul>',
    );
    selectRange(editor, 'aa', 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><p>aa</p></li><li><p>b</p></li></ul></blockquote>'
        + '<ul><li><p>d</p></li></ul>',
    );
  });
});

describe('a selection covering both levels of a nested list', () => {
  // Taking the outer item out of its list makes the inner one the first block
  // of what is left, so it is a list item again — a block cannot become the
  // row that was pressed while it is one (rule 2). Each block still leaves one
  // level of its own: `deep` starts two levels in and ends in the body because
  // the item that held it went there too, which is where a one-level lift puts
  // it (user 2026-08-30).
  const NESTED = '<p>lead</p><ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>';

  it('turns every block into the row that was pressed', () => {
    const editor = openBody(NESTED);
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe('<h1>lead</h1><h1>one</h1><h1>deep</h1>');
  });

  it.each(['paragraph', 'heading-1', 'heading-2', 'heading-3',
    'bullet-list', 'ordered-list', 'code-block', 'quote'] as const)(
    'reaches %s', (id) => {
      const editor = openBody(NESTED);
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      expect(canRunBlockType(editor, id)).toBe(true);
    },
  );

  it('leaves a block that is only an item because a sibling was lifted alone', () => {
    // `sib` is nobody's selection, and it is the second item of the inner
    // list, so lifting `deep` does not make it the first block of anything.
    const editor = openBody(
      '<ul><li><p>one</p><ul><li><p>deep</p></li><li><p>sib</p></li></ul></li></ul>',
    );
    selectBlock(editor, 'deep');
    runBlockType(editor, 'paragraph');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p><p>deep</p><ul><li><p>sib</p></li></ul></li></ul>',
    );
  });
});

describe('an item that cannot be cut open', () => {
  // A list item opens with a paragraph, so an item holding `<p>note</p>` and a
  // heading cannot give up its first block on its own: what would be left
  // opens with the heading. The item comes apart instead and its blocks land
  // in the body, which leaves the reader with the line they pressed on plus
  // the block that was riding along in the same item.
  const STUCK = '<ul><li><p>note</p><h2>aside</h2></li><li><p>next</p></li></ul>';

  it('lets the first block become a heading, and the rest of the item comes with it', () => {
    const editor = openBody(STUCK);
    selectBlock(editor, 'note');
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(
      '<h1>note</h1><h2>aside</h2><ul><li><p>next</p></li></ul>',
    );
  });

  it.each(['paragraph', 'heading-1', 'heading-2', 'heading-3',
    'bullet-list', 'ordered-list', 'code-block', 'quote'] as const)(
    'reaches %s', (id) => {
      const editor = openBody(STUCK);
      selectBlock(editor, 'note');
      expect(canRunBlockType(editor, id)).toBe(true);
    },
  );

  it('keeps cutting the item open where what is left can still be one', () => {
    // Two paragraphs: taking the first leaves a paragraph, which an item can
    // open with, so only the selected block moves and `b` takes the marker.
    const editor = openBody('<ul><li><p>a</p><p>b</p></li></ul>');
    selectBlock(editor, 'a');
    runBlockType(editor, 'paragraph');
    expect(editor.getHTML()).toBe('<p>a</p><ul><li><p>b</p></li></ul>');
  });
});
