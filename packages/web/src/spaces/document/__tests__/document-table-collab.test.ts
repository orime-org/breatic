// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1126 A17: two people editing one table at the same time end up with
 * the same table, with every word either of them typed.
 *
 * Each side works on its own copy first and the two copies are exchanged
 * afterwards, which is what a collaborator's edit arriving mid-way looks like:
 * neither saw the other's change when they made their own.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { moveToGap, startTableDrag, dragSourceOf } from '@web/spaces/document/document-table-drag';
import {
  deleteColumnAt,
  deleteRowAt,
  insertColumn,
  insertRow,
  mergeSelectedCells,
} from '@web/spaces/document/document-table-run';
import { setTableTarget, tableTargetOf } from '@web/spaces/document/document-table-target';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  for (const editor of mounted.splice(0)) {
    editor.unmount();
  }
  document.body.innerHTML = '';
});

/**
 * Mounts an editor on a document.
 * @param doc - The Yjs document.
 * @returns The editor.
 */
function mount(doc: Y.Doc): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  return editor;
}

/** Two editors whose documents are exchanged only when asked. */
interface Pair {
  readonly ours: Editor;
  readonly theirs: Editor;
  /** Exchanges every change made since the last exchange, both ways. */
  readonly sync: () => void;
}

/**
 * Two editors on one 3 × 3 table, in step with each other.
 * @returns The pair.
 */
function pair(): Pair {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const ours = mount(a);
  const theirs = mount(b);
  ours.replaceBlocks(ours.document, [
    { type: 'paragraph', content: 'lead' },
    {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: ['a1', 'b1', 'c1'] },
          { cells: ['a2', 'b2', 'c2'] },
          { cells: ['a3', 'b3', 'c3'] },
        ],
      },
    },
  ] as never);
  /** Exchanges until neither side has anything the other lacks. */
  const sync = (): void => {
    for (let round = 0; round < 5; round += 1) {
      const toB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
      const toA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
      Y.applyUpdate(b, toB, 'peer');
      Y.applyUpdate(a, toA, 'peer');
      const settled =
        Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)).length <= 2 &&
        Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)).length <= 2;
      if (settled) return;
    }
  };
  sync();
  return { ours, theirs, sync };
}

/**
 * Where a cell holding some text starts.
 * @param editor - The editor.
 * @param text - The cell's words.
 * @returns The position before the cell.
 */
function cellOf(editor: Editor, text: string): number {
  let at = -1;
  editor.prosemirrorState.doc.descendants((node, pos) => {
    const role = node.type.spec['tableRole'] as string | undefined;
    if (at < 0 && (role === 'cell' || role === 'header_cell') && node.textContent === text) at = pos;
    return at < 0;
  });
  return at;
}

/**
 * Types into a cell, after its words.
 * @param editor - The editor.
 * @param cell - The cell's words now.
 * @param text - What to type.
 */
function typeInto(editor: Editor, cell: string, text: string): void {
  const view = editor.prosemirrorView!;
  const pos = cellOf(editor, cell);
  const end = pos + 1 + view.state.doc.nodeAt(pos)!.content.size - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)).insertText(text));
}

/**
 * The tables as cell texts, each row as many cells as it has.
 * @param editor - The editor.
 * @returns One grid per table.
 */
function grids(editor: Editor): string[][][] {
  const found: string[][][] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name !== 'table') return true;
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells);
    });
    found.push(rows);
    return false;
  });
  return found;
}

/**
 * Whether every table is well formed: no row short of the others, no cell
 * overlapping another, merged cells counted by their spans.
 * @param editor - The editor.
 * @returns True when the table plugin finds nothing to repair.
 */
function rectangular(editor: Editor): boolean {
  let ok = true;
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.type.name !== 'table') return true;
    if (TableMap.get(node).problems !== null) ok = false;
    return false;
  });
  return ok;
}

/**
 * Asserts both sides hold the same document, rectangular, and returns its tables.
 * @param p - The pair.
 * @returns The tables.
 */
function converged(p: Pair): string[][][] {
  expect(p.theirs.prosemirrorState.doc.toJSON()).toEqual(p.ours.prosemirrorState.doc.toJSON());
  expect(rectangular(p.ours)).toBe(true);
  return grids(p.ours);
}

