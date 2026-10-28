// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { createExtension } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import { act } from '@testing-library/react';
import type { Mark, Node as PMNode, Schema } from '@tiptap/pm/model';
import { NodeSelection, Plugin, TextSelection, type Selection, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { type BodyTreeOwner, type BodyTreeUnit, type BodyTreeView } from '@breatic/shared';
import { documentBodyFragment, documentBodyRecords, documentBodySource, documentCommentThreads, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { buildDocumentEditor, type DocumentEditorOptions } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { BodyProjectionIndex } from '@web/spaces/document/document-body-codec-types';
import { finalizeBodyPointName, isNamedCharacterAlive, nameBodyPoint, nameBodySelection, resolveBodyPoint, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import type { BodyPointName, BodyPointResolution, BodyStagedTextPointName } from '@web/spaces/document/document-body-positions-types';
import type { BodyInlineUnit } from '@web/spaces/document/document-body-provenance';
import { stagedBodyNameState } from '@web/spaces/document/document-body-staged';
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
function open(doc: Y.Doc, extensions: DocumentEditorOptions['extensions'] = []): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), extensions, body: { document: 'document:drop-append', runtime, origin, history } });
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

/** A real DOM drag whose coordinates may change while native or peer input arrives. */
interface DomDrag {
  readonly drop: (target: number) => void;
}

/** Supplies only missing host geometry and clipboard; PM and the post-DOM source listener run unmodified. @throws {Error} If the installed DOM handlers cannot capture a drag. */
function beginDomDrag(body: OpenBody, selection: Selection, implicitNode = false): DomDrag {
  const view = body.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.setSelection(selection)));
  const clipboard = new Map<string, string>();
  const transfer = {
    files: [], items: [], types: [] as string[], effectAllowed: 'uninitialized', dropEffect: 'none',
    getData: (type: string): string => clipboard.get(type) ?? '',
    setData: (type: string, value: string): void => { clipboard.set(type, value); transfer.types = [...clipboard.keys()]; },
    clearData: (): void => { clipboard.clear(); transfer.types = []; },
    setDragImage: (): void => undefined,
  };
  let position = implicitNode ? selection.to : selection.from;
  let inside = implicitNode ? selection.from : -1;
  const geometry = vi.spyOn(view, 'posAtCoords').mockImplementation(() => ({ pos: position, inside }));
  let source: Element = view.dom;
  if (selection instanceof NodeSelection) {
    const node = view.nodeDOM(selection.from);
    if (!(node instanceof Element)) throw new Error('The real inline node has no DOM target');
    source = node;
    if (implicitNode) {
      // Selected, non-draggable atoms are a normal PM mightDrag case. The right
      // edge lies outside its dragstart selection interval, so PM chooses node.
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 40, clientY: 40 });
      act(() => source.dispatchEvent(down));
    }
  }
  const start = new MouseEvent('dragstart', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
  Object.defineProperty(start, 'dataTransfer', { value: transfer });
  act(() => source.dispatchEvent(start));
  const dragging = view.dragging;
  if (dragging === null) throw new Error('The actual DOM dragstart did not create PM dragging');
  expect(dragging.move).toBe(true);
  if (implicitNode) {
    expect('node' in dragging && dragging.node instanceof NodeSelection).toBe(true);
    if (!('node' in dragging) || !(dragging.node instanceof NodeSelection)) throw new Error('PM did not choose the implicit selected atom');
    expect([dragging.node.from, dragging.node.to]).toEqual([selection.from, selection.to]);
  } else expect('node' in dragging ? dragging.node : undefined).toBeUndefined();
  expect([dragging.slice.openStart, dragging.slice.openEnd]).toEqual(selection instanceof NodeSelection ? [0, 0] : [3, 3]);
  return { drop: (target): void => {
    position = target;
    inside = -1;
    try {
      const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
      Object.defineProperty(drop, 'dataTransfer', { value: transfer });
      act(() => view.dom.dispatchEvent(drop));
      expect(drop.defaultPrevented).toBe(true);
      expect(view.dragging).toBeNull();
    } finally { geometry.mockRestore(); }
  } };
}

