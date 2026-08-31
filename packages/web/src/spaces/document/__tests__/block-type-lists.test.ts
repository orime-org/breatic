// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Lists: how far a press reaches, and what happens to an indent.
 *
 * A press moves the block ONE level out of its list and stops there (user
 * 2026-08-30, `demo/2026-08-30-nested-list-lift-decision.html`). An item of a
 * nested list therefore lands in the item above as a plain paragraph, and an
 * item of a top level list lands in the body — one level takes it out either
 * way. Where the reader wants to keep going, Shift-Tab is the control that
 * moves an indent.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBlockType, markedIds } from '@web/spaces/document/document-block-model';

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

  it('keeps the indent where it is the only one on its level', () => {
    const editor = openBody(NESTED_ALONE);
    selectBlock(editor, 'deep');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p><ol><li><p>deep</p></li></ol></li></ul>',
    );
  });

  it('keeps the indent where the sibling comes before it', () => {
    const editor = openBody(
      '<ul><li><p>one</p><ul><li><p>sib</p></li><li><p>deep</p></li></ul></li></ul>',
    );
    selectBlock(editor, 'deep');
    runBlockType(editor, 'ordered-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p>'
        + '<ul><li><p>sib</p></li></ul>'
        + '<ol><li><p>deep</p></li></ol>'
        + '</li></ul>',
    );
  });
});

describe('switching a nested item to the list type it already is', () => {
  it('becomes a paragraph inside the level above where it has a sibling', () => {
    const editor = openBody(NESTED_SIB);
    selectBlock(editor, 'deep');
    expect(markedIds(editor).has('bullet-list')).toBe(true);
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p><p>deep</p><ul><li><p>sib</p></li></ul></li></ul>',
    );
  });

  it('becomes a paragraph in the level above where it is the only one there', () => {
    const editor = openBody(NESTED_ALONE);
    selectBlock(editor, 'deep');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe('<ul><li><p>one</p><p>deep</p></li></ul>');
  });

  it('becomes a paragraph in the level above where the sibling comes first', () => {
    const editor = openBody(
      '<ul><li><p>one</p><ul><li><p>sib</p></li><li><p>deep</p></li></ul></li></ul>',
    );
    selectBlock(editor, 'deep');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p><ul><li><p>sib</p></li></ul><p>deep</p></li></ul>',
    );
  });

  it('reaches the body from three levels down one press at a time', () => {
    const editor = openBody(
      '<ul><li><p>l1</p><ul><li><p>l2</p><ul><li><p>deep</p></li>'
        + '<li><p>d2</p></li></ul></li></ul></li></ul>',
    );
    selectBlock(editor, 'deep');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>l1</p><ul><li><p>l2</p><p>deep</p>'
        + '<ul><li><p>d2</p></li></ul></li></ul></li></ul>',
    );
  });

  it('takes a top level item out of the list in one press', () => {
    const editor = openBody('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    selectBlock(editor, 'a');
    runBlockType(editor, 'bullet-list');
    expect(editor.getHTML()).toBe('<p>a</p><ul><li><p>b</p></li></ul>');
  });
});
