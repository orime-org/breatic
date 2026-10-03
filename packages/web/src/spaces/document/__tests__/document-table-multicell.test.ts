// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A9: with several cells selected, the bubble bar's styles reach
 * the words in every one of them, not only in the cell the selection ended in.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { setColour } from '@web/spaces/document/document-colour-run';
import { everyRunCarries, markTypeOf } from '@web/spaces/document/document-style-range';
import { writeStyle } from '@web/spaces/document/document-style-write';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Opens a mounted editor holding a 2 × 2 table.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    {
      type: 'table',
      content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] },
    },
  ] as never);
  return editor;
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The text.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'tableCell' && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * Selects the cells from one to another.
 * @param editor - The editor.
 * @param anchor - The anchor cell's text.
 * @param head - The head cell's text.
 */
function selectCells(editor: Editor, anchor: string, head: string): void {
  const view = editor.prosemirrorView!;
  view.dispatch(
    view.state.tr.setSelection(
      CellSelection.create(view.state.doc, cellOf(editor, anchor), cellOf(editor, head)),
    ),
  );
}

/**
 * The marks on each cell's text, by cell text.
 * @param editor - The editor.
 * @returns Mark names per cell.
 */
function marksByCell(editor: Editor): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name === 'tableCell') {
      const names = new Set<string>();
      node.descendants((child) => {
        child.marks.forEach((mark) => names.add(mark.type.name));
      });
      out[node.textContent] = [...names].sort();
      return false;
    }
    return true;
  });
  return out;
}

describe('styles over several selected cells (A9)', () => {
  it('bold reaches every selected cell', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b2');

    writeStyle(editor, true, ['bold']);

    expect(marksByCell(editor)).toEqual({ a1: ['bold'], b1: ['bold'], a2: ['bold'], b2: ['bold'] });
  });

  it('reads as on only when every selected cell carries it', () => {
    const editor = open();
    const view = editor.prosemirrorView!;
    const a1 = cellOf(editor, 'a1') + 2;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, a1, a1 + 2)));
    writeStyle(editor, true, ['bold']);

    selectCells(editor, 'a1', 'b2');
    const state = editor.prosemirrorState;
    expect(everyRunCarries(state, markTypeOf(state, 'bold')!)).toBe(false);
  });

  it('a text colour reaches every selected cell', () => {
    const editor = open();
    selectCells(editor, 'a1', 'b1');

    setColour(editor, 'textColor', 'blue');

    expect(marksByCell(editor)).toEqual({ a1: ['textColor'], b1: ['textColor'], a2: [], b2: [] });
  });
});
