// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, documentBodyRecords, documentBodySource, registerDocumentBodyRecords, type BodyFact, type BodyRecord } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyDerivedRecord, BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { nameBodyPoint, resolveBodyPoint } from '@web/spaces/document/document-body-positions';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { cleanupCodecFixtures, codecDoc, codecFacts, codecFixture, codecNativeTokens, codecParagraph } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
}

const bodies: OpenBody[] = [];

afterEach(() => {
  act(() => {
    for (const body of bodies.splice(0).reverse()) {
      body.editor.unmount();
      body.runtime.dispose();
      body.history.destroy();
      body.host.remove();
    }
    cleanupCodecFixtures();
  });
});

/** Uses the independently approved missing-cell geometry, plus an existing body sibling. @throws {Error} If native registration is invalid. */
function sparseFixture(): Y.Doc {
  const containers: BodyRecord[] = [
    { id: 'table', kind: 'container', type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'A' },
    { id: 'row:0', kind: 'container', type: 'docTableRow', attrs: { id: 'row:0' }, parent: 'table', order: '0' },
    { id: 'row:1', kind: 'container', type: 'docTableRow', attrs: { id: 'row:1' }, parent: 'table', order: '1' },
    ...['A', 'B', 'C'].map((id, index): BodyRecord => ({
      id: `cell:${id}`, kind: 'container', type: 'docTableCell',
      attrs: { id: `cell:${id}`, colspan: 1, rowspan: 1, colwidth: null },
      parent: index < 2 ? 'row:0' : 'row:1', order: String(index % 2),
    })),
  ];
  const doc = codecFixture([
    { id: 'A', text: 'A', parent: 'cell:A' }, { id: 'B', text: 'B', parent: 'cell:B' },
    { id: 'C', text: 'C', parent: 'cell:C' }, { id: 'Z', text: 'Z', parent: 'group' },
  ], containers);
  codecFacts(doc, 'geometry', ['table', 'row:0', 'row:1'].map((owner, index): BodyFact => ({
    id: `geometry:${index}`, group: 'geometry', kind: 'attribute', owner, name: 'id', value: owner, counter: 1, dependencies: [],
  })));
  registerDocumentBodyRecords(doc, { groups: [{ id: 'original-format', facts: ['original-bold'], history: 'base' }], facts: [
    { id: 'original-bold', kind: 'mark', group: 'original-format', dependencies: [], payload: { type: 'bold', attrs: {} } },
  ] });
  documentBodySource(doc, 'S:A').format(1, 1, { 'mark:bold': { factId: 'original-bold' } });
  return doc;
}

/** Mounts the actual records editor, runtime and native history without substituting their core behavior. @throws {Error} If factory assembly fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:derived-edit', origin, runtime, history } });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, history, origin, host };
  bodies.push(body);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return body;
}

/** Reads exactly the factory's common final frame. @throws {Error} If the real records binding is absent. */
function frame(body: OpenBody): BodyProjection {
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The actual records binding is missing');
  return binding.read();
}

/** Reads the actual codec without accepting an incomplete native source. @throws {Error} If source dependencies are incomplete. */
function project(doc: Y.Doc, schema: Schema): BodyProjection {
  const result = projectBodyTree(doc, schema, { document: 'document:derived-edit', epoch: 1 });
  if (result.status !== 'ready') throw new Error(`Incomplete derived edit fixture: ${result.status}`);
  return result.projection;
}

/** Copies a full current native snapshot to a genuinely independent client. @throws {Error} If Yjs rejects the bytes. */
function clone(doc: Y.Doc): Y.Doc {
  const next = codecDoc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  return next;
}

