// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lists: how far a press reaches, and what happens to an indent.
 *
 * The indent is a list item's position rather than its type, so switching type
 * keeps it — but only where the level still has a sibling to hold it up.
 * Where the item is the only one on its level, lifting it out takes the whole
 * level with it (`demo/2026-08-29-nested-list-item-probe-output.txt`).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBlockType, isMarked } from '@web/spaces/document/document-block-model';

import { openBody, closeAll, selectBlock, selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

const NESTED_ALONE = '<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>';
const NESTED_SIB =
  '<ul><li><p>one</p><ul><li><p>deep</p></li><li><p>sib</p></li></ul></li></ul>';

describe('every item in the selection gives way', () => {
  it('reaches all twenty items of a long list', () => {
    const items = Array.from({ length: 20 }, (_, i) => `<li><p>item ${i}</p></li>`).join('');
    const editor = openBody(`<ul>${items}</ul>`);
    selectWholeBody(editor);
    runBlockType(editor, 'heading-1');
    const headings = editor.getHTML().match(/<h1>/g);
    expect(headings).toHaveLength(20);
    expect(editor.getHTML()).not.toContain('<ul>');
  });
});

describe('switching a nested item to the other list type', () => {
  it('keeps the indent where the level still has a sibling', () => {
    const editor = openBody(NESTED_SIB);
    selectBlock(editor, 'deep');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p>'
        + '<ol><li><p>deep</p></li></ol>'
        + '<ul><li><p>sib</p></li></ul>'
        + '</li></ul>',
    );
  });

  it('drops to the top level where the item is the only one on its level', () => {
    const editor = openBody(NESTED_ALONE);
    selectBlock(editor, 'deep');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p></li></ul><ol><li><p>deep</p></li></ol>',
    );
  });
});

describe('switching a nested item to the list type it already is', () => {
  it('becomes a paragraph inside the level above where it has a sibling', () => {
    const editor = openBody(NESTED_SIB);
    selectBlock(editor, 'deep');
    expect(isMarked(editor, 'bullet-list')).toBe(true);
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p><p>deep</p><ul><li><p>sib</p></li></ul></li></ul>',
    );
  });

  it('becomes a top level paragraph where it is the only one on its level', () => {
    const editor = openBody(NESTED_ALONE);
    selectBlock(editor, 'deep');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe('<ul><li><p>one</p></li></ul><p>deep</p>');
  });
});

describe('a list item whose second block is a heading', () => {
  const PASTED = '<ul><li><p>para</p><h2>x</h2></li></ul>';

  it('ticks both Heading 2 and Bullet list', () => {
    const editor = openBody(PASTED);
    selectBlock(editor, 'x');
    expect(isMarked(editor, 'heading-2')).toBe(true);
    expect(isMarked(editor, 'bullet-list')).toBe(true);
  });

  it.each([['heading-2'], ['bullet-list']] as const)(
    'pressing %s takes that block out of the list item',
    (id) => {
      const editor = openBody(PASTED);
      selectBlock(editor, 'x');
      runBlockType(editor, id);
      expect(editor.getHTML()).toBe('<ul><li><p>para</p></li></ul><p>x</p>');
    },
  );
});
