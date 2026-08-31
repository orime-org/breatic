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

import { canRunBlockType, runBlockType } from '@web/spaces/document/document-block-press';

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

describe('taking a quote off lines buried in a nested list', () => {
  // A quote is 0 or 1 levels, never 2 (user 2026-08-31), so a press that leaves
  // the selection quoted is wrong however deep the lists go. The split at the
  // selection's edges arranges the ordinary cases: it leaves the selected run in
  // a list of its own, which the unwrap then takes out alone. A line deeper than
  // the quote's own child cannot be arranged that way — isolating it means
  // splitting `li` where the second half would open with a list, and `listItem`
  // is `paragraph block*`. That stretch is carried out instead: the list holding
  // it is cut, the quote split after the item that held it, and the cut list put
  // between the two halves. Of the four editors surveyed only CKEditor 5 ends
  // here (`demo/2026-08-31-unquote-nested-industry.html`).
  const BURIED = '<blockquote><ul><li><p>a</p>'
    + '<ol><li><p>b</p></li><li><p>c</p></li></ol>'
    + '</li><li><p>z</p></li></ul></blockquote>';

  it('frees the buried line and leaves the other three quoted', () => {
    const editor = openBody(BURIED);
    selectBlock(editor, 'c');
    expect(canRunBlockType(editor, 'quote')).toBe(true);
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul></blockquote>'
        + '<ol><li><p>c</p></li></ol>'
        + '<blockquote><ul><li><p>z</p></li></ul></blockquote>',
    );
  });

  it('frees the whole inner list where the selection covers all of it', () => {
    const editor = openBody(BURIED);
    selectRange(editor, 'b', 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p></li></ul></blockquote>'
        + '<ol><li><p>b</p></li><li><p>c</p></li></ol>'
        + '<blockquote><ul><li><p>z</p></li></ul></blockquote>',
    );
  });

  it('puts the line after the quote where its item was the quote\'s last', () => {
    // Nothing follows the item, so there is no second half of the quote to
    // make. Splitting anyway would leave an empty one behind.
    const editor = openBody(
      '<blockquote><ul><li><p>a</p>'
        + '<ol><li><p>b</p></li><li><p>c</p></li></ol>'
        + '</li></ul></blockquote>',
    );
    selectBlock(editor, 'c');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ul><li><p>a</p><ol><li><p>b</p></li></ol></li></ul></blockquote>'
        + '<ol><li><p>c</p></li></ol>',
    );
  });

  it('carries the indented lines along when the item above them is the one picked', () => {
    // `b` and `c` are indented under `a`, so they go where `a` goes — the same
    // way Tab and Shift-Tab move an item with everything nested below it. Only
    // `z`, an item of its own, stays behind.
    const editor = openBody(BURIED);
    selectBlock(editor, 'a');
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<ul><li><p>a</p><ol><li><p>b</p></li><li><p>c</p></li></ol></li></ul>'
        + '<blockquote><ul><li><p>z</p></li></ul></blockquote>',
    );
  });

  it('still frees a line the split can isolate', () => {
    // The same press one level up: `c` sits directly in the quoted list, so
    // splitting that list either side of it leaves a list holding only `c`.
    const editor = openBody(
      '<blockquote><ol><li><p>b</p></li><li><p>c</p></li><li><p>e</p></li></ol></blockquote>',
    );
    selectBlock(editor, 'c');
    expect(canRunBlockType(editor, 'quote')).toBe(true);
    runBlockType(editor, 'quote');
    expect(editor.getHTML()).toBe(
      '<blockquote><ol><li><p>b</p></li></ol></blockquote>'
        + '<ol><li><p>c</p></li></ol>'
        + '<blockquote><ol><li><p>e</p></li></ol></blockquote>',
    );
  });
});