/** Finds the actual default owner and its required derived parent from the stable projection index. @throws {Error} If the approved fixture has no single hole. */
function hole(projection: BodyProjection): { readonly owner: BodyDerivedRecord; readonly cell: BodyDerivedRecord } {
  const owners = [...projection.index.derived.values()].filter((record) => record.kind === 'owner');
  expect(owners).toHaveLength(1);
  const owner = owners[0];
  const cell = projection.index.derived.get(owner.parent);
  if (cell === undefined || cell.type !== 'docTableCell') throw new Error('The missing table cell has no derived descriptor');
  expect(projection.index.derived.size).toBe(2);
  return { owner, cell };
}

/** Builds the independent complete missing-cell result, using only pre-input stable local handles. @throws {RangeError} If expected content violates the actual schema. */
function expectedSparse(schema: Schema, local: ReturnType<typeof hole>, text = '', sibling = 'Z'): PMNode {
  /** Builds one independently specified original cell with its original content mark. @throws {RangeError} If the schema rejects it. */
  const cell = (id: string): PMNode => schema.node('docTableCell', { id: `cell:${id}`, colspan: 1, rowspan: 1, colwidth: null },
    schema.node('blockContainer', { id }, schema.node('paragraph', null, schema.text(id, id === 'A' ? [schema.mark('bold')] : []))),
  );
  return schema.node('doc', null, schema.node('blockGroup', null, [
    schema.node('docTable', { id: 'table' }, [
      schema.node('docTableRow', { id: 'row:0' }, [cell('A'), cell('B')]),
      schema.node('docTableRow', { id: 'row:1' }, [cell('C'), schema.node('docTableCell', local.cell.attrs,
        schema.node('blockContainer', local.owner.wrapperAttrs, schema.node('paragraph', local.owner.attrs, text === '' ? undefined : schema.text(text))),
      )]),
    ]),
    codecParagraph(schema, 'Z', sibling),
  ]));
}

/** Checks complete real JSON, installed table geometry and current handle admission. @throws {Error} If the actual table is absent. */
function expectSparse(body: OpenBody, expected: PMNode): BodyProjection {
  expect(body.runtime.read().status).toBe('active');
  const projection = frame(body);
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
  expect(projection.doc.toJSON()).toEqual(expected.toJSON());
  expect(project(body.doc, body.editor.pmSchema).doc.toJSON()).toEqual(expected.toJSON());
  expect(() => projection.doc.check()).not.toThrow();
  let table: PMNode | undefined;
  projection.doc.descendants((node) => { if (node.type.spec['tableRole'] === 'table') table = node; });
  if (table === undefined) throw new Error('The actual sparse table disappeared');
  const map = TableMap.get(table);
  expect(map.problems).toBeNull();
  expect([map.width, map.height]).toEqual([2, 2]);
  return projection;
}

/** Places a real caret and sends normal text through the mounted factory's dispatch path. @throws {Error} If the currently displayed owner has no boundary. */
function type(body: OpenBody, owner: string, text: string, end = false): void {
  const boundary = frame(body).index.nodes.get(owner);
  if (boundary === undefined) throw new Error('The displayed input target is missing');
  act(() => {
    const view = body.editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end ? boundary.contentTo : boundary.contentFrom)));
    view.dispatch(view.state.tr.insertText(text));
  });
}

/** Exchanges real client deltas in either order and repeats every frame. @throws {Error} If native updates cannot be applied. */
function exchange(a: OpenBody, b: OpenBody, first = true): void {
  act(() => {
    for (let round = 0; round < 2; round += 1) {
      const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
      const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
      const updates = first ? [[b.doc, toB], [a.doc, toA]] as const : [[a.doc, toA], [b.doc, toB]] as const;
      for (const [doc, bytes] of updates) {
        Y.applyUpdate(doc, bytes, 'peer');
        Y.applyUpdate(doc, bytes, 'peer');
      }
    }
  });
}

/** Requires all original native IDs and their initial order to remain present exactly once. @throws {never} */
function expectOriginals(projection: BodyProjection, tokens: readonly string[]): void {
  expect(projection.units.filter((unit) => tokens.includes(unit.token)).map((unit) => unit.token)).toEqual(tokens);
  expect(new Set(projection.units.map((unit) => unit.token)).size).toBe(projection.units.length);
}