/** Replays actual history and duplicate network delivery against explicit before/after models. @throws {Error} If a native frame becomes invalid. */
function expectMoveHistory(author: OpenBody, peer: OpenBody, before: PMNode, model: ReturnType<typeof dropModel>, original: BodyTreeView, peerHistory = 0): void {
  expectDrop(author, model, original, false);
  expect(author.userUpdates).toBe(1);
  expect(author.history.undoStack).toHaveLength(1);
  const threads = documentCommentThreads(author.doc).toJSON();
  exchange(author, peer);
  expectDrop(peer, model, original, false);
  expect(native(peer.doc).owners).toEqual(native(author.doc).owners);
  expect(peer.history.undoStack).toHaveLength(peerHistory);
  act(() => { author.history.undo(); });
  exchange(author, peer);
  for (const body of [author, peer]) {
    expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(native(body.doc).owners.map(ownerPayload)).toEqual(original.owners.map(ownerPayload));
    expect(documentCommentThreads(body.doc).toJSON()).toEqual(threads);
  }
  act(() => { author.history.redo(); });
  exchange(author, peer);
  for (const body of [author, peer, open(clone(author.doc))]) {
    expectDrop(body, model, original, false);
    expect(native(body.doc).owners).toEqual(native(author.doc).owners);
    expect(documentCommentThreads(body.doc).toJSON()).toEqual(threads);
  }
}

/** Actual accepted root and append observations made by a passive consumer. */
interface FreshStageCapture {
  readonly root: { readonly units: readonly BodyInlineUnit[]; readonly names: readonly BodyPointName[]; readonly matches: boolean }[];
  readonly append: { readonly units: readonly BodyInlineUnit[]; readonly resolutions: readonly BodyPointResolution[]; readonly index: BodyProjectionIndex; readonly matches: boolean }[];
}

