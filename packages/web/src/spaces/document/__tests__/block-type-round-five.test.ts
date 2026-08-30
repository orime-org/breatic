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
import { NodeSelection } from '@tiptap/pm/state';

import { canRunBlockType, runBlockType } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectRange } from './block-type-fixtures';

afterEach(() => {
  closeAll();
});

describe('an item the lift cannot take out of its list', () => {
  // A list item has to open with a paragraph, so taking the first block out of
  // an item that also holds a sub-list would leave the item opening with the
  // sub-list. `liftTarget` refuses, and every exclusive row is out of reach
  // for as long as it does (§6.7, the greyed set pinned in the menu's tests).
  const STUCK = '<ul><li><p>a</p></li><li><p>b</p><ul><li><p>c</p></li></ul></li></ul>';

  it.each(['paragraph', 'heading-1', 'bullet-list', 'ordered-list'] as const)(
    'leaves the document alone when %s is pressed',
    (id) => {
      const editor = openBody(STUCK);
      selectBlock(editor, 'b');
      runBlockType(editor, id);
      expect(editor.getHTML()).toBe(STUCK);
    },
  );

  it.each(['paragraph', 'heading-1', 'bullet-list', 'ordered-list'] as const)(
    'says %s cannot be reached',
    (id) => {
      const editor = openBody(STUCK);
      selectBlock(editor, 'b');
      expect(canRunBlockType(editor, id)).toBe(false);
    },
  );
});

describe('a node selection over a list', () => {
  // A Mod+click leaves one. Every step of a press re-reads the blocks off the
  // transaction's own selection, and lifting the first item deletes the node
  // the selection sat on, so the steps after it saw one block where the reader
  // had the whole list.
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

  it('leaves the document alone rather than moving only its first block', () => {
    const editor = openBody(START);
    selectTheList(editor);
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(START);
  });

  it('says the row cannot be reached', () => {
    const editor = openBody(START);
    selectTheList(editor);
    expect(canRunBlockType(editor, 'heading-1')).toBe(false);
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

describe('splitting a list that starts at a number of its own', () => {
  it('numbers the piece after the split from one', () => {
    const editor = openBody(
      '<ol start="3"><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>',
    );
    selectBlock(editor, 'two');
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(
      '<ol start="3"><li><p>one</p></li></ol>'
        + '<h1>two</h1>'
        + '<ol><li><p>three</p></li></ol>',
    );
  });
});