describe('actual first input into local derived body slots', () => {
  it('registers only the touched missing cell and owner in one user edit and retains its point through undo redo and snapshot', () => {
    const doc = sparseFixture();
    const peerDoc = clone(doc);
    const bytes = Y.encodeStateAsUpdate(doc);
    let updates = 0;
    doc.on('update', () => { updates += 1; });
    const a = open(doc);
    const b = open(peerDoc);
    const before = frame(a);
    const local = hole(before);
    const original = ['A', 'B', 'C', 'Z'].flatMap((id) => codecNativeTokens(doc, id, 1));
    const records = new Map(documentBodyRecords(doc).records);
    const empty = expectedSparse(a.editor.pmSchema, local);
    expectSparse(a, empty);
    expectSparse(b, empty);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(updates).toBe(0);
    const point = nameBodyPoint(before.index, { kind: 'node', node: local.owner.id, side: 'inside' });
    expect(resolveBodyPoint(before.index, point)).toMatchObject({ status: 'resolved', pos: before.index.nodes.get(local.owner.id)!.contentFrom });
    let userUpdates = 0;
    const registrations: { readonly json: unknown; readonly ids: readonly string[]; readonly history: number }[] = [];
    doc.on('update', (_update, origin) => {
      if (origin === a.origin) userUpdates += 1;
      else {
        const read = project(doc, a.editor.pmSchema);
        registrations.push({ json: read.doc.toJSON(), ids: read.units.map((unit) => unit.token), history: a.history.undoStack.length });
      }
    });

    type(a, local.owner.id, 'Q');

    const edited = expectedSparse(a.editor.pmSchema, local, 'Q');
    const actual = expectSparse(a, edited);
    expectOriginals(actual, original);
    expect(userUpdates).toBe(1);
    expect(a.history.undoStack).toHaveLength(1);
    expect(registrations.length).toBeGreaterThan(0);
    for (const registration of registrations) {
      expect(registration.json).toEqual(empty.toJSON());
      expect(registration.ids).toEqual(original);
      expect(registration.history).toBe(0);
    }
    const newRecords = [...actual.view.body.records.values()].filter((record) => !records.has(record.id));
    expect(newRecords.filter((record) => record.kind !== 'facet').map((record) => record.id).sort()).toEqual([local.cell.id, local.owner.id].sort());
    expect(actual.view.body.records.get(local.cell.id)).toMatchObject({ kind: 'container', type: local.cell.type, parent: local.cell.parent, order: local.cell.order, attrs: local.cell.attrs });
    expect(actual.view.body.records.get(local.owner.id)).toMatchObject({ kind: 'owner', type: local.owner.type, parent: local.owner.parent, order: local.owner.order, attrs: local.owner.attrs, wrapperAttrs: local.owner.wrapperAttrs, base: false });
    expect([...actual.view.body.facts.values()].filter((fact) => fact.kind === 'birth').map((fact) => fact.kind === 'birth' ? fact.owner : '')).toEqual([local.owner.id]);
    for (const [id, value] of records) expect(documentBodyRecords(doc).records.get(id)).toBe(value);
    expect(resolveBodyPoint(actual.index, point)).toMatchObject({ status: 'resolved', pos: actual.index.nodes.get(local.owner.id)!.contentFrom });
    exchange(a, b);
    expectSparse(b, edited);
    expect(b.history.undoStack).toHaveLength(0);
    act(() => { a.history.undo(); });
    exchange(a, b, false);
    expectOriginals(expectSparse(a, empty), original);
    expectSparse(b, empty);
    expect(a.history.undoStack).toHaveLength(0);
    expect(a.history.redoStack).toHaveLength(1);
    act(() => { a.history.redo(); });
    exchange(a, b);
    expectOriginals(expectSparse(a, edited), original);
    expectSparse(b, edited);
    const saved = clone(doc);
    const savedBytes = Y.encodeStateAsUpdate(saved);
    const reopened = open(saved);
    expectSparse(reopened, edited);
    expect(Y.encodeStateAsUpdate(saved)).toEqual(savedBytes);
    expect(reopened.history.undoStack).toHaveLength(0);
  });

  it('keeps every untouched derived descriptor local when the user types in an existing sibling', () => {
    const doc = sparseFixture();
    const a = open(doc);
    const before = frame(a);
    const local = hole(before);
    const keys = [...documentBodyRecords(doc).records.keys()].sort();
    const original = ['A', 'B', 'C', 'Z'].flatMap((id) => codecNativeTokens(doc, id, 1));
    const bytes = Y.encodeStateAsUpdate(doc);
    expect(project(doc, a.editor.pmSchema).doc.toJSON()).toEqual(before.doc.toJSON());
    expect(project(doc, a.editor.pmSchema).index.derived).toEqual(before.index.derived);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    let userUpdates = 0;
    doc.on('update', (_update, origin) => { if (origin === a.origin) userUpdates += 1; });

    type(a, 'Z', '!', true);

    const expected = expectedSparse(a.editor.pmSchema, local, '', 'Z!');
    const actual = expectSparse(a, expected);
    expectOriginals(actual, original);
    expect([...documentBodyRecords(doc).records.keys()].sort()).toEqual(keys);
    for (const id of before.index.derived.keys()) expect(actual.view.body.records.has(id)).toBe(false);
    expect([...actual.view.body.facts.values()].some((fact) => fact.kind === 'birth' && before.index.derived.has(fact.owner))).toBe(false);
    expect(actual.index.derived).toEqual(before.index.derived);
    expect(userUpdates).toBe(1);
    expect(a.history.undoStack).toHaveLength(1);
    act(() => { a.history.undo(); });
    expectSparse(a, expectedSparse(a.editor.pmSchema, local));
    act(() => { a.history.redo(); });
    expectSparse(a, expected);
    const reopened = open(clone(doc));
    expectSparse(reopened, expected);
    for (const id of before.index.derived.keys()) expect(documentBodyRecords(reopened.doc).records.has(id)).toBe(false);
  });

  it.each([true, false])('converges when two real editors first type in the same derived cell with author-first %s', (first) => {
    const doc = sparseFixture();
    const a = open(doc);
    const b = open(clone(doc));
    const before = frame(a);
    const local = hole(before);
    expect(hole(frame(b))).toEqual(local);
    const original = ['A', 'B', 'C', 'Z'].flatMap((id) => codecNativeTokens(doc, id, 1));

    type(a, local.owner.id, 'Q');
    type(b, local.owner.id, 'R');
    expectSparse(a, expectedSparse(a.editor.pmSchema, local, 'Q'));
    expectSparse(b, expectedSparse(b.editor.pmSchema, local, 'R'));
    exchange(a, b, first);

    expect(a.runtime.read().status).toBe('active');
    expect(b.runtime.read().status).toBe('active');
    const combined = frame(a).units.filter((unit) => unit.block === local.owner.id).map((unit) => unit.value).join('');
    expect(combined.split('').sort()).toEqual(['Q', 'R']);
    const expected = expectedSparse(a.editor.pmSchema, local, combined);
    expectOriginals(expectSparse(a, expected), original);
    expectSparse(b, expected);
    expect(frame(b).units).toEqual(frame(a).units);
    expect(a.history.undoStack).toHaveLength(1);
    expect(b.history.undoStack).toHaveLength(1);
    act(() => { a.history.undo(); });
    exchange(a, b, !first);
    const peerOnly = expectedSparse(a.editor.pmSchema, local, 'R');
    expectOriginals(expectSparse(a, peerOnly), original);
    expectSparse(b, peerOnly);
    expect(a.history.undoStack).toHaveLength(0);
    expect(b.history.undoStack).toHaveLength(1);
    const reopened = open(clone(a.doc));
    expectSparse(reopened, peerOnly);
  });

  it('accepts new typing into the same default cell after the first input is undone', () => {
    const doc = sparseFixture();
    const a = open(doc);
    const local = hole(frame(a));
    const original = ['A', 'B', 'C', 'Z'].flatMap((id) => codecNativeTokens(doc, id, 1));
    type(a, local.owner.id, 'Q');
    expectSparse(a, expectedSparse(a.editor.pmSchema, local, 'Q'));
    act(() => { a.history.undo(); });
    expectSparse(a, expectedSparse(a.editor.pmSchema, local));
    type(a, local.owner.id, 'R');
    expectOriginals(expectSparse(a, expectedSparse(a.editor.pmSchema, local, 'R')), original);
    expect(a.history.undoStack).toHaveLength(1);
    expect(a.history.redoStack).toHaveLength(0);
    act(() => { a.history.undo(); });
    expectSparse(a, expectedSparse(a.editor.pmSchema, local));
    act(() => { a.history.redo(); });
    expectOriginals(expectSparse(a, expectedSparse(a.editor.pmSchema, local, 'R')), original);
  });

  it('materializes the complete empty synthetic body on first real input and restores empty content with one native undo', () => {
    const doc = codecFixture([]);
    const bytes = Y.encodeStateAsUpdate(doc);
    const a = open(doc);
    const b = open(clone(doc));
    const before = frame(a);
    expect(before.synthetic).toBe(true);
    expect(before.units).toEqual([]);
    const local = [...before.index.derived.values()].filter((record) => record.kind === 'owner');
    expect(local).toHaveLength(1);
    const owner = local[0];
    expect(documentBodyRecords(doc).records.has(owner.id)).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(a.editor.prosemirrorState.doc.toJSON()).toEqual(b.editor.prosemirrorState.doc.toJSON());
    let userUpdates = 0;
    doc.on('update', (_update, origin) => { if (origin === a.origin) userUpdates += 1; });

    type(a, owner.id, 'Q');

    expect(a.runtime.read().status).toBe('active');
    const expected = a.editor.pmSchema.node('doc', null, a.editor.pmSchema.node('blockGroup', null, codecParagraph(a.editor.pmSchema, owner.id, 'Q')));
    expect(a.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    const actual = project(doc, a.editor.pmSchema);
    expect(actual.synthetic).toBe(false);
    expect(actual.doc.toJSON()).toEqual(expected.toJSON());
    expect(actual.units.map((unit) => [unit.block, unit.value])).toEqual([[owner.id, 'Q']]);
    expect(actual.view.body.records.get(owner.id)).toMatchObject({ kind: 'owner', type: 'paragraph', base: false });
    expect(actual.view.body.sources.size).toBeGreaterThan(0);
    expect(userUpdates).toBe(1);
    expect(a.history.undoStack).toHaveLength(1);
    exchange(a, b);
    expect(b.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    act(() => { a.history.undo(); });
    exchange(a, b, false);
    expect(project(doc, a.editor.pmSchema).synthetic).toBe(true);
    expect(project(doc, a.editor.pmSchema).units).toEqual([]);
    expect(a.editor.prosemirrorState.doc.toJSON()).toEqual(before.doc.toJSON());
    expect(b.editor.prosemirrorState.doc.toJSON()).toEqual(before.doc.toJSON());
    expect(a.history.undoStack).toHaveLength(0);
    expect(a.history.redoStack).toHaveLength(1);
    act(() => { a.history.redo(); });
    exchange(a, b);
    expect(a.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    expect(b.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    const saved = clone(doc);
    const savedBytes = Y.encodeStateAsUpdate(saved);
    const reopened = open(saved);
    expect(reopened.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
    expect(project(saved, reopened.editor.pmSchema).synthetic).toBe(false);
    expect(Y.encodeStateAsUpdate(saved)).toEqual(savedBytes);
  });
});
