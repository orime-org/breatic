// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import * as Y from 'yjs';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';

import { type BodyFact, type BodyJsonObject, type BodyRecord } from '@breatic/shared';
import { documentBodyFragment, documentBodySource, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { cleanupCodecFixtures, codecDoc, codecFacts, codecFixture, codecNativeTokens, codecSchema } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

/** An independently specified original cell and its original geometric attrs. */
interface GeometryCell {
  readonly id: string;
  readonly attrs?: BodyJsonObject;
}

/** One independently specified sparse geometry and exact installed-library result. */
interface GeometryCase {
  readonly name: string;
  readonly problem: string;
  readonly rows: readonly (readonly GeometryCell[])[];
  readonly grid: readonly (readonly string[])[];
  readonly width: number;
  readonly positions: readonly number[];
  readonly derived: number;
  readonly tail?: boolean;
}

const cases: readonly GeometryCase[] = [
  { name: 'missing cells', problem: 'missing', rows: [[{ id: 'A' }, { id: 'B' }], [{ id: 'C' }]], grid: [['A', 'B'], ['C', '']], width: 2, positions: [6, 13, 22], derived: 2 },
  { name: 'colliding spans', problem: 'collision', rows: [[{ id: 'A' }, { id: 'B', attrs: { rowspan: 2 } }], [{ id: 'C', attrs: { colspan: 2 } }]], grid: [['', 'A', 'B', ''], ['', '', 'C']], width: 4, positions: [12, 19, 46], derived: 8 },
  { name: 'overlong rowspans', problem: 'overlong_rowspan', rows: [[{ id: 'A', attrs: { rowspan: 4 } }]], grid: [['A']], width: 1, positions: [6], derived: 0 },
  { name: 'column width disagreements', problem: 'colwidth mismatch', rows: [[{ id: 'A', attrs: { colwidth: [120] } }, { id: 'B' }], [{ id: 'C', attrs: { colwidth: [140] } }, { id: 'D', attrs: { colwidth: [180] } }]], grid: [['A', 'B'], ['C', 'D']], width: 2, positions: [6, 13, 22, 29], derived: 0 },
  { name: 'an entirely empty visible row', problem: 'missing', rows: [[{ id: 'A' }, { id: 'B' }], []], grid: [['A', 'B'], ['', '']], width: 2, positions: [6, 13], derived: 4 },
  { name: 'an empty table with no rows', problem: 'zero_sized', rows: [], grid: [], width: 0, positions: [3], derived: 0, tail: true },
  { name: 'an empty table with an empty visible row', problem: 'zero_sized', rows: [[]], grid: [], width: 0, positions: [3], derived: 0, tail: true },
];

const editors: ReturnType<typeof buildDocumentEditor>[] = [];
const histories: Y.UndoManager[] = [];
const runtimes: ReturnType<typeof createDocumentBodyRuntime>[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    for (const editor of editors.splice(0)) editor.unmount();
    for (const runtime of runtimes.splice(0)) runtime.dispose();
    for (const history of histories.splice(0)) history.destroy();
    for (const host of hosts.splice(0)) host.remove();
    cleanupCodecFixtures();
  });
});

/**
 * Gives original cells explicit default geometry, independently of the codec.
 * @param cell - The test-owned original geometric input.
 * @returns Complete original cell attributes.
 * @throws {never}
 */
function cellAttrs(cell: GeometryCell): BodyJsonObject {
  return { id: `cell:${cell.id}`, colspan: 1, rowspan: 1, colwidth: null, ...cell.attrs };
}

/**
 * Registers a sparse native table; current id attrs keep otherwise empty rows visible.
 * @param input - Independently specified original geometry.
 * @returns A real native document with original units and one current mark.
 * @throws {Error} If the production records boundary rejects the fixture.
 */
