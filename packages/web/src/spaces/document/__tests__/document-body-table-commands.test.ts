// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentBodyFragment, readBodyTree } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { mergeSelectedCells, splitCellAt } from '@web/spaces/document/document-table-run';
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

describe('table commands through the actual records binding', () => {
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
