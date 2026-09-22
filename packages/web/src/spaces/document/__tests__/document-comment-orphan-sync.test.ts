// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The library's orphan sync stays off the reader's undo stack (#18, A16).
 *
 * When a thread is resolved, deleted, or gone, the library walks the body and
 * rewrites every mark carrying that thread id so its `orphan` attribute
 * matches — `updateMarksFromThreads`, called from the thread store's
 * subscription. It goes through `editor.transact` and sets NO meta at all
 * (measured: `comments/extension.ts:130-173` has no `setMeta`), which means it
 * satisfies all three conditions this Space uses for "the reader's own edit":
 * the doc changed, nothing appended it, and it is not the sync binding.
 *
 * So without a fourth condition it lands on the undo stack, and a reader who
 * presses Cmd+Z right after a PEER resolved a thread undoes that peer's
 * highlight change instead of their own last edit. §5.1.1 is explicit that
 * machine-derived decorative syncs do not go on the stack.
 *
 * The predicate reads the transaction's steps rather than guessing from
 * content: every step adds or removes a mark, and the mark is a comment.
 *
 * That alone is not enough, and the case that shows why is a reader opening a
 * comment: putting the mark on the selected words is ALSO nothing but a
 * comment mark step, and it is the reader's own edit — Cmd+Z has to take it
 * back. So the predicate needs a second half, and it has to be one neither
 * side can get wrong: our own writes carry `DOCUMENT_COMMENT_WRITE`, the
 * library's sync carries no meta at all. Absence of that meta is what says
 * "the library did this".
 *
 * TDD: red because neither export exists yet.
 */

import { Mark, Slice } from '@tiptap/pm/model';
import { AddMarkStep, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  DOCUMENT_COMMENT_WRITE,
  isCommentOrphanSync,
} from '@web/spaces/document/document-comment-orphan-sync';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor holding one paragraph of words.
 * @returns The editor, mounted.
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
  ] as never);
  return editor;
}

/**
 * Where the first run of text sits.
 * @param editor - The editor.
 * @returns That run's range.
 */
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

/** A comment mark, orphaned or not. */
function commentMark(editor: Editor, orphan: boolean): Mark {
  return editor.prosemirrorState.schema.marks.comment.create({
    threadId: 't1',
    orphan,
  });
}

describe('isCommentOrphanSync', () => {
  it('recognises the rewrite the library makes when a thread is resolved', () => {
    // The shape of `updateMarksFromThreads`: remove the mark, add it back with
    // the other `orphan`, both over the same run.
    const editor = open();
    const { from, to } = firstRun(editor);
    const tr = editor.prosemirrorState.tr
      .removeMark(from, to, commentMark(editor, false))
      .addMark(from, to, commentMark(editor, true));

    expect(isCommentOrphanSync(tr)).toBe(true);
  });

  it('does not recognise a reader typing', () => {
    const editor = open();
    const { from } = firstRun(editor);
    expect(
      isCommentOrphanSync(editor.prosemirrorState.tr.insertText('more', from)),
    ).toBe(false);
  });

  it('does not recognise a reader making text bold', () => {
    const editor = open();
    const { from, to } = firstRun(editor);
    const bold = editor.prosemirrorState.schema.marks.bold.create(null);
    expect(
      isCommentOrphanSync(editor.prosemirrorState.tr.addMark(from, to, bold)),
    ).toBe(false);
  });

  it('does not recognise a reader opening a comment of their own', () => {
    // Identical in shape to the sync — nothing but a comment mark step — and
    // it is the reader's edit, so Cmd+Z has to take it back. Our own meta is
    // the only thing that separates them.
    const editor = open();
    const { from, to } = firstRun(editor);
    const tr = editor.prosemirrorState.tr
      .addMark(from, to, commentMark(editor, false))
      .setMeta(DOCUMENT_COMMENT_WRITE, true);

    expect(isCommentOrphanSync(tr)).toBe(false);
  });

  it('recognises the sync even though it has the same step shape', () => {
    // The same two steps without our meta: this is the library's, and the
    // pair above is the reader's. Nothing but the meta tells them apart.
    const editor = open();
    const { from, to } = firstRun(editor);
    const asOurs = editor.prosemirrorState.tr
      .addMark(from, to, commentMark(editor, true))
      .setMeta(DOCUMENT_COMMENT_WRITE, true);
    const asTheirs = editor.prosemirrorState.tr.addMark(
      from,
      to,
      commentMark(editor, true),
    );

    expect(isCommentOrphanSync(asOurs)).toBe(false);
    expect(isCommentOrphanSync(asTheirs)).toBe(true);
  });

  it('does not recognise a transaction that also changes text', () => {
    // A transaction is not the sync if it does anything besides rewriting the
    // marks, whatever else it also does.
    const editor = open();
    const { from, to } = firstRun(editor);
    const tr = editor.prosemirrorState.tr
      .removeMark(from, to, commentMark(editor, false))
      .addMark(from, to, commentMark(editor, true));
    tr.step(new ReplaceStep(from, from, Slice.empty));

    expect(isCommentOrphanSync(tr)).toBe(false);
  });

  it('does not recognise an empty transaction', () => {
    // No steps means nothing happened, and "every step is a comment mark
    // step" is vacuously true of an empty list — which would read a plain
    // selection change as the sync.
    const editor = open();
    expect(isCommentOrphanSync(editor.prosemirrorState.tr)).toBe(false);
  });

  it('reads the steps, not the marks left on the document', () => {
    const editor = open();
    const { from, to } = firstRun(editor);
    const tr = editor.prosemirrorState.tr
      .removeMark(from, to, commentMark(editor, false))
      .addMark(from, to, commentMark(editor, true));

    expect(tr.steps.every((step) => step instanceof AddMarkStep || step instanceof RemoveMarkStep)).toBe(
      true,
    );
    expect(isCommentOrphanSync(tr)).toBe(true);
  });
});