function geometryFixture(input: GeometryCase): Y.Doc {
  const containers: BodyRecord[] = [{ id: 'table', kind: 'container', type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'A' }];
  const owners = input.rows.flatMap((row, ordinal) => {
    containers.push({ id: `row:${ordinal}`, kind: 'container', type: 'docTableRow', attrs: { id: `row:${ordinal}` }, parent: 'table', order: String(ordinal) });
    return row.map((cell, index) => {
      containers.push({ id: `cell:${cell.id}`, kind: 'container', type: 'docTableCell', attrs: cellAttrs(cell), parent: `row:${ordinal}`, order: String(index) });
      return { id: cell.id, text: cell.id, parent: `cell:${cell.id}` };
    });
  });
  if (input.tail) owners.push({ id: 'Z', text: 'Z', parent: 'group' });
  const doc = codecFixture(owners, containers);
  const visible: BodyFact[] = ['table', ...input.rows.map((_, ordinal) => `row:${ordinal}`)].map((owner, ordinal) => ({ id: `geometry:${ordinal}`, group: 'geometry', kind: 'attribute', owner, name: 'id', value: owner, counter: 1, dependencies: [] }));
  codecFacts(doc, 'geometry', visible);
  if (owners.some((owner) => owner.id === 'A')) {
    registerDocumentBodyRecords(doc, { facts: [{ id: 'original-bold', group: 'original-format', kind: 'mark', dependencies: [], payload: { type: 'bold', attrs: {} } }], groups: [{ id: 'original-format', facts: ['original-bold'], history: 'base' }] });
    documentBodySource(doc, 'S:A').format(1, 1, { 'mark:bold': { factId: 'original-bold' } });
  }
  return doc;
}

/**
 * Builds the independent raw PM input using exactly the real schema and original geometry.
 * @param schema - The actual production schema.
 * @param input - Test-owned original rows, cells and attributes.
 * @returns Raw PM geometry before installed table repair.
 * @throws {RangeError} If the fixture cannot be represented by the real schema.
 */
function rawDocument(schema: Schema, input: GeometryCase): PMNode {
  const rows = input.rows.map((row, ordinal) => schema.node('docTableRow', { id: `row:${ordinal}` }, row.map((cell) => schema.node('docTableCell', cellAttrs(cell), schema.node('blockContainer', { id: cell.id }, schema.node('paragraph', null, schema.text(cell.id, cell.id === 'A' ? [schema.mark('bold')] : [])))))));
  const table = schema.nodes['docTable'].create({ id: 'table' }, rows);
  const tail = input.tail ? [schema.node('blockContainer', { id: 'Z' }, schema.node('paragraph', null, schema.text('Z')))] : [];
  return schema.node('doc', null, schema.node('blockGroup', null, [table, ...tail]));
}

/**
 * Applies the independent installed repair until its own TableMap reports no remaining problem.
 * @param doc - The raw independently constructed PM input.
 * @returns The installed library's stable corrected document.
 * @throws {Error} If this finite fixture does not settle within the bounded test oracle.
 */
function upstreamRepair(doc: PMNode): PMNode {
  let state = EditorState.create({ doc });
  for (let pass = 0; pass < 8; pass += 1) {
    const correction = fixTables(state);
    if (correction === undefined) return state.doc;
    state = state.apply(correction);
  }
  throw new Error('The installed repair did not settle for the fixed geometry fixture');
}

/**
 * Requires a real codec frame, with no schema or table repair stub.
 * @param doc - The original native document.
 * @param schema - The actual production schema.
 * @param epoch - The caller's final publication epoch.
 * @returns The complete real projection.
 * @throws {Error} If native dependencies are incomplete.
 */
function projection(doc: Y.Doc, schema: Schema, epoch = 1): BodyProjection {
  const read = projectBodyTree(doc, schema, { document: 'document:geometry', epoch });
  expect(read.status).toBe('ready');
  if (read.status !== 'ready') throw new Error('The sparse native fixture is incomplete');
  return read.projection;
}

/**
 * Compares all node attrs and contents while leaving generated identity to separate assertions.
 * @param value - The complete PM JSON value.
 * @param registered - Original registered identities that must remain exact.
 * @returns Full PM JSON with only derived id values normalized to null.
 * @throws {never}
 */
function geometryJson(value: unknown, registered: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((child) => geometryJson(child, registered));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'id' && typeof child === 'string' && !registered.has(child) ? null : geometryJson(child, registered)]));
}

/**
 * Reads the actual repaired table without assuming its original offsets survived.
 * @param doc - A complete PM projection.
 * @returns The real table, or null after zero-sized table omission.
 * @throws {never}
 */
function tableOf(doc: PMNode): PMNode | null {
  let table: PMNode | null = null;
  doc.descendants((node) => { if (node.type.spec.tableRole === 'table') table = node; });
  return table;
}

/**
 * Reads original cell text per physical row, retaining empty derived cells.
 * @param table - The installed repaired table.
 * @returns Its cell contents in physical row order.
 * @throws {never}
 */
