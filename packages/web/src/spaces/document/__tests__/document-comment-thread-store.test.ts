// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The thread store, wired to this document (#18, design §4.2).
 *
 * Threads live in the same Y.Doc as the body, in the map
 * `documentCommentThreads` hands back, so one connection carries both and a
 * thread cannot arrive without the text it points at.
 *
 * Two things this pins that nothing else can:
 *
 * `threadPositions`. The design's orphan test is "this thread id is absent
 * from the position table" (§9), and that table is computed by the library
 * inside its own extension. Reaching it is therefore a wiring question, not a
 * logic one: if `getExtension` hands back nothing, or the table stays empty
 * while a mark sits in the body, the orphan test silently reads every thread
 * as an orphan.
 *
 * `resolveUsers`. The library requires it and throws without one. Ours maps
 * the account's own `UserSummary` — the same source the canvas annotations
 * read (#1881), so a name cannot differ between the two surfaces. The mapping
 * is not identity: the library wants `username`, the account calls it `name`.
 *
 * TDD: red because neither export exists yet.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as Y from 'yjs';

import { CommentsExtension } from '@blocknote/core/comments';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { toCommentUsers } from '@web/spaces/document/document-comment-thread-store';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Opens an editor with comments wired to the document given.
 * @param doc - The document Space's Y.Doc.
 * @returns The editor, mounted.
 */
function open(doc: Y.Doc): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

describe('toCommentUsers', () => {
  it('maps the account name onto the field the library reads', () => {
    expect(
      toCommentUsers([
        {
          id: 'u1',
          name: 'Ada',
          email: 'ada@example.com',
          avatarUrl: 'https://example.com/ada.png',
        },
      ]),
    ).toEqual([
      { id: 'u1', username: 'Ada', avatarUrl: 'https://example.com/ada.png' },
    ]);
  });

  it('leaves the avatar empty when the account has none', () => {
    expect(
      toCommentUsers([{ id: 'u1', name: 'Ada', email: 'ada@example.com' }]),
    ).toEqual([{ id: 'u1', username: 'Ada', avatarUrl: undefined }]);
  });

  it('answers for nobody when given nobody', () => {
    expect(toCommentUsers([])).toEqual([]);
  });
});

describe('documentCommentsExtension', () => {
  it('registers the library extension, reachable off the editor', () => {
    const editor = open(new Y.Doc());
    expect(editor.getExtension(CommentsExtension)).toBeDefined();
  });

  it('writes a new thread into the map beside the body', async () => {
    const doc = new Y.Doc();
    const editor = open(doc);
    const comments = editor.getExtension(CommentsExtension)!;

    await comments.threadStore.createThread({ initialComment: { body: [] } });

    expect([...documentCommentThreads(doc).keys()]).toHaveLength(1);
  });

  it('reports no position for a thread the body does not mark', async () => {
    const doc = new Y.Doc();
    const editor = open(doc);
    const comments = editor.getExtension(CommentsExtension)!;

    const thread = await comments.threadStore.createThread({
      initialComment: { body: [] },
    });

    // Nothing wrote a mark, so the table has no entry — which is exactly what
    // the orphan test reads.
    expect(comments.store.state.threadPositions.has(thread.id)).toBe(false);
  });

  it('reports a position once the body carries that thread mark', () => {
    const doc = new Y.Doc();
    const editor = open(doc);
    const comments = editor.getExtension(CommentsExtension)!;
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'words to discuss' },
    ] as never);

    const view = editor.prosemirrorView!;
    const mark = view.state.schema.marks.comment.create({
      threadId: 't1',
      orphan: false,
    });
    const body = view.state.doc;
    let from = 0;
    let to = 0;
    body.descendants((node, pos) => {
      if (node.isText && from === 0) {
        from = pos;
        to = pos + node.nodeSize;
      }
      return true;
    });
    view.dispatch(view.state.tr.addMark(from, to, mark));

    const at = comments.store.state.threadPositions.get('t1');
    expect(at).toBeDefined();
    expect(at!.to).toBeGreaterThan(at!.from);
  });
});
