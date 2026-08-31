// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press builds one transaction, and every selection shape reaches it.
 *
 * Counting dispatches rather than staging a failure: `chain().run()` dispatches
 * before it reports success (`@tiptap/core@3.29.2` `dist/index.js:82-87`), so
 * a single dispatch is what makes a press all-or-nothing in the first place.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { AllSelection, NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';

import { runBlockType } from '@web/spaces/document/document-block-press';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

/**
 * How many transactions a press dispatches.
 * @param editor - The editor.
 * @param id - Which row.
 * @returns The count.
 */
function dispatchesOf(editor: Editor, id: BlockTypeId): number {
  let count = 0;
  const spy = vi.spyOn(editor.view, 'dispatch');
  spy.mockImplementation((...args) => {
    count += 1;
    return Object.getPrototypeOf(editor.view).dispatch.apply(editor.view, args);
  });
  runBlockType(editor, id);
  spy.mockRestore();
  return count;
}

describe('one press, one transaction', () => {
  it.each([
    ['heading-1', '<ul><li><p>x</p></li></ul>'],
    ['bullet-list', '<blockquote><h1>x</h1></blockquote>'],
    ['quote', '<ol><li><p>one</p></li><li><p>two</p></li></ol>'],
  ] as const)('pressing %s dispatches once', (id, start) => {
    const editor = openBody(start);
    selectWholeBody(editor);
    expect(dispatchesOf(editor, id)).toBe(1);
  });

  it.each([
    ['heading-1', '<ul><li><p>x</p></li></ul>'],
    ['bullet-list', '<blockquote><h1>x</h1></blockquote>'],
    ['quote', '<ol><li><p>one</p></li><li><p>two</p></li></ol>'],
  ] as const)('one undo puts the document back after pressing %s', (id, start) => {
    const editor = openBody(start);
    selectWholeBody(editor);
    const before = editor.getHTML();
    runBlockType(editor, id);
    expect(editor.getHTML()).not.toBe(before);
    editor.commands.undo();
    expect(editor.getHTML()).toBe(before);
  });
});

/** Every row the menu draws, in the order it draws them. */
const ROWS: BlockTypeId[] = [
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

describe('selection shapes other than a plain range', () => {
  const ALL_START = '<h1>one</h1><ol><li><p>two</p></li></ol>';

  it.each(ROWS)('gives an AllSelection the same result as a text selection: %s', (id) => {
    const viaText = openBody(ALL_START);
    selectWholeBody(viaText);
    runBlockType(viaText, id);

    const viaAll = openBody(ALL_START);
    viaAll.view.dispatch(
      viaAll.state.tr.setSelection(new AllSelection(viaAll.state.doc)),
    );
    runBlockType(viaAll, id);

    expect(viaAll.getHTML()).toBe(viaText.getHTML());
  });

  const NODE_START = '<p>one</p><p>two</p>';

  it.each(ROWS)('gives a node selection the same result as selecting it: %s', (id) => {
    const viaText = openBody(NODE_START);
    selectBlock(viaText, 'two');
    runBlockType(viaText, id);

    const viaNode = openBody(NODE_START);
    let at = 0;
    viaNode.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === 'two') at = pos;
      return true;
    });
    viaNode.view.dispatch(
      viaNode.state.tr.setSelection(NodeSelection.create(viaNode.state.doc, at)),
    );
    runBlockType(viaNode, id);

    expect(viaNode.getHTML()).toBe(viaText.getHTML());
  });
});

describe('the selection a press leaves behind (§6.2)', () => {
  // The press works off a pair of text block endpoints, so a selection that is
  // not already a text range gets one put in its place; §6.2's second promise
  // is that the reader's own selection comes back at the end. Two tiers of
  // `Mod-a` are shipped, so a select-all is an ordinary way to be holding one.
  it.each(ROWS)('keeps a select-all over three paragraphs whole: %s', (id) => {
    const editor = openBody('<p>one</p><p>two</p><p>three</p>');
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    runBlockType(editor, id);
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to, '|')).toBe('one|two|three');
  });

  it.each(ROWS)('leaves a select-all over one paragraph selected: %s', (id) => {
    const editor = openBody('<p>one</p>');
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    runBlockType(editor, id);
    // An empty selection takes the bubble bar off screen with it
    // (`SelectionBubbleBar.tsx`'s `isWarranted`), so the reader would have to
    // select the paragraph again to press a second row.
    expect(editor.state.selection.empty).toBe(false);
  });

  // A node selection over a text block is what a Mod+click leaves: with
  // `selectNodeModifier` held, prosemirror-view builds one (`prosemirror-view`
  // `MouseDown`), and `document-click-to-write` lets a modified click through.
  // Every exclusive press replaces the node it was on, so prosemirror has
  // nothing to map the selection onto and hands back a caret.
  it.each(ROWS)('leaves a node selection holding something: %s', (id) => {
    const editor = openBody('<h2>one</h2><p>two</p>');
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)),
    );
    runBlockType(editor, id);
    expect(editor.state.selection.empty).toBe(false);
  });
});

describe('a selection holding no text block', () => {
  it.each([
    ['paragraph'],
    ['heading-1'],
    ['heading-2'],
    ['heading-3'],
    ['bullet-list'],
    ['ordered-list'],
    ['task-list'],
    ['code-block'],
    ['quote'],
  ] as const)('pressing %s on an empty document changes nothing', (id) => {
    const editor = openBody('');
    const before = editor.getHTML();
    editor.commands.setTextSelection({ from: 0, to: 0 });
    expect(() => {
      runBlockType(editor, id);
    }).not.toThrow();
    expect(editor.getHTML()).toBe(before);
  });
});

describe('a stored heading below level three', () => {
  /**
   * A document whose one block is a level 4 heading.
   * @returns That editor.
   */
  function openLevelFour(): Editor {
    const editor = openBody('<h1>x</h1>');
    const heading = editor.state.schema.nodes.heading;
    if (!heading) throw new Error('no heading node in the schema');
    editor.view.dispatch(editor.state.tr.setNodeMarkup(0, heading, { level: 4 }));
    selectBlock(editor, 'x');
    return editor;
  }

  it.each(ROWS)('does not throw when %s is pressed on it', (id) => {
    const editor = openLevelFour();
    expect(() => {
      runBlockType(editor, id);
    }).not.toThrow();
  });

  it('leaves the level alone until a row is pressed', () => {
    const editor = openLevelFour();
    // `BODY_HEADING_LEVELS` stops at three, so a stored level 4 renders as the
    // last one the body knows and the level attribute keeps its own value.
    expect(editor.state.doc.firstChild?.attrs.level).toBe(4);
    runBlockType(editor, 'heading-1');
    expect(editor.state.doc.firstChild?.attrs.level).toBe(1);
  });
});
