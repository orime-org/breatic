// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Quote is a switch, and a document holds only one level of it.
 *
 * Wrapping and unwrapping have the same shape: the selected blocks land in one
 * quote, and every quote the selection touches splits at the selection's
 * edges, so blocks nobody selected stay in quotes of their own.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { runBlockType } from '@web/spaces/document/document-block-press';

import { openBody, closeAll, selectBlock, selectRange } from './block-type-fixtures';

afterEach(() => {
  closeAll();
  vi.restoreAllMocks();
});

describe('unwrapping', () => {
  it('takes a quote off a list and leaves the list alone', () => {
    const editor = openBody('<blockquote><ul><li><p>deep</p></li></ul></blockquote>');
    selectBlock(editor, 'deep');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe('<ul><li><p>deep</p></li></ul>');
  });

  it('strips every level of a nested quote in one press', () => {
    const editor = openBody('<blockquote><blockquote><p>deep</p></blockquote></blockquote>');
    selectBlock(editor, 'deep');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe('<p>deep</p>');
  });

  it('splits the quote where only some of its blocks are selected', () => {
    const editor = openBody('<blockquote><p>a</p><p>b</p><p>c</p></blockquote>');
    selectBlock(editor, 'b');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><p>a</p></blockquote><p>b</p><blockquote><p>c</p></blockquote>',
    );
  });
});

describe('wrapping across a quote boundary', () => {
  it('leaves the unselected block in the original quote', () => {
    const editor = openBody('<blockquote><p>a</p><p>b</p></blockquote><p>c</p>');
    selectRange(editor, 'b', 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><p>a</p></blockquote><blockquote><p>b</p><p>c</p></blockquote>',
    );
  });

  it('splits both quotes where the selection runs from one into another', () => {
    const editor = openBody(
      '<blockquote><p>A</p><p>B</p></blockquote><p>C</p><blockquote><p>D</p><p>E</p></blockquote>',
    );
    selectRange(editor, 'B', 'D');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><p>A</p></blockquote>'
        + '<blockquote><p>B</p><p>C</p><p>D</p></blockquote>'
        + '<blockquote><p>E</p></blockquote>',
    );
  });
});

describe('a selection covering part of a list', () => {
  it('keeps the quoted part a list and renumbers both sides', () => {
    const editor = openBody(
      '<ol><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li><li><p>four</p></li></ol>',
    );
    selectRange(editor, 'two', 'three');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ol><li><p>one</p></li></ol>'
        + '<blockquote><ol><li><p>two</p></li><li><p>three</p></li></ol></blockquote>'
        + '<ol><li><p>four</p></li></ol>',
    );
  });
});

describe('a nested list item', () => {
  it('wraps the level the item sits on and leaves the level above it', () => {
    const editor = openBody(
      '<ul><li><p>one</p><ul><li><p>deep</p></li><li><p>sib</p></li></ul></li></ul>',
    );
    selectBlock(editor, 'deep');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>one</p>'
        + '<blockquote><ul><li><p>deep</p></li></ul></blockquote>'
        + '<ul><li><p>sib</p></li></ul>'
        + '</li></ul>',
    );
  });
});
