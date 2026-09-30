// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which ranges can carry a comment (#18, A2 · A3).
 *
 * Two entries ask this, and they ask it of the same range type. The bubble
 * bar acts on what the reader selected; the block handle acts on the row the
 * pointer is over, which `selectionOverBlockContent` turns into a selection
 * over that row's own content without dispatching it. So one predicate
 * answers both, and a row's answer cannot drift from a selection's.
 *
 * The rule is R7's, already delivered for the colour panel: an empty block
 * covers no run, so the entry is unavailable rather than present and inert
 * (`document-colour-run.ts`, `colourFaceOver`).
 *
 * A code block is NOT an exception, which is worth pinning because the
 * formatting marks are refused there. Measured on this build's schema: every
 * content node allows the comment mark, and `codeBlock`'s mark set is exactly
 * `[comment]` — the library puts the mark in a non-formatting group for this
 * reason. Code can be discussed; it just cannot be styled.
 *
 * TDD: red because `canCommentOver` does not exist yet.
 */

import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { canCommentOver } from '@web/spaces/document/document-comment-target';
import { selectionOverBlockContent } from '@web/spaces/document/document-hovered-block';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/** A block as `editor.document` hands it back. */
interface Seen {
  readonly id: string;
}

/**
 * Opens an editor holding one row of each shape this pins.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'words to discuss' },
    { type: 'paragraph', content: '' },
    { type: 'heading', props: { level: 1 }, content: '' },
    { type: 'codeBlock', content: 'const answer = 42;' },
    { type: 'bulletListItem', content: '' },
  ] as never);
  return editor;
}

/**
 * The selection standing for one row, the way the handle's menu builds it.
 * @param editor - The editor.
 * @param index - Which row.
 * @returns That row's range.
 */
function over(editor: Editor, index: number): TextSelection {
  const { doc } = editor.prosemirrorState;
  const id = (editor.document as unknown as Seen[])[index]!.id;
  return selectionOverBlockContent(doc, id) as TextSelection;
}

/**
 * Whether the row at one index can be commented on.
 * @param editor - The editor.
 * @param index - Which row.
 * @returns The predicate's answer for that row.
 */
function answerFor(editor: Editor, index: number): boolean {
  return canCommentOver(editor.prosemirrorState.doc, over(editor, index));
}

describe('canCommentOver', () => {
  it('is yes for a row with words in it', () => {
    expect(answerFor(open(), 0)).toBe(true);
  });

  it('is no for an empty paragraph', () => {
    expect(answerFor(open(), 1)).toBe(false);
  });

  it('is no for an empty heading, the same as for a paragraph', () => {
    // The rule is about the words, not about the kind of row.
    expect(answerFor(open(), 2)).toBe(false);
  });

  it('is no for an empty list item', () => {
    expect(answerFor(open(), 4)).toBe(false);
  });

  it('is yes for a code block, where formatting is refused but this is not', () => {
    expect(answerFor(open(), 3)).toBe(true);
  });

  it('is yes for a selection spanning an empty row and a filled one', () => {
    // Reaching any words at all is enough: the mark lands on those.
    const editor = open();
    const { doc } = editor.prosemirrorState;
    const empty = over(editor, 1);
    const filled = over(editor, 3);

    expect(
      canCommentOver(doc, TextSelection.create(doc, empty.from, filled.to)),
    ).toBe(true);
  });

  it('is no for a row holding only a line break', () => {
    // The range is a character wide and holds no text, which is why the
    // question goes to the schema rather than to `to > from`. A reader makes
    // this row by pressing Shift+Enter on an empty one; the same shape is
    // what a table or an image will be once those arrive (#15 · #16 · #17).
    const editor = open();
    const view = editor.prosemirrorView!;
    const row = over(editor, 1);
    view.dispatch(
      view.state.tr.insert(
        row.from,
        view.state.schema.nodes.hardBreak.create(),
      ),
    );

    const { doc } = view.state;
    const widened = over(editor, 1);
    expect(widened.to).toBeGreaterThan(widened.from);
    expect(doc.textBetween(widened.from, widened.to)).toBe('');
    expect(canCommentOver(doc, widened)).toBe(false);
  });

  it('is no for a collapsed caret, which covers no words', () => {
    const editor = open();
    const { doc } = editor.prosemirrorState;
    const row = over(editor, 0);

    expect(canCommentOver(doc, TextSelection.create(doc, row.from))).toBe(false);
  });
});
