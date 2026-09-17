// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { rowPaintsSomething } from '@web/spaces/document/document-hovered-block';

/**
 * A block shaped the way BlockNote hands one to the side menu: its own inline
 * content in `content`, nested blocks in `children`, props on `props`.
 * @param over - What to set on this block.
 * @returns The block.
 */
function block(over: {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown[];
  children?: unknown[];
}): Parameters<typeof rowPaintsSomething>[0] {
  return {
    type: over.type ?? 'paragraph',
    props: over.props ?? {},
    content: over.content ?? [],
    children: over.children ?? [],
  } as Parameters<typeof rowPaintsSomething>[0];
}

describe('what the reader sees on the hovered row', () => {
  it('an empty paragraph shows nothing', () => {
    expect(rowPaintsSomething(block({}))).toBe(false);
  });

  it('a paragraph with text shows something', () => {
    expect(rowPaintsSomething(block({ content: [{ type: 'text' }] }))).toBe(
      true,
    );
  });

  // `content` holds the block's own inline content only, so a list item whose
  // text was deleted still draws a bullet with its nested items under it
  // (`BlockContainer.ts:27` is `blockContent blockGroup?`).
  it('a list item with no text of its own but nested items shows something', () => {
    expect(
      rowPaintsSomething(
        block({ type: 'bulletListItem', children: [block({})] }),
      ),
    ).toBe(true);
  });

  // An empty code block is a grey frame on screen, and the reader has to be
  // able to grab it.
  it('an empty code block shows something', () => {
    expect(rowPaintsSomething(block({ type: 'codeBlock' }))).toBe(true);
  });

  it('a heading with no text shows nothing', () => {
    expect(rowPaintsSomething(block({ type: 'heading' }))).toBe(false);
  });

  // THE ROW THE HANDLE USED TO BE WITHHELD FROM. A bulleted item draws its
  // marker whatever it holds, so the reader sees that row and has to be able
  // to take hold of it — measured 2026-09-17, it offered a plus and no handle.
  it('a bulleted item with nothing in it shows its marker', () => {
    expect(rowPaintsSomething(block({ type: 'bulletListItem' }))).toBe(true);
  });

  it('a numbered item with nothing in it shows its number', () => {
    expect(rowPaintsSomething(block({ type: 'numberedListItem' }))).toBe(true);
  });

  // A quote draws a rule beside the row, and a numbered heading its number,
  // both while the row holds no words — the same call the looks-empty hint
  // makes (`document-placeholders-blocknote`).
  it('an empty quoted paragraph shows its rule', () => {
    expect(rowPaintsSomething(block({ props: { quoted: true } }))).toBe(true);
  });

  it('an empty numbered heading shows its number', () => {
    expect(
      rowPaintsSomething(block({ type: 'heading', props: { numbered: true } })),
    ).toBe(true);
  });

  // A line broken with Shift+Enter shows nothing of itself. Through the block
  // API the break arrives as a text item — measured, a row holding one comes
  // back as `[{ type: 'text', text: '\n' }]` — so counting items alone would
  // call this row visible while the hint calls it empty.
  it('a row holding only a line break shows nothing', () => {
    expect(
      rowPaintsSomething(block({ content: [{ type: 'text', text: '\n' }] })),
    ).toBe(false);
  });

  it('a row holding a break and a word shows the word', () => {
    expect(
      rowPaintsSomething(
        block({ content: [{ type: 'text', text: '\n' }, { type: 'text', text: 'x' }] }),
      ),
    ).toBe(true);
  });
});
