// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Copies of a commented picture, and the picture moved (inner#1316 §5.2).
 *
 * A comment on media stands on the block's id. Every way of making a copy —
 * pasting what was copied, dragging with the copy key held, duplicating the
 * table the picture sits in — gives the copy a fresh id, so the copy comes
 * without the comment, as copied words do. Dragging the picture to move it
 * keeps its id, so the comment goes with it.
 */

import { act } from '@testing-library/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { asCommentBody, commentsOn } from '@web/spaces/document/document-comment-extension';
import { mediaThreadPositions } from '@web/spaces/document/document-comment-media';
import { commentOn } from '@web/spaces/document/document-comment-post';
import { moveRowTo } from '@web/spaces/document/document-drag-move';
import { duplicateRow } from '@web/spaces/document/document-handle-commands';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { OURS, settled } from '@web/spaces/document/__tests__/paste-harness';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const PICTURE = { id: 'pic', type: 'image', props: { url: `${OURS}a.png`, name: 'a.png' } };
const WORDS = { id: 'words', type: 'paragraph', content: 'alpha bravo' };

/**
 * Mounts an editor with comments, media from our storage and the product's undo.
 * @param blocks - The body.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const { extension } = createDocumentUndo(doc);
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [extension],
    comments: { doc, readWho: () => ({ role: 'editor', viewerId: 'u1' }) },
    media: { assetUrlPrefix: () => OURS, onLeftOut: vi.fn(), start: vi.fn() },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Posts a comment on the picture.
 * @param editor - The editor.
 * @returns The thread id.
 */
async function commentOnPicture(editor: Editor): Promise<string> {
  const posted = await commentOn(editor, asCommentBody('a note'), { mediaBlockId: 'pic' });
  return (posted as { id: string }).id;
}

/**
 * Where each media comment stands, by the id of the block it stands on.
 * @param editor - The editor.
 * @returns Thread id to block id.
 */
function standing(editor: Editor): Record<string, string> {
  const doc = editor.prosemirrorState.doc;
  const out: Record<string, string> = {};
  const threads = [...commentsOn(editor)!.threadStore.getThreads().values()];
  for (const [threadId, { from }] of mediaThreadPositions(doc, threads)) {
    out[threadId] = String(doc.nodeAt(from)!.attrs['id']);
  }
  return out;
}

/**
 * The block ids of the picture rows the body holds; a copy that kept the
 * original's id shows as the same id twice.
 * @param editor - The editor.
 * @returns The ids, in body order.
 */
function pictureIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'blockContainer' && node.firstChild?.type.name === 'image') ids.push(String(node.attrs['id']));
    return true;
  });
  return ids;
}

/**
 * The picture as the clipboard would carry it, selected as a node.
 * @param editor - The editor.
 * @param wholeRow - Whether its whole row is taken, as a row drag takes it.
 * @returns Its HTML, and the slice a drag would carry.
 */
function copyOfPicture(editor: Editor, wholeRow = false): { html: string; slice: import('@tiptap/pm/model').Slice } {
  const view = editor.prosemirrorView!;
  const row = rowById(view.state.doc, 'pic')!;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, wholeRow ? row.from : row.from + 1)));
  const serialized = view.serializeForClipboard(view.state.selection.content());
  return { html: serialized.dom.innerHTML, slice: serialized.slice };
}

/**
 * Drags the picture's row from inside the body to a position with the copy
 * key held, which copies it.
 * @param editor - The editor.
 * @param at - Where it lands.
 */
function dragCopyOfPicture(editor: Editor, at: number): void {
  const { html, slice } = copyOfPicture(editor, true);
  const view = editor.prosemirrorView!;
  (view as unknown as { dragging: unknown }).dragging = { slice, move: false };
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, { clientX: 1, clientY: 1, altKey: true, ctrlKey: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { types: ['text/html'], files: [], items: [], getData: (type: string): string => (type === 'text/html' ? html : '') },
  });
  view.dom.dispatchEvent(drop);
}

/**
 * Drops content of these formats at a position, as from another tab: no drag
 * of this view is under way.
 * @param editor - The editor.
 * @param at - Where it lands.
 * @param formats - Each format the drag carries.
 */
function dropFrom(editor: Editor, at: number, formats: Readonly<Record<string, string>>): void {
  const view = editor.prosemirrorView!;
  const box = { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
  for (const element of [view.dom, view.dom.firstElementChild as HTMLElement]) element.getBoundingClientRect = (): DOMRect => box;
  view.posAtCoords = (): { pos: number; inside: number } => ({ pos: at, inside: -1 });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.assign(drop, { clientX: 1, clientY: 1 });
  Object.defineProperty(drop, 'dataTransfer', {
    value: { types: Object.keys(formats), files: [], items: [], getData: (type: string): string => formats[type] ?? '' },
  });
  view.dom.dispatchEvent(drop);
}

describe('copies of a commented picture', () => {
  it('takes a copy dropped in from another tab of the same body without the comment', async () => {
    const editor = open([WORDS, PICTURE, { id: 'tail', type: 'paragraph', content: 'tail' }]);
    await act(async () => {
      await settled();
    });
    const id = await commentOnPicture(editor);
    const view = editor.prosemirrorView!;
    // Copied the way the user copies a stretch that runs over the picture.
    const doc = view.state.doc;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, rowById(doc, 'words')!.from + 3, rowById(doc, 'tail')!.from + 3)));
    const { dom, text } = view.serializeForClipboard(view.state.selection.content());

    dropFrom(editor, rowById(view.state.doc, 'tail')!.to - 2, { 'blocknote/html': dom.innerHTML, 'text/html': dom.innerHTML, 'text/plain': text });
    await act(async () => {
      await settled();
    });

    expect(new Set(pictureIds(editor)).size).toBe(2);
    expect(standing(editor)).toEqual({ [id]: 'pic' });
  });

  it('drags a copy, with the copy key held, without the comment', async () => {
    const editor = open([PICTURE, WORDS]);
    const id = await commentOnPicture(editor);

    dragCopyOfPicture(editor, rowById(editor.prosemirrorState.doc, 'words')!.to);
    await settled();

    expect(new Set(pictureIds(editor)).size).toBe(2);
    expect(standing(editor)).toEqual({ [id]: 'pic' });
  });

  it('carries the comment along when the picture\'s row is dragged to move it', async () => {
    const editor = open([PICTURE, WORDS]);
    const id = await commentOnPicture(editor);

    const view = editor.prosemirrorView!;
    moveRowTo(view, 'pic', rowById(view.state.doc, 'words')!.to);

    expect(pictureIds(editor)).toEqual(['pic']);
    expect(editor.document.map((block) => block.id)).toEqual(['words', 'pic']);
    expect(standing(editor)).toEqual({ [id]: 'pic' });
  });

  it('duplicates a table without the comment on the picture in its cell', async () => {
    const editor = open([tableBlock({ rows: [{ cells: ['words', { blocks: [PICTURE] }] }] })]);
    const id = await commentOnPicture(editor);

    duplicateRow(editor as never, editor.document[0] as never);

    expect(new Set(pictureIds(editor)).size).toBe(2);
    expect(standing(editor)).toEqual({ [id]: 'pic' });
  });
});
