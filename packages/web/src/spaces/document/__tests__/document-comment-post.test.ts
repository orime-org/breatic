// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Posting a comment (#18, A1 · A2 · A21, design §6.1).
 *
 * Two steps, and the order matters: the thread is created first, because its
 * id is what the mark carries. The library will not do the second step —
 * `YjsThreadStore.addThreadToDocument` is `undefined`, its own comment saying
 * the store does not support it — and its fallback would be `setMark` on the
 * current selection, which the block entry has no way to hand a range to.
 *
 * Writing it ourselves is what makes the two entries one operation: the
 * bubble bar opens the draft on the reader's selection, the block handle on
 * `selectionOverBlockContent`, and from here they are identical (A2).
 *
 * The range comes from the draft plugin at the moment of posting, not from
 * the caller: the plugin is what has carried it across every edit since the
 * draft opened, and a peer's deletion can arrive between React rendering the
 * composer and the reader pressing post.
 *
 * TDD: red because `postComment` does not exist yet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
} from '@web/spaces/document/document-comment-draft-range';
import { postComment } from '@web/spaces/document/document-comment-post';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor with comments and the draft plugin wired, holding one
 * paragraph.
 * @returns The editor and the document behind it.
 */
function open(): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'alpha bravo charlie' },
  ] as never);
  return { editor, doc };
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
 * Opens a draft aimed at the range given, the way an entry does.
 * @param editor - The editor.
 * @param range - Where the comment is going.
 */
function aimAt(editor: Editor, range: { from: number; to: number }): void {
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, range));
}

/** Every comment mark in the body, with the text it covers. */
function highlights(editor: Editor): { threadId: string; text: string }[] {
  const found: { threadId: string; text: string }[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'comment') {
        found.push({
          threadId: mark.attrs.threadId as string,
          text: node.text ?? '',
        });
      }
    }
    return true;
  });
  return found;
}

describe('postComment', () => {
  it('creates the thread and marks exactly the words it was aimed at', async () => {
    const { editor, doc } = open();
    const run = firstRun(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    const posted = await postComment(editor, 'a first thought');

    expect(posted).not.toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toHaveLength(1);
    expect(highlights(editor)).toEqual([
      { threadId: posted!.id, text: 'alpha' },
    ]);
  });

  it('puts the words in the thread as its first comment', async () => {
    const { editor } = open();
    const run = firstRun(editor);
    aimAt(editor, { from: run.from, to: run.from + 5 });

    const posted = await postComment(editor, 'a first thought');

    const comments = editor.getExtension(CommentsExtension)!;
    const stored = comments.threadStore.getThreads().get(posted!.id);
    expect(stored?.comments).toHaveLength(1);
    expect(JSON.stringify(stored?.comments[0]?.body)).toContain(
      'a first thought',
    );
  });

  it('marks the whole block when the block entry aimed at its range', async () => {
    // A2: identical to selecting the block's text by hand and commenting.
    const { editor } = open();
    const run = firstRun(editor);
    aimAt(editor, run);

    const posted = await postComment(editor, 'about this block');

    expect(highlights(editor)).toEqual([
      { threadId: posted!.id, text: 'alpha bravo charlie' },
    ]);
  });

  it('posts nothing with no draft open', async () => {
    const { editor, doc } = open();

    expect(await postComment(editor, 'nothing aimed at')).toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
  });

  it('posts nothing once the words it was aimed at are deleted', async () => {
    const { editor, doc } = open();
    const run = firstRun(editor);
    const range = { from: run.from, to: run.from + 5 };
    aimAt(editor, range);

    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.delete(range.from, range.to));

    expect(await postComment(editor, 'too late')).toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toHaveLength(0);
    expect(highlights(editor)).toEqual([]);
  });

  it('keeps the thread when the words go while the thread is being created', async () => {
    // Creating a thread is a round trip. The words can go during it, and the
    // thread is already made by then — §9.2's S3 is this shape exactly:
    // unresolved, with nothing in the body to point at. Dropping the thread
    // instead would lose what the reader wrote.
    const { editor, doc } = open();
    const run = firstRun(editor);
    const range = { from: run.from, to: run.from + 5 };
    aimAt(editor, range);

    const comments = editor.getExtension(CommentsExtension)!;
    const store = comments.threadStore;
    const realCreate = store.createThread.bind(store);
    store.createThread = async (options): Promise<never> => {
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.delete(range.from, range.to));
      return (await realCreate(options)) as never;
    };

    const posted = await postComment(editor, 'racing a deletion');

    expect(posted).not.toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toHaveLength(1);
    expect(highlights(editor)).toEqual([]);
  });

  it('marks the words, not the numbers, when they move during creation', async () => {
    // A peer inserting text above shifts the range while the thread is being
    // created. Writing the numbers the draft opened with would put the
    // highlight on whatever now sits at those offsets.
    const { editor } = open();
    const run = firstRun(editor);
    aimAt(editor, { from: run.from + 6, to: run.from + 11 });

    const comments = editor.getExtension(CommentsExtension)!;
    const store = comments.threadStore;
    const realCreate = store.createThread.bind(store);
    store.createThread = async (options): Promise<never> => {
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.insertText('xx ', run.from));
      return (await realCreate(options)) as never;
    };

    const posted = await postComment(editor, 'about bravo');

    expect(highlights(editor)).toEqual([
      { threadId: posted!.id, text: 'bravo' },
    ]);
  });

  it('lets a second comment overlap the first, keeping both marks', async () => {
    // `excludes: ""` allows it, and A20 rests on both surviving.
    const { editor } = open();
    const run = firstRun(editor);

    aimAt(editor, { from: run.from, to: run.from + 11 });
    const first = await postComment(editor, 'the first');
    aimAt(editor, { from: run.from + 6, to: run.from + 19 });
    const second = await postComment(editor, 'the second');

    expect(new Set(highlights(editor).map((hit) => hit.threadId))).toEqual(
      new Set([first!.id, second!.id]),
    );
    // The shared run carries both, which is what makes it a deeper colour.
    expect(highlights(editor).filter((hit) => hit.text === 'bravo')).toHaveLength(
      2,
    );
  });

});
