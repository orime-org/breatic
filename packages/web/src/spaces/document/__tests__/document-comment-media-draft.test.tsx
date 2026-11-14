// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A comment being written on a picture, a video or an audio block
 * (inner#1316 §5.3).
 *
 * The draft is aimed at the block by its id. The id is a reliable identity,
 * so the draft follows the block the way the collaboration rules ask of
 * anything that can be followed without guessing: gone with the block, back
 * when the block is back — an undo, a peer's undo, the second half of a drag
 * that moves it. A draft dropped because the user can no longer write stays
 * dropped, as a draft on words does (A22).
 */

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, documentCommentThreads } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { DocumentCommentDraftCard } from '@web/spaces/document/DocumentCommentDraftCard';
import {
  DOCUMENT_COMMENT_DRAFT_RANGE,
  draftIn,
  draftRangeIn,
  type Draft,
} from '@web/spaces/document/document-comment-draft-range';
import { openMediaCommentDraft } from '@web/spaces/document/document-comment-entries';
import { MEDIA_BLOCK_ID } from '@web/spaces/document/document-comment-media';
import { postComment } from '@web/spaces/document/document-comment-post';
import { domElementOf } from '@web/spaces/document/document-editor-view';
import { useCommentAnchors } from '@web/spaces/document/use-comment-anchors';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

/** Each editor's undo manager, the product's own (`createDocumentUndo`). */
const managers = new Map<Editor, Y.UndoManager>();

afterEach(() => {
  cleanup();
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const PICTURE = { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png', caption: 'dawn' } };
const WORDS = { id: 'words', type: 'paragraph', content: 'alpha bravo' };
const PENDING = { id: 'pending', type: 'image', props: { uploadId: 'up-1', url: '', name: 'b.png' } };

/**
 * Mounts an editor with comments and the draft plugin wired.
 * @param blocks - The body.
 * @returns The editor and its document.
 */
function open(blocks: unknown[]): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc();
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
  managers.set(editor, manager);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, doc };
}

/**
 * The open draft.
 * @param editor - The editor.
 * @returns It.
 */
function draftOf(editor: Editor): Draft | null {
  return draftIn(editor.prosemirrorState);
}

describe('openMediaCommentDraft', () => {
  it('aims a draft at the picture by its id, with no words under it', () => {
    const { editor } = open([WORDS, PICTURE]);

    expect(openMediaCommentDraft(editor, 'pic')).toBe(true);

    expect(draftOf(editor)).toMatchObject({ kind: 'aimed', mediaBlockId: 'pic' });
    expect(draftRangeIn(editor.prosemirrorState)).toBeNull();
  });

  it.each([
    ['a block with words', 'words'],
    ['a picture still uploading', 'pending'],
    ['an id the body does not hold', 'gone'],
  ])('opens nothing on %s', (_label, blockId) => {
    const { editor } = open([WORDS, PICTURE, PENDING]);

    expect(openMediaCommentDraft(editor, blockId)).toBe(false);
    expect(draftOf(editor)).toBeNull();
  });
});

describe('a media draft following its block', () => {
  it('drops when the picture goes and comes back, same opening, with an undo', () => {
    const { editor } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');
    const opened = draftOf(editor)!;

    managers.get(editor)!.stopCapturing();
    editor.removeBlocks(['pic']);
    expect(draftOf(editor)).toMatchObject({ kind: 'dropped', why: 'targetGone', opening: opened.opening });

    editor.undo();
    expect(draftOf(editor)).toMatchObject({ kind: 'aimed', mediaBlockId: 'pic', opening: opened.opening });
  });

  it('is aimed again once a drag that moves the picture puts it back down', () => {
    const { editor } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');

    managers.get(editor)!.stopCapturing();
    editor.removeBlocks(['pic']);
    editor.insertBlocks([PICTURE] as never, 'words', 'before');

    expect(draftOf(editor)).toMatchObject({ kind: 'aimed', mediaBlockId: 'pic' });
  });

  it('stays dropped after the user lost the right to write, whatever the body does', () => {
    const { editor } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.setMeta(DOCUMENT_COMMENT_DRAFT_RANGE, { drop: 'cannotWrite' }));
    view.dispatch(view.state.tr.insertText('x', 3));

    expect(draftOf(editor)).toMatchObject({ kind: 'dropped', why: 'cannotWrite' });
  });

  it('hands back the same draft object when the body changes around the picture', () => {
    const { editor } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');
    const before = draftOf(editor);
    const view = editor.prosemirrorView!;

    view.dispatch(view.state.tr.insertText('x', 3));

    expect(draftOf(editor)).toBe(before);
  });
});

describe('postComment from a media draft', () => {
  it('writes the comment on the picture', async () => {
    const { editor, doc } = open([PICTURE]);
    openMediaCommentDraft(editor, 'pic');

    const posted = await postComment(editor, 'warmer light');

    const stored = documentCommentThreads(doc).get(posted!.id) as Y.Map<unknown>;
    expect(stored.get('metadata')).toEqual({ [MEDIA_BLOCK_ID]: 'pic' });
  });

  it('writes nothing once the picture is gone', async () => {
    const { editor, doc } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');
    managers.get(editor)!.stopCapturing();
    editor.removeBlocks(['pic']);

    expect(await postComment(editor, 'warmer light')).toBeNull();
    expect([...documentCommentThreads(doc).keys()]).toEqual([]);
  });
});

describe('the draft card of a media draft', () => {
  it('quotes the picture it is aimed at', () => {
    const { editor } = open([PICTURE]);
    openMediaCommentDraft(editor, 'pic');

    render(<DocumentCommentDraftCard editor={editor as never} draft={draftOf(editor)!} myRole='editor' reading={false} />);

    expect(screen.getByTestId('doc-comment-draft-quote').textContent).toBe('a.png');
  });

  it('says the media was deleted once the picture is gone', () => {
    const { editor } = open([WORDS, PICTURE]);
    openMediaCommentDraft(editor, 'pic');
    managers.get(editor)!.stopCapturing();
    editor.removeBlocks(['pic']);

    render(<DocumentCommentDraftCard editor={editor as never} draft={draftOf(editor)!} myRole='editor' reading={false} />);

    expect(screen.getByTestId('doc-comment-draft-dropped').textContent).toBe('This media was deleted.');
  });
});

describe('the draft anchor of a media draft', () => {
  it('measures the top of the picture again after every change to the body', () => {
    const { editor } = open([WORDS, PICTURE]);
    const column = document.createElement('div');
    column.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const block = domElementOf(editor)!.querySelector<HTMLElement>('[data-id="pic"]')!;
    let blockTop = 340;
    block.getBoundingClientRect = () => ({ top: blockTop }) as DOMRect;
    const anchor = { id: 'doc-comment-draft', mediaBlockId: 'pic' };

    const { result } = renderHook(() => useCommentAnchors(editor, [], React.useRef(column), anchor));
    expect(result.current.tops.get('doc-comment-draft')).toBe(240);

    blockTop = 400;
    act(() => {
      const view = editor.prosemirrorView!;
      view.dispatch(view.state.tr.insertText('more ', 3));
    });
    expect(result.current.tops.get('doc-comment-draft')).toBe(300);
  });
});
