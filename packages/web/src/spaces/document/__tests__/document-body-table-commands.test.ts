// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment, readBodyTree } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { insertColumn, insertRow, mergeSelectedCells, splitCellAt } from '@web/spaces/document/document-table-run';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

const opened: Array<{
  editor: ReturnType<typeof buildDocumentEditor>;
  runtime: ReturnType<typeof createDocumentBodyRuntime>;
  undo: ReturnType<typeof createDocumentUndo>;
  host: HTMLElement;
}> = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const entry of opened.splice(0).reverse()) {
      entry.editor.unmount();
      entry.runtime.dispose();
      entry.undo.manager.destroy();
      entry.host.remove();
    }
    cleanupCodecFixtures();
  });
});

/** Mounts the production records binding and its original native history. @throws {Error} If setup fails. */
function open(table: TableInput, separateHistory = true): typeof opened[number] & { doc: ReturnType<typeof codecFixture> } {
  const doc = codecFixture([{ id: 'lead', text: 'lead' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    body: { document: 'records-table-commands', runtime, history: undo.manager, origin },
    extensions: [undo.extension],
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  opened.push({ editor, runtime, undo, host });
  act(() => {
    editor.mount(host);
    editor.insertBlocks([tableBlock(table)] as never, 'lead', 'after');
  });
  expect(runtime.read().status).toBe('active');
  if (separateHistory) {
    undo.manager.clear();
    undo.manager.stopCapturing();
  }
  return { editor, runtime, undo, host, doc };
}

/** Reads physical table cells without matching repeated text or IDs. @throws {never} */
function cells(doc: PMNode): Array<{ node: PMNode; pos: number }> {
  const result: Array<{ node: PMNode; pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.tableRole === 'cell' || node.type.spec.tableRole === 'header_cell') result.push({ node, pos });
  });
  return result;
}

/** Reads the single actual table, including stable row identities. @throws {Error} If the table is absent. */
function tableOf(doc: PMNode): PMNode {
  let table: PMNode | undefined;
  doc.descendants((node) => { if (node.type.spec.tableRole === 'table') table = node; });
  if (table === undefined) throw new Error('Expected one table');
  return table;
}

/** Checks the complete persisted projection against the accepted editor result. @throws {Error} If the binding is absent. */
function expectPublished(body: ReturnType<typeof open>): void {
  expect(body.runtime.read().status).toBe('active');
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('Expected the records binding');
  expect(binding.read().doc.toJSON()).toEqual(body.editor.prosemirrorState.doc.toJSON());
  expect(TableMap.get(tableOf(body.editor.prosemirrorState.doc)).problems).toBeNull();
}

describe('table commands through the actual records binding', () => {
  for (const header of [false, true]) {
    for (const axis of ['row', 'column'] as const) {
      for (const slot of [0, 1, 2]) {
        it(`keeps old identities when inserting a ${axis} at slot ${slot} with headers ${header}`, () => {
          const body = open({ headerRows: header ? 1 : 0, rows: [{ cells: ['A', 'B'] }, { cells: ['C', 'D'] }] });
          const { editor, undo, doc } = body;
          const before = editor.prosemirrorState.doc;
          const originalCells = cells(before);
          const table = tableOf(before);
          const native = readBodyTree(doc);
          if (native.status !== 'ready') throw new Error('Expected native source');
          const originalUnits = native.view.units.map((unit) => [unit.id, unit.source, unit.value]);
          act(() => {
            if (axis === 'row') insertRow(editor, originalCells[slot === 2 ? 2 : 0].pos, slot === 0 ? 'above' : 'below');
            else insertColumn(editor, originalCells[slot === 2 ? 1 : 0].pos, slot === 0 ? 'left' : 'right');
          });
          expectPublished(body);
          const after = editor.prosemirrorState.doc;
          const afterCells = cells(after);
          const actualTable = tableOf(after);
          expect([TableMap.get(actualTable).width, TableMap.get(actualTable).height]).toEqual(axis === 'row' ? [2, 3] : [3, 2]);
          for (const original of originalCells) {
            expect(afterCells.find(({ node }) => node.attrs['id'] === original.node.attrs['id'])?.node.toJSON()).toEqual(original.node.toJSON());
          }
          expect(new Set(afterCells.map(({ node }) => node.attrs['id'])).size).toBe(6);
          expect(actualTable.attrs).toEqual(table.attrs);
          const oldRows = Array.from({ length: table.childCount }, (_, index) => table.child(index).attrs['id']);
          expect(Array.from({ length: actualTable.childCount }, (_, index) => actualTable.child(index).attrs['id']).filter((id) => oldRows.includes(id))).toEqual(oldRows);
          const expectedWords = axis === 'row'
            ? [['', '', 'A', 'B', 'C', 'D'], ['A', 'B', '', '', 'C', 'D'], ['A', 'B', 'C', 'D', '', '']][slot]
            : [['', 'A', 'B', '', 'C', 'D'], ['A', '', 'B', 'C', '', 'D'], ['A', 'B', '', 'C', 'D', '']][slot];
          expect(afterCells.map(({ node }) => node.textContent)).toEqual(expectedWords);
          const afterNative = readBodyTree(doc);
          if (afterNative.status !== 'ready') throw new Error('Expected committed source');
          expect(afterNative.view.units.map((unit) => [unit.id, unit.source, unit.value])).toEqual(originalUnits);
          expect(undo.manager.undoStack).toHaveLength(1);
          act(() => { editor.undo(); });
          expect(editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
          act(() => { editor.redo(); });
          expect(editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
          expectPublished(body);
        });
      }
    }
  }

  it('adds a new row from the final cell with the real Tab handler', () => {
    const body = open({ rows: [{ cells: ['A', 'B'] }, { cells: ['C', 'D'] }] });
    const { editor, undo } = body;
    const view = editor.prosemirrorView;
    const before = view.state.doc;
    const last = cells(before).at(-1)!;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, last.pos + last.node.nodeSize - 3))));
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      expect(view.someProp('handleKeyDown', (handler) => handler(view, event))).toBe(true);
    });
    expectPublished(body);
    expect(cells(view.state.doc).map(({ node }) => node.textContent)).toEqual(['A', 'B', 'C', 'D', '', '']);
    expect(undo.manager.undoStack).toHaveLength(1);
    act(() => { editor.undo(); });
    expect(view.state.doc.toJSON()).toEqual(before.toJSON());
  });

  it('splits a partial merge without borrowing the untouched next cell identity', () => {
    const body = open({ rows: [{ cells: ['A', 'X', 'B'] }] });
    const { editor, undo } = body;
    const view = editor.prosemirrorView;
    const initial = cells(view.state.doc);
    const untouched = initial[2].node;
    act(() => view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, initial[0].pos, initial[1].pos))));
    act(() => mergeSelectedCells(editor));
    expectPublished(body);
    undo.manager.clear();
    undo.manager.stopCapturing();
    const before = view.state.doc;
    act(() => splitCellAt(editor, cells(view.state.doc)[0].pos));
    expectPublished(body);
    const after = view.state.doc;
    expect(cells(after).map(({ node }) => node.textContent)).toEqual(['AX', '', 'B']);
    expect(cells(after)[2].node.toJSON()).toEqual(untouched.toJSON());
    expect(new Set(cells(after).map(({ node }) => node.attrs['id'])).size).toBe(3);
    expect(undo.manager.undoStack).toHaveLength(1);
    act(() => { editor.undo(); });
    expect(view.state.doc.toJSON()).toEqual(before.toJSON());
    act(() => { editor.redo(); });
    expect(view.state.doc.toJSON()).toEqual(after.toJSON());
  });

  for (const header of [false, true]) {
    for (const [width, height] of [[2, 1], [1, 2], [2, 2]] as const) {
      it(`splits a ${width} by ${height} ${header ? 'header' : 'ordinary'} cell and restores it with one undo`, () => {
        const { editor, runtime, undo, doc } = open({
          headerRows: header ? height : 0,
          rows: Array.from({ length: height }, (_, row) => ({ cells: Array.from({ length: width }, (_, column) => row === 0 && column === 0 ? {
            blocks: [{ id: 'heading', type: 'heading', content: 'AA' }, { id: 'paragraph', type: 'paragraph', content: 'BB' }],
          } : '') })),
        });
        const view = editor.prosemirrorView;
        const unmerged = cells(view.state.doc);
        act(() => view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, unmerged[0].pos, unmerged.at(-1)!.pos))));
        act(() => mergeSelectedCells(editor));
        expect(runtime.read().status).toBe('active');
        expect(cells(view.state.doc)).toHaveLength(1);
        undo.manager.clear();
        undo.manager.stopCapturing();
        const before = editor.prosemirrorState.doc.toJSON();
        const native = readBodyTree(doc);
        expect(native.status).toBe('ready');
        if (native.status !== 'ready') throw new Error('Expected the complete fixture');
        const originalUnits = native.view.units.map((unit) => unit.id);
        const originalCell = cells(editor.prosemirrorState.doc)[0];
        act(() => splitCellAt(editor, originalCell.pos));

        expect(runtime.read().status).toBe('active');
        const afterCells = cells(editor.prosemirrorState.doc);
        expect(afterCells).toHaveLength(width * height);
        expect(afterCells.map(({ node }) => node.textContent)).toEqual(['AABB', ...Array<string>(width * height - 1).fill('')]);
        expect(afterCells[0].node.attrs['id']).toBe(originalCell.node.attrs['id']);
        expect(new Set(afterCells.map(({ node }) => node.attrs['id'])).size).toBe(width * height);
        expect(afterCells.map(({ node }) => node.type.name)).toEqual(Array<string>(width * height).fill(header ? 'docTableHeader' : 'docTableCell'));
        const after = editor.prosemirrorState.doc.toJSON();
        const read = readBodyTree(doc);
        expect(read.status).toBe('ready');
        if (read.status !== 'ready') throw new Error('Expected a complete split');
        expect(read.view.units.map((unit) => unit.id)).toEqual(originalUnits);
        expect(undo.manager.undoStack).toHaveLength(1);
        act(() => { editor.undo(); });
        expect(editor.prosemirrorState.doc.toJSON()).toEqual(before);
        act(() => { editor.redo(); });
        expect(editor.prosemirrorState.doc.toJSON()).toEqual(after);
      });
    }
  }

  it.each(['Backspace', 'Delete'])('removes an empty table with %s and restores it with one native undo', (key) => {
    const { editor, runtime, undo } = open({ rows: [{ cells: ['', ''] }, { cells: ['', ''] }] });
    const view = editor.prosemirrorView;
    const before = view.state.doc.toJSON();
    const positions = cells(view.state.doc);
    act(() => view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, positions[0].pos, positions.at(-1)!.pos))));
    act(() => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      expect(view.someProp('handleKeyDown', (handler) => handler(view, event))).toBe(true);
    });
    expect(runtime.read().status).toBe('active');
    expect(cells(view.state.doc)).toHaveLength(0);
    expect(undo.manager.undoStack).toHaveLength(1);
    act(() => { editor.undo(); });
    expect(view.state.doc.toJSON()).toEqual(before);
  });

  it.each(['Backspace', 'Delete'])('separates %s of a newly inserted empty table from its insertion capture', (key) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { editor, undo } = open({ rows: [{ cells: ['', ''] }, { cells: ['', ''] }] }, false);
    const view = editor.prosemirrorView;
    const before = view.state.doc.toJSON();
    expect(undo.manager.undoStack).toHaveLength(1);
    const positions = cells(view.state.doc);
    act(() => view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, positions[0].pos, positions.at(-1)!.pos))));
    act(() => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      expect(view.someProp('handleKeyDown', (handler) => handler(view, event))).toBe(true);
    });
    expect(cells(view.state.doc)).toHaveLength(0);
    expect(undo.manager.undoStack).toHaveLength(2);
    act(() => { editor.undo(); });
    expect(view.state.doc.toJSON()).toEqual(before);
  });
});
