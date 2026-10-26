// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bodyTreeRecordProperties,
  documentBodyRecords,
  documentBodySource,
  documentCommentThreads,
  registerDocumentBodyRecords,
  type BodyJsonObject,
} from '@breatic/shared';

import { writeAlignment } from '@web/spaces/document/document-align-run';
import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { compileBodyBatch } from '@web/spaces/document/document-body-compiler';
import { replayBodyJournal } from '@web/spaces/document/document-body-journal';
import { commitPreparedBodyBatch, prepareBodyBatch } from '@web/spaces/document/document-body-plan';
import type { BodyBatchEnvironment } from '@web/spaces/document/document-body-plan-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { mergeSelectedCells } from '@web/spaces/document/document-table-run';
import {
  cleanupCodecFixtures,
  codecDoc,
  codecFixture,
  codecNativeTokens,
  codecParagraph,
  codecSchema,
  codecTableFixture,
} from '@web/spaces/document/__tests__/document-body-codec-fixtures';

const histories: Y.UndoManager[] = [];
const runtimes: DocumentBodyRuntime[] = [];

afterEach(() => {
  histories.splice(0).forEach((history) => history.destroy());
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  cleanupCodecFixtures();
});

/** Reads the actual codec and requires complete dependencies at each observation. @throws {Error} If the body is incomplete. */
function project(doc: Y.Doc, schema: Schema): BodyProjection {
  const result = projectBodyTree(doc, schema, { document: 'table-compiler-document', epoch: 1 });
  if (result.status !== 'ready') throw new Error(`Incomplete table compiler fixture: ${result.status}`);
  return result.projection;
}

/** Creates the existing real commit-engine environment without a binding or browser substitute. @throws {never} */
function environment(doc: Y.Doc, schema: Schema): { readonly env: BodyBatchEnvironment; readonly history: Y.UndoManager } {
  const userOrigin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([userOrigin]) });
  histories.push(history);
  runtimes.push(runtime);
  return { history, env: { doc, runtime, userOrigin, canWrite: () => true, project: (source) => project(source, schema) } };
}

