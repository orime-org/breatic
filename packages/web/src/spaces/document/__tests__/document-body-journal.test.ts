// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { EditorState, Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared/document-body';

import { BodyJournal, replayBodyJournal } from '@web/spaces/document/document-body-journal';
import {
  BODY_OPERATION_META,
  recordBodyOperation,
  transferBodyOperations,
  type BodyTransferOperation,
} from '@web/spaces/document/document-body-provenance';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import {
  bodyDocument,
  bodyJournalSchema,
  bodyLabels,
  bodyParagraph,
  initialBodyUnits,
} from '@web/spaces/document/__tests__/document-body-provenance-fixtures';

const bodies: { readonly editor: ReturnType<typeof buildDocumentEditor>; readonly doc: Y.Doc; readonly host: HTMLElement }[] = [];

afterEach(() => {
  act(() => {
    for (const body of bodies.splice(0)) {
      body.editor.unmount();
      body.doc.destroy();
      body.host.remove();
    }
  });
});

describe('body provenance journal', () => {
  it('tracks the accepted root and every appended transaction at their exact stage', () => {
    const before = bodyDocument(bodyParagraph('p', 'X'));
    const state = EditorState.create({
      schema: bodyJournalSchema,
      doc: before,
      plugins: [
        new Plugin({ appendTransaction: (transactions, _old, current) => (
          transactions.some((transaction) => transaction.getMeta('test-root') === true)
            ? current.tr.insertText('A', current.doc.content.size - 1).setMeta('test-append', true)
            : null
        ) }),
        new Plugin({ appendTransaction: (transactions, _old, current) => (
          transactions.some((transaction) => transaction.getMeta('test-append') === true)
            ? current.tr.insertText('B', current.doc.content.size - 1)
            : null
        ) }),
      ],
    });
    const accepted = state.applyTransaction(state.tr.insertText('R', 2).setMeta('test-root', true));

    const result = replayBodyJournal(before, initialBodyUnits(before), accepted.transactions, { batchId: 'batch-root' });

    expect(result.doc.toJSON()).toEqual(accepted.state.doc.toJSON());
    expect(result.doc.textContent).toBe('XRAB');
    expect(result.transactions.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(result.transactions.map((entry) => entry.stages.map((stage) => stage.document.textContent))).toEqual([
      ['X', 'XR'], ['XR', 'XRA'], ['XRA', 'XRAB'],
    ]);
    expect(result.units.map((unit) => unit.value)).toEqual(['X', 'R', 'A', 'B']);
    expect(result.units.map((unit) => unit.origin)).toEqual(['existing', 'fresh', 'fresh', 'fresh']);
    expect(result.units[0]!.token).toBe('native:0');
    expect(new Set(bodyLabels(result.units)).size).toBe(4);
    expect(result.deleted).toEqual([]);
  });

  it('leaves a filtered root outside the journal and preserves its original bytes of meaning', () => {
    const before = bodyDocument(bodyParagraph('p', 'AA'));
    const initial = initialBodyUnits(before);
    const state = EditorState.create({
      schema: bodyJournalSchema,
      doc: before,
      plugins: [new Plugin({ filterTransaction: () => false })],
    });
    const accepted = state.applyTransaction(state.tr.insertText('new', 1));
    const result = replayBodyJournal(before, initial, accepted.transactions, { batchId: 'filtered' });

    expect(accepted.transactions).toEqual([]);
    expect(result.doc.toJSON()).toEqual(before.toJSON());
    expect(result.units).toEqual(initial);
    expect(result.transactions).toEqual([]);
    expect(result.operations).toEqual([]);
  });

  it('keeps the same text replacement fresh despite a reused block id', () => {
    const before = bodyDocument(bodyParagraph('same-id', 'AAAA'));
    const initial = initialBodyUnits(before);
    const state = EditorState.create({ schema: bodyJournalSchema, doc: before });
    const transaction = state.tr.insertText('AAAA', 1, 5);

    const result = replayBodyJournal(before, initial, [transaction], { batchId: 'rewrite' });

    expect(result.doc.toJSON()).toEqual(before.toJSON());
    expect(result.units.map((unit) => unit.origin)).toEqual(['fresh', 'fresh', 'fresh', 'fresh']);
    expect(result.units.filter((unit) => bodyLabels(initial).includes(unit.token))).toEqual([]);
    expect(bodyLabels(result.deleted)).toEqual(bodyLabels(initial));
  });

  it('records a copied string as fresh while preserving the original labels', () => {
    const before = bodyDocument(bodyParagraph('p', 'AAAA'));
    const initial = initialBodyUnits(before);
    const state = EditorState.create({ schema: bodyJournalSchema, doc: before });

    const result = replayBodyJournal(before, initial, [state.tr.insertText('AAAA', 5)], { batchId: 'copy' });

    expect(result.doc.textContent).toBe('AAAAAAAA');
    expect(bodyLabels(result.units.slice(0, 4))).toEqual(bodyLabels(initial));
    expect(result.units.map((unit) => unit.origin)).toEqual([
      'existing', 'existing', 'existing', 'existing', 'fresh', 'fresh', 'fresh', 'fresh',
    ]);
    expect(new Set(bodyLabels(result.units)).size).toBe(8);
  });

  it('preserves text and inline labels through ReplaceAroundStep gaps', () => {
    const before = bodyDocument(bodyParagraph('p', 'ABCD'));
    const initial = initialBodyUnits(before);
    const state = EditorState.create({ schema: bodyJournalSchema, doc: before });
    const transaction = state.tr.setNodeMarkup(0, undefined, { id: 'new-id' });

    const result = replayBodyJournal(before, initial, [transaction], { batchId: 'markup' });

    expect(transaction.steps[0].toJSON()['stepType']).toBe('replaceAround');
    expect(bodyLabels(result.units)).toEqual(bodyLabels(initial));
    expect(result.units.map((unit) => unit.block)).toEqual(['new-id', 'new-id', 'new-id', 'new-id']);
    expect(result.deleted).toEqual([]);
  });

  it('rebases child metadata after an existing outer step without remapping its positions', () => {
    const before = bodyDocument(bodyParagraph('p', 'AB'), bodyParagraph('q', 'CD'));
    const outer = EditorState.create({ schema: bodyJournalSchema, doc: before }).tr.insertText('!', 1);
    const childState = EditorState.create({ schema: bodyJournalSchema, doc: outer.doc });
    const child = childState.tr.delete(6, 8).insertText('CD', 4);
    recordBodyOperation(child, {
      id: 'child-move',
      name: 'preserve child text',
      source: { transaction: 0, step: 0 },
      target: { transaction: 0, step: child.steps.length },
      handoffs: [{
        kind: 'move',
        source: { boundary: { transaction: 0, step: 0 }, from: 6, to: 8, block: 'q' },
        target: { boundary: { transaction: 0, step: child.steps.length }, from: 4, to: 6, block: 'p' },
      }],
      created: [],
    });
    child.steps.forEach((step) => outer.step(step));

    transferBodyOperations(child, outer, { stepOffset: 1, transaction: 0 });
    const operations = outer.getMeta(BODY_OPERATION_META) as readonly BodyTransferOperation[];

    expect(operations).toHaveLength(1);
    expect(operations[0]!.source).toEqual({ transaction: 0, step: 1 });
    expect(operations[0]!.target).toEqual({ transaction: 0, step: 3 });
    expect(operations[0]!.handoffs[0]!.source).toEqual({
      boundary: { transaction: 0, step: 1 }, from: 6, to: 8, block: 'q',
    });
    const result = replayBodyJournal(before, initialBodyUnits(before), [outer], { batchId: 'wrapper' });
    expect(result.doc.textContent).toBe('!ABCD');
    expect(result.units.filter((unit) => unit.origin === 'existing').map((unit) => unit.value)).toEqual(['A', 'B', 'C', 'D']);
    expect(result.units.filter((unit) => unit.value === 'C' || unit.value === 'D').map((unit) => unit.token)).toEqual(['native:2', 'native:3']);
  });

  it('keeps source labels across the actual first-child Backspace command', () => {
    act(() => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
      const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
      const host = document.createElement('div');
      document.body.appendChild(host);
      bodies.push({ editor, doc, host });
      editor.mount(host);
      editor.replaceBlocks(editor.document, [
        { id: 'parent', type: 'paragraph', content: 'AB', children: [{ id: 'child', type: 'paragraph', content: 'CD' }] },
      ] as never);
      const view = editor.prosemirrorView;
      let parentFrom = -1;
      let childFrom = -1;
      view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'blockContainer' && node.attrs['id'] === 'parent') parentFrom = pos + 2;
        if (node.type.name === 'blockContainer' && node.attrs['id'] === 'child') childFrom = pos + 2;
      });
      expect(parentFrom).toBeGreaterThanOrEqual(0);
      expect(childFrom).toBeGreaterThan(parentFrom);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, childFrom)));
      const before = view.state.doc;
      const initial = initialBodyUnits(before);
      let produced: Transaction | undefined;
      const originalDispatch = view.props.dispatchTransaction;
      view.setProps({ dispatchTransaction: (transaction) => { produced = transaction; } });
      const handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })));
      view.setProps({ dispatchTransaction: originalDispatch });
      expect(handled).toBe(true);
      if (produced === undefined) throw new Error('Backspace did not dispatch');
      expect(produced.doc.textContent).toBe('ABCD');
      const operations = produced.getMeta(BODY_OPERATION_META) as readonly BodyTransferOperation[];
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        name: 'blocknote first child merge',
        source: { transaction: 0, step: 0 }, target: { transaction: 0, step: produced.steps.length },
        handoffs: [{ kind: 'move',
          source: { boundary: { transaction: 0, step: 0 }, from: childFrom, to: childFrom + 2, block: 'child' },
          target: { boundary: { transaction: 0, step: produced.steps.length }, from: parentFrom + 2, to: parentFrom + 4, block: 'parent' },
        }], created: [],
      });

      const result = replayBodyJournal(before, initial, [produced], { batchId: 'backspace' });

      expect(bodyLabels(result.units)).toEqual(bodyLabels(initial));
      expect(result.units.map((unit) => unit.value)).toEqual(['A', 'B', 'C', 'D']);
      expect(result.units.map((unit) => unit.block)).toEqual(['parent', 'parent', 'parent', 'parent']);
      expect(result.deleted).toEqual([]);
    });
  });

  it('retains the accepted journal when a later transaction has an invalid before document', () => {
    const before = bodyDocument(bodyParagraph('p', 'A'));
    const initial = initialBodyUnits(before);
    const journal = new BodyJournal(before, initial, { batchId: 'staged' });
    const state = EditorState.create({ schema: bodyJournalSchema, doc: before });
    journal.accept(state.tr.insertText('B', 2));
    const previous = journal.read();

    expect(() => journal.accept(state.tr.insertText('C', 2))).toThrow(/before document/);

    expect(journal.read()).toBe(previous);
    expect(journal.read().doc.textContent).toBe('AB');
  });
});
