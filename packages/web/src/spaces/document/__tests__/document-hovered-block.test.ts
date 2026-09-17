// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { rowShowsSomething } from '@web/spaces/document/document-hovered-block';

/**
 * A block shaped the way BlockNote hands one to the side menu: its own inline
 * content in `content`, nested blocks in `children`.
 * @param over - What to set on this block.
 * @returns The block.
 */
function block(over: {
  type?: string;
  content?: unknown[];
  children?: unknown[];
}): Parameters<typeof rowShowsSomething>[0] {
  return {
    type: over.type ?? 'paragraph',
    content: over.content ?? [],
    children: over.children ?? [],
  } as Parameters<typeof rowShowsSomething>[0];
}

describe('what the reader sees on the hovered row', () => {
  it('an empty paragraph shows nothing', () => {
    expect(rowShowsSomething(block({}))).toBe(false);
  });

  it('a paragraph with text shows something', () => {
    expect(rowShowsSomething(block({ content: [{ type: 'text' }] }))).toBe(true);
  });

  // `content` holds the block's own inline content only, so a list item whose
  // text was deleted still draws a bullet with its nested items under it
  // (`BlockContainer.ts:27` is `blockContent blockGroup?`).
  it('a list item with no text of its own but nested items shows something', () => {
    expect(
      rowShowsSomething(
        block({ type: 'bulletListItem', children: [block({})] }),
      ),
    ).toBe(true);
  });

  // An empty code block is a grey frame on screen, and the reader has to be
  // able to grab it.
  it('an empty code block shows something', () => {
    expect(rowShowsSomething(block({ type: 'codeBlock' }))).toBe(true);
  });

  it('a heading with no text shows nothing', () => {
    expect(rowShowsSomething(block({ type: 'heading' }))).toBe(false);
  });
});