/** Builds real native L/R sources before either author's history begins. @throws {Error} If registration is invalid. */
function tableFixture(marked: boolean): Y.Doc {
  const doc = codecTableFixture();
  for (const [id, word] of [['L', 'L'], ['R', 'R']] as const) {
    const text = documentBodySource(doc, `S:${id}`);
    text.delete(1, text.length - 2);
    text.insert(1, word, { ctx: 'base' });
  }
  if (marked) {
    registerDocumentBodyRecords(doc, { groups: [{ id: 'seed-marks', facts: ['seed-bold', 'seed-link', 'seed-comment'], history: 'base' }], facts: [
      { id: 'seed-bold', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
      { id: 'seed-link', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/r' } } },
      { id: 'seed-comment', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'comment', attrs: { threadId: 't-r', orphan: false } } },
    ] });
    documentBodyRecords(doc).enabled.set('seed-marks', true);
    documentBodySource(doc, 'S:R').format(1, 1, {
      'mark:bold': { factId: 'seed-bold' },
      'mark:link': { factId: 'seed-link' },
      'mark:comment:t-r': { factId: 'seed-comment' },
    });
    // This is the same native thread envelope used by the existing import fixtures.
    documentCommentThreads(doc).set('t-r', {
      id: 't-r', resolved: false, createdAt: '2026-10-25T12:00:00.000Z',
      comments: [{ id: 'c-r', userId: 'author', body: [{ type: 'text', text: 'Retain this thread' }] }],
    });
  }
  return doc;
}

/** Gives a new independent native client exactly the current source snapshot. @throws {Error} If Yjs rejects the bytes. */
function clone(doc: Y.Doc): Y.Doc {
  const next = codecDoc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  return next;
}

/** Captures the production merge's genuine PM transaction at its state/dispatch boundary. @throws {Error} If merge does not produce exactly one root. */
function mergeTransaction(projection: BodyProjection): Transaction {
  const cells: number[] = [];
  projection.doc.descendants((node, pos) => {
    if (node.type.spec['tableRole'] === 'cell') cells.push(pos);
  });
  expect(cells).toHaveLength(2);
  const state = EditorState.create({ doc: projection.doc,
    selection: CellSelection.create(projection.doc, cells[0], cells[1]),
  });
  const transactions: Transaction[] = [];
  // This test deliberately exercises the real PM producer/compiler layer.
  // The actual two-editor factory path is covered independently by its T9 suite.
  const editor = { prosemirrorView: { state, dispatch: (transaction: Transaction) => { transactions.push(transaction); } } };
  mergeSelectedCells(editor as unknown as Parameters<typeof mergeSelectedCells>[0]);
  expect(transactions).toHaveLength(1);
  if (transactions[0] === undefined) throw new Error('The production merge did not dispatch');
  return transactions[0];
}

/** Builds the independently expected original mark payloads through the real schema. @throws {RangeError} If the actual schema lacks a mark. */
function expectedMarks(schema: Schema, marked: boolean): readonly Mark[] {
  return marked ? [schema.mark('bold'), schema.mark('link', { href: 'https://example.com/r' }), schema.mark('comment', { threadId: 't-r', orphan: false })] : [];
}

/** Builds complete independently specified table JSON, including all original block/cell handles. @throws {RangeError} If expected geometry is invalid. */
function expectedTable(schema: Schema, merged: boolean, right: string, marked: boolean): PMNode {
  const leftBlock = codecParagraph(schema, 'L', 'L');
  const rightBlock = schema.node('blockContainer', { id: 'R' }, schema.node('paragraph', null, [
    schema.text('R', expectedMarks(schema, marked)),
    ...(right.length === 1 ? [] : [schema.text(right.slice(1), marked ? [schema.mark('bold')] : [])]),
  ]));
  const left = schema.node('docTableCell', { id: 'left', colspan: merged ? 2 : 1, rowspan: 1, colwidth: null }, merged ? [leftBlock, rightBlock] : [leftBlock]);
  const rightCell = schema.node('docTableCell', { id: 'right', colspan: 1, rowspan: 1, colwidth: null }, rightBlock);
  return schema.node('doc', null, schema.node('blockGroup', null,
    schema.node('docTable', { id: 'table' }, schema.node('docTableRow', { id: 'row' }, merged ? [left] : [left, rightCell])),
  ));
}

/** Checks real installed TableMap geometry and the complete independently expected PM document. @throws {Error} If projection or geometry is invalid. */
function expectTable(doc: Y.Doc, schema: Schema, expected: PMNode, merged: boolean): BodyProjection {
  const projection = project(doc, schema);
  expect(projection.doc.toJSON()).toEqual(expected.toJSON());
  expect(() => projection.doc.check()).not.toThrow();
  const tables: PMNode[] = [];
  projection.doc.descendants((node) => {
    if (node.type.spec['tableRole'] === 'table') tables.push(node);
  });
  expect(tables).toHaveLength(1);
  const map = TableMap.get(tables[0]);
  expect(map.problems).toBeNull();
  expect([map.width, map.height]).toEqual([2, 1]);
  expect(new Set(map.map).size).toBe(merged ? 1 : 2);
  return projection;
}

/** Exchanges genuine independent updates in both orders and repeats every received frame. @throws {Error} If Yjs rejects an update. */
function exchange(author: Y.Doc, peer: Y.Doc, authorFirst: boolean): void {
  for (let round = 0; round < 2; round += 1) {
    const toPeer = Y.encodeStateAsUpdate(author, Y.encodeStateVector(peer));
    const toAuthor = Y.encodeStateAsUpdate(peer, Y.encodeStateVector(author));
    const updates = authorFirst ? [[peer, toPeer], [author, toAuthor]] as const : [[author, toAuthor], [peer, toPeer]] as const;
    for (const [doc, bytes] of updates) {
      Y.applyUpdate(doc, bytes, 'peer');
      Y.applyUpdate(doc, bytes, 'peer');
    }
  }
}

describe('actual table producer through the complete body compiler', () => {
  it.each([[true, false], [false, false], [true, true], [false, true]] as const)(
    'preserves late source-cell input with author-first %s and original marks %s', (authorFirst, marked) => {
      const schema = codecSchema();
      const author = tableFixture(marked);
      const peer = clone(author);
      const initial = project(author, schema);
      const original = [codecNativeTokens(author, 'L', 1)[0], codecNativeTokens(author, 'R', 1)[0]];
      const threads = documentCommentThreads(author).toJSON();
      const { env, history } = environment(author, schema);
      const transaction = mergeTransaction(initial);
      const journal = replayBodyJournal(initial.doc, initial.units, [transaction], { batchId: 'table-late-peer' });
      expect(transaction.doc.toJSON()).toEqual(expectedTable(schema, true, 'R', marked).toJSON());
      const before = Y.encodeStateAsUpdate(author);
      const plan = compileBodyBatch({ doc: author, projection: initial, journal, batchId: 'table-late-peer' });
      const prepared = prepareBodyBatch(env, plan);
      expect(Y.encodeStateAsUpdate(author)).toEqual(before);
      expect(history.undoStack).toHaveLength(0);
      commitPreparedBodyBatch(env, prepared);
      expectTable(author, schema, expectedTable(schema, true, 'R', marked), true);
      expect(history.undoStack).toHaveLength(1);
      const unseen = expectTable(peer, schema, expectedTable(schema, false, 'R', marked), false);
      const originalRight = unseen.index.units.find((unit) => unit.owner === 'R')!;
      const caret = TextSelection.create(unseen.doc, unseen.index.owners.get('R')!.contentTo);
      // The installed Link and CommentMark are non-inclusive at this endpoint.
      expect(caret.$from.marks()).toEqual(marked ? [schema.mark('bold')] : []);
      const attributes = {
        ctx: originalRight.native.attributes['ctx'],
        ...(marked ? { 'mark:bold': originalRight.native.attributes['mark:bold'] } : {}),
      };
      expect(attributes).toMatchObject({ ctx: 'base' });
      // The late peer still writes at the original native source's tail.
      // Its actual PM caret marks fix the native endpoint inheritance premise.
      peer.transact(() => {
        const right = documentBodySource(peer, 'S:R');
        right.insert(right.length - 1, '_PEER', attributes);
      }, 'late-peer-input');
      const peerTokens = codecNativeTokens(peer, 'R', 6);
      expectTable(peer, schema, expectedTable(schema, false, 'R_PEER', marked), false);

      exchange(author, peer, authorFirst);

      const merged = expectedTable(schema, true, 'R_PEER', marked);
      const mergedAuthor = expectTable(author, schema, merged, true);
      const mergedPeer = expectTable(peer, schema, merged, true);
      expect(mergedAuthor.units.map((unit) => unit.token)).toEqual([original[0], ...peerTokens]);
      expect(mergedPeer.units).toEqual(mergedAuthor.units);
      expect(mergedAuthor.units.filter((unit) => original.includes(unit.token)).map((unit) => unit.token)).toEqual(original);
      expect(documentCommentThreads(author).toJSON()).toEqual(threads);
      expect(documentCommentThreads(peer).toJSON()).toEqual(threads);
      expect(history.undoStack).toHaveLength(1);

      history.undo();
      exchange(author, peer, !authorFirst);

      const restored = expectedTable(schema, false, 'R_PEER', marked);
      const afterUndo = expectTable(author, schema, restored, false);
      expectTable(peer, schema, restored, false);
      expect(afterUndo.units.map((unit) => unit.token)).toEqual([original[0], ...peerTokens]);
      expect(history.undoStack).toHaveLength(0);
      expect(history.redoStack).toHaveLength(1);
      expect(documentCommentThreads(author).toJSON()).toEqual(threads);
      const reopened = clone(author);
      expectTable(reopened, schema, restored, false);
      expect(project(reopened, schema).units).toEqual(afterUndo.units);
      expect(documentCommentThreads(reopened).toJSON()).toEqual(threads);
    },
  );

  it('retains unseen attributes of a known owner through actual typing alignment undo and snapshot reading', () => {
    const schema = codecSchema();
    const payload = JSON.parse('{"__proto__":{"retained":true},"config":{"items":[1,null,"future"]}}') as BodyJsonObject;
    // The actual importOwner path retains complete XML attrs on known owners;
    // this fixture starts at that records-ready boundary, before any user edit.
    const doc = codecFixture([{ id: 'A', text: 'AB', attrs: { futurePayload: payload, textAlignment: 'left', textColor: 'blue' } }]);
    const initial = project(doc, schema);
    const stored = documentBodyRecords(doc).records.get('A');
    const originals = codecNativeTokens(doc, 'A', 2);
    const owner = initial.index.owners.get('A')!;
    expect(Object.hasOwn(initial.doc.nodeAt(owner.contentFrom - 1)!.attrs, 'futurePayload')).toBe(false);
    const root = EditorState.create({ doc: initial.doc }).tr.insertText('!', owner.contentFrom + 1);
    writeAlignment(root, [{ node: root.doc.nodeAt(owner.contentFrom - 1)!, pos: owner.contentFrom - 1 }], 'right');
    const journal = replayBodyJournal(initial.doc, initial.units, [root], { batchId: 'known-owner-attrs' });
    const expected = schema.node('doc', null, schema.node('blockGroup', null,
      codecParagraph(schema, 'A', 'A!B', 'paragraph', { textAlignment: 'right', textColor: 'blue' }),
    ));
    expect(journal.doc.toJSON()).toEqual(expected.toJSON());
    const { env, history } = environment(doc, schema);
    const before = Y.encodeStateAsUpdate(doc);
    const plan = compileBodyBatch({ doc, projection: initial, journal, batchId: 'known-owner-attrs' });
    const prepared = prepareBodyBatch(env, plan);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);

    const result = commitPreparedBodyBatch(env, prepared);

    expect(result.projection.doc.toJSON()).toEqual(expected.toJSON());
    expect(result.projection.units.filter((unit) => originals.includes(unit.token)).map((unit) => unit.token)).toEqual(originals);
    expect(documentBodyRecords(doc).records.get('A')).toBe(stored);
    expect(bodyTreeRecordProperties(project(doc, schema).view, 'A').attrs).toMatchObject({ futurePayload: payload, textAlignment: 'right', textColor: 'blue' });
    expect(plan.registration.facts?.some((fact) => fact.kind === 'attribute' && fact.name === 'futurePayload')).toBe(false);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(project(doc, schema).doc.toJSON()).toEqual(initial.doc.toJSON());
    expect(bodyTreeRecordProperties(project(doc, schema).view, 'A').attrs).toMatchObject({ futurePayload: payload, textAlignment: 'left', textColor: 'blue' });
    const reopened = clone(doc);
    expect(documentBodyRecords(reopened).records.get('A')).toBe(stored);
    const attrs = bodyTreeRecordProperties(project(reopened, schema).view, 'A').attrs;
    const retained = attrs['futurePayload'];
    expect(retained).toEqual(payload);
    if (retained === null || typeof retained !== 'object' || Array.isArray(retained)) throw new Error('The retained payload is not an object');
    expect(Object.hasOwn(retained, '__proto__')).toBe(true);
    expect(project(reopened, schema).doc.toJSON()).toEqual(initial.doc.toJSON());
  });
});
