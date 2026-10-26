// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Structural selection invariants for the fourteen extension bindings over
 * five body fixtures and their valid starts (inner#1619 T14, design 5.3): no
 * key edits the document or leaves text across one table's cells, and a held
 * table only stops a selection at the body's edge. Six held-table scenarios
 * also pin the exact normalized endpoints; other cases assert only structure.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';

import { documentBodyFragment } from '@breatic/shared/document-body';

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

/** Where a selection starts, as words and offsets for its anchor and head. */
const STARTS = {
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
} satisfies Record<string, [string, number, string, number]>;

type Start = keyof typeof STARTS;

/** A body and the selection starts its words actually support. */
interface Template {
  content: unknown[];
  starts: Start[];
  exact?: Partial<Record<Start, 'both' | 'first-table' | 'second-table' | 'closing' | 'opening'>>;
}

/**
 * There are 36 valid body/start pairs. Bodies without the line above, line
 * below or preceding table omit only starts that name those missing words.
 * Every declared start must resolve; missing fixture words fail the test.
 */
const TEMPLATES: Record<string, Template> = {
  'between lines': {
    content: [{ type: 'paragraph', content: 'lead' }, table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
    starts: ['a caret at the end of the line above', 'a caret at the start of the line below', 'held from above', 'held from below', 'a caret in the first row', 'a caret in the last row', 'held from a cell to the line below', 'held from a cell to the line above'],
    exact: { 'held from above': 'both', 'held from below': 'both' },
  },
  'closing the body': {
    content: [{ type: 'paragraph', content: 'lead' }, table('a1', 'b1', 'a2', 'b2')],
    starts: ['a caret at the end of the line above', 'held from above', 'a caret in the first row', 'a caret in the last row', 'held from a cell to the line above'],
    exact: { 'held from above': 'closing' },
  },
  'opening the body': {
    content: [table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
    starts: ['a caret at the start of the line below', 'held from below', 'a caret in the first row', 'a caret in the last row', 'held from a cell to the line below'],
    exact: { 'held from below': 'opening' },
  },
  'next to another table': {
    content: [{ type: 'paragraph', content: 'lead' }, table('a0', 'b0', 'c0', 'd0'), table('a1', 'b1', 'a2', 'b2'), { type: 'paragraph', content: 'below' }],
    starts: Object.keys(STARTS) as Start[],
    exact: { 'held from one table into the next': 'first-table', 'held from the next table back into the first': 'second-table' },
  },
  'nested under a list item': {
    content: [{ type: 'bulletListItem', content: 'lead', children: [table('a1', 'b1', 'a2', 'b2')] }, { type: 'paragraph', content: 'below' }],
    starts: ['a caret at the end of the line above', 'a caret at the start of the line below', 'held from above', 'held from below', 'a caret in the first row', 'a caret in the last row', 'held from a cell to the line below', 'held from a cell to the line above'],
  },
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

describe.each(Object.entries(TEMPLATES))('selection keys around a table %s', (_template, { content, starts, exact }) => {
  describe.each(starts.map((start) => [start, STARTS[start]] as const))('from %s', (start, [anchorWords, anchorOffset, headWords, headOffset]) => {
    it.each(KEYS)('%s %o preserves the structural selection invariants', (key, mods) => {
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
      const host = document.createElement('div');
      document.body.appendChild(host);
      editor.mount(host);
      mounted.push(editor);
      editor.replaceBlocks(editor.document, content as never);
      const view = editor.prosemirrorView;
      const anchor = at(editor, anchorWords, anchorOffset);
      const head = at(editor, headWords, headOffset);
      expect(anchor, `missing anchor words: ${anchorWords}`).toBeGreaterThanOrEqual(0);
      expect(head, `missing head words: ${headWords}`).toBeGreaterThanOrEqual(0);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
      const before = view.state;
      const held = tableAtLeavingHead(before);

      const event = new KeyboardEvent('keydown', { key, shiftKey: true, ...mods, bubbles: true, cancelable: true });
      view.someProp('handleKeyDown', (f) => f(view, event));

      const { selection, doc } = view.state;
      expect(doc.eq(before.doc)).toBe(true);
      const expected = exact?.[start];
      const back = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home';
      if (expected !== undefined) {
        const unchanged = (expected === 'closing' && !back) || (expected === 'opening' && back);
        const collapse = (expected === 'first-table' && back) || (expected === 'second-table' && !back);
        if (unchanged) expect(selection.eq(before.selection)).toBe(true);
        else {
          expect(selection.anchor).toBe(before.selection.anchor);
          expect(selection.head).toBe(collapse ? before.selection.anchor : at(editor, back ? 'lead' : 'below', back ? 4 : 0));
        }
      }
      const from = tableAround(selection.$from);
      const to = tableAround(selection.$to);
      const acrossCells = selection instanceof TextSelection && from !== null && from.pos === to?.pos && !selection.$from.sameParent(selection.$to);
      expect(acrossCells).toBe(false);
      if (held !== null && selection.eq(before.selection)) {
        // Only a table at the body's end that way, with the other end outside
        // it, leaves nothing to reach.
        const group = before.doc.firstChild!;
        expect(back ? group.firstChild : group.lastChild).toBe(held.node);
      }
    });
  });
});
