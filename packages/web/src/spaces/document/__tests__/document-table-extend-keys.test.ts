// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Every key that extends a selection, from every place around a table, in
 * every shape of body a table stands in (inner#1619 T14, design 5.3): no key
 * edits the document, none leaves a text selection across one table's cells,
 * and none is stuck on a table the selection holds whole.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { tableAtLeavingHead } from '@web/spaces/document/document-table-leave-selection';
import { tableAround } from '@web/spaces/document/document-table-nodes';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/** A 2 × 2 table of the given words. */
const table = (a: string, b: string, c: string, d: string): unknown => tableBlock({ rows: [{ cells: [a, b] }, { cells: [c, d] }] });

/** The bodies a table stands in. */
const TEMPLATES: Record<string, unknown[]> = {
  'between lines': [{ type: 'paragraph', content: 'lead' }, table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
  'closing the body': [{ type: 'paragraph', content: 'lead' }, table('a1', 'b1', 'a2', 'b2')],
  'opening the body': [table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
  'next to another table': [{ type: 'paragraph', content: 'lead' }, table('a0', 'b0', 'c0', 'd0'), table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
  'nested under a list item': [{ type: 'bulletListItem', content: 'lead', children: [table('a1', 'b1', 'a2', 'b2')] }, { type: 'paragraph', content: 'below' }],
};

/** Where a selection starts, as words and offsets for its anchor and head. */
const STARTS: Record<string, [string, number, string, number]> = {
  'a caret at the end of the line above': ['lead', 4, 'lead', 4],
  'a caret at the start of the line below': ['below', 0, 'below', 0],
  'held from above': ['lead', 2, 'a2', 1],
  'held from below': ['below', 3, 'b1', 1],
  'a caret in the first row': ['a1', 1, 'a1', 1],
  'a caret in the last row': ['b2', 1, 'b2', 1],
  'held from a cell to the line below': ['b1', 1, 'below', 2],
  'held from a cell to the line above': ['a2', 1, 'lead', 2],
  'held from one table into the next': ['b0', 1, 'a2', 1],
  'held from the next table back into the first': ['a2', 1, 'b0', 1],
};

/** Every key that extends a selection, with its modifiers. */
const KEYS: [string, KeyboardEventInit][] = [
  ['ArrowLeft', {}], ['ArrowRight', {}], ['ArrowUp', {}], ['ArrowDown', {}],
  ['ArrowLeft', { altKey: true }], ['ArrowRight', { altKey: true }], ['ArrowUp', { altKey: true }], ['ArrowDown', { altKey: true }],
  ['ArrowLeft', { ctrlKey: true }], ['ArrowRight', { ctrlKey: true }],
  ['ArrowLeft', { metaKey: true }], ['ArrowRight', { metaKey: true }],
  ['Home', {}], ['End', {}],
];

/**
 * A position in some words, or -1 when the body has none.
 * @param editor - The editor.
 * @param words - The words.
 * @param offset - How far into them.
 * @returns The position.
 */
function at(editor: Editor, words: string, offset: number): number {
  let found = -1;
  editor.prosemirrorView.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text === words) found = pos + offset;
    return found < 0;
  });
  return found;
}

describe.each(Object.entries(TEMPLATES))('selection keys around a table %s', (_template, content) => {
  describe.each(Object.entries(STARTS))('from %s', (_start, [anchorWords, anchorOffset, headWords, headOffset]) => {
    it.each(KEYS)('%s %o edits nothing, cuts no table and is not stuck', (key, mods) => {
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
      const host = document.createElement('div');
      document.body.appendChild(host);
      editor.mount(host);
      mounted.push(editor);
      editor.replaceBlocks(editor.document, content as never);
      const view = editor.prosemirrorView;
      const anchor = at(editor, anchorWords, anchorOffset);
      const head = at(editor, headWords, headOffset);
      if (anchor < 0 || head < 0) return;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
      const before = view.state;
      const held = tableAtLeavingHead(before);

      const event = new KeyboardEvent('keydown', { key, shiftKey: true, ...mods, bubbles: true, cancelable: true });
      view.someProp('handleKeyDown', (f) => f(view, event));

      const { selection, doc } = view.state;
      expect(doc.eq(before.doc)).toBe(true);
      const from = tableAround(selection.$from);
      const to = tableAround(selection.$to);
      const acrossCells = selection instanceof TextSelection && from !== null && from.pos === to?.pos && !selection.$from.sameParent(selection.$to);
      expect(acrossCells).toBe(false);
      if (held !== null && selection.eq(before.selection)) {
        // Only a table at the body's end that way, with the other end outside
        // it, leaves nothing to reach.
        const back = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home';
        const group = before.doc.firstChild!;
        expect(back ? group.firstChild : group.lastChild).toBe(held.node);
      }
    });
  });
});
