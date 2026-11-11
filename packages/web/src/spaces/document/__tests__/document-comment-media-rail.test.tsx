// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The comment panel reading comments on media blocks (inner#1316 §5.4).
 *
 * Everything the panel reads about where a comment stands used to come from
 * the comment marks in the body, through the library's position table. A
 * comment on a picture has no mark: its place is the block named on the
 * thread. Each reader is checked here against a body that holds only such a
 * comment, which is where a reader that still looks only at marks shows.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { asCommentBody } from '@web/spaces/document/document-comment-extension';
import { commentedElement } from '@web/spaces/document/document-comment-media';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { domElementOf } from '@web/spaces/document/document-editor-view';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { useCommentAnchors } from '@web/spaces/document/use-comment-anchors';
import { useCommentCards } from '@web/spaces/document/use-comment-cards';
import { useCommentRail } from '@web/spaces/document/use-comment-rail';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const PICTURE = { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png', caption: 'dawn' } };
const WORDS = { id: 'words', type: 'paragraph', content: 'alpha bravo' };

/**
 * Mounts an editor with comments wired.
 * @param blocks - The body.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Posts a comment on a media block.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns The thread id.
 */
async function onMedia(editor: Editor, blockId: string): Promise<string> {
  const posted = await commentOn(editor, asCommentBody('on the picture'), { mediaBlockId: blockId });
  return (posted as { id: string }).id;
}

/**
 * Posts a comment on the first five letters of a block.
 * @param editor - The editor.
 * @param blockId - The block.
 * @returns The thread id.
 */
async function onWords(editor: Editor, blockId: string): Promise<string> {
  const posted = await commentOn(editor, asCommentBody('on the words'), (state) => {
    const row = rowById(state.doc, blockId)!;
    return [{ from: row.from + 2, to: row.from + 7 }];
  });
  return (posted as { id: string }).id;
}

describe('useCommentRail with media comments', () => {
  it('lists a comment on a picture in a body that holds no other comment', async () => {
    const editor = open([PICTURE]);
    const { result } = renderHook(() => useCommentRail(editor));
    let id = '';
    await act(async () => {
      id = await onMedia(editor, 'pic');
    });

    expect(result.current.unresolved).toEqual([{ id, settled: false }]);
  });

  it('drops the card with the picture and brings it back with an undo', async () => {
    const editor = open([WORDS, PICTURE]);
    const { result } = renderHook(() => useCommentRail(editor));
    let id = '';
    await act(async () => {
      id = await onMedia(editor, 'pic');
    });

    act(() => {
      editor.removeBlocks(['pic']);
    });
    expect(result.current.unresolved).toEqual([]);

    act(() => {
      editor.undo();
    });
    expect(result.current.unresolved).toEqual([{ id, settled: false }]);
  });

  it('orders comments on words and on pictures by where they stand in the body', async () => {
    const editor = open([PICTURE, WORDS]);
    const { result } = renderHook(() => useCommentRail(editor));
    let onText = '';
    let onPicture = '';
    await act(async () => {
      onText = await onWords(editor, 'words');
      onPicture = await onMedia(editor, 'pic');
    });

    expect(result.current.unresolved.map((card) => card.id)).toEqual([onPicture, onText]);
  });
});

describe('useCommentCards with media comments', () => {
  it('quotes a picture by its kind, name, caption and address', async () => {
    const editor = open([PICTURE]);
    const { result } = renderHook(() => {
      const rail = useCommentRail(editor);
      return useCommentCards(editor, rail);
    });
    let id = '';
    await act(async () => {
      id = await onMedia(editor, 'pic');
    });

    expect(result.current.unresolved).toHaveLength(1);
    expect(result.current.unresolved[0]).toMatchObject({
      id,
      quote: '',
      media: { type: 'image', name: 'a.png', caption: 'dawn', url: 'https://cdn.test/a.png' },
    });
  });

  it('gives a card on words no media quote', async () => {
    const editor = open([WORDS]);
    const { result } = renderHook(() => {
      const rail = useCommentRail(editor);
      return useCommentCards(editor, rail);
    });
    await act(async () => {
      await onWords(editor, 'words');
    });

    expect(result.current.unresolved[0]).toMatchObject({ quote: 'alpha', media: null });
  });
});

describe('useCommentAnchors with media comments', () => {
  it('lines a picture card up with the top of the picture', async () => {
    const editor = open([WORDS, PICTURE]);
    let id = '';
    await act(async () => {
      id = await onMedia(editor, 'pic');
    });
    const column = document.createElement('div');
    column.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const block = domElementOf(editor)!.querySelector<HTMLElement>('[data-id="pic"]')!;
    block.getBoundingClientRect = () => ({ top: 340 }) as DOMRect;

    const { result } = renderHook(() => useCommentAnchors(editor, [id], React.useRef(column)));

    expect(result.current.tops.get(id)).toBe(240);
  });
});

describe('commentedElement', () => {
  it('finds the highlight of a comment on words', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p><span class="bn-thread-mark" data-bn-thread-id="t1">alpha</span></p>';

    expect(commentedElement(root, 't1', null)?.textContent).toBe('alpha');
  });

  it('finds the block of a comment on a picture', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="bn-block-outer" data-id="pic"><div class="bn-block" data-id="pic"></div></div>';

    expect(commentedElement(root, 't2', 'pic')?.className).toBe('bn-block-outer');
  });

  it('finds nothing for a picture that is gone', () => {
    const root = document.createElement('div');

    expect(commentedElement(root, 't2', 'pic')).toBeNull();
  });
});