function gridOf(table: PMNode): string[][] {
  return Array.from({ length: table.childCount }, (_, row) => Array.from({ length: table.child(row).childCount }, (__, cell) => table.child(row).child(cell).textContent));
}

/**
 * Requires every generated cell and default block to have a distinct stable v5 identity.
 * @param doc - The actual codec or mounted PM projection.
 * @param registered - The immutable source's original node identities.
 * @param count - The independently expected number of generated node identities.
 * @returns Derived identities in current document order.
 * @throws {Error} If a generated slot has no string identity.
 */
function derivedIds(doc: PMNode, registered: ReadonlySet<string>, count: number): string[] {
  const result: string[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'blockContainer' && node.type.spec.tableRole !== 'cell' && node.type.spec.tableRole !== 'header_cell') return;
    const id: unknown = node.attrs['id'];
    if (typeof id === 'string' && registered.has(id)) return;
    expect(id).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u));
    if (typeof id !== 'string') throw new Error('Every derived cell and block must have a stable identity');
    result.push(id);
  });
  expect(result).toHaveLength(count);
  expect(new Set(result).size).toBe(count);
  return result;
}

/**
 * Mounts the actual records factory with a real native history and runtime.
 * @param doc - The independently synchronized native source.
 * @returns The production editor, its runtime and its native history.
 * @throws {Error} If real editor assembly or mounting fails.
 */
function mountRecords(doc: Y.Doc): { editor: ReturnType<typeof buildDocumentEditor>; runtime: ReturnType<typeof createDocumentBodyRuntime>; history: Y.UndoManager } {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:geometry', origin, runtime, history } });
  const host = document.createElement('div');
  editors.push(editor);
  runtimes.push(runtime);
  histories.push(history);
  hosts.push(host);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return { editor, runtime, history };
}

