// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type BodyTreeOwner, type BodyTreeUnit, type BodyTreeView } from '@breatic/shared';
import { documentBodyFragment, documentBodyRecords, documentBodySource, documentCommentThreads, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { cleanupCodecFixtures, codecDoc, codecFixture, type CodecOwner } from '@web/spaces/document/__tests__/document-body-codec-fixtures';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
  userUpdates: number;
}

type DropKind = 'same paragraph' | 'cross paragraph' | 'cross block';
type ExpectedOwner = readonly [string, readonly (string | number)[]];
const opened: OpenBody[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.runtime.dispose();
      body.history.destroy();
      body.host.remove();
    }
    cleanupCodecFixtures();
  });
});

/** Reads original native units independently of the accepted PM state. @throws {Error} If source dependencies are incomplete. */
function native(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete drop fixture: ${read.status}`);
  return read.view;
}

/** Adds native mark facts and opaque payloads without using the producer under test. @throws {Error} If registration fails. */
function markFixture(doc: Y.Doc, owners: readonly CodecOwner[]): Y.Doc {
  registerDocumentBodyRecords(doc, { groups: [{ id: 'drop-marks', facts: ['drop-bold', 'drop-link', 'drop-comment'], history: 'base' }], facts: [
    { id: 'drop-bold', kind: 'mark', group: 'drop-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
    { id: 'drop-link', kind: 'mark', group: 'drop-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/drop' } } },
    { id: 'drop-comment', kind: 'mark', group: 'drop-marks', dependencies: [], payload: { type: 'comment', attrs: { threadId: 'drop-thread', orphan: false } } },
  ] });
  documentBodyRecords(doc).enabled.set('drop-marks', true);
  for (const owner of owners) {
    documentBodySource(doc, `S:${owner.id}`).format(1, owner.text.length, {
      'mark:bold': { factId: 'drop-bold' }, 'mark:link': { factId: 'drop-link' },
      'mark:comment:drop-thread': { factId: 'drop-comment' }, 'vendor-payload': { owner: owner.id, keep: [7, true] },
    });
  }
  documentCommentThreads(doc).set('drop-thread', { id: 'drop-thread', resolved: false, createdAt: '2026-10-25T12:00:00.000Z', comments: [
    { id: 'drop-note', userId: 'author', body: [{ type: 'text', text: 'Original discussion' }] },
  ] });
  return doc;
}

/** Opens the actual records factory and native history without XML fallback. @throws {Error} If construction fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:drop-append', runtime, origin, history } });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, history, origin, host, userUpdates: 0 };
  opened.push(body);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  doc.on('update', (_bytes, actualOrigin) => { if (actualOrigin === origin) body.userUpdates += 1; });
  return body;
}

/** Opens an independent client from genuine encoded source bytes. @throws {Error} If Yjs rejects the snapshot. */
function clone(doc: Y.Doc): Y.Doc {
  const next = codecDoc();
  Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
  return next;
}

/** Sends both directions and repeats each actual native update. @throws {Error} If an update is invalid. */
function exchange(author: OpenBody, peer: OpenBody): void {
  act(() => {
    for (let round = 0; round < 2; round += 1) {
      const toPeer = Y.encodeStateAsUpdate(author.doc, Y.encodeStateVector(peer.doc));
      const toAuthor = Y.encodeStateAsUpdate(peer.doc, Y.encodeStateVector(author.doc));
      for (const [doc, bytes] of [[peer.doc, toPeer], [author.doc, toAuthor]] as const) {
        Y.applyUpdate(doc, bytes, 'peer');
        Y.applyUpdate(doc, bytes, 'peer');
      }
    }
  });
}

/** Builds the independently expected original or comment-stripped copy marks. @throws {RangeError} If a product mark is absent. */
function marks(schema: Schema, copied = false): readonly Mark[] {
  return [schema.mark('bold'), schema.mark('link', { href: 'https://example.com/drop' }), ...(copied ? [] : [schema.mark('comment', { threadId: 'drop-thread', orphan: false })])];
}

/** Builds an expected wrapper with separately specified runs, kind and children. @throws {RangeError} If the expected node is invalid. */
function paragraph(schema: Schema, id: string, runs: readonly PMNode[], children: readonly PMNode[] = [], type = 'paragraph'): PMNode {
  return schema.node('blockContainer', { id }, [schema.node(type, type === 'heading' ? { level: 2 } : {}, runs), ...(children.length === 0 ? [] : [schema.node('blockGroup', null, children)])]);
}

/** Builds a complete expected document with no dependency on the fitter's result. @throws {RangeError} If the expected tree is invalid. */
function documentOf(schema: Schema, nodes: readonly PMNode[]): PMNode {
  return schema.node('doc', null, schema.node('blockGroup', null, nodes));
}

/** Captures original identities by their explicit seed owner, never by repeated words. @throws {Error} If a seed owner is absent. */
function ids(original: BodyTreeView, owner: string): readonly string[] {
  const found = original.owners.find((candidate) => candidate.id === owner);
  if (found === undefined) throw new Error('Missing explicitly seeded owner');
  return found.units.map((unit) => unit.id);
}

/** Keeps exact native identity and original payload separate from new permanent cut geometry. @throws {never} */
function ownerPayload(owner: BodyTreeOwner): unknown {
  return { ...owner, units: owner.units.map((unit) => ({ id: unit.id, source: unit.source, value: unit.value, attributes: unit.attributes })) };
}

/** Reads the semantic mark types behind a fresh native unit's fact references. @throws {Error} If a mark reference is invalid. */
function markTypes(view: BodyTreeView, unit: BodyTreeUnit): readonly string[] {
  return Object.entries(unit.attributes).filter(([key]) => key.startsWith('mark:')).map(([, value]) => {
    if (value === null || typeof value !== 'object' || !('factId' in value) || typeof value.factId !== 'string') throw new Error('Invalid fresh mark reference');
    const fact = view.body.facts.get(value.factId);
    if (fact?.kind !== 'mark') throw new Error('Missing fresh mark payload');
    return fact.payload.type;
  }).sort();
}

/** Supplies only jsdom's missing host clipboard/coordinate boundary, then runs installed PM dragstart and drop. @throws {Error} If the actual native handlers cannot start or complete a drag. */
function internalDrop(body: OpenBody, from: number, to: number, target: number, copied: boolean): void {
  const view = body.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to))));
  const clipboard = new Map<string, string>();
  const transfer = {
    files: [], items: [], types: [] as string[], effectAllowed: 'uninitialized', dropEffect: 'none',
    getData: (type: string): string => clipboard.get(type) ?? '',
    setData: (type: string, value: string): void => { clipboard.set(type, value); transfer.types = [...clipboard.keys()]; },
    clearData: (): void => { clipboard.clear(); transfer.types = []; },
    setDragImage: (): void => undefined,
  };
  let position = from;
  const geometry = vi.spyOn(view, 'posAtCoords').mockImplementation(() => ({ pos: position, inside: -1 }));
  try {
    const start = new MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
    Object.defineProperty(start, 'dataTransfer', { value: transfer });
    act(() => view.dispatchEvent(start));
    if (view.dragging === null) throw new Error('Installed PM dragstart did not capture its real selection');
    expect([view.dragging.slice.openStart, view.dragging.slice.openEnd]).toEqual([3, 3]);
    expect(view.dragging.move).toBe(true);
    // Ctrl is changed at drop time on this real non-Mac jsdom platform;
    // no browser platform or PM copy/move decision is mocked.
    position = target;
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, ctrlKey: copied });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    act(() => view.dispatchEvent(drop));
    expect(drop.defaultPrevented).toBe(true);
    expect(view.dragging).toBeNull();
  } finally {
    geometry.mockRestore();
  }
}

/** Builds expected PM text runs and original/fresh positions from the explicit drop model. @throws {RangeError} If the expected product tree is invalid. */
function dropModel(schema: Schema, kind: DropKind, copied: boolean, original: BodyTreeView, extraId = 'B'): { readonly doc: PMNode; readonly owners: readonly ExpectedOwner[] } {
  const a = ids(original, 'A');
  const b = ids(original, 'B');
  const full = marks(schema);
  const copy = marks(schema, true);
  if (kind === 'same paragraph') return {
    doc: documentOf(schema, [paragraph(schema, 'A', copied ? [schema.text('AAAA', full), schema.text('AA', copy)] : [schema.text('AAAA', full)]), paragraph(schema, 'B', [schema.text('AA', full)])]),
    owners: [['A', copied ? [...a, 0, 1] : [a[0], a[3], a[1], a[2]]], ['B', b]],
  };
  if (kind === 'cross paragraph') return {
    doc: documentOf(schema, [paragraph(schema, 'A', [schema.text(copied ? 'AAAA' : 'AA', full)]), paragraph(schema, 'B', copied ? [schema.text('A', full), schema.text('AA', copy), schema.text('A', full)] : [schema.text('AAAA', full)])]),
    owners: [['A', copied ? a : [a[0], a[3]]], ['B', copied ? [b[0], 0, 1, b[1]] : [b[0], a[1], a[2], b[1]]]],
  };
  const c = ids(original, 'C');
  const z = ids(original, 'Z');
  return {
    doc: documentOf(schema, [
      paragraph(schema, 'A', [schema.text('AA', full)]),
      ...(copied ? [paragraph(schema, 'B', [schema.text('AA', full)])] : []),
      paragraph(schema, 'C', [schema.text('AA', full)]),
      paragraph(schema, 'Z', copied ? [schema.text('A', full), schema.text('A', copy)] : [schema.text('AA', full)]),
      paragraph(schema, extraId, copied ? [schema.text('A', copy), schema.text('A', full)] : [schema.text('AA', full)]),
    ]),
    owners: copied ? [['A', a], ['B', b], ['C', c], ['Z', [z[0], 0]], [extraId, [1, z[1]]]] : [['A', [a[0], b[1]]], ['C', c], ['Z', [z[0], a[1]]], ['B', [b[0], z[1]]]],
  };
}

/** Checks native source inheritance or explicitly fresh copy positions without a text-diff oracle. @throws {Error} If projection or source metadata is invalid. */
function expectDrop(body: OpenBody, model: ReturnType<typeof dropModel>, original: BodyTreeView, copied: boolean): void {
  expect(body.runtime.read().status).toBe('active');
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(model.doc.toJSON());
  const view = native(body.doc);
  expect(view.owners.map((owner) => owner.id)).toEqual(model.owners.map(([owner]) => owner));
  const before = new Map(original.units.map((unit) => [unit.id, unit]));
  const sources = new Set(original.units.map((unit) => unit.source));
  const fresh: string[] = [];
  for (const [owner, wanted] of model.owners) {
    const actual = view.owners.find((candidate) => candidate.id === owner)!.units;
    expect(actual).toHaveLength(wanted.length);
    for (const [index, expected] of wanted.entries()) {
      const unit = actual[index];
      if (typeof expected === 'string') {
        const prior = before.get(expected)!;
        expect({ id: unit.id, source: unit.source, value: unit.value, attributes: unit.attributes }).toEqual({ id: prior.id, source: prior.source, value: prior.value, attributes: prior.attributes });
      } else {
        expect(copied).toBe(true);
        expect(before.has(unit.id)).toBe(false);
        expect(sources.has(unit.source)).toBe(false);
        expect(unit.value).toBe('A');
        expect(markTypes(view, unit)).toEqual(['bold', 'link']);
        expect(unit.attributes['vendor-payload']).toBeUndefined();
        const context = unit.attributes['ctx'];
        expect(typeof context).toBe('string');
        expect(view.body.contexts.has(String(context))).toBe(true);
        fresh.push(unit.id);
      }
    }
  }
  expect(fresh).toHaveLength(copied ? 2 : 0);
  expect(new Set(view.units.map((unit) => unit.id)).size).toBe(model.owners.reduce((sum, [, units]) => sum + units.length, 0));
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The actual drop binding is absent');
  expect(binding.read().units.map((unit) => unit.token)).toEqual(view.owners.flatMap((owner) => owner.units.map((unit) => unit.id)));
}

describe('actual internal text drop and accepted unfold append at the unit event layer', () => {
  it.each([
    ['same paragraph', false], ['same paragraph', true], ['cross paragraph', false], ['cross paragraph', true], ['cross block', false], ['cross block', true],
  ] as const)('keeps fitted %s native provenance with copy modifier=%s', (kind, copied) => {
    const owners = kind === 'cross block'
      ? [{ id: 'A', text: 'AA' }, { id: 'B', text: 'AA' }, { id: 'C', text: 'AA' }, { id: 'Z', text: 'AA' }]
      : [{ id: 'A', text: 'AAAA' }, { id: 'B', text: 'AA' }];
    const doc = markFixture(codecFixture(owners), owners);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, owners.map((owner) => paragraph(schema, owner.id, [schema.text(owner.text, marks(schema))])));
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    const threads = documentCommentThreads(doc).toJSON();
    const index = bodyBindingOf(author.editor.prosemirrorState)!.read().index;
    const from = index.owners.get('A')!.contentFrom + 1;
    const to = kind === 'cross block' ? index.owners.get('B')!.contentFrom + 1 : from + 2;
    const target = kind === 'same paragraph' ? index.owners.get('A')!.contentTo : index.owners.get(kind === 'cross block' ? 'Z' : 'B')!.contentFrom + 1;

    internalDrop(author, from, to, target, copied);

    const finalExtra: unknown = kind === 'cross block' && copied ? author.editor.prosemirrorState.doc.firstChild?.lastChild?.attrs['id'] : 'B';
    if (typeof finalExtra !== 'string') throw new Error('The actual copied open slice did not create a named final block');
    if (kind === 'cross block' && copied) expect(original.body.records.has(finalExtra)).toBe(false);
    const model = dropModel(schema, kind, copied, original, finalExtra);
    expectDrop(author, model, original, copied);
    expect(author.userUpdates).toBe(1);
    expect(author.history.undoStack).toHaveLength(1);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    exchange(author, peer);
    expectDrop(peer, model, original, copied);
    expect(native(peer.doc).owners).toEqual(native(doc).owners);
    expect(peer.history.undoStack).toHaveLength(0);
    act(() => { author.history.undo(); });
    exchange(author, peer);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(native(doc).owners.map(ownerPayload)).toEqual(original.owners.map(ownerPayload));
    expect(native(peer.doc).owners.map(ownerPayload)).toEqual(original.owners.map(ownerPayload));
    act(() => { author.history.redo(); });
    exchange(author, peer);
    expectDrop(author, model, original, copied);
    expectDrop(peer, model, original, copied);
    expect(native(peer.doc).owners).toEqual(native(doc).owners);
    const reopened = open(clone(doc));
    expectDrop(reopened, model, original, copied);
    expect(native(reopened.doc).owners).toEqual(native(doc).owners);
    expect(documentCommentThreads(reopened.doc).toJSON()).toEqual(threads);
  });

  it('commits actual block insertion and cell-table unfold append as one user batch with original sources intact', () => {
    const owners = [{ id: 'P', text: 'AA', type: 'bulletListItem', parent: 'left' }, { id: 'K', text: 'AA', parent: 'nested' }, { id: 'Z', text: 'AA', parent: 'right' }];
    const doc = markFixture(codecFixture(owners, [
      { id: 'outer', kind: 'container', type: 'docTable', attrs: { id: 'outer' }, parent: 'group', order: 'A' },
      { id: 'row', kind: 'container', type: 'docTableRow', attrs: { id: 'row' }, parent: 'outer', order: 'A' },
      { id: 'left', kind: 'container', type: 'docTableCell', attrs: { id: 'left', colspan: 1, rowspan: 1, colwidth: null }, parent: 'row', order: 'A' },
      { id: 'right', kind: 'container', type: 'docTableCell', attrs: { id: 'right', colspan: 1, rowspan: 1, colwidth: null }, parent: 'row', order: 'B' },
      { id: 'nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
    ]), owners);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const full = marks(schema);
    const originalK = paragraph(schema, 'K', [schema.text('AA', full)]);
    const inserted = [
      paragraph(schema, 'I', [schema.text('AA', [schema.mark('bold')])], [paragraph(schema, 'IC', [schema.text('AA')])], 'heading'),
      paragraph(schema, 'J', [schema.text('AA', [schema.mark('italic')])]),
    ];
    const makeExpected = (withInserted: boolean): PMNode => documentOf(schema, [schema.node('docTable', { id: 'outer' }, schema.node('docTableRow', { id: 'row' }, [
      schema.node('docTableCell', { id: 'left', colspan: 1, rowspan: 1, colwidth: null }, paragraph(schema, 'P', [schema.text('AA', full)], [...(withInserted ? inserted : []), originalK], 'bulletListItem')),
      schema.node('docTableCell', { id: 'right', colspan: 1, rowspan: 1, colwidth: null }, paragraph(schema, 'Z', [schema.text('AA', full)])),
    ]))]);
    const before = makeExpected(false);
    const after = makeExpected(true);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    const batches: (readonly Transaction[])[] = [];
    author.editor._tiptapEditor.on('transaction', ({ transaction, appendedTransactions }) => {
      if (rowById(transaction.doc, 'incoming') !== undefined) batches.push([transaction, ...appendedTransactions]);
    });
    const incoming = { ...tableBlock({ rows: [{ cells: [
      { blocks: [{ id: 'I', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'AA', styles: { bold: true } }], children: [{ id: 'IC', type: 'paragraph', content: 'AA' }] }] },
      { blocks: [{ id: 'J', type: 'paragraph', content: [{ type: 'text', text: 'AA', styles: { italic: true } }] }] },
    ] }] }), id: 'incoming' };
    act(() => { author.editor.insertBlocks([incoming] as never, 'K', 'before'); });
    expect(author.runtime.read().status).toBe('active');
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(batches).toHaveLength(1);
    expect(batches[0].slice(1).filter((transaction) => rowById(transaction.before, 'incoming') !== undefined && rowById(transaction.doc, 'incoming') === undefined).map((transaction) => transaction.doc.textContent)).toEqual(['AAAAAAAAAAAA']);
    expect(batches[0].at(-1)!.doc.toJSON()).toEqual(after.toJSON());
    expect(rowById(author.editor.prosemirrorState.doc, 'incoming')).toBeUndefined();
    expect(author.userUpdates).toBe(1);
    expect(author.history.undoStack).toHaveLength(1);
    const current = native(doc);
    expect(current.owners.map((owner) => owner.id)).toEqual(['P', 'I', 'IC', 'J', 'K', 'Z']);
    for (const old of original.owners) expect(ownerPayload(current.owners.find((owner) => owner.id === old.id)!)).toEqual(ownerPayload(old));
    const fresh = current.owners.filter((owner) => ['I', 'IC', 'J'].includes(owner.id)).flatMap((owner) => owner.units);
    expect(fresh).toHaveLength(6);
    expect(new Set(fresh.map((unit) => unit.id)).size).toBe(6);
    expect(fresh.every((unit) => !original.units.some((prior) => prior.id === unit.id || prior.source === unit.source))).toBe(true);
    expect(current.owners.find((owner) => owner.id === 'I')!.units.map((unit) => markTypes(current, unit))).toEqual([['bold'], ['bold']]);
    expect(current.owners.find((owner) => owner.id === 'IC')!.units.map((unit) => markTypes(current, unit))).toEqual([[], []]);
    expect(current.owners.find((owner) => owner.id === 'J')!.units.map((unit) => markTypes(current, unit))).toEqual([['italic'], ['italic']]);
    const table = rowById(author.editor.prosemirrorState.doc, 'outer')!;
    const map = TableMap.get(table.node);
    expect([map.width, map.height, map.problems]).toEqual([2, 1, null]);
    exchange(author, peer);
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(native(peer.doc).owners).toEqual(current.owners);
    expect(peer.history.undoStack).toHaveLength(0);
    act(() => { author.history.undo(); });
    exchange(author, peer);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(native(doc).owners.map(ownerPayload)).toEqual(original.owners.map(ownerPayload));
    act(() => { author.history.redo(); });
    exchange(author, peer);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    for (const old of original.owners) expect(ownerPayload(native(doc).owners.find((owner) => owner.id === old.id)!)).toEqual(ownerPayload(old));
    const reopened = open(clone(doc));
    expect(reopened.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(native(reopened.doc).owners).toEqual(native(doc).owners);
    expect(documentCommentThreads(reopened.doc).toJSON()).toEqual(documentCommentThreads(doc).toJSON());
  });
});
