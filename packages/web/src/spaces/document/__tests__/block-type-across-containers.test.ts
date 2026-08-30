// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Selections that run across a container's edge.
 *
 * The action's set is the selection's text blocks (§6.0), so a press acts on
 * those and leaves everything else where it stands: the blocks nobody selected
 * keep their own quote or list, and a block that is not a text block at all
 * keeps its place among them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/react';

import { runBlockType } from '@web/spaces/document/document-block-model';
import type { BlockTypeId } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectRange, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

describe('a list press across a quote edge', () => {
  const CASES: Array<[start: string, expected: string]> = [
    [
      '<blockquote><p>a</p></blockquote><p>b</p>',
      '<blockquote><ul><li><p>a</p></li></ul></blockquote><ul><li><p>b</p></li></ul>',
    ],
    [
      '<p>b</p><blockquote><p>a</p></blockquote>',
      '<ul><li><p>b</p></li></ul><blockquote><ul><li><p>a</p></li></ul></blockquote>',
    ],
    [
      '<blockquote><p>a</p></blockquote><blockquote><p>b</p></blockquote>',
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>' +
        '<blockquote><ul><li><p>b</p></li></ul></blockquote>',
    ],
    [
      '<blockquote><p>a</p><p>c</p></blockquote><p>b</p>',
      '<blockquote><ul><li><p>a</p></li><li><p>c</p></li></ul></blockquote>' +
        '<ul><li><p>b</p></li></ul>',
    ],
  ];

  it.each(CASES)('turns each side into a list of its own: %s', (start, expected) => {
    const editor = openBody(start);
    selectWholeBody(editor);
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(expected);
  });

  it('leaves a quoted list where it is', () => {
    const editor = openBody('<blockquote><ul><li><p>a</p></li></ul></blockquote><p>b</p>');
    selectWholeBody(editor);
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<blockquote><ol><li><p>a</p></li></ol></blockquote><ol><li><p>b</p></li></ol>',
    );
  });
});

describe('Quote over a selection with one end inside a list', () => {
  it('splits the list at the head and quotes only the selected run', () => {
    const editor = openBody(
      '<p>lead</p><ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>',
    );
    selectRange(editor, 'lead', 'one');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><p>lead</p><ul><li><p>one</p></li></ul></blockquote>' +
        '<ul><li><p>two</p></li><li><p>three</p></li></ul>',
    );
  });

  it('splits the list at the tail and quotes only the selected run', () => {
    const editor = openBody(
      '<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul><p>tail</p>',
    );
    selectRange(editor, 'two', 'tail');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p></li></ul>' +
        '<blockquote><ul><li><p>two</p></li><li><p>three</p></li></ul><p>tail</p></blockquote>',
    );
  });

  it('splits both lists where the selection runs from one into the next', () => {
    const editor = openBody(
      '<ul><li><p>a</p></li><li><p>b</p></li></ul><ol><li><p>c</p></li><li><p>d</p></li></ol>',
    );
    selectRange(editor, 'b', 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p></li></ul>' +
        '<blockquote><ul><li><p>b</p></li></ul><ol><li><p>c</p></li></ol></blockquote>' +
        '<ol><li><p>d</p></li></ol>',
    );
  });
});

describe('Quote taken off part of a quoted list', () => {
  const QUOTED = '<blockquote><ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul></blockquote>';

  it('lifts only the selected item and leaves the siblings quoted', () => {
    const editor = openBody(QUOTED);
    selectBlock(editor, 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>' +
        '<ul><li><p>b</p></li></ul>' +
        '<blockquote><ul><li><p>c</p></li></ul></blockquote>',
    );
  });

  it('lifts the whole list where the selection covers it', () => {
    const editor = openBody(QUOTED);
    selectRange(editor, 'a', 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul>',
    );
  });
});

/**
 * Puts an atom block between the two paragraphs of `<p>one</p><p>two</p>`.
 * @param editor - The editor.
 */