describe('read-only sparse table projection and deterministic derived geometry', () => {
  it.each(cases)('repairs $name using installed geometry while preserving native units and exact positions', (input) => {
    const schema = codecSchema();
    const doc = geometryFixture(input);
    const raw = rawDocument(schema, input);
    const rawTable = raw.nodeAt(1)!;
    expect(TableMap.get(rawTable).problems?.map((problem) => problem.type)).toContain(input.problem);
    const expected = upstreamRepair(raw);
    const history = new Y.UndoManager(doc, { trackedOrigins: new Set([{}]) });
    histories.push(history);
    const before = Y.encodeStateAsUpdate(doc);
    const labels = [...input.rows.flat().map((cell) => cell.id), ...(input.tail ? ['Z'] : [])];
    const tokens = labels.flatMap((label) => codecNativeTokens(doc, label, label.length));
    let updates = 0;
    doc.on('update', () => { updates += 1; });

    const frame = projection(doc, schema);
    const registered = new Set(frame.view.body.records.keys());
    expect(geometryJson(frame.doc.toJSON(), registered)).toEqual(geometryJson(expected.toJSON(), registered));
    expect(() => frame.doc.check()).not.toThrow();
    const table = tableOf(frame.doc);
    if (input.width === 0) expect(table).toBeNull();
    else {
      if (table === null) throw new Error('The repaired table must retain its original content');
      expect(TableMap.get(table).problems).toBeNull();
      expect(TableMap.get(table).width).toBe(input.width);
      expect(gridOf(table)).toEqual(input.grid);
    }
    expect(frame.units.map((unit) => unit.token)).toEqual(tokens);
    expect(frame.units.map((unit) => unit.pos)).toEqual(input.positions);
    expect(frame.units.map((unit) => unit.value)).toEqual(labels);
    expect(frame.index.units.map((unit) => unit.token)).toEqual(tokens);
    frame.doc.descendants((node, pos) => {
      const id: unknown = node.attrs['id'];
      if (typeof id !== 'string' || !registered.has(id)) return;
      const boundary = frame.index.nodes.get(id);
      expect(boundary).toMatchObject({ id, from: pos, to: pos + node.nodeSize });
      if (node.type.name === 'blockContainer') expect(frame.index.owners.get(id)).toMatchObject({ contentFrom: pos + 2, contentTo: pos + 2 + node.firstChild!.content.size });
      else expect(boundary).toMatchObject({ contentFrom: pos + 1, contentTo: pos + node.nodeSize - 1 });
    });
    for (const unit of frame.index.units) {
      expect(frame.doc.textBetween(unit.pos, unit.pos + unit.width)).toBe(unit.value);
      expect(frame.index.owners.get(unit.owner)!.contentFrom).toBe(unit.pos);
    }
    const ids = derivedIds(frame.doc, registered, input.derived);
    const second = projection(doc, schema, 2);
    expect(second.doc.toJSON()).toEqual(frame.doc.toJSON());
    expect(derivedIds(second.doc, registered, input.derived)).toEqual(ids);
    if (input.problem === 'overlong_rowspan') expect(table!.firstChild!.firstChild!.attrs['rowspan']).toBe(1);
    if (input.problem === 'colwidth mismatch') expect(Array.from({ length: 2 }, (_, row) => Array.from({ length: 2 }, (__, cell) => table!.child(row).child(cell).attrs['colwidth']))).toEqual([[[140], [180]], [[140], [180]]]);
    expect(updates).toBe(0);
    expect(history.undoStack).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('gives two peers identical complete JSON and stable hole IDs without native registration', () => {
    const schema = codecSchema();
    const first = geometryFixture(cases[0]);
    const bytes = Y.encodeStateAsUpdate(first);
    const second = codecDoc();
    Y.applyUpdate(second, bytes);
    const one = projection(first, schema);
    const two = projection(second, schema, 9);
    const registered = new Set(one.view.body.records.keys());
    expect(two.doc.toJSON()).toEqual(one.doc.toJSON());
    expect(derivedIds(two.doc, registered, 2)).toEqual(derivedIds(one.doc, registered, 2));
    expect(two.units).toEqual(one.units);
    expect(Y.encodeStateAsUpdate(first)).toEqual(bytes);
    expect(Y.encodeStateAsUpdate(second)).toEqual(bytes);
  });

  it('keeps mounted holes stable when real remote projection invokes the UniqueID normalizer', () => {
    const writer = geometryFixture(cases[0]);
    const original = Y.encodeStateAsUpdate(writer);
    const first = codecDoc();
    const second = codecDoc();
    Y.applyUpdate(first, original);
    Y.applyUpdate(second, original);
    const a = mountRecords(first);
    const b = mountRecords(second);
    const registered = new Set(projection(writer, a.editor.pmSchema).view.body.records.keys());
    const initialIds = derivedIds(a.editor.prosemirrorState.doc, registered, 2);
    expect(b.editor.prosemirrorState.doc.toJSON()).toEqual(a.editor.prosemirrorState.doc.toJSON());
    expect(Y.encodeStateAsUpdate(first)).toEqual(original);
    expect(Y.encodeStateAsUpdate(second)).toEqual(original);

    const generators = [a.editor, b.editor].map((editor) => {
      const extension = editor._tiptapEditor.extensionManager.extensions.find((candidate) => candidate.name === 'uniqueID');
      if (extension === undefined) throw new Error('The real UniqueID normalizer must be installed');
      const options: unknown = extension.options;
      if (typeof options !== 'object' || options === null || !('generateID' in options) || typeof options.generateID !== 'function') throw new Error('The installed UniqueID must expose its actual generator');
      return vi.spyOn(options as { generateID: () => string }, 'generateID');
    });
    documentBodySource(writer, 'S:A').insert(1, 'X', { ctx: 'base' });
    const remote = Y.encodeStateAsUpdate(writer);
    act(() => {
      Y.applyUpdate(first, remote, 'remote-geometry');
      Y.applyUpdate(second, remote, 'remote-geometry');
    });
    expect(a.runtime.read().status).toBe('active');
    expect(b.runtime.read().status).toBe('active');
    expect(a.editor.prosemirrorState.doc.textContent).toBe('XABC');
    expect(b.editor.prosemirrorState.doc.toJSON()).toEqual(a.editor.prosemirrorState.doc.toJSON());
    expect(derivedIds(a.editor.prosemirrorState.doc, registered, 2)).toEqual(initialIds);
    expect(derivedIds(b.editor.prosemirrorState.doc, registered, 2)).toEqual(initialIds);
    for (const generate of generators) expect(generate).not.toHaveBeenCalled();
    expect(a.history.undoStack).toHaveLength(0);
    expect(b.history.undoStack).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(first)).toEqual(remote);
    expect(Y.encodeStateAsUpdate(second)).toEqual(remote);
  });
});
