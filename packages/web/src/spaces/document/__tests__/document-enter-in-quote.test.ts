// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A7b · C11: pressing Enter inside a quote leaves you inside it.
 *
 * A quote is a prop on the block here, not a container around it, so a block
 * split off from a quoted one keeps its quote only if someone puts it there.
 * `splitBlockTr` hands the new block `attrs: {}` unless asked otherwise, and
 * BlockNote's general Enter asks for props only when the caret is mid-block —
 * so ending a quoted line and pressing Enter drops you out of the quote.
 *
 * There are three ways to reach a split, and each is reached by a different
 * handler: the general Enter for prose, and one list handler each for the
 * ordered and unordered kinds.
 *
 * C11 lives here too because it is the same code path from the other side:
 * BlockNote's general Enter reads the position BEFORE `deleteSelection()` and
 * calls `tr.split` with no `canSplit` guard, which is the exact shape the
 * retired `document-split-block.ts` existed to work around.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/**
 * Opens an editor holding the given blocks.
 * @param blocks - What to put in the document.
 * @returns The editor.
 */
function open(
  blocks: readonly Readonly<Record<string, unknown>>[],
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/** The document as plain records. */
function blocksOf(editor: ReturnType<typeof buildDocumentEditor>): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

/**
 * Presses Enter through the keymap.
 * @param editor - The editor to press Enter in.
 * @returns Whether a handler claimed it.
 */
function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/**
 * Puts the caret at the end of one block.
 * @param editor - The editor to move the caret in.
 * @param index - Which top-level block.
 */
function caretToEndOf(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
): void {
  editor.setTextCursorPosition(blocksOf(editor)[index]!.id, 'end');
}

const KINDS = [
  { type: 'paragraph', label: 'prose' },
  { type: 'bulletListItem', label: 'an unordered item' },
  { type: 'numberedListItem', label: 'an ordered item' },
  { type: 'checkListItem', label: 'a to-do item' },
] as const;

describe('Enter at the end of a quoted line', () => {
  KINDS.forEach(({ type, label }) => {
    it(`keeps the block it splits off inside the quote — ${label}`, () => {
      const editor = open([{ type, props: { quoted: true }, content: 'one' }]);
      caretToEndOf(editor, 0);
      pressEnter(editor);

      const blocks = blocksOf(editor);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.props['quoted']).toBe(true);
      expect(blocks[1]?.props['quoted']).toBe(true);
    });
  });

  it('leaves an unquoted line unquoted', () => {
    const editor = open([{ type: 'paragraph', content: 'one' }]);
    caretToEndOf(editor, 0);
    pressEnter(editor);

    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.props['quoted']).toBe(false);
  });

  it('does not carry a heading’s level into the block after it', () => {
    // Enter at the end of a heading opens a paragraph, which is what the
    // built-in handler does and what a writer expects. Carrying the quote
    // across must not turn into carrying everything across.
    const editor = open([
      { type: 'heading', props: { level: 2, quoted: true }, content: 'title' },
    ]);
    caretToEndOf(editor, 0);
    pressEnter(editor);

    const blocks = blocksOf(editor);
    expect(blocks[1]?.type).toBe('paragraph');
    expect(blocks[1]?.props['quoted']).toBe(true);
  });
});

describe('C11 — Enter over a selection spanning two list items', () => {
  it('does not throw, and leaves the document whole', () => {
    const editor = open([
      { type: 'numberedListItem', content: 'first' },
      { type: 'numberedListItem', content: 'second' },
    ]);
    const view = editor.prosemirrorView!;
    // From inside the first item to inside the second.
    const from = 4;
    const to = view.state.doc.content.size - 4;
    editor.transact((tr) => {
      tr.setSelection(
        (view.state.selection.constructor as never as {
          create: (doc: unknown, a: number, b: number) => never;
        }).create(tr.doc, from, to),
      );
    });

    expect(() => pressEnter(editor)).not.toThrow();
    const blocks = blocksOf(editor);
    expect(blocks.length).toBeGreaterThan(0);
    expect(view.state.doc.check()).toBeUndefined();
  });
});
