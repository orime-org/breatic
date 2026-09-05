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
import { TextSelection } from '@tiptap/pm/state';

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
  return editor.document;
}

/**
 * Presses Enter through the keymap.
 * @param editor - The editor to press Enter in.
 * @returns Whether a handler claimed it.
 */
function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): boolean {
  const view = editor.prosemirrorView;
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
  editor.setTextCursorPosition(blocksOf(editor)[index].id, 'end');
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

  it('opens an unticked to-do after a ticked one', () => {
    // The line the writer opens next is their next task, not a copy of the one
    // they just finished. tiptap marks `checked` `keepOnSplit: false` and
    // Lexical clears it in `resetOnCopyNodeFrom`, both singling this prop out
    // from the ones a split carries along.
    const editor = open([
      { type: 'checkListItem', props: { checked: true }, content: 'done' },
    ]);
    editor.setTextCursorPosition(blocksOf(editor)[0].id, 'end');
    pressEnter(editor);

    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.props['checked'], 'the finished task').toBe(true);
    expect(blocks[1]?.props['checked'], 'the line opened after it').toBe(false);
  });

  it('leaves the text with what described it, whatever path Enter takes', () => {
    // Enter at the very start opens a line ABOVE: `tr.split` puts the text in
    // the block below, so that block is the writer's own line and arrives as
    // the line they had. A heading outside a quote — the one shape none of
    // these handlers claim — is the measure: it comes through with its number.
    // Measured before this, the three shapes these handlers do claim each
    // dropped something the reader had set: the tick, the pinned number, the
    // list's own start.
    const CASES = [
      { type: 'checkListItem', props: { checked: true }, prop: 'checked', want: true },
      { type: 'checkListItem', props: { checked: true, quoted: true }, prop: 'checked', want: true },
      { type: 'heading', props: { level: 2, numbered: true, number: 7, quoted: true }, prop: 'number', want: 7 },
      { type: 'numberedListItem', props: { start: 5 }, prop: 'start', want: 5 },
    ] as const;

    for (const { type, props, prop, want } of CASES) {
      const editor = open([{ type, props, content: 'text' }]);
      editor.setTextCursorPosition(blocksOf(editor)[0].id, 'start');
      pressEnter(editor);

      const blocks = blocksOf(editor);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]?.props[prop], `${type}: the block holding the text`).toBe(
        want,
      );
    }
  });

  it('answers a selection the same way whichever end it was drawn from', () => {
    // `Selection.anchor` is the end the drag started at, so it swaps with the
    // direction; the cut is at `from`, which does not. Both ends sit in one
    // block here, so what this pins is the cut itself: the highlight opens at
    // offset 0, so the text goes to the new block and that block arrives as
    // the line the reader had. Measured while the split asked the anchor, a
    // ticked task came back unticked when drawn right to left.
    const CASES = [
      { type: 'checkListItem', props: { checked: true }, prop: 'checked', want: true },
      { type: 'numberedListItem', props: { start: 5 }, prop: 'start', want: 5 },
      { type: 'heading', props: { level: 2, quoted: true }, prop: 'level', want: 2 },
    ] as const;

    for (const { type, props, prop, want } of CASES) {
      for (const backwards of [false, true] as const) {
        const editor = open([{ type, props, content: 'abcd' }]);
        const view = editor.prosemirrorView;
        let start = 0;
        view.state.doc.descendants((node, pos) => {
          if (node.isTextblock && start === 0) start = pos + 1;
          return true;
        });
        const stop = start + 2;
        editor.transact((tr) => {
          tr.setSelection(
            TextSelection.create(
              tr.doc,
              backwards ? stop : start,
              backwards ? start : stop,
            ),
          );
        });
        pressEnter(editor);

        const drawn = backwards ? 'right to left' : 'left to right';
        const blocks = blocksOf(editor);
        expect(blocks, `${type}: ${drawn}`).toHaveLength(2);
        expect(blocks[1]?.type, `${type}: ${drawn}`).toBe(type);
        expect(blocks[1]?.props[prop], `${type}: ${drawn}`).toBe(want);
      }
    }
  });

  it('answers a selection running past its first block the same way too', () => {
    // Which BLOCK a handler is answering for is read off the selection as
    // well, and reading it there reads the anchor: drawn right to left over
    // two blocks, the ticked task and the unordered item both had their key
    // declined and came back split into a plain paragraph, out of the list,
    // and a quoted line came back out of the quote.
    const CASES = [
      { type: 'checkListItem', props: { checked: true } },
      { type: 'bulletListItem', props: {} },
      { type: 'paragraph', props: { quoted: true } },
    ] as const;

    for (const { type, props } of CASES) {
      for (const backwards of [false, true] as const) {
        const editor = open([
          { type, props, content: 'abcd' },
          { type: 'paragraph', content: 'efgh' },
        ]);
        const view = editor.prosemirrorView;
        const spots: number[] = [];
        view.state.doc.descendants((node, pos) => {
          if (node.isTextblock) spots.push(pos + 1);
          return true;
        });
        const start = spots[0] + 2;
        const stop = spots[1] + 2;
        editor.transact((tr) => {
          tr.setSelection(
            TextSelection.create(
              tr.doc,
              backwards ? stop : start,
              backwards ? start : stop,
            ),
          );
        });
        pressEnter(editor);

        const drawn = backwards ? 'right to left' : 'left to right';
        const blocks = blocksOf(editor);
        expect(blocks, `${type}: ${drawn}`).toHaveLength(2);
        expect(blocks[1]?.type, `${type}: ${drawn}`).toBe(type);
        expect(blocks[1]?.props['quoted'], `${type}: ${drawn}`).toBe(
          props['quoted' as keyof typeof props] === true,
        );
      }
    }
  });

  it('keeps a heading whole when Enter opens a line above it', () => {
    // Enter at the very start pushes the heading down and leaves an empty one
    // above, so the block carrying the text is the NEW one — and it has to
    // arrive as the heading the writer had. Measured before this: a level 2
    // quoted heading came back level 1 and stopped being numbered, while the
    // same heading outside a quote kept both.
    const editor = open([
      {
        type: 'heading',
        props: { level: 2, quoted: true, numbered: true },
        content: 'title',
      },
    ]);
    editor.setTextCursorPosition(blocksOf(editor)[0].id, 'start');
    pressEnter(editor);

    const blocks = blocksOf(editor);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]?.type).toBe('heading');
    expect(blocks[1]?.props['level']).toBe(2);
    expect(blocks[1]?.props['numbered']).toBe(true);
    expect(blocks[1]?.props['quoted']).toBe(true);
  });
});

