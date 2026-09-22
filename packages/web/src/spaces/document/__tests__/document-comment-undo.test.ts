// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cmd+Z takes back the reader's own edit, not a peer's resolve (#18, A16).
 *
 * The library keeps every comment mark's `orphan` attribute in step with its
 * thread, and it does that from the thread store's subscription — so a PEER
 * resolving a thread produces a local transaction here, through
 * `editor.transact` with no meta at all. That satisfies every condition this
 * Space uses for "the reader's own edit", so without the fourth condition
 * (design §9.3) it becomes the top of the undo stack, and the reader's next
 * Cmd+Z takes back a highlight change they did not make while their own last
 * edit stays put.
 *
 * What these pin is the outcome rather than the marker: press undo and see
 * which change came back.
 *
 * TDD: red because the undo plugin does not know about the sync yet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import {
  documentBodyFragment,
  documentCommentThreads,
  encodeInitialSpaceContent,
} from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { DOCUMENT_COMMENT_DRAFT_RANGE } from '@web/spaces/document/document-comment-draft-range';
import { DOCUMENT_COMMENT_WRITE } from '@web/spaces/document/document-comment-orphan-sync';
import { postComment } from '@web/spaces/document/document-comment-post';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor over one paragraph, with undo tracking on.
 * @returns The editor and its undo manager.
 */
function open(): { editor: Editor; manager: Y.UndoManager } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'words to discuss' },
  ] as never);
  // Y.UndoManager groups by a capture timeout a test outruns, so each step
  // has to be closed explicitly or they merge into one.
  manager.stopCapturing();
  return { editor, manager };
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

/** How many comment marks the body carries, and what they say. */
function commentMarks(editor: Editor): { threadId: string; orphan: boolean }[] {
  const found: { threadId: string; orphan: boolean }[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        found.push({
          threadId: mark.attrs.threadId as string,
          orphan: mark.attrs.orphan === true,
        });
      }
    }
    return true;
  });
  return found;
}

/**
 * Puts a comment on the first run, the way this Space does.
 * @param editor - The editor.
 */
function readerOpensAComment(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const { from, to } = firstRun(editor);
  const mark = view.state.schema.marks.comment.create({
    threadId: 't1',
    orphan: false,
  });
  view.dispatch(
    view.state.tr.addMark(from, to, mark).setMeta(DOCUMENT_COMMENT_WRITE, true),
  );
}

/**
 * Rewrites the orphan flag the way the library's subscription does — same
 * steps, no meta.
 * @param editor - The editor.
 */
function libraryMarksItOrphaned(editor: Editor): void {
  const view = editor.prosemirrorView!;
  const { from, to } = firstRun(editor);
  const marks = view.state.schema.marks.comment;
  view.dispatch(
    view.state.tr
      .removeMark(from, to, marks.create({ threadId: 't1', orphan: false }))
      .addMark(from, to, marks.create({ threadId: 't1', orphan: true })),
  );
}

/**
 * Opens an editor with undo tracking AND comments on.
 * @returns The editor, its undo manager, and the document behind both.
 */
function openWithComments(): {
  editor: Editor;
  manager: Y.UndoManager;
  doc: Y.Doc;
  } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { manager, extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'words to discuss' },
  ] as never);
  manager.stopCapturing();
  return { editor, manager, doc };
}

/**
 * Posts a comment over the first run, down the path the composer takes.
 * @param editor - The editor.
 */
async function postAComment(editor: Editor): Promise<void> {
  const view = editor.prosemirrorView!;
  const { from, to } = firstRun(editor);
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, { from, to }),
  );
  await postComment(editor, 'have a look');
}

/** How many threads the document holds. */
function threadCount(doc: Y.Doc): number {
  return documentCommentThreads(doc).size;
}

/**
 * Writes a thread the way another client's does — an origin ours never
 * tracks.
 * @param doc - The document.
 */
function peerPostsAThread(doc: Y.Doc): void {
  const threads = documentCommentThreads(doc);
  doc.transact(() => {
    const thread = new Y.Map<unknown>();
    thread.set('id', 'peer-thread');
    thread.set('type', 'thread');
    thread.set('comments', new Y.Array());
    threads.set('peer-thread', thread);
  }, 'a peer');
}

describe('undo after the library syncs an orphan flag', () => {
  it('takes back the comment the reader opened, not the flag rewrite', () => {
    const { editor, manager } = open();

    readerOpensAComment(editor);
    manager.stopCapturing();
    expect(commentMarks(editor)).toEqual([{ threadId: 't1', orphan: false }]);

    libraryMarksItOrphaned(editor);
    expect(commentMarks(editor)).toEqual([{ threadId: 't1', orphan: true }]);

    editor.undo();

    // The reader's own last edit was opening the comment, so that is what
    // comes back. Had the sync been captured, the mark would still be here
    // with `orphan: false` — the flag rewrite undone instead.
    expect(commentMarks(editor)).toEqual([]);
  });

  it('still takes back a comment the reader opens after a sync', () => {
    // The fourth condition sets the marker false, and this is what says the
    // reader's next edit puts it back to true rather than being swallowed.
    const { editor, manager } = open();

    readerOpensAComment(editor);
    manager.stopCapturing();
    libraryMarksItOrphaned(editor);
    manager.stopCapturing();

    const view = editor.prosemirrorView!;
    const { from } = firstRun(editor);
    view.dispatch(view.state.tr.insertText('!', from));
    manager.stopCapturing();
    expect(editor.prosemirrorState.doc.textContent).toContain('!');

    editor.undo();
    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');
  });

  it('leaves the reader their own text edit to undo as well', () => {
    const { editor, manager } = open();

    libraryMarksItOrphaned(editor);
    manager.stopCapturing();

    editor.undo();

    // Nothing of the reader's was on the stack above the initial content, so
    // undo reaches back to before the paragraph was written rather than
    // taking back the sync.
    expect(editor.prosemirrorState.doc.textContent).not.toContain(
      'words to discuss',
    );
  });
});

describe('undo right after posting a comment', () => {
  it('takes the whole comment back, thread and highlight together', async () => {
    // Posting is two writes — the thread into its map, the mark onto the
    // words — and a reader who presses Cmd+Z is taking back the one thing
    // they did. Leaving the thread behind makes the panel say the text was
    // deleted, which is untrue, and keeps the unresolved dot lit forever.
    //
    // Every editor that models comments as marks puts them in undo's reach
    // for this reason; it is why Remirror and Collaborne both moved
    // highlights out of a side table and into the document.
    const { editor, manager, doc } = openWithComments();

    await postAComment(editor);
    expect(commentMarks(editor)).toHaveLength(1);
    expect(threadCount(doc)).toBe(1);

    manager.undo();

    expect(commentMarks(editor)).toHaveLength(0);
    expect(threadCount(doc)).toBe(0);
  });

  it('brings it back on redo', async () => {
    const { editor, manager, doc } = openWithComments();
    await postAComment(editor);

    manager.undo();
    manager.redo();

    expect(commentMarks(editor)).toHaveLength(1);
    expect(threadCount(doc)).toBe(1);
  });

  it('leaves a thread a peer wrote where it is', async () => {
    // Undo is per-reader: `trackedOrigins` decides what this manager owns,
    // and a peer's write carries an origin it does not track.
    const { editor, manager, doc } = openWithComments();
    await postAComment(editor);
    peerPostsAThread(doc);
    expect(threadCount(doc)).toBe(2);

    manager.undo();

    expect(threadCount(doc)).toBe(1);
  });
});
