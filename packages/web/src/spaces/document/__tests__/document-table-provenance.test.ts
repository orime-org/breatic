// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { replayBodyJournal } from '@web/spaces/document/document-body-journal';
import {
  BODY_OPERATION_META,
  bodyOperations,
  type BodyTransferRange,
} from '@web/spaces/document/document-body-provenance';
import { mergeSelectedCells, moveLineAt, splitCellAt } from '@web/spaces/document/document-table-run';
import {
  bodyLabels,
  initialBodyUnits,
} from '@web/spaces/document/__tests__/document-body-provenance-fixtures';
import { tableBlock, type TableInput } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const opened: { readonly editor: Editor; readonly doc: Y.Doc; readonly host: HTMLElement }[] = [];

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.doc.destroy();
      body.host.remove();
    }
  });
});

/** Opens the production factory over initialized body bytes. @throws {Error} If a fixture is rejected. */
function open(table: TableInput): Editor {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  opened.push({ editor, doc, host });
  act(() => {
    editor.mount(host);
    editor.replaceBlocks(editor.document, [
      { id: 'lead', type: 'paragraph', content: 'Z' },
      tableBlock(table),
    ] as never);
  });
  return editor;
}

/** Finds physical cells independently of their repeated text. @throws {never} */
function cells(doc: PMNode): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec['tableRole'] === 'cell' || node.type.spec['tableRole'] === 'header_cell') positions.push(pos);
  });
  return positions;
}

/** Captures the actual producer dispatch without replacing its command or steps. @throws {Error} If no single root is dispatched. */
function capture(editor: Editor, command: () => void): Transaction {
  const view = editor.prosemirrorView;
  const previous = view.props.dispatchTransaction;
  const dispatched: Transaction[] = [];
  view.setProps({ dispatchTransaction: (transaction) => { dispatched.push(transaction); } });
  try {
    act(command);
  } finally {
    view.setProps({ dispatchTransaction: previous });
  }
  expect(dispatched).toHaveLength(1);
  if (dispatched[0] === undefined) throw new Error('The production command did not dispatch');
  return dispatched[0];
}

/** Selects the actual first and last cells before the producer runs. @throws {Error} If cells are missing. */
function selectAll(editor: Editor): void {
  const view = editor.prosemirrorView;
  const positions = cells(view.state.doc);
  if (positions[0] === undefined || positions.at(-1) === undefined) throw new Error('Missing fixture cells');
  act(() => {
    view.dispatch(view.state.tr.setSelection(CellSelection.create(view.state.doc, positions[0], positions.at(-1))));
  });
}

/** Reads a transfer range from its real transaction step boundary. @throws {Error} If its boundary is invalid. */
function rangeUnits(transaction: Transaction, range: BodyTransferRange): ReturnType<typeof initialBodyUnits> {
  expect(range.boundary.transaction).toBe(0);
  expect(range.boundary.step).toBeGreaterThanOrEqual(0);
  expect(range.boundary.step).toBeLessThanOrEqual(transaction.steps.length);
  const doc = range.boundary.step === transaction.steps.length ? transaction.doc : transaction.docs[range.boundary.step];
  if (doc === undefined) throw new Error('Missing actual step document');
  expect(range.from).toBeGreaterThanOrEqual(0);
  expect(range.to).toBeLessThanOrEqual(doc.content.size);
  expect(range.from).toBeLessThan(range.to);
  const units = initialBodyUnits(doc).filter((unit) => unit.pos >= range.from && unit.pos + unit.width <= range.to);
  expect(units.length).toBeGreaterThan(0);
  expect(units.every((unit) => unit.block === range.block)).toBe(true);
  return units;
}

