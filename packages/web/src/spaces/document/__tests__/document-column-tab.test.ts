// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1314 A1 and design §5.1 entry table: Tab and Shift-Tab in columns.
 * A column is a body of its own: Tab indents a block under the one above it
 * in the same column, and Shift-Tab takes it back out, never out of the
 * column. A press whose selection runs across columns, or that would put the
 * column group under the block above it, moves nothing and draws the nudge
 * on the block it could not move.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { indentReach } from '@web/spaces/document/document-handle-commands';
import { columnsBlock, para } from '@web/spaces/document/__tests__/column-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function editorWith(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where some text starts.
 * @param doc - The document.
 * @param text - The text.
 * @returns The position of its first character.
 */
function posOf(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text) === true) found = pos + node.text.indexOf(text);
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${text}"`);
  return found;
}

/**
 * Selects from one text to another.
 * @param editor - The editor.
 * @param from - Where the selection starts.
 * @param to - Where it ends; the caret alone when left out.
 */
function select(editor: Editor, from: string, to?: string): void {
  const view = editor.prosemirrorView;
  const a = posOf(view.state.doc, from);
  const b = to === undefined ? a : posOf(view.state.doc, to);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a, b)));
}

/**
 * Presses Tab, or Shift-Tab, through the keymap.
 * @param editor - The editor.
 * @param withShift - Whether Shift is held.
 */
function pressTab(editor: Editor, withShift = false): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: withShift, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/** A block as the block API hands it. */
interface Seen {
  readonly type: string;
  readonly content?: readonly { text?: string }[];
  readonly children: readonly Seen[];
}

/**
 * Each column's blocks as `words` or `words>child,child`.
 * @param editor - The editor.
 * @returns One array per column of the first group.
 */
function columnsOf(editor: Editor): string[][] {
  const group = (editor.document as unknown as Seen[]).find((block) => block.type === 'docColumnList');
  const words = (block: Seen): string => (block.content ?? []).map((part) => part.text ?? '').join('');
  const line = (block: Seen): string =>
    block.children.length === 0 ? words(block) : `${words(block)}>${block.children.map(line).join(',')}`;
  return (group?.children ?? []).map((column) => column.children.map(line));
}

/**
 * The words of the blocks drawn with the nudge.
 * @param editor - The editor.
 * @returns Their text.
 */
function nudged(editor: Editor): string[] {
  return [...editor.prosemirrorView.dom.querySelectorAll('[data-tab-blocked]')].map((element) => element.textContent ?? '');
}

describe('Tab in a column', () => {
  it('indents a block under the one above it in the same column', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'b');
    pressTab(editor);
    expect(columnsOf(editor)).toEqual([['a>b'], ['c']]);
  });

  it('moves nothing on a column\'s first block and nudges that block alone', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'c');
    pressTab(editor);
    expect(columnsOf(editor)).toEqual([['a', 'b'], ['c']]);
    expect(nudged(editor)).toEqual(['c']);
  });

  it('moves nothing when the selection runs across two columns', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'b', 'c');
    pressTab(editor);
    expect(columnsOf(editor)).toEqual([['a', 'b'], ['c']]);
    expect((editor.document as unknown as Seen[]).map((block) => block.type)).toEqual(['paragraph', 'docColumnList']);
    expect(nudged(editor)).not.toEqual([]);
  });

  it('never puts the group under a list item above it', () => {
    const editor = editorWith([{ type: 'bulletListItem', content: 'item' }, columnsBlock(['a'], ['c'])]);
    select(editor, 'a', 'c');
    pressTab(editor);
    expect((editor.document as unknown as Seen[]).map((block) => block.type)).toEqual(['bulletListItem', 'docColumnList']);
  });
});

describe('Shift-Tab in a column', () => {
  it('takes an indented block back out within its column', () => {
    const editor = editorWith([
      columnsBlock({ blocks: [{ type: 'paragraph', content: 'a', children: [para('b')] }] }, ['c']),
    ]);
    select(editor, 'b');
    pressTab(editor, true);
    expect(columnsOf(editor)).toEqual([['a', 'b'], ['c']]);
  });

  it('never takes a column\'s own block out of the column', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    select(editor, 'b');
    pressTab(editor, true);
    expect(columnsOf(editor)).toEqual([['a', 'b'], ['c']]);
    expect((editor.document as unknown as Seen[]).map((block) => block.type)).toEqual(['paragraph', 'docColumnList']);
  });
});

describe('the handle menu\'s indent rows', () => {
  it('offer no indent for a column group, which never stands under another block', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a'], ['c'])]);
    const group = (editor.document as unknown as { id: string; type: string }[])[1]!;
    expect(indentReach(editor.prosemirrorState.doc, group.id)).toEqual({ in: false, out: false });
  });

  it('offer indent under the block above in the same column, and no way out of the column', () => {
    const editor = editorWith([para('lead'), columnsBlock(['a', 'b'], ['c'])]);
    const column = (editor.document as unknown as { children: { children: { id: string }[] }[] }[])[1]!.children[0]!;
    expect(indentReach(editor.prosemirrorState.doc, column.children[1]!.id)).toEqual({ in: true, out: false });
  });
});
