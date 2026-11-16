// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a pick in the slash menu does to the document (inner#1125 A4, A8,
 * design 5.5, 5.9).
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { landSlashMedia, pickInSlashMenu, slashTyped } from '@web/spaces/document/document-slash-pick';

type Editor = ReturnType<typeof buildDocumentEditor>;

interface ReadBlock {
  readonly id: string;
  readonly type: string;
  readonly content?: readonly { text?: string }[];
}

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  _resetDocumentEditorCacheForTests();
  document.body.innerHTML = '';
});

function editorWith(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

function read(editor: Editor): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

function words(block: ReadBlock | undefined): string {
  return (block?.content ?? []).map((part) => part.text ?? '').join('');
}

/** Puts the caret at the end of the first block, the way typing leaves it. */
function caretAtEnd(editor: Editor, blockId: string): void {
  editor.setTextCursorPosition(blockId, 'end');
  const view = editor.prosemirrorView;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.from)));
}

describe('a pick in the slash menu', () => {
  it('turns an empty paragraph holding only the query into the pick', () => {
    const editor = editorWith([{ type: 'paragraph', content: '/he' }]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    pickInSlashMenu(editor as never, slashTyped(editor as never, id, '/he')!, 'heading-1');
    const blocks = read(editor);
    expect(blocks[0]?.type).toBe('heading');
    expect(words(blocks[0])).toBe('');
  });

  it('turns an empty list item into the pick, whatever its type', () => {
    const editor = editorWith([{ type: 'bulletListItem', content: '/' }]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    pickInSlashMenu(editor as never, slashTyped(editor as never, id, '/')!, 'heading-2');
    expect(read(editor)).toHaveLength(1);
    expect(read(editor)[0]?.type).toBe('heading');
  });

  it('adds the pick below a line with text and keeps that text', () => {
    const editor = editorWith([{ type: 'paragraph', content: 'hello /he' }]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    pickInSlashMenu(editor as never, slashTyped(editor as never, id, '/he')!, 'heading-1');
    const blocks = read(editor);
    expect(words(blocks[0])).toBe('hello ');
    expect(blocks[0]?.type).toBe('paragraph');
    expect(blocks[1]?.type).toBe('heading');
  });

  it('returns the formula block whose box opens next', () => {
    const editor = editorWith([{ type: 'paragraph', content: '/fo' }]);
    const id = read(editor)[0]!.id;
    caretAtEnd(editor, id);
    const made = pickInSlashMenu(editor as never, slashTyped(editor as never, id, '/fo')!, 'formula');
    expect(made).toBe(read(editor)[0]?.id);
    expect(read(editor)[0]?.type).toBe('mathBlock');
  });
});

describe('media picked in the slash menu', () => {
  const picture = [{ type: 'image', props: { url: 'https://example.test/a.png' } }];

  it('removes the query and lands the file once it is chosen', () => {
    const editor = editorWith([{ type: 'paragraph', content: 'text /im' }]);
    const id = read(editor)[0]!.id;
    const typed = slashTyped(editor as never, id, '/im')!;
    expect(landSlashMedia(editor as never, typed, picture as never)).toBe(true);
    expect(words(read(editor)[0])).toBe('text ');
    expect(read(editor).some((block) => block.type === 'image')).toBe(true);
  });

  it('lands the file without deleting text that changed meanwhile', () => {
    const editor = editorWith([{ type: 'paragraph', content: 'text /im' }]);
    const id = read(editor)[0]!.id;
    const typed = slashTyped(editor as never, id, '/im')!;
    editor.updateBlock(id, { content: 'text rewritten' } as never);
    expect(landSlashMedia(editor as never, typed, picture as never)).toBe(true);
    expect(words(read(editor)[0])).toBe('text rewritten');
    expect(read(editor).some((block) => block.type === 'image')).toBe(true);
  });

  it('lands nothing once the row is gone', () => {
    const editor = editorWith([{ type: 'paragraph', content: 'keep' }, { type: 'paragraph', content: '/im' }]);
    const id = read(editor)[1]!.id;
    const typed = slashTyped(editor as never, id, '/im')!;
    editor.removeBlocks([id]);
    expect(landSlashMedia(editor as never, typed, picture as never)).toBe(false);
    expect(read(editor).some((block) => block.type === 'image')).toBe(false);
  });
});