/** Checks every declared handoff against actual PM documents, independently of journal replay. @throws {Error} If metadata is invalid. */
function checkCoordinates(transaction: Transaction, firstStep = 0): void {
  const operations = bodyOperations(transaction);
  expect(operations.length).toBeGreaterThan(0);
  expect(operations.some((operation) => operation.source.step === firstStep)).toBe(true);
  for (const operation of operations) {
    expect(operation.source.transaction).toBe(0);
    expect(operation.target.transaction).toBe(0);
    expect(operation.source.step).toBeGreaterThanOrEqual(firstStep);
    expect(operation.target.step).toBeGreaterThan(operation.source.step);
    expect(operation.target.step).toBeLessThanOrEqual(transaction.steps.length);
    expect(operation.handoffs.length).toBeGreaterThan(0);
    for (const handoff of operation.handoffs) {
      expect(['move', 'preserve']).toContain(handoff.kind);
      expect(rangeUnits(transaction, handoff.target).map((unit) => [unit.value, unit.width])).toEqual(
        rangeUnits(transaction, handoff.source).map((unit) => [unit.value, unit.width]),
      );
    }
  }
}

/** Provides repeated words in independently identified, differently typed source blocks. @throws {never} */
function mergeTable(): TableInput {
  return { rows: [{ cells: [
    { blocks: [{ id: 'left-heading', type: 'heading', content: 'AA' }, { id: 'left-list', type: 'bulletListItem', content: 'AA' }] },
    { blocks: [{ id: 'right-list', type: 'numberedListItem', content: 'AA' }, { id: 'right-paragraph', type: 'paragraph', content: 'AA' }] },
  ] }] };
}

