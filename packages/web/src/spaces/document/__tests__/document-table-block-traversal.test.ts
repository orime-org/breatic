// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A14: a table is one block to every command that walks the blocks
 * under a selection. Block types never reach into it, the quote row takes the
 * whole table, and typing a shorthand in a cell stays text in that cell.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { canRunBlockType, runBlockType } from '@web/spaces/document/document-block-run';
import {
  blocksUnder,
  blocksUnderFor,
  CONTENT_ROWS,
  tickedOver,
} from '@web/spaces/document/document-block-ticks';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/** A 2 × 2 table block. */
const TABLE = {
  type: 'table',
  content: {
    type: 'tableContent',
    rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }],
  },
};

/**
 * Opens a mounted editor holding the given blocks.
 * @param blocks - The blocks to write.
 * @returns The editor.
 */
function open(blocks: readonly unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * Where a piece of text starts.
 * @param doc - The document.
 * @param text - The text to find.
 * @returns The position of its first character.
 */
function posOf(doc: PMNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text?.includes(text) === true) {
      found = pos + node.text.indexOf(text);
    }
    return found < 0;
  });
  if (found < 0) {
    throw new Error(`no "${text}" in the document`);
  }
  return found;
}

/**
 * Puts a text selection between two pieces of text.
 * @param editor - The editor.
 * @param from - Text the selection starts at.
 * @param to - Text the selection ends after.
 */
function select(editor: Editor, from: string, to: string): void {
  const view = editor.prosemirrorView!;
  const doc = view.state.doc;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(doc, posOf(doc, from), posOf(doc, to) + to.length),
    ),
  );
}

/**
 * The table's rows as the text of each cell.
 * @param editor - The editor.
 * @returns One array of cell texts per row.
 */
function cells(editor: Editor): string[][] {
  let table: PMNode | null = null;
  editor.prosemirrorState.doc.descendants((node) => {
    if (table === null && node.type.name === 'table') {
      table = node;
    }
    return table === null;
  });
  if (table === null) {
    throw new Error('no table');
  }
  const rows: string[][] = [];
  (table as PMNode).forEach((row) => {
    const texts: string[] = [];
    row.forEach((cell) => texts.push(cell.textContent));
    rows.push(texts);
  });
  return rows;
}

/**
 * The block types, top to bottom.
 * @param editor - The editor.
 * @returns One type per top-level block.
 */
function types(editor: Editor): string[] {
  return (editor.document as unknown as { type: string }[]).map((b) => b.type);
}

/**
 * Types text one character at a time through the input rules.
 * @param editor - The editor.
 * @param text - What to type.
 */
function type(editor: Editor, text: string): void {
  const view = editor.prosemirrorView!;
  for (const character of text) {
    const { from, to } = view.state.selection;
    const claimed =
      view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, character, () => view.state.tr),
      ) ?? false;
    if (!claimed) {
      view.dispatch(view.state.tr.insertText(character, from, to));
    }
  }
}

describe('a table under a selection', () => {
  it('is no block for the rows that are not quote, from inside a cell', () => {
    const editor = open([TABLE]);
    select(editor, 'a1', 'a1');
    const { doc, selection } = editor.prosemirrorState;

    expect(blocksUnder(doc, selection)).toEqual([]);
    expect(blocksUnderFor(doc, selection, 'heading-1')).toEqual([]);
    expect(canRunBlockType(editor)).toBe(false);
  });

  it('is one block for the quote row', () => {
    const editor = open([TABLE]);
    select(editor, 'a1', 'b2');
    const { doc, selection } = editor.prosemirrorState;

    const covered = blocksUnderFor(doc, selection, 'quote');
    expect(covered.map(({ node }) => node.type.name)).toEqual(['table']);
  });

  it('leaves the table alone for every content row pressed in a cell', () => {
    for (const row of CONTENT_ROWS) {
      const editor = open([TABLE]);
      select(editor, 'b1', 'b1');

      expect(() => runBlockType(editor, row)).not.toThrow();
      expect(types(editor)).toEqual(['table']);
      expect(cells(editor)).toEqual([
        ['a1', 'b1'],
        ['a2', 'b2'],
      ]);
      editor.unmount();
      mounted.pop();
    }
  });

  it('quotes and unquotes the whole table from a cell', () => {
    const editor = open([TABLE]);
    select(editor, 'a2', 'a2');

    runBlockType(editor, 'quote');
    expect((editor.document[0] as { props: { quoted: boolean } }).props.quoted).toBe(true);
    expect(cells(editor)).toEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);

    runBlockType(editor, 'quote');
    expect((editor.document[0] as { props: { quoted: boolean } }).props.quoted).toBe(false);
  });

  it('converts the paragraphs around a table and leaves the table', () => {
    const editor = open([
      { type: 'paragraph', content: 'above' },
      TABLE,
      { type: 'paragraph', content: 'below' },
    ]);
    select(editor, 'above', 'below');
    const { doc, selection } = editor.prosemirrorState;
    expect(blocksUnderFor(doc, selection, 'heading-1').map(({ node }) => node.type.name)).toEqual([
      'paragraph',
      'paragraph',
    ]);

    runBlockType(editor, 'heading-1');

    expect(types(editor)).toEqual(['heading', 'table', 'heading']);
    expect(cells(editor)).toEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);
  });

  it('does not untick a row the paragraphs around it share', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'above' },
      TABLE,
      { type: 'heading', props: { level: 2 }, content: 'below' },
    ]);
    select(editor, 'above', 'below');
    const { doc, selection } = editor.prosemirrorState;

    expect(tickedOver(doc, selection).has('heading-2')).toBe(true);
  });

  it('keeps three dashes typed in a cell as text', () => {
    const editor = open([TABLE]);
    const view = editor.prosemirrorView!;
    // An emptied cell, so the dashes start the line the rule looks at.
    const at = posOf(view.state.doc, 'b2');
    const tr = view.state.tr.delete(at, at + 2);
    tr.setSelection(TextSelection.create(tr.doc, at));
    view.dispatch(tr);

    type(editor, '---');

    expect(types(editor)).toEqual(['table']);
    expect(cells(editor)[1]).toEqual(['a2', '---']);
  });
});
