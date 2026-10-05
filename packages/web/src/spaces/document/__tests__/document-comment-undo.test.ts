// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Cmd+Z takes back the reader's own text edit, never a comment (#18, A16).
 *
 * A comment is withdrawn from the card that holds it, so undo is not the way
 * back from one — and the library's `orphan` rewrites are not the reader's
 * doing at all: they run from the thread store's subscription, so a PEER
 * resolving a thread produces a local transaction here. Both are transactions
 * of nothing but comment mark steps, and neither goes on the stack.
 *
 * What these pin is the outcome rather than the marker: press undo and see
 * which change came back.
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
import { postComment } from '@web/spaces/document/document-comment-post';
import { commentsOn } from '@web/spaces/document/document-comment-extension';
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
  view.dispatch(view.state.tr.addMark(from, to, mark));
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
 * @returns The thread's id.
 */
async function postAComment(editor: Editor): Promise<string> {
  const view = editor.prosemirrorView!;
  const { from, to } = firstRun(editor);
  view.dispatch(
    view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, [{ from, to }]),
  );
  const thread = await postComment(editor, 'have a look');
  return thread!.id;
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

describe('undo around comment highlights', () => {
  it('leaves both the reader-made highlight and the flag rewrite alone', () => {
    const { editor, manager } = open();

    readerOpensAComment(editor);
    manager.stopCapturing();
    libraryMarksItOrphaned(editor);
    manager.stopCapturing();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('!', firstRun(editor).to - 1));
    manager.stopCapturing();

    editor.undo();

    // Neither highlight write went on the stack, so the one press reaches
    // past both to the text edit and leaves the mark where it is.
    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');
    expect(commentMarks(editor)).toEqual([{ threadId: 't1', orphan: true }]);
  });

  it('still takes back a text edit the reader makes after a sync', () => {
    // A highlight write leaves the marker false, and this says the reader's
    // next real edit puts it back to true rather than being swallowed.
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

  it('reaches past a sync on its own to the last text edit', () => {
    const { editor, manager } = open();

    libraryMarksItOrphaned(editor);
    manager.stopCapturing();

    editor.undo();

    expect(editor.prosemirrorState.doc.textContent).not.toContain(
      'words to discuss',
    );
  });
});

describe('undo right after posting a comment', () => {
  it('leaves the comment alone, highlight and thread both', async () => {
    // A comment is withdrawn from the card that holds it — Delete, or Resolve
    // to settle it — so Cmd+Z is not the way back from one (user 2026-09-22).
    // Posting is two writes and only one of them was ever reachable by undo,
    // so taking that one back left the highlight gone with the thread still
    // there: the panel then said the text was deleted, which was untrue, and
    // the unresolved dot stayed lit.
    const { editor, manager, doc } = openWithComments();

    await postAComment(editor);
    expect(commentMarks(editor)).toHaveLength(1);
    expect(threadCount(doc)).toBe(1);
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('!', firstRun(editor).to - 1));
    manager.stopCapturing();

    manager.undo();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');
    expect(commentMarks(editor)).toHaveLength(1);
    expect(threadCount(doc)).toBe(1);
  });

  it('reaches past it to the text edit the reader made before', async () => {
    // Undo is not swallowed by a comment sitting on top of the stack: it
    // never went on the stack, so the reader's last real edit is still what
    // comes back.
    const { editor, manager } = openWithComments();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('!', firstRun(editor).to - 1));
    manager.stopCapturing();
    expect(editor.prosemirrorState.doc.textContent).toContain('!');

    await postAComment(editor);
    manager.undo();

    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');
    expect(commentMarks(editor)).toHaveLength(1);
  });

  it('gives the reader their edit back when they redo it', async () => {
    // The marker the manager reads carries across dispatches, so naming a
    // comment write false has to not outlive that write. The undo pressed
    // next puts its content back through the manager itself, and a marker
    // still reading false refuses that transaction a place on the redo
    // stack — leaving the reader's edit gone for good.
    const { editor, manager } = openWithComments();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('!', firstRun(editor).to - 1));
    manager.stopCapturing();

    await postAComment(editor);
    manager.undo();
    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');

    manager.redo();

    expect(editor.prosemirrorState.doc.textContent).toContain('!');
  });

  it('holds the reader to their own text when they settle a thread', async () => {
    // The reader settling one goes down the same road a peer's does: the
    // library rewrites the mark, and the sync binding follows with a replace
    // over the whole body (measured 2026-09-23). Nothing about that is the
    // reader's edit, so undo reaches past it and redo brings it back.
    const { editor, manager } = openWithComments();
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('!', firstRun(editor).to - 1));
    manager.stopCapturing();
    const thread = await postAComment(editor);

    const comments = commentsOn(editor)!;
    await comments.threadStore.resolveThread({ threadId: thread });
    manager.undo();
    expect(editor.prosemirrorState.doc.textContent).not.toContain('!');

    manager.redo();

    expect(editor.prosemirrorState.doc.textContent).toContain('!');
  });

  it('leaves a thread a peer wrote where it is', async () => {
    const { editor, manager, doc } = openWithComments();
    await postAComment(editor);
    peerPostsAThread(doc);

    manager.undo();

    expect(threadCount(doc)).toBe(2);
  });
});
