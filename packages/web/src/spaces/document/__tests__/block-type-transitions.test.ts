// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every cell of the transition table, and the shapes a multi-block selection
 * turns into.
 *
 * Rule 2: pressing an exclusive row goes back to Text where that row is
 * already ticked, and turns every block into it otherwise, the other exclusive
 * rows giving way. Rule 3: pressing Quote wraps or unwraps and leaves the
 * block type alone.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBlockType } from '@web/spaces/document/document-block-model';
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

const PRESSED: BlockTypeId[] = [
  'paragraph',
  'heading-1',
  'bullet-list',
  'ordered-list',
  'code-block',
  'quote',
];

/** One starting state, and what each of the six presses leaves behind. */
type Row = [name: string, start: string, results: string[]];

const P = '<p>x</p>';
const H1 = '<h1>x</h1>';
const UL = '<ul><li><p>x</p></li></ul>';
const OL = '<ol><li><p>x</p></li></ol>';
const CODE = '<pre><code>x</code></pre>';

/**
 * The same HTML inside a quote.
 * @param inner - What the quote holds.
 * @returns The quoted HTML.
 */
function quoted(inner: string): string {
  return `<blockquote>${inner}</blockquote>`;
}

// Order of results: Text, Heading 1, Bullet list, Ordered list, Code block, Quote.
const TABLE: Row[] = [
  ['a paragraph', P, [P, H1, UL, OL, CODE, quoted(P)]],
  [
    'a paragraph in a quote',
    quoted(P),
    [quoted(P), quoted(H1), quoted(UL), quoted(OL), quoted(CODE), P],
  ],
  ['a level one heading', H1, [P, P, UL, OL, CODE, quoted(H1)]],
  [
    'a level one heading in a quote',
    quoted(H1),
    [quoted(P), quoted(P), quoted(UL), quoted(OL), quoted(CODE), H1],
  ],
  ['a level two heading', '<h2>x</h2>', [P, H1, UL, OL, CODE, quoted('<h2>x</h2>')]],
  [
    'a level two heading in a quote',
    quoted('<h2>x</h2>'),
    [quoted(P), quoted(H1), quoted(UL), quoted(OL), quoted(CODE), '<h2>x</h2>'],
  ],
  ['a bullet list item', UL, [P, H1, P, OL, CODE, quoted(UL)]],
  [
    'a bullet list item in a quote',
    quoted(UL),
    [quoted(P), quoted(H1), quoted(P), quoted(OL), quoted(CODE), UL],
  ],
  ['an ordered list item', OL, [P, H1, UL, P, CODE, quoted(OL)]],
  [
    'an ordered list item in a quote',
    quoted(OL),
    [quoted(P), quoted(H1), quoted(UL), quoted(P), quoted(CODE), OL],
  ],
  ['a code block', CODE, [P, H1, UL, OL, P, quoted(CODE)]],
  [
    'a code block in a quote',
    quoted(CODE),
    [quoted(P), quoted(H1), quoted(UL), quoted(OL), quoted(P), CODE],
  ],
];

describe('the transition table', () => {
  const cells = TABLE.flatMap(([name, start, results]) =>
    PRESSED.map((id, index) => [name, start, id, results[index]] as const));

  it.each(cells)('%s, pressing %s', (_name, start, id, expected) => {
    const editor = openBody(start);
    selectBlock(editor, 'x');
    runBlockType(editor, id as BlockTypeId);
    expect(editor.getHTML()).toBe(expected);
  });
});

describe('heading levels', () => {
  it.each([
    ['heading-1', '<h1>plain</h1>'],
    ['heading-2', '<h2>plain</h2>'],
    ['heading-3', '<h3>plain</h3>'],
  ])('a paragraph pressing %s becomes that level', (id, expected) => {
    const editor = openBody('<p>plain</p>');
    selectBlock(editor, 'plain');
    runBlockType(editor, id as BlockTypeId);
    expect(editor.getHTML()).toBe(expected);
  });

  it.each([
    ['<h1>plain</h1>', 'heading-1'],
    ['<h2>plain</h2>', 'heading-2'],
    ['<h3>plain</h3>', 'heading-3'],
  ])('%s pressing its own level goes back to a paragraph', (start, id) => {
    const editor = openBody(start);
    selectBlock(editor, 'plain');
    runBlockType(editor, id as BlockTypeId);
    expect(editor.getHTML()).toBe('<p>plain</p>');
  });

  it('a level one heading pressing Heading 3 becomes level three', () => {
    const editor = openBody('<h1>plain</h1>');
    selectBlock(editor, 'plain');
    runBlockType(editor, 'heading-3');
    expect(editor.getHTML()).toBe('<h3>plain</h3>');
  });
});

describe('a quote survives every exclusive press', () => {
  it.each([
    ['a quoted paragraph', quoted(P)],
    ['a quoted heading', quoted(H1)],
    ['a quoted list', quoted(UL)],
  ])('%s keeps its quote', (_name, start) => {
    for (const id of ['paragraph', 'heading-1', 'bullet-list', 'ordered-list', 'code-block'] as const) {
      const editor = openBody(start);
      selectBlock(editor, 'x');
      runBlockType(editor, id);
      expect(editor.getHTML()).toMatch(/^<blockquote>/);
    }
  });
});

describe('pressing Quote leaves the block type alone', () => {
  it.each([
    ['a heading', H1, quoted(H1)],
    ['a code block', CODE, quoted(CODE)],
    ['a list item', UL, quoted(UL)],
  ])('%s keeps what it is', (_name, start, expected) => {
    const editor = openBody(start);
    selectBlock(editor, 'x');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(expected);
  });
});

describe('several blocks at once', () => {
  const THREE = '<p>one</p><p>two</p><p>three</p>';

  it('presses Bullet list into one list of three items', () => {
    const editor = openBody(THREE);
    selectWholeBody(editor);
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>',
    );
  });

  it('presses Quote into one quote holding three paragraphs', () => {
    const editor = openBody(THREE);
    selectWholeBody(editor);
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><p>one</p><p>two</p><p>three</p></blockquote>',
    );
  });

  it('presses Code block into three separate code blocks', () => {
    const editor = openBody(THREE);
    selectWholeBody(editor);
    runBlockType(editor, 'code-block');
    expect(editor.getHTML()).toBe(
      '<pre><code>one</code></pre><pre><code>two</code></pre><pre><code>three</code></pre>',
    );
  });

  it('turns a heading and a paragraph both into headings', () => {
    const editor = openBody('<h1>one</h1><p>two</p>');
    selectWholeBody(editor);
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe('<h1>one</h1><h1>two</h1>');
  });
});

describe('a selection crossing a list boundary', () => {
  it('merges the selected blocks into one list and splits off the rest', () => {
    const editor = openBody(
      '<p>lead</p><ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>',
    );
    selectRange(editor, 'lead', 'one');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>lead</p></li><li><p>one</p></li></ul>'
        + '<ul><li><p>two</p></li><li><p>three</p></li></ul>',
    );
  });

  it('lifts the selected list items out and leaves the rest renumbered', () => {
    const editor = openBody(
      '<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li><li><p>four</p></li></ol>',
    );
    selectRange(editor, 'two', 'three');
    runBlockType(editor, 'heading-1');
    expect(editor.getHTML()).toBe(
      '<ol><li><p>one</p></li></ol><h1>two</h1><h1>three</h1><ol><li><p>four</p></li></ol>',
    );
  });
});