describe('C11 — Enter over a selection spanning two list items', () => {
  it('does not throw, and leaves the document whole', () => {
    const editor = open([
      { type: 'numberedListItem', content: 'first' },
      { type: 'numberedListItem', content: 'second' },
    ]);
    const view = editor.prosemirrorView;
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

describe('Enter over a selection that opens in an empty quoted block', () => {
  // Emptiness and the caret's offset are read off the block the selection
  // OPENS in, and both stay true once it runs past that block. The branch
  // that answers an empty quoted line then opens another one without
  // replacing anything, and what the reader had highlighted stays where it
  // was — the same shape the list's Enter had.
  it('replaces what is selected', () => {
    const editor = open([
      { type: 'paragraph', content: '', props: { quoted: true } },
      { type: 'paragraph', content: 'keep me', props: { quoted: true } },
    ]);
    const view = editor.prosemirrorView;
    let from = -1;
    let to = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.childCount === 0) from = pos + 1;
      if (node.textContent === 'keep me') to = pos + 5;
      return true;
    });
    editor.transact((tr) => {
      tr.setSelection(
        (view.state.selection.constructor as never as {
          create: (doc: unknown, a: number, b: number) => never;
        }).create(tr.doc, from, to),
      );
    });

    expect(() => pressEnter(editor)).not.toThrow();
    expect(editor.prosemirrorState.doc.textContent).not.toContain('keep');
  });
});