function insertAtomBetween(editor: Editor): void {
  const type = editor.state.schema.nodes.unsupportedBlock;
  if (!type) throw new Error('no unsupportedBlock in the schema');
  let at = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === 'one') at = pos + node.nodeSize;
    return false;
  });
  editor.view.dispatch(editor.state.tr.insert(at, type.create({ originalName: 'futureThing' })));
}

const ATOM = '<div data-unsupported-block="" data-original-name="futureThing"></div>';

describe('a block that is not a text block', () => {
  it('stays where it stands when the blocks around it become a list', () => {
    const editor = openBody('<p>one</p><p>two</p>');
    insertAtomBetween(editor);
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      `<ul><li><p>one</p></li></ul>${ATOM}<ul><li><p>two</p></li></ul>`,
    );
  });

  it('goes into the quote with them (§6.0, user 2026-08-30)', () => {
    const editor = openBody('<p>one</p><p>two</p>');
    insertAtomBetween(editor);
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(`<blockquote><p>one</p>${ATOM}<p>two</p></blockquote>`);
  });

  it('comes back out of the quote with them', () => {
    const editor = openBody('<p>one</p><p>two</p>');
    insertAtomBetween(editor);
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'quote');
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(`<p>one</p>${ATOM}<p>two</p>`);
  });

  it('comes back out with them when the list is switched off', () => {
    const editor = openBody('<p>one</p><p>two</p>');
    insertAtomBetween(editor);
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'bullet-list');
    selectRange(editor, 'one', 'two');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(`<p>one</p>${ATOM}<p>two</p>`);
  });
});

describe('a press that changes nothing', () => {
  // A list item's content is `paragraph block*`, so this item's first block
  // cannot become a heading and cannot leave the item on its own. The press
  // reports failure and the transaction stays home (rule 4).
  const STUCK = '<ul><li><p>para</p><h2>x</h2></li></ul>';
  const ROWS: BlockTypeId[] = [
    'paragraph', 'heading-1', 'heading-2', 'heading-3',
    'bullet-list', 'ordered-list', 'code-block',
  ];

  it.each(ROWS)('dispatches nothing for %s', (id) => {
    const editor = openBody(STUCK);
    selectBlock(editor, 'para');
    let dispatched = 0;
    const original = editor.view.dispatch.bind(editor.view);
    editor.view.dispatch = (tr): void => {
      dispatched += 1;
      original(tr);
    };
    runBlockType(editor, id);
    expect(dispatched).toBe(0);
    expect(editor.getHTML()).toBe(STUCK);
  });
});

describe('a quote between the block and the list holding it', () => {
  // §6.1's measured path takes a list item one level out of its list and
  // leaves blockquote alone, and A4 has the quote survive every exclusive
  // press. A block a quote holds inside a list item is not a list item itself
  // (no marker on screen), so nothing has to make way for it: it changes type
  // where it stands and both containers survive.
  it('keeps the quote and the item when a heading is pressed on a quoted block', () => {
    const editor = openBody('<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>');
    selectBlock(editor, 'b');
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><blockquote><h1>b</h1></blockquote></li></ul>',
    );
  });

  it('takes a quoted inner list one level out and keeps the quote', () => {
    const editor = openBody(
      '<ul><li><p>a</p><blockquote><ul><li><p>b</p></li></ul></blockquote></li></ul>',
    );
    selectBlock(editor, 'b');
    runBlockType(editor, 'paragraph');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>',
    );
  });

  it('keeps the quote when a heading is pressed on a quoted inner list', () => {
    const editor = openBody(
      '<ul><li><p>a</p><blockquote><ul><li><p>b</p></li></ul></blockquote></li></ul>',
    );
    selectBlock(editor, 'b');
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><blockquote><h1>b</h1></blockquote></li></ul>',
    );
  });
});

describe('a long list', () => {
  it('lifts every one of a hundred items', () => {
    const items = Array.from({ length: 100 }, (_, i) => `<li><p>item ${i}</p></li>`).join('');
    const editor = openBody(`<ul>${items}</ul>`);
    selectWholeBody(editor);
    runBlockType(editor, 'heading-1');
    const html = editor.getHTML();
    expect(html.match(/<h1>/g)).toHaveLength(100);
    expect(html).not.toContain('<ul>');
  });
});
