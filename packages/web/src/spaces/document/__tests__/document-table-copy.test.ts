// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1619 T11, design 5.7: copying from a table whose cells hold blocks.
 * Another app gets a `<table>` whose cells hold the blocks as HTML, and the
 * plain text is the table as the Agent reads it. Words in one cell copy
 * without the table around them. Selected cells copy as a table of those
 * cells, and a cut empties them.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A mounted editor holding a paragraph, a table and a paragraph.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'above' },
    tableBlock({
      rows: [
        {
          cells: [
            { blocks: [{ type: 'heading', props: { level: 2 }, content: 'Title' }, { type: 'paragraph', content: 'more' }] },
            'b1',
          ],
        },
        { cells: ['a2', 'b2'] },
      ],
    }),
    { type: 'paragraph', content: 'below' },
  ] as never);
  // A copy or a cut in the body lands while it holds the focus.
  editor.prosemirrorView.focus();
  return editor;
}

/**
 * Where some words start.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The position.
 */
function at(editor: Editor, words: string): number {
  let found = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === words) found = pos;
    return found < 0;
  });
  return found;
}

/**
 * The position before the cell holding some words.
 * @param editor - The editor.
 * @param words - The words.
 * @returns The position.
 */
function cellOf(editor: Editor, words: string): number {
  const $pos = editor.prosemirrorState.doc.resolve(at(editor, words));
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === 'docTableCell') return $pos.before(depth);
  }
  return -1;
}

/**
 * Fires a copy or a cut and reads what it put on the clipboard.
 * @param editor - The editor.
 * @param type - Copy or cut.
 * @returns The clipboard, by type.
 */
function clip(editor: Editor, type: 'copy' | 'cut' = 'copy'): Record<string, string> {
  const data: Record<string, string> = {};
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      setData: (format: string, value: string) => {
        data[format] = value;
      },
      clearData: () => {
        Object.keys(data).forEach((key) => delete data[key]);
      },
      getData: (format: string) => data[format] ?? '',
    },
  });
  editor.prosemirrorView.dom.dispatchEvent(event);
  return data;
}

describe('copying from a table whose cells hold blocks', () => {
  it('hands another app the table, its cells holding their blocks, and the plain text the Agent reads', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, 'above'), at(editor, 'below') + 5)));

    const data = clip(editor);

    expect(data['text/html']).toContain('<table');
    expect(data['text/html']).toContain('<h2');
    expect(data['text/plain']).toContain('above');
    expect(data['text/plain']).toContain('<table>');
    expect(data['text/plain']).toContain('<h2');
    expect(data['text/plain']).toContain('below');
  });

  it('copies words in one cell without the table around them', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, 'Title'), at(editor, 'more') + 4)));

    const data = clip(editor);

    expect(data['text/html']).not.toContain('<table');
    expect(data['text/html']).toContain('Title');
    expect(data['text/html']).toContain('more');
    expect(data['blocknote/html']).not.toContain('docTable');
    expect(data['text/plain']).not.toContain('|');
  });

  it('copies selected cells as a table of those cells, with their blocks', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'Title'), cellOf(editor, 'b1'))));

    const data = clip(editor);

    expect(data['text/html']).toContain('<table');
    expect(data['text/html']).toContain('<h2');
    expect(data['text/html']).toContain('b1');
    expect(data['text/html']).not.toContain('a2');
    expect(data['text/plain']).toContain('Title');
    expect(data['text/plain']).toContain('b1');
  });

  it('empties the selected cells on a cut, after copying them', () => {
    const editor = open();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, cellOf(editor, 'Title'), cellOf(editor, 'b1'))));

    const data = clip(editor, 'cut');

    expect(data['text/html']).toContain('Title');
    const firstRow: string[] = [];
    let rows = 0;
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'docTableRow') rows += 1;
      if (rows === 1 && node.type.name === 'docTableCell') {
        firstRow.push(String(node.childCount) + ':' + node.textContent);
      }
      return true;
    });
    expect(firstRow).toEqual(['1:', '1:']);
    expect(editor.prosemirrorState.doc.textContent).toContain('a2');
  });
});

describe('copying a selection that starts in the words of the block a table is nested under', () => {
  /**
   * Opens a list item with a table and a line nested under it.
   * @returns The editor.
   */
  const nested = (): Editor => {
    const editor = open();
    editor.replaceBlocks(editor.document, [
      { type: 'bulletListItem', content: 'item', children: [tableBlock({ rows: [{ cells: ['a1', 'b1'] }] }), { type: 'paragraph', content: 'kid' }] },
    ] as never);
    return editor;
  };

  it('carries the item\'s selected words with a selection ending in the table', () => {
    const editor = nested();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, 'item') + 2, at(editor, 'b1') + 1)));

    const data = clip(editor);

    expect(data['text/plain']).toContain('em');
    expect(data['text/plain']).toContain('<table>');
  });

  it('carries the item\'s selected words with a selection over the table to the line under it', () => {
    const editor = nested();
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at(editor, 'item') + 2, at(editor, 'kid') + 2)));

    const data = clip(editor);

    expect(data['text/plain']).toContain('em');
    expect(data['text/plain']).toContain('<table>');
    expect(data['text/plain']).toContain('ki');
  });
});