describe('two people on one table (A17)', () => {
  it('keeps what each typed while the other adds a row and a column', () => {
    const p = pair();

    typeInto(p.ours, 'b2', '!');
    insertRow(p.ours, cellOf(p.ours, 'a1'), 'above');
    typeInto(p.theirs, 'c3', '?');
    insertColumn(p.theirs, cellOf(p.theirs, 'c1'), 'right');
    p.sync();

    const [table] = converged(p);
    const words = table!.flat();
    expect(words).toContain('b2!');
    expect(words).toContain('c3?');
    expect(table).toHaveLength(4);
    expect(table![1]).toHaveLength(4);
  });

  it('agrees when one deletes a row and the other a column', () => {
    const p = pair();

    deleteRowAt(p.ours, cellOf(p.ours, 'a2'));
    deleteColumnAt(p.theirs, cellOf(p.theirs, 'b1'));
    p.sync();

    expect(converged(p)).toEqual([[['a1', 'c1'], ['a3', 'c3']]]);
  });

  it('keeps the words typed into a row the other deletes out of the table, and nothing breaks', () => {
    const p = pair();

    typeInto(p.ours, 'a2', 'x');
    deleteRowAt(p.theirs, cellOf(p.theirs, 'a2'));
    p.sync();

    const [table] = converged(p);
    expect(table!.flat()).not.toContain('a2');
  });

  it('agrees when one merges cells while the other types into them', () => {
    const p = pair();
    const view = p.ours.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(p.ours, 'a1'), cellOf(p.ours, 'b2')),
      ),
    );

    mergeSelectedCells(p.ours);
    typeInto(p.theirs, 'c1', '+');
    p.sync();

    const [table] = converged(p);
    expect(table![0]).toEqual(['a1b1a2b2', 'c1+']);
  });

  it('agrees, and stays a table, when one merges cells the other is typing into', () => {
    // Two people changing the same cells at once is outside what we promise
    // (user 2026-09-29): the letter typed into a cell the merge took away goes
    // with that cell, as it does with a deleted row. What holds is that both
    // sides end up with the same, well-formed table.
    const p = pair();
    const view = p.ours.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(p.ours, 'a1'), cellOf(p.ours, 'b2')),
      ),
    );

    mergeSelectedCells(p.ours);
    typeInto(p.theirs, 'b1', '+');
    p.sync();

    expect(converged(p)[0]).toHaveLength(3);
  });

  it('agrees when both drag lines at the same time', () => {
    const p = pair();

    moveToGap(p.ours, cellOf(p.ours, 'a1'), 'row', 3);
    moveToGap(p.theirs, cellOf(p.theirs, 'a1'), 'column', 3);
    p.sync();

    const [table] = converged(p);
    expect(table!.flat().sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3']);
  });

  it('sends a dragged column width to the other side', () => {
    const p = pair();
    const view = p.ours.prosemirrorView!;
    const tr = view.state.tr;
    for (const name of ['a1', 'a2', 'a3']) {
      const pos = cellOf(p.ours, name);
      tr.setNodeMarkup(pos, undefined, { ...view.state.doc.nodeAt(pos)!.attrs, colwidth: [240] });
    }
    view.dispatch(tr);
    p.sync();

    const cell = p.theirs.prosemirrorState.doc.nodeAt(cellOf(p.theirs, 'a1'))!;
    expect(cell.attrs['colwidth']).toEqual([240]);
  });
});

describe('cells selected while the other side edits (A17)', () => {
  it('stay selected as cells when the other side types before the table', () => {
    const p = pair();
    const view = p.ours.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, cellOf(p.ours, 'a1'), cellOf(p.ours, 'b2')),
      ),
    );

    const peer = p.theirs.prosemirrorView!;
    peer.dispatch(peer.state.tr.insertText('more ', 1));
    p.sync();

    const { selection } = p.ours.prosemirrorState;
    expect(selection).toBeInstanceOf(CellSelection);
    const cells: string[] = [];
    (selection as CellSelection).forEachCell((cell) => cells.push(cell.textContent));
    expect(cells).toEqual(['a1', 'b1', 'a2', 'b2']);
  });
});

