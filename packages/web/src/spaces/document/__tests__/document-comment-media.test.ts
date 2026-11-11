// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A comment on a picture, a video or an audio block (inner#1316 §5.2).
 *
 * The anchor is the block's id, written on the thread's metadata once and
 * never again; the body is not touched. Whether the thread has somewhere to
 * stand is read off the body: a block with that id, of a media type, is its
 * place. Everything the user sees follows from what happens to that id —
 * gone with the block, back with an undo, fresh on a copy.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import {
  MEDIA_BLOCK_ID,
  anchoredMediaIds,
  mediaThreadPositions,
} from '@web/spaces/document/document-comment-media';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { duplicateRow } from '@web/spaces/document/document-handle-commands';
import { rowById } from '@web/spaces/document/document-row-by-id';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const PICTURE = { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png', caption: 'dawn' } };
const WORDS = { id: 'words', type: 'paragraph', content: 'alpha bravo' };
const PENDING = { id: 'pending', type: 'image', props: { uploadId: 'up-1', url: '', name: 'b.png' } };

/**
 * Mounts an editor with comments wired over a document.
 * @param doc - The document.
 * @param blocks - What the body is set to, or nothing to keep what the document holds.
 * @returns The editor.
 */
function mount(doc: Y.Doc, blocks?: unknown[]): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  if (blocks !== undefined) editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Every thread the editor's store holds.
 * @param editor - The editor.
 * @returns The threads.
 */
function threadsOf(editor: Editor): { id: string; metadata?: unknown }[] {
  return [...commentsOn(editor)!.threadStore.getThreads().values()];
}

/**
 * Posts a comment on a media block.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns What `commentOn` answered.
 */
function postOn(editor: Editor, blockId: string): ReturnType<typeof commentOn> {
  return commentOn(editor, asCommentBody('a note'), { mediaBlockId: blockId });
}

describe('commentOn a media block', () => {
  it('writes the block id on the thread and leaves the body as it was', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [WORDS, PICTURE]);
    const before = editor.prosemirrorState.doc.toJSON();

    const posted = await postOn(editor, 'pic');

    expect(posted).not.toBeNull();
    const id = (posted as { id: string }).id;
    const stored = documentCommentThreads(doc).get(id) as Y.Map<unknown>;
    expect(stored.get('metadata')).toEqual({ [MEDIA_BLOCK_ID]: 'pic' });
    expect(editor.prosemirrorState.doc.toJSON()).toEqual(before);
  });

  it('keeps the metadata a caller hands in beside the block id', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [PICTURE]);

    const posted = await commentOn(editor, asCommentBody('x'), { mediaBlockId: 'pic' }, { thread: { proposalId: 'p1' } });

    const stored = documentCommentThreads(doc).get((posted as { id: string }).id) as Y.Map<unknown>;
    expect(stored.get('metadata')).toEqual({ proposalId: 'p1', [MEDIA_BLOCK_ID]: 'pic' });
  });

  it.each([
    ['a block with words', 'words'],
    ['a picture still uploading', 'pending'],
    ['an id the body does not hold', 'gone'],
  ])('creates nothing on %s', async (_label, blockId) => {
    const doc = new Y.Doc();
    const editor = mount(doc, [WORDS, PICTURE, PENDING]);

    const posted = await postOn(editor, blockId);

    expect(posted).toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toEqual([]);
  });
});

describe('mediaThreadPositions', () => {
  it('places a media thread on its block and leaves text threads to the library', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [WORDS, PICTURE]);
    const posted = (await postOn(editor, 'pic')) as { id: string };
    await commentOn(editor, asCommentBody('on words'), (state) => {
      const row = rowById(state.doc, 'words')!;
      return [{ from: row.from + 2, to: row.from + 7 }];
    });

    const positions = mediaThreadPositions(editor.prosemirrorState.doc, threadsOf(editor));

    const row = rowById(editor.prosemirrorState.doc, 'pic')!;
    expect([...positions.entries()]).toEqual([[posted.id, { from: row.from, to: row.to }]]);
  });

  it('drops the thread when the block goes and brings it back with an undo', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [WORDS, PICTURE]);
    const posted = (await postOn(editor, 'pic')) as { id: string };

    editor.removeBlocks(['pic']);
    expect(mediaThreadPositions(editor.prosemirrorState.doc, threadsOf(editor)).size).toBe(0);

    editor.undo();
    const row = rowById(editor.prosemirrorState.doc, 'pic')!;
    expect([...mediaThreadPositions(editor.prosemirrorState.doc, threadsOf(editor)).entries()]).toEqual([
      [posted.id, { from: row.from, to: row.to }],
    ]);
  });

  it('leaves a duplicated picture without the comment', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [PICTURE]);
    const posted = (await postOn(editor, 'pic')) as { id: string };

    duplicateRow(editor as never, editor.getBlock('pic') as never);

    expect(editor.document).toHaveLength(2);
    const positions = mediaThreadPositions(editor.prosemirrorState.doc, threadsOf(editor));
    const row = rowById(editor.prosemirrorState.doc, 'pic')!;
    expect([...positions.entries()]).toEqual([[posted.id, { from: row.from, to: row.to }]]);
  });

  it('keeps every comment two people post on one picture at once, on both sides', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        async (fromA, fromB, aFirst) => {
          const docA = new Y.Doc();
          const docB = new Y.Doc();
          const a = mount(docA, [PICTURE]);
          Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
          const b = mount(docB);
          const posted: string[] = [];
          for (let i = 0; i < fromA; i += 1) posted.push(((await postOn(a, 'pic')) as { id: string }).id);
          for (let i = 0; i < fromB; i += 1) posted.push(((await postOn(b, 'pic')) as { id: string }).id);

          const toB = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB));
          const toA = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA));
          if (aFirst) {
            Y.applyUpdate(docB, toB);
            Y.applyUpdate(docA, toA);
          } else {
            Y.applyUpdate(docA, toA);
            Y.applyUpdate(docB, toB);
          }

          for (const editor of [a, b]) {
            const positions = mediaThreadPositions(editor.prosemirrorState.doc, threadsOf(editor));
            const row = rowById(editor.prosemirrorState.doc, 'pic')!;
            expect([...positions.keys()].sort()).toEqual([...posted].sort());
            for (const at of positions.values()) expect(at).toEqual({ from: row.from, to: row.to });
          }
          a.unmount();
          b.unmount();
          mounted.splice(mounted.indexOf(a), 1);
          mounted.splice(mounted.indexOf(b), 1);
        },
      ),
      { numRuns: 12 },
    );
  });
});

describe('anchoredMediaIds', () => {
  it('reads the block ids threads stand on, and forgets a deleted thread', async () => {
    const doc = new Y.Doc();
    const editor = mount(doc, [WORDS, PICTURE]);
    const kept = (await postOn(editor, 'pic')) as { id: string };
    await commentOn(editor, asCommentBody('on words'), (state) => {
      const row = rowById(state.doc, 'words')!;
      return [{ from: row.from + 2, to: row.from + 7 }];
    });

    expect([...anchoredMediaIds(documentCommentThreads(doc))]).toEqual(['pic']);

    await commentsOn(editor)!.threadStore.deleteThread({ threadId: kept.id });
    expect([...anchoredMediaIds(documentCommentThreads(doc))]).toEqual([]);
  });
});
