// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What a keystroke costs the comment panel once comments stand on media
 * (inner#1316 §5.4).
 *
 * The panel reads where every comment stands on each change to the body.
 * Comments on words are found in one walk of the body for the whole panel;
 * comments on media must be too, or each picture with a comment adds a walk
 * of the whole body to every keystroke. Reads that do not depend on the body
 * must not run on a keystroke at all: rebuilding the thread map deserialises
 * every comment in the document.
 */

import { YjsThreadStore } from '@blocknote/core/yjs';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { act, cleanup, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { useCommentAnchors } from '@web/spaces/document/use-comment-anchors';
import { useCommentCards } from '@web/spaces/document/use-comment-cards';
import { useCommentRail } from '@web/spaces/document/use-comment-rail';
import { useMediaComments } from '@web/spaces/document/use-media-comments';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Mounts an editor with a line of words and this many pictures, each with a comment.
 * @param pictures - How many commented pictures.
 * @returns The editor.
 */
async function withCommentedPictures(pictures: number): Promise<Editor> {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  const blocks = [
    { id: 'words', type: 'paragraph', content: 'alpha bravo' },
    ...Array.from({ length: pictures }, (_, i) => ({ id: `pic-${i}`, type: 'image', props: { url: `https://cdn.test/${i}.png`, name: `${i}.png` } })),
  ];
  editor.replaceBlocks(editor.document, blocks as never);
  for (let i = 0; i < pictures; i += 1) {
    await commentOn(editor, asCommentBody('note'), { mediaBlockId: `pic-${i}` });
  }
  return editor;
}

/** Types one letter at the start of the first line. */
function typeOne(editor: Editor): void {
  act(() => {
    const view = editor.prosemirrorView!;
    view.dispatch(view.state.tr.insertText('x', 3));
  });
}

/**
 * How many times the panel walks the body for one keystroke.
 * @param pictures - How many commented pictures the body holds.
 * @returns The walks, and the one-by-one thread reads.
 */
async function panelCostOfAKeystroke(pictures: number): Promise<{ walks: number; singleReads: number }> {
  const editor = await withCommentedPictures(pictures);
  const column = document.createElement('div');
  renderHook(() => {
    const rail = useCommentRail(editor);
    useCommentCards(editor, rail);
    return useCommentAnchors(editor, rail.unresolved.map((card) => card.id), React.useRef(column));
  });
  const walks = vi.spyOn(ProseMirrorNode.prototype, 'descendants');
  const singleReads = vi.spyOn(YjsThreadStore.prototype, 'getThread');
  typeOne(editor);
  return { walks: walks.mock.calls.length, singleReads: singleReads.mock.calls.length };
}

describe('what a keystroke costs the comment panel', () => {
  it('walks the body as often with eight commented pictures as with one', async () => {
    const one = await panelCostOfAKeystroke(1);
    vi.restoreAllMocks();
    const eight = await panelCostOfAKeystroke(8);

    expect(eight.walks).toBe(one.walks);
  });

  it('reads no thread one by one', async () => {
    const cost = await panelCostOfAKeystroke(8);

    expect(cost.singleReads).toBe(0);
  });

  it('rebuilds no thread map for the media blocks\' own reading', async () => {
    const editor = await withCommentedPictures(2);
    renderHook(() => useMediaComments(editor));
    const rebuilds = vi.spyOn(commentsOn(editor)!.threadStore, 'getThreads');

    typeOne(editor);

    expect(rebuilds).not.toHaveBeenCalled();
  });

  it('reads the panel once per keystroke', async () => {
    const editor = await withCommentedPictures(2);
    await commentOn(editor, asCommentBody('on words'), () => [{ from: 3, to: 8 }]);
    renderHook(() => useCommentRail(editor));
    const rebuilds = vi.spyOn(commentsOn(editor)!.threadStore, 'getThreads');

    typeOne(editor);

    expect(rebuilds).toHaveBeenCalledTimes(1);
  });
});
