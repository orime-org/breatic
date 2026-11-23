// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1314 design §5.5: a selection across columns, replaced by a delete,
 * a cut or typing. Each column keeps what was not selected in it, as a cell
 * does (`takeAwayCellContent`); words never run from one column into another;
 * a column whose blocks were all taken goes by the repair rule, so a group
 * left with one column dissolves.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { columnsBlock, para, shapeOf } from '@web/spaces/document/__tests__/column-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * An editor holding the given blocks.
 * @param blocks - The top-level blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where some words start, plus an offset into them.
 * @param doc - The document.
 * @param words - The words.
 * @param offset - How far in.
 * @returns The position.
 */
function at(doc: PMNode, words: string, offset: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(words) === true) found = pos + node.text.indexOf(words) + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no "${words}"`);
  return found;
}

/**
 * Selects between two points in words.
 * @param editor - The editor.
 * @param from - The words and offset the selection starts at.
 * @param to - The words and offset it ends at.
 */
function select(editor: Editor, from: readonly [string, number], to: readonly [string, number]): void {
  const view = editor.prosemirrorView;
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, at(doc, ...from), at(doc, ...to))));
}

/**
 * Presses a key through the keymap.
 * @param editor - The editor.
 * @param key - The key.
 */
function press(editor: Editor, key: string): void {
  const view = editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  view.someProp('handleKeyDown', (handler) => handler(view, event));
}

/**
 * Types words the way the browser hands them to the editor.
 * @param editor - The editor.
 * @param words - The words.
 */
function typeWords(editor: Editor, words: string): void {
  const view = editor.prosemirrorView;
  const { from, to } = view.state.selection;
  const handled = view.someProp('handleTextInput', (handler) => handler(view, from, to, words, () => view.state.tr.insertText(words, from, to)));
  if (handled !== true) view.dispatch(view.state.tr.insertText(words, from, to));
}

describe('a selection across columns, replaced', () => {
  it('keeps each column\'s unselected words in that column on Backspace', () => {
    const editor = open([columnsBlock(['alpha', 'beta'], ['gamma', 'delta'])]);
    select(editor, ['beta', 2], ['gamma', 2]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['[alpha,be|mma,delta]']);
  });

  it('dissolves the group when a column\'s blocks are all taken', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], ['gamma', 'delta'])]);
    select(editor, ['alpha', 0], ['gamma', 2]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['lead', 'mma', 'delta']);
  });

  it('puts typed words where the selection started, in its column', () => {
    const editor = open([columnsBlock(['alpha', 'beta'], ['gamma', 'delta'])]);
    select(editor, ['beta', 2], ['gamma', 2]);
    typeWords(editor, 'X');
    expect(shapeOf(editor.document as never)).toEqual(['[alpha,beX|mma,delta]']);
  });

  it('keeps the body\'s words and the column\'s when a selection runs into a group from above', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], ['gamma'])]);
    select(editor, ['lead', 2], ['alpha', 2]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['le', '[pha|gamma]']);
  });

  it('does the same on Delete', () => {
    const editor = open([columnsBlock(['alpha', 'beta'], ['gamma', 'delta'])]);
    select(editor, ['beta', 2], ['gamma', 2]);
    press(editor, 'Delete');
    expect(shapeOf(editor.document as never)).toEqual(['[alpha,be|mma,delta]']);
  });

  it('takes a group the selection covers whole, joining the body\'s words around it', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], ['gamma']), para('tail')]);
    select(editor, ['lead', 2], ['tail', 2]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['leil']);
  });

  it('keeps the column\'s words and the body\'s when a selection runs out of a group below', () => {
    const editor = open([columnsBlock(['alpha'], ['gamma']), para('tail')]);
    select(editor, ['gamma', 2], ['tail', 2]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['[alpha|ga]', 'il']);
  });

  it('keeps an unselected picture at the top of the column the selection starts in', () => {
    const editor = open([columnsBlock({ blocks: [picture, para('hello')] }, ['world'])]);
    select(editor, ['hello', 0], ['world', 2]);
    press(editor, 'Backspace');
    expect(pictures(editor)).toBe(1);
  });

  it('keeps an unselected picture at the bottom of the column the selection ends in', () => {
    const editor = open([para('lead'), columnsBlock(['alpha'], { blocks: [para('world'), picture] })]);
    select(editor, ['alpha', 0], ['world', 5]);
    press(editor, 'Backspace');
    expect(pictures(editor)).toBe(1);
  });
});

const picture = { type: 'image', props: { url: 'https://example.com/a.png' } };

/**
 * How many pictures the document holds.
 * @param editor - The editor.
 * @returns The count.
 */
function pictures(editor: Editor): number {
  let count = 0;
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'image') count += 1;
    return true;
  });
  return count;
}

describe('a selection from a table in one column into another column (design §5.5)', () => {
  const blocks = (): unknown[] => [
    columnsBlock({ blocks: [para('before'), tableBlock({ rows: [{ cells: ['t1', 't2'] }] })] }, ['bee bop', 'more']),
  ];

  it('takes the table whole and keeps each column\'s other blocks there on Backspace', () => {
    const editor = open(blocks());
    select(editor, ['t2', 1], ['bee bop', 3]);
    press(editor, 'Backspace');
    expect(shapeOf(editor.document as never)).toEqual(['[before| bop,more]']);
  });

  it('keeps the group when a letter is typed over it', () => {
    const editor = open(blocks());
    select(editor, ['t2', 1], ['bee bop', 3]);
    typeWords(editor, 'X');
    const shape = shapeOf(editor.document as never);
    expect(shape).toHaveLength(1);
    expect(shape[0]).toMatch(/^\[.*\|.*\]$/);
  });
});