/** Observes the real binding after its state field, without constructing transactions or a replacement journal. @throws {never} */
function freshStageObserver(capture: FreshStageCapture): NonNullable<DocumentEditorOptions['extensions']>[number] {
  return createExtension(() => ({
    key: 'dropFreshNameConsumer',
    tiptapExtensions: [Extension.create({
      name: 'dropFreshNameConsumer', priority: -1,
      addProseMirrorPlugins: () => [new Plugin<null>({ state: {
        init: () => null,
        apply: (tr, _value, _old, state) => {
          const binding = bodyBindingOf(state);
          if (!tr.docChanged || binding === null) return null;
          const frame = binding.read(state);
          const units = (frame.index.staged?.units ?? []).filter((unit) => unit.block !== null && ['I', 'IC', 'J'].includes(unit.block));
          if (rowById(tr.doc, 'incoming') !== undefined && capture.root.length === 0) capture.root.push({
            units, matches: frame.doc.eq(tr.doc), names: units.map((unit) => nameBodyPoint(frame.index, { kind: 'text', pos: unit.pos, assoc: 1 })),
          });
          if (rowById(tr.before, 'incoming') !== undefined && rowById(tr.doc, 'incoming') === undefined) capture.append.push({
            units, index: frame.index, matches: frame.doc.eq(tr.doc),
            resolutions: (capture.root[0]?.names ?? []).map((name) => resolveBodyPoint(frame.index, name)),
          });
          return null;
        },
      } })],
    })],
  }))();
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

  it('moves the original DOM drag source after Safari-style caret relocation', () => {
    const owners = [{ id: 'A', text: 'AAAA' }, { id: 'B', text: 'AA' }];
    const doc = markFixture(codecFixture(owners), owners);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, owners.map((owner) => paragraph(schema, owner.id, [schema.text(owner.text, marks(schema))])));
    const view = author.editor.prosemirrorView;
    const index = bodyBindingOf(view.state)!.read().index;
    const from = index.owners.get('A')!.contentFrom + 1;
    const target = index.owners.get('B')!.contentFrom + 1;
    const selection = TextSelection.create(view.state.doc, from, from + 2);
    const sourceName = nameBodySelection(index, selection);
    const drag = beginDomDrag(author, selection);
    // Safari may replace its live selection with the drop caret after dragstart.
    // This models that state transition without changing the browser platform.
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target))));
    expect(view.state.selection.empty).toBe(true);
    const live = resolveBodySelection(bodyBindingOf(view.state)!.read().index, sourceName);
    expect(live.status).toBe('resolved');
    if (live.status === 'resolved') expect([live.selection.from, live.selection.to]).toEqual([from, from + 2]);
    drag.drop(target);
    expectMoveHistory(author, peer, before, dropModel(schema, 'cross paragraph', false, original), original);
  });

  it('moves the live named DOM range including peer input made after dragstart', () => {
    const owners = [{ id: 'A', text: 'AAAA' }, { id: 'B', text: 'AA' }];
    const doc = markFixture(codecFixture(owners), owners);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const view = author.editor.prosemirrorView;
    const initialIndex = bodyBindingOf(view.state)!.read().index;
    const first = initialIndex.owners.get('A')!.contentFrom;
    const selection = TextSelection.create(view.state.doc, first + 1, first + 3);
    const sourceName = nameBodySelection(initialIndex, selection);
    const drag = beginDomDrag(author, selection);
    const peerView = peer.editor.prosemirrorView;
    const at = bodyBindingOf(peerView.state)!.read().index.owners.get('A')!.contentFrom + 2;
    expect(peerView.state.doc.resolve(at).marks().map((mark) => mark.type.name).sort()).toEqual(['bold', 'comment', 'link']);
    act(() => peerView.dispatch(peerView.state.tr.insertText('X', at)));
    exchange(author, peer);
    const withPeer = native(doc);
    const a = ids(withPeer, 'A');
    const b = ids(withPeer, 'B');
    expect(a).toHaveLength(5);
    expect(view.dragging!.slice.content.textBetween(0, view.dragging!.slice.content.size)).toBe('AA');
    const before = documentOf(schema, [paragraph(schema, 'A', [schema.text('AAXAA', marks(schema))]), paragraph(schema, 'B', [schema.text('AA', marks(schema))])]);
    expect(view.state.doc.toJSON()).toEqual(before.toJSON());
    const currentIndex = bodyBindingOf(view.state)!.read().index;
    const live = resolveBodySelection(currentIndex, sourceName);
    expect(live.status).toBe('resolved');
    if (live.status === 'resolved') {
      expect([live.selection.from, live.selection.to]).toEqual([currentIndex.owners.get('A')!.contentFrom + 1, currentIndex.owners.get('A')!.contentFrom + 4]);
      expect(live.selection.content().content.textBetween(0, live.selection.content().content.size)).toBe('AXA');
    }
    const target = currentIndex.owners.get('B')!.contentFrom + 1;
    drag.drop(target);
    const model = {
      doc: documentOf(schema, [paragraph(schema, 'A', [schema.text('AA', marks(schema))]), paragraph(schema, 'B', [schema.text('AAXAA', marks(schema))])]),
      owners: [['A', [a[0], a[4]]], ['B', [b[0], a[1], a[2], a[3], b[1]]]] as readonly ExpectedOwner[],
    };
    expectMoveHistory(author, peer, before, model, withPeer, 1);
  });

  it.each([false, true])('moves a selected native inline atom through DOM dragging.node=%s', (implicitNode) => {
    const owners = [{ id: 'A', text: 'AA' }, { id: 'B', text: 'AA' }];
    const doc = markFixture(codecFixture(owners), owners);
    const value = { bodyInline: { type: 'futureToken', attrs: { payload: ['keep', 7, true] } } };
    documentBodySource(doc, 'S:A').insertEmbed(2, value, {
      ctx: 'base', 'mark:bold': { factId: 'drop-bold' }, 'mark:link': { factId: 'drop-link' },
      'mark:comment:drop-thread': { factId: 'drop-comment' }, 'vendor-payload': { owner: 'atom', keep: [7, true] },
    });
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const full = marks(schema);
    const atom = schema.node('unsupportedInline', { originalName: 'futureToken' }, undefined, full);
    const before = documentOf(schema, [paragraph(schema, 'A', [schema.text('A', full), atom, schema.text('A', full)]), paragraph(schema, 'B', [schema.text('AA', full)])]);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    const view = author.editor.prosemirrorView;
    const index = bodyBindingOf(view.state)!.read().index;
    const position = index.owners.get('A')!.contentFrom + 1;
    expect(view.state.doc.nodeAt(position)!.type.spec).toEqual(expect.objectContaining({ atom: true, inline: true }));
    expect(view.state.doc.nodeAt(position)!.type.spec.draggable).not.toBe(true);
    const drag = beginDomDrag(author, NodeSelection.create(view.state.doc, position), implicitNode);
    // Both explicit and implicit selections are resolved against the current
    // source even if the platform subsequently relocates the DOM caret.
    const target = index.owners.get('B')!.contentFrom + 1;
    act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target))));
    drag.drop(target);
    const a = ids(original, 'A');
    const b = ids(original, 'B');
    const model = {
      doc: documentOf(schema, [paragraph(schema, 'A', [schema.text('AA', full)]), paragraph(schema, 'B', [schema.text('A', full), atom, schema.text('A', full)])]),
      owners: [['A', [a[0], a[2]]], ['B', [b[0], a[1], b[1]]]] as readonly ExpectedOwner[],
    };
    expectMoveHistory(author, peer, before, model, original);
  });

  it('keeps a permanent mixed text-table-text DOM move through the real cell unfold append', () => {
    const owners = [
      { id: 'A', text: 'AA' },
      { id: 'I', text: 'AA', type: 'heading', attrs: { level: 2 }, parent: 'source-left' },
      { id: 'IC', text: 'AA', parent: 'source-nested' },
      { id: 'J', text: 'AA', parent: 'source-right' },
      { id: 'B', text: 'AA' },
      { id: 'P', text: 'AA', type: 'bulletListItem', parent: 'left' },
      { id: 'K', text: 'AA', parent: 'nested' },
      { id: 'Z', text: 'AA', parent: 'right' },
    ];
    const doc = markFixture(codecFixture(owners, [
      { id: 'source-table', kind: 'container', type: 'docTable', attrs: { id: 'source-table' }, parent: 'group', order: 'B' },
      { id: 'source-row', kind: 'container', type: 'docTableRow', attrs: { id: 'source-row' }, parent: 'source-table', order: 'A' },
      { id: 'source-left', kind: 'container', type: 'docTableCell', attrs: { id: 'source-left', colspan: 1, rowspan: 1, colwidth: null }, parent: 'source-row', order: 'A' },
      { id: 'source-right', kind: 'container', type: 'docTableCell', attrs: { id: 'source-right', colspan: 1, rowspan: 1, colwidth: null }, parent: 'source-row', order: 'B' },
      { id: 'source-nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'I', order: 'z' },
      { id: 'outer', kind: 'container', type: 'docTable', attrs: { id: 'outer' }, parent: 'group', order: 'Z' },
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
    const i = paragraph(schema, 'I', [schema.text('AA', full)], [paragraph(schema, 'IC', [schema.text('AA', full)])], 'heading');
    const j = paragraph(schema, 'J', [schema.text('AA', full)]);
    const makeOuter = (children: readonly PMNode[]): PMNode => schema.node('docTable', { id: 'outer' }, schema.node('docTableRow', { id: 'row' }, [
      schema.node('docTableCell', { id: 'left', colspan: 1, rowspan: 1, colwidth: null }, paragraph(schema, 'P', [schema.text('AA', full)], children, 'bulletListItem')),
      schema.node('docTableCell', { id: 'right', colspan: 1, rowspan: 1, colwidth: null }, paragraph(schema, 'Z', [schema.text('AA', full)])),
    ]));
    const sourceTable = schema.node('docTable', { id: 'source-table' }, schema.node('docTableRow', { id: 'source-row' }, [
      schema.node('docTableCell', { id: 'source-left', colspan: 1, rowspan: 1, colwidth: null }, i),
      schema.node('docTableCell', { id: 'source-right', colspan: 1, rowspan: 1, colwidth: null }, j),
    ]));
    const before = documentOf(schema, [paragraph(schema, 'A', [schema.text('AA', full)]), sourceTable, paragraph(schema, 'B', [schema.text('AA', full)]), makeOuter([paragraph(schema, 'K', [schema.text('AA', full)])])]);
    const after = documentOf(schema, [paragraph(schema, 'A', [schema.text('AA', full)]), makeOuter([
      paragraph(schema, 'K', [schema.text('AA', full)]), i, j, paragraph(schema, 'B', [schema.text('AA', full)]),
    ])]);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    const a = ids(original, 'A');
    const b = ids(original, 'B');
    const k = ids(original, 'K');
    // Explicit source-tail / target-left and source-head / target-right pairs.
    // The permanent table's blocks retain reading order and the nested child.
    const model = { doc: after, owners: [
      ['A', [a[0], b[1]]], ['P', ids(original, 'P')], ['K', [k[0], a[1]]],
      ['I', ids(original, 'I')], ['IC', ids(original, 'IC')], ['J', ids(original, 'J')],
      ['B', [b[0], k[1]]], ['Z', ids(original, 'Z')],
    ] as readonly ExpectedOwner[] };
    const batches: (readonly Transaction[])[] = [];
    author.editor._tiptapEditor.on('transaction', ({ transaction, appendedTransactions }) => {
      if (transaction.docChanged && transaction.before.eq(before)) batches.push([transaction, ...appendedTransactions]);
    });
    const view = author.editor.prosemirrorView;
    const index = bodyBindingOf(view.state)!.read().index;
    const selection = TextSelection.create(view.state.doc, index.owners.get('A')!.contentFrom + 1, index.owners.get('B')!.contentFrom + 1);
    const slicedGroup = selection.content().content.firstChild!;
    expect(slicedGroup.type.name).toBe('blockGroup');
    expect(slicedGroup.childCount).toBe(3);
    expect(slicedGroup.child(0).textContent).toBe('A');
    expect(slicedGroup.child(1).toJSON()).toEqual(sourceTable.toJSON());
    expect(slicedGroup.child(2).textContent).toBe('A');
    const drag = beginDomDrag(author, selection);
    drag.drop(index.owners.get('K')!.contentFrom + 1);
    expect(batches).toHaveLength(1);
    expect(rowById(batches[0][0].doc, 'source-table')).toBeDefined();
    const unfolds = batches[0].slice(1).filter((tr) => rowById(tr.before, 'source-table') !== undefined && rowById(tr.doc, 'source-table') === undefined);
    expect(unfolds).toHaveLength(1);
    expect(unfolds[0].doc.toJSON()).toEqual(after.toJSON());
    expect(batches[0].at(-1)!.doc.toJSON()).toEqual(after.toJSON());
    expectMoveHistory(author, peer, before, model, original);
    const table = rowById(view.state.doc, 'outer')!;
    const map = TableMap.get(table.node);
    expect([map.width, map.height, map.problems]).toEqual([2, 1, null]);
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
    const stage: FreshStageCapture = { root: [], append: [] };
    const author = open(doc, [freshStageObserver(stage)]);
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
    const published: { readonly index: BodyProjectionIndex; readonly resolutions: readonly BodyPointResolution[]; readonly alive: readonly boolean[] }[] = [];
    const unsubscribe = bodyBindingOf(author.editor.prosemirrorState)!.subscribeApplied(({ projection }) => {
      const names = stage.root[0]?.names ?? [];
      published.push({ index: projection.index, resolutions: names.map((name) => resolveBodyPoint(projection.index, name)), alive: names.map((name) => isNamedCharacterAlive(projection.index, name)) });
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
    expect(stage.root).toHaveLength(1);
    expect(stage.append).toHaveLength(1);
    expect(stage.root[0].matches).toBe(true);
    expect(stage.append[0].matches).toBe(true);
    const rootUnits = stage.root[0].units;
    expect(rootUnits.map((unit) => [unit.block, unit.value, unit.origin])).toEqual([
      ['I', 'A', 'fresh'], ['I', 'A', 'fresh'], ['IC', 'A', 'fresh'], ['IC', 'A', 'fresh'], ['J', 'A', 'fresh'], ['J', 'A', 'fresh'],
    ]);
    expect(new Set(rootUnits.map((unit) => unit.token)).size).toBe(6);
    expect(stage.append[0].units.map((unit) => [unit.block, unit.token, unit.origin])).toEqual(rootUnits.map((unit) => [unit.block, unit.token, unit.origin]));
    expect(stage.root[0].names.map((name) => name.kind)).toEqual(Array.from({ length: 6 }, () => 'stagedText'));
    const held = stage.root[0].names as readonly BodyStagedTextPointName[];
    expect(held.map((name) => name.token)).toEqual(rootUnits.map((unit) => unit.token));
    expect(published).toHaveLength(1);
    const finalIndex = bodyBindingOf(author.editor.prosemirrorState)!.read().index;
    const expectedPoints = ['I', 'I', 'IC', 'IC', 'J', 'J'].map((owner, offset) => ({ owner, offset: offset % 2 }));
    for (const [ordinal, point] of expectedPoints.entries()) {
      const append = stage.append[0];
      const pendingPosition = append.index.owners.get(point.owner)!.contentFrom + point.offset;
      expect(append.resolutions[ordinal]).toEqual({ status: 'resolved', pos: pendingPosition, epoch: append.index.epoch });
      const unit = current.owners.find((owner) => owner.id === point.owner)!.units[point.offset];
      const state = stagedBodyNameState(held[ordinal]);
      expect(state).toEqual(expect.objectContaining({ status: 'final', character: true }));
      const finalized = finalizeBodyPointName(held[ordinal]);
      expect(finalized).toEqual(expect.objectContaining({ kind: 'text', source: unit.source, token: unit.id }));
      const wanted = { status: 'resolved', pos: finalIndex.owners.get(point.owner)!.contentFrom + point.offset, epoch: finalIndex.epoch };
      expect(resolveBodyPoint(finalIndex, held[ordinal])).toEqual(wanted);
      expect(published[0].resolutions[ordinal]).toEqual(wanted);
      expect(published[0].alive[ordinal]).toBe(true);
      expect(isNamedCharacterAlive(finalIndex, held[ordinal])).toBe(true);
    }
    expect(published[0].index).toBe(finalIndex);
    unsubscribe();
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