describe('production table body provenance', () => {
  it('preserves each repeated source occurrence through the actual cell merge', () => {
    const editor = open(mergeTable());
    selectAll(editor);
    const before = editor.prosemirrorState.doc;
    const initial = initialBodyUnits(before);

    const transaction = capture(editor, () => { mergeSelectedCells(editor); });
    const result = replayBodyJournal(before, initial, [transaction], { batchId: 'table-merge' });

    expect(cells(transaction.doc)).toHaveLength(1);
    expect(transaction.doc.textContent).toBe('ZAAAAAAAA');
    expect(bodyLabels(result.units)).toEqual(bodyLabels(initial));
    expect(result.units.map((unit) => unit.block)).toEqual(initial.map((unit) => unit.block));
    expect(result.units.every((unit) => unit.origin === 'existing')).toBe(true);
    expect(result.deleted).toEqual([]);
    checkCoordinates(transaction);
  });

  it('requires exact declared merge boundaries even when every source word is identical', () => {
    const editor = open(mergeTable());
    selectAll(editor);
    const before = editor.prosemirrorState.doc;
    const initial = initialBodyUnits(before);
    const transaction = capture(editor, () => { mergeSelectedCells(editor); });
    checkCoordinates(transaction);
    const operations = bodyOperations(transaction);
    const missing = transaction.setMeta(BODY_OPERATION_META, []);

    expect(bodyLabels(replayBodyJournal(before, initial, [missing], { batchId: 'missing-merge' }).units)).not.toEqual(bodyLabels(initial));

    transaction.setMeta(BODY_OPERATION_META, operations.map((operation, index) => index !== 0 ? operation : {
      ...operation,
      handoffs: operation.handoffs.map((handoff, handoffIndex) => handoffIndex !== 0 ? handoff : {
        ...handoff,
        source: { ...handoff.source, from: handoff.source.from + 1 },
      }),
    }));
    expect(() => replayBodyJournal(before, initial, [transaction], { batchId: 'wrong-merge' })).toThrow();
  });

  it('keeps original blocks in the top-left split cell and gives the new empty cell no old source', () => {
    const editor = open({ rows: [{ cells: [{ props: { colspan: 2 }, blocks: [
      { id: 'split-heading', type: 'heading', content: 'AA' },
      { id: 'split-list', type: 'bulletListItem', content: 'AA' },
    ] }] }] });
    const before = editor.prosemirrorState.doc;
    const initial = initialBodyUnits(before);
    const transaction = capture(editor, () => { splitCellAt(editor, cells(before)[0]); });
    const result = replayBodyJournal(before, initial, [transaction], { batchId: 'table-split' });
    const afterCells = cells(transaction.doc).map((pos) => transaction.doc.nodeAt(pos)!);

    expect(afterCells.map((cell) => cell.textContent)).toEqual(['AAAA', '']);
    expect(afterCells.map((cell) => Number(cell.attrs['colspan']))).toEqual([1, 1]);
    expect(bodyLabels(result.units)).toEqual(bodyLabels(initial));
    expect(result.units.map((unit) => unit.block)).toEqual(initial.map((unit) => unit.block));
    expect(result.deleted).toEqual([]);
  });

  it('gives an explicit same-word cell block replacement fresh identity despite its reused id', () => {
    const editor = open(mergeTable());
    const before = editor.prosemirrorState.doc;
    const initial = initialBodyUnits(before);
    const replaced = initial.filter((unit) => unit.block === 'right-paragraph');
    const transaction = capture(editor, () => {
      editor.replaceBlocks(['right-paragraph'], [{ id: 'right-paragraph', type: 'paragraph', content: 'AA' }] as never);
    });
    const result = replayBodyJournal(before, initial, [transaction], { batchId: 'table-replace' });
    const current = result.units.filter((unit) => unit.block === 'right-paragraph');

    expect(transaction.doc.textContent).toBe(before.textContent);
    expect(current.map((unit) => unit.value)).toEqual(['A', 'A']);
    expect(current.map((unit) => unit.origin)).toEqual(['fresh', 'fresh']);
    expect(bodyLabels(current).some((token) => bodyLabels(initial).includes(token))).toBe(false);
    expect(bodyLabels(result.deleted)).toEqual(bodyLabels(replaced));
    expect(bodyLabels(result.units.filter((unit) => unit.block !== 'right-paragraph'))).toEqual(
      bodyLabels(initial.filter((unit) => unit.block !== 'right-paragraph')),
    );
  });

  it.each(['row', 'column'] as const)('preserves the whole table through a %s move after an outer text step', (orientation) => {
    const editor = open({ rows: [
      { cells: [{ blocks: [{ id: 'a', type: 'paragraph', content: 'AA' }] }, { blocks: [{ id: 'b', type: 'paragraph', content: 'AA' }] }] },
      { cells: [{ blocks: [{ id: 'c', type: 'paragraph', content: 'AA' }] }, { blocks: [{ id: 'd', type: 'paragraph', content: 'AA' }] }] },
    ] });
    const before = editor.prosemirrorState.doc;
    const initial = initialBodyUnits(before);
    const lead = initial.find((unit) => unit.block === 'lead')!;
    const transaction = capture(editor, () => {
      editor.transact((tr) => {
        tr.insertText('!', lead.pos + lead.width);
        moveLineAt(editor, cells(tr.doc)[0], orientation, 1);
      });
    });
    const result = replayBodyJournal(before, initial, [transaction], { batchId: `table-${orientation}` });
    const order = orientation === 'row' ? ['c', 'd', 'a', 'b'] : ['b', 'a', 'd', 'c'];
    const expectedTable = order.flatMap((id) => initial.filter((unit) => unit.block === id));

    expect(transaction.doc.textContent).toBe('Z!AAAAAAAA');
    expect(result.units.map((unit) => unit.block)).toEqual(['lead', 'lead', ...expectedTable.map((unit) => unit.block)]);
    expect(bodyLabels(result.units.slice(2))).toEqual(bodyLabels(expectedTable));
    expect(result.units[0].token).toBe(lead.token);
    expect(result.units[1].origin).toBe('fresh');
    expect(bodyLabels(initial)).not.toContain(result.units[1].token);
    expect(result.deleted).toEqual([]);
    expect(transaction.steps.length).toBeGreaterThan(1);
    checkCoordinates(transaction, 1);
  });
});
