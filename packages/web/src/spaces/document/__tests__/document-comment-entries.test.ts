// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two entries that open a comment (#18, A1 · A2 · A3).
 *
 * They differ in one thing: where the range comes from. The bubble bar acts on
 * what the reader selected; the block handle stands its row in for a range
 * over that row's own content. From the moment the draft opens they are the
 * same operation, which is what A2 asks for — commenting on a whole block
 * reads as selecting its text by hand and commenting.
 *
 * `canRun` is `canCommentOver`, so an entry over text-less words is
 * unavailable rather than present and inert (A3, R7). The role does not come
 * into it here: both carriers render nothing at all for a viewer
 * (`DocumentEditor.tsx`, `!readOnly &&` on the block strip and the bubble
 * bar), so a viewer never reaches either entry.
 *
 * `isActive` is always false. The entry opens a box; it is not a state the
 * selection can be in, and showing it pressed over already-commented words
 * would say pressing it again does something other than start a new comment.
 *
 * TDD: red because neither export exists yet.
 */

import { TextSelection } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentCommentDraftRange, draftRangeIn } from '@web/spaces/document/document-comment-draft-range';
import {
  commentTool,
  openCommentDraft,
} from '@web/spaces/document/document-comment-entries';
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
 * Opens an editor with the draft plugin on, holding words and an empty row.
 * @returns The editor, mounted.
 */
function open(): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    extensions: [documentCommentDraftRange()],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
    { type: 'paragraph', content: '' },
  ] as never);
  return editor;
}

/** Where the first run of text sits. */
function firstRun(editor: Editor): { from: number; to: number } {
  let at: { from: number; to: number } | undefined;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.isText && at === undefined) {
      at = { from: pos, to: pos + node.nodeSize };
    }
    return true;
  });
  return at!;
}

/**
 * Puts the reader's selection over the range given.
 * @param editor - The editor.
 * @param range - What to select.
 */
function select(editor: Editor, range: { from: number; to: number }): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, range.from, range.to),
    ),
  );
}

/**
 * The range standing for one row, the way the block menu builds it.
 * @param editor - The editor.
 * @param index - Which row.
 * @returns That row's range.
 */
function overRow(editor: Editor, index: number): { from: number; to: number } {
  const id = (editor.document as unknown as Seen[])[index]!.id;
  return selectionOverBlockContent(editor.prosemirrorState.doc, id);
}

describe('the bubble bar entry', () => {
  it('is available over selected words', () => {
    const editor = open();
    select(editor, { from: firstRun(editor).from, to: firstRun(editor).from + 5 });

    expect(commentTool.canRun(editor)).toBe(true);
  });

  it('is unavailable with nothing selected', () => {
    const editor = open();
    select(editor, { from: firstRun(editor).from, to: firstRun(editor).from });

    expect(commentTool.canRun(editor)).toBe(false);
  });

  it('is never shown as pressed', () => {
    const editor = open();
    const run = firstRun(editor);
    select(editor, { from: run.from, to: run.from + 5 });

    expect(commentTool.isActive(editor)).toBe(false);
  });

  it('opens the draft on exactly what the reader selected', () => {
    const editor = open();
    const run = firstRun(editor);
    const chosen = { from: run.from + 6, to: run.from + 11 };
    select(editor, chosen);

    commentTool.run(editor);

    expect(draftRangeIn(editor.prosemirrorState)).toEqual(chosen);
  });
});

describe('openCommentDraft', () => {
  it('opens the draft on a range handed in, the way the block menu does', () => {
    // A2: the whole row's own content, which the handle's menu computes
    // without dispatching a selection of its own.
    const editor = open();
    const row = overRow(editor, 0);

    expect(openCommentDraft(editor, row)).toBe(true);
    expect(draftRangeIn(editor.prosemirrorState)).toEqual({
      from: row.from,
      to: row.to,
    });
  });

  it('leaves the reader’s own selection and caret alone', () => {
    // The handle is on screen only while the reader holds no selection, and
    // their caret is elsewhere. Opening a comment on a row must not move it.
    const editor = open();
    const run = firstRun(editor);
    select(editor, { from: run.to - 1, to: run.to - 1 });
    const before = editor.prosemirrorState.selection;

    openCommentDraft(editor, overRow(editor, 0));

    const after = editor.prosemirrorState.selection;
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to);
  });

  it('refuses a row with no words in it', () => {
    // A3: the empty row's range covers no run, so there is nothing to mark.
    const editor = open();

    expect(openCommentDraft(editor, overRow(editor, 1))).toBe(false);
    expect(draftRangeIn(editor.prosemirrorState)).toBeNull();
  });

  it('replaces the range when a second entry is pressed', () => {
    const editor = open();
    const run = firstRun(editor);
    const first = { from: run.from, to: run.from + 5 };
    const second = { from: run.from + 6, to: run.from + 11 };

    openCommentDraft(editor, first);
    openCommentDraft(editor, second);

    expect(draftRangeIn(editor.prosemirrorState)).toEqual(second);
  });
});
