// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A10: Enter on a selection that spans blocks does not raise.
 *
 * The selection a writer makes by dragging is not confined to one block, and
 * every one of those shapes reaches the same split. This file walks the shapes
 * and says what each leaves behind.
 *
 * Two of them are answered by `document-enter.ts` rather than by BlockNote,
 * because BlockNote's own handlers raise on them:
 *
 * - A whole-document selection reaches `splitBlock.ts:55`, which hands the
 *   selection straight to `tr.split`; a selection resolved outside every block
 *   makes `prosemirror-transform` read `copy` off an undefined parent.
 * - A node selection reaches `NodeSelectionKeyboard.ts:48`, which inserts a
 *   bare `paragraph` (not the `blockContainer` a `blockGroup` accepts) at
 *   `$to.after() + 1` — one past the end of a document whose only block is
 *   selected.
 *
 * Both are shapes a reader reaches with the mouse: `Cmd`-A, and the platform's
 * select-node modifier over a block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

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

/**
 * Presses Enter through the keymap, the way a keyboard reaches it.
 * @param editor - The editor to press Enter in.
 * @returns Whether a handler claimed the key.
 */
function pressEnter(editor: ReturnType<typeof buildDocumentEditor>): boolean {
  const view = editor.prosemirrorView!;
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  return (
    view.someProp('handleKeyDown', (handler) => handler(view, event)) ?? false
  );
}

/** The type of every top-level block, in order. */
function typesOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  return (editor.document as { type: string }[]).map((block) => block.type);
}

/** The text of every block container, in document order. */
function textsOf(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'blockContainer') {
      out.push(node.textContent);
    }
    return true;
  });
  return out;
}

/**
 * Selects from the start of one text node to the end of another.
 * @param editor - The editor to select in.
 * @param first - Index of the text node the selection opens on.
 * @param last - Index of the text node it closes on.
 */
function selectTexts(
  editor: ReturnType<typeof buildDocumentEditor>,
  first: number,
  last: number,
): void {
  const view = editor.prosemirrorView!;
  const spots: { pos: number; size: number }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isText) spots.push({ pos, size: node.nodeSize });
    return true;
  });
  const a = spots[first]!;
  const b = spots[last]!;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.between(
        view.state.doc.resolve(a.pos),
        view.state.doc.resolve(b.pos + b.size),
      ),
    ),
  );
}

/**
 * Selects one whole block, the way the select-node modifier does.
 * @param editor - The editor to select in.
 * @param index - Which block container, in document order.
 */
function selectBlock(
  editor: ReturnType<typeof buildDocumentEditor>,
  index: number,
): void {
  const view = editor.prosemirrorView!;
  const spots: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') spots.push(pos);
    return true;
  });
  view.dispatch(
    view.state.tr.setSelection(
      NodeSelection.create(view.state.doc, spots[index]!),
    ),
  );
}

describe('Enter on a selection that spans blocks', () => {
  it('empties two list items dragged over whole, leaving the list', () => {
    const editor = open([
      { type: 'paragraph', content: 'x' },
      { type: 'bulletListItem', content: 'aa' },
      { type: 'bulletListItem', content: 'bb' },
      { type: 'paragraph', content: 'y' },
    ]);
    selectTexts(editor, 1, 2);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(typesOf(editor)).toEqual([
      'paragraph',
      'bulletListItem',
      'bulletListItem',
      'paragraph',
    ]);
    expect(textsOf(editor)).toEqual(['x', '', '', 'y']);
  });

  it('does the same for an ordered list', () => {
    const editor = open([
      { type: 'paragraph', content: 'x' },
      { type: 'numberedListItem', content: 'aa' },
      { type: 'numberedListItem', content: 'bb' },
      { type: 'paragraph', content: 'y' },
    ]);
    selectTexts(editor, 1, 2);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(typesOf(editor)).toEqual([
      'paragraph',
      'numberedListItem',
      'numberedListItem',
      'paragraph',
    ]);
    expect(textsOf(editor)).toEqual(['x', '', '', 'y']);
  });

  it('joins what is left when half of each of two items is taken', () => {
    const editor = open([
      { type: 'bulletListItem', content: 'abcd' },
      { type: 'bulletListItem', content: 'efgh' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.between(
          view.state.doc.resolve(5),
          view.state.doc.resolve(11),
        ),
      ),
    );

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(typesOf(editor)).toEqual(['bulletListItem', 'paragraph']);
    expect(textsOf(editor)).toEqual(['ab', 'efgh']);
  });

  it('leaves two empty blocks when a paragraph and a list item are taken', () => {
    const editor = open([
      { type: 'paragraph', content: 'aa' },
      { type: 'bulletListItem', content: 'bb' },
    ]);
    selectTexts(editor, 0, 1);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['', '']);
  });

  it('leaves two empty blocks when a quoted block and a paragraph are taken', () => {
    const editor = open([
      { type: 'paragraph', content: 'aa', props: { quoted: true } },
      { type: 'paragraph', content: 'bb' },
    ]);
    selectTexts(editor, 0, 1);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['', '']);
  });

  it('splits the only block when all of its text is taken', () => {
    const editor = open([{ type: 'paragraph', content: 'aa' }]);
    selectTexts(editor, 0, 0);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['', '']);
  });

  it('opens a block after the one selected whole, with the caret in it', () => {
    const editor = open([
      { type: 'paragraph', content: 'aa' },
      { type: 'paragraph', content: 'bb' },
    ]);
    selectBlock(editor, 0);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['aa', '', 'bb']);
    const { selection } = editor.prosemirrorState;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('');
  });

  it('opens one after the only block, when that is what is selected', () => {
    const editor = open([{ type: 'paragraph', content: 'aa' }]);
    selectBlock(editor, 0);

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['aa', '']);
  });

  it('opens a block at the end when the whole document is selected', () => {
    const editor = open([
      { type: 'paragraph', content: 'aa' },
      { type: 'paragraph', content: 'bb' },
    ]);
    const view = editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(new AllSelection(view.state.doc)),
    );

    expect(() => {
      pressEnter(editor);
    }).not.toThrow();
    expect(textsOf(editor)).toEqual(['aa', 'bb', '']);
  });
});