describe('a menu held open while the other side edits (A17)', () => {
  /**
   * The words of the cell our menu holds.
   * @param editor - Our editor.
   * @returns Them, or null with no target.
   */
  function held(editor: Editor): string | null {
    const pos = tableTargetOf(editor.prosemirrorState);
    return pos === null ? null : (editor.prosemirrorState.doc.nodeAt(pos)?.textContent ?? null);
  }

  it('keeps its cell when the other side types before the table', () => {
    const p = pair();
    setTableTarget(p.ours.prosemirrorView!, cellOf(p.ours, 'b2'));

    const peer = p.theirs.prosemirrorView!;
    peer.dispatch(peer.state.tr.insertText('more ', 1));
    p.sync();

    expect(held(p.ours)).toBe('b2');
  });

  it('keeps its cell when the other side types into it', () => {
    const p = pair();
    setTableTarget(p.ours.prosemirrorView!, cellOf(p.ours, 'b2'));

    typeInto(p.theirs, 'b2', '!');
    p.sync();

    expect(held(p.ours)).toBe('b2!');
  });

  it('keeps its cell when the other side adds a row above it', () => {
    const p = pair();
    setTableTarget(p.ours.prosemirrorView!, cellOf(p.ours, 'b2'));

    insertRow(p.theirs, cellOf(p.theirs, 'a1'), 'above');
    p.sync();

    expect(held(p.ours)).toBe('b2');
  });

  it('lets go when the other side deletes its row', () => {
    const p = pair();
    setTableTarget(p.ours.prosemirrorView!, cellOf(p.ours, 'b2'));

    deleteRowAt(p.theirs, cellOf(p.theirs, 'a2'));
    p.sync();

    expect(tableTargetOf(p.ours.prosemirrorState)).toBeNull();
  });

  it('keeps following its cell through our own edit after a remote one', () => {
    const p = pair();
    setTableTarget(p.ours.prosemirrorView!, cellOf(p.ours, 'b2'));
    typeInto(p.theirs, 'a1', '#');
    p.sync();

    insertRow(p.ours, cellOf(p.ours, 'a1#'), 'above');
    typeInto(p.theirs, 'c3', '#');
    p.sync();

    expect(held(p.ours)).toBe('b2');
  });
});

describe('a drag while the other side changes the table (A17)', () => {
  it('keeps going when the other side types elsewhere', () => {
    const p = pair();
    startTableDrag(p.ours.prosemirrorView!, 'row', cellOf(p.ours, 'a2'));

    const peer = p.theirs.prosemirrorView!;
    peer.dispatch(peer.state.tr.insertText('more ', 1));
    p.sync();

    const source = dragSourceOf(p.ours.prosemirrorState);
    expect(source).not.toBeNull();
    expect(p.ours.prosemirrorState.doc.nodeAt(source!.cellPos)?.textContent).toBe('a2');
  });

  it('drops the row it started on after the other side adds a column', () => {
    const p = pair();
    startTableDrag(p.ours.prosemirrorView!, 'row', cellOf(p.ours, 'a2'));

    insertColumn(p.theirs, cellOf(p.theirs, 'a1'), 'left');
    p.sync();
    moveToGap(p.ours, dragSourceOf(p.ours.prosemirrorState)!.cellPos, 'row', 0);
    p.sync();

    const [table] = converged(p);
    expect(table![0]!.slice(1)).toEqual(['a2', 'b2', 'c2']);
  });

  it('gives the drag up when the other side deletes the row it started on', () => {
    const p = pair();
    startTableDrag(p.ours.prosemirrorView!, 'row', cellOf(p.ours, 'a2'));

    deleteRowAt(p.theirs, cellOf(p.theirs, 'a2'));
    p.sync();

    expect(dragSourceOf(p.ours.prosemirrorState)).toBeNull();
  });

  it('gives the drag up when the other side deletes the whole table', () => {
    const p = pair();
    startTableDrag(p.ours.prosemirrorView!, 'column', cellOf(p.ours, 'b1'));

    p.theirs.removeBlocks([(p.theirs.document[1] as { id: string }).id]);
    p.sync();

    expect(dragSourceOf(p.ours.prosemirrorState)).toBeNull();
    expect(grids(p.ours)).toEqual([]);
  });
});
