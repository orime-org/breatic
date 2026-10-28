// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  documentBodyFragment, documentBodyRecords, documentBodySource, documentCommentThreads,
  readBodyTree, registerDocumentBodyRecords,
  type BodyJsonObject, type BodyRecord, type BodyTreeUnit, type BodyTreeView,
} from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { runBlockType } from '@web/spaces/document/document-block-run';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { BodyProjectionIndex } from '@web/spaces/document/document-body-codec-types';
import { bodyNativeItem, bodyNativeItemAlive, bodyTokenId } from '@web/spaces/document/document-body-position-native';
import { isNamedCharacterAlive, nameBodyPoint, resolveBodyPoint } from '@web/spaces/document/document-body-positions';
import type { BodyTextPointName } from '@web/spaces/document/document-body-positions-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { rowById } from '@web/spaces/document/document-row-by-id';
import {
  cleanupCodecFixtures, codecDoc, codecFixture, type CodecOwner,
} from '@web/spaces/document/__tests__/document-body-codec-fixtures';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
  userUpdates: number;
}

type Ownership = readonly (readonly [string, readonly string[]])[];

const opened: OpenBody[] = [];
const priorToggle = new Map<string, string | null>();

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.runtime.dispose();
      body.history.destroy();
      body.host.remove();
    }
    cleanupCodecFixtures();
  });
  for (const [key, value] of priorToggle) {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }
  priorToggle.clear();
});

/** Reads native identities without deriving them from accepted PM text. @throws {Error} If source dependencies are incomplete. */
function native(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete command fixture: ${read.status}`);
  return read.view;
}

/** Seeds independently specified owners with complete native marks and opaque attributes. @throws {Error} If registration fails. */
function fixture(owners: readonly CodecOwner[], containers: readonly BodyRecord[] = []): Y.Doc {
  const doc = codecFixture(owners, containers);
  registerDocumentBodyRecords(doc, {
    groups: [{ id: 'command-marks', facts: ['command-bold', 'command-link', 'command-comment'], history: 'base' }],
    facts: [
      { id: 'command-bold', kind: 'mark', group: 'command-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
      { id: 'command-link', kind: 'mark', group: 'command-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/command' } } },
      { id: 'command-comment', kind: 'mark', group: 'command-marks', dependencies: [], payload: { type: 'comment', attrs: { threadId: 'command-thread', orphan: false } } },
    ],
  });
  documentBodyRecords(doc).enabled.set('command-marks', true);
  for (const owner of owners) {
    if (owner.text === '') continue;
    documentBodySource(doc, `S:${owner.id}`).format(1, owner.text.length, {
      'mark:bold': { factId: 'command-bold' }, 'mark:link': { factId: 'command-link' },
      'mark:comment:command-thread': { factId: 'command-comment' }, 'vendor-payload': { owner: owner.id, keep: [7, true] },
    });
  }
  documentCommentThreads(doc).set('command-thread', {
    id: 'command-thread', resolved: false, createdAt: '2026-10-25T12:00:00.000Z',
    comments: [{ id: 'command-note', userId: 'author', body: [{ type: 'text', text: 'Preserve original words' }] }],
  });
  return doc;
}

/** Opens the real records factory with its native origin-scoped history. @throws {Error} If production assembly fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:command-producers', origin, runtime, history } });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, history, origin, host, userUpdates: 0 };
  opened.push(body);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  doc.on('update', (_bytes, actualOrigin) => { if (actualOrigin === origin) body.userUpdates += 1; });
  return body;
}

/** Creates a genuinely independent native peer or saved-snapshot document. @throws {Error} If Yjs rejects bytes. */
function clone(doc: Y.Doc): Y.Doc {
  const peer = codecDoc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return peer;
}

/** Builds expected content from test inputs and the real schema defaults. @throws {RangeError} If expected content violates the schema. */
function block(schema: Schema, id: string, text: string, type = 'paragraph', attrs: BodyJsonObject = {}, children: readonly PMNode[] = [], marked = true): PMNode {
  const contentType = schema.nodes[type];
  const marks = marked ? contentType.allowedMarks([
    schema.mark('bold'), schema.mark('link', { href: 'https://example.com/command' }),
    schema.mark('comment', { threadId: 'command-thread', orphan: false }),
  ]) : [];
  return schema.node('blockContainer', { id }, [
    schema.node(type, attrs, text === '' ? undefined : schema.text(text, marks)),
    ...(children.length === 0 ? [] : [schema.node('blockGroup', null, children)]),
  ]);
}

/** Builds an independently ordered complete PM document. @throws {RangeError} If the expected tree is invalid. */
function documentOf(schema: Schema, children: readonly PMNode[]): PMNode {
  return schema.node('doc', null, schema.node('blockGroup', null, children));
}

/** Reads original identities from the native seed, never by matching repeated words. @throws {Error} If a test-owned owner is absent. */
function ids(original: BodyTreeView, owner: string): readonly string[] {
  const found = original.owners.find((candidate) => candidate.id === owner);
  if (found === undefined) throw new Error(`Missing original owner: ${owner}`);
  return found.units.map((unit) => unit.id);
}

/** Captures the native owner/identity map without retaining mutable Yjs state. @throws {never} */
function ownership(original: BodyTreeView): Ownership {
  return original.owners.map((owner) => [owner.id, owner.units.map((unit) => unit.id)] as const);
}

/** Compares all source payload fields separately from their new owner placement. @throws {never} */
function payload(unit: BodyTreeUnit): unknown {
  return { id: unit.id, value: unit.value, attributes: unit.attributes };
}

/** Checks complete PM JSON and exact native placement plus mark/ctx/opaque preservation. @throws {Error} If binding dependencies are incomplete. */
function expectFrame(body: OpenBody, expected: PMNode, wanted: Ownership, original: BodyTreeView): void {
  expect(body.runtime.read().status).toBe('active');
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(expected.toJSON());
  const current = native(body.doc);
  expect(current.owners.map((owner) => [owner.id, owner.units.map((unit) => unit.id)])).toEqual(wanted);
  const originals = new Map(original.owners.flatMap((owner) => owner.units.map((unit) => [unit.id, unit] as const)));
  for (const owner of current.owners) {
    for (const unit of owner.units) expect(payload(unit)).toEqual(payload(originals.get(unit.id)!));
  }
  const tokens = wanted.flatMap(([, units]) => units);
  expect(new Set(tokens).size).toBe(tokens.length);
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The actual command binding is absent');
  expect(binding.read().units.map((unit) => unit.token)).toEqual(tokens);
  expect(() => body.editor.prosemirrorState.doc.check()).not.toThrow();
}

/** Selects an actual owner boundary from the published production index. @throws {Error} If the target is absent. */
function select(body: OpenBody, owner: string, offset: number): void {
  const target = bodyBindingOf(body.editor.prosemirrorState)?.read().index.owners.get(owner);
  if (target === undefined) throw new Error('The command target is absent');
  const view = body.editor.prosemirrorView;
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target.contentFrom + offset))));
}

/** Presses the real key through every installed handler, preserving chain semantics. @throws {Error} If a real handler fails. */
function press(body: OpenBody, key: 'Backspace' | 'Delete' | 'Enter'): void {
  const view = body.editor.prosemirrorView;
  let handled = false;
  act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))) === true; });
  expect(handled, 'The real installed command must claim this key').toBe(true);
}

/** Delivers both directions and repeated native frames without a PM sync substitute. @throws {Error} If Yjs rejects bytes. */
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

/** Verifies one complete user batch, peer merge, native undo/redo and saved-source reopening. @throws {Error} If actual native dependencies are incomplete. */
function complete(author: OpenBody, peer: OpenBody, before: PMNode, after: PMNode, beforeIds: Ownership, afterIds: Ownership, original: BodyTreeView): void {
  const threads = documentCommentThreads(peer.doc).toJSON();
  expectFrame(author, after, afterIds, original);
  expect(documentCommentThreads(author.doc).toJSON()).toEqual(threads);
  expect(author.userUpdates).toBe(1);
  expect(author.history.undoStack).toHaveLength(1);
  exchange(author, peer);
  expectFrame(peer, after, afterIds, original);
  expect(peer.history.undoStack).toHaveLength(0);
  expect(documentCommentThreads(peer.doc).toJSON()).toEqual(threads);
  act(() => { author.history.undo(); });
  exchange(author, peer);
  expectFrame(author, before, beforeIds, original);
  expectFrame(peer, before, beforeIds, original);
  expect(author.history.undoStack).toHaveLength(0);
  expect(author.history.redoStack).toHaveLength(1);
  act(() => { author.history.redo(); });
  exchange(author, peer);
  expectFrame(author, after, afterIds, original);
  expectFrame(peer, after, afterIds, original);
  expect(documentCommentThreads(author.doc).toJSON()).toEqual(threads);
  const reopened = open(clone(author.doc));
  expectFrame(reopened, after, afterIds, original);
  expect(reopened.history.undoStack).toHaveLength(0);
}

/** Sets the actual heading's local toggle state and restores the prior value on cleanup. @throws {DOMException} If storage access fails. */
function toggle(openedState: boolean): void {
  const key = 'toggle-P';
  if (!priorToggle.has(key)) priorToggle.set(key, window.localStorage.getItem(key));
  window.localStorage.setItem(key, String(openedState));
}

/** Reads the actual final index for this explicit deletion/undo negative only. @throws {Error} If the binding is absent. */
function replacementIndex(body: OpenBody): BodyProjectionIndex {
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The explicit replacement binding is absent');
  return binding.read().index;
}

/** Captures one immutable original native name per real character before its deletion. @throws {Error} If a native character cannot be named. */
function replacementNames(body: OpenBody): readonly BodyTextPointName[] {
  const index = replacementIndex(body);
  return index.units.filter((unit) => unit.owner === 'P').map((unit) => {
    const name = nameBodyPoint(index, { kind: 'text', pos: unit.pos, assoc: 1 });
    if (name.kind !== 'text' || name.token === null) throw new Error('Expected a final native replacement character name');
    expect(name.token).toBe(unit.token);
    return name;
  });
}

/** Requires each held local name to follow its actual Yjs redone item into the restored owner. @throws {Error} If a restored native item is absent. */
function expectLocalReplacementNames(body: OpenBody, names: readonly BodyTextPointName[]): void {
  const index = replacementIndex(body);
  const owner = index.owners.get('P');
  if (owner === undefined) throw new Error('The restored P owner is absent');
  const units = index.units.filter((unit) => unit.owner === 'P');
  expect(units).toHaveLength(names.length);
  for (const [offset, name] of names.entries()) {
    const id = bodyTokenId(name.source, name.token);
    if (id === null) throw new Error('The original native token is absent');
    const originalItem = Y.getItem(body.doc.store, id);
    expect(originalItem).toBeInstanceOf(Y.Item);
    if (!(originalItem instanceof Y.Item)) throw new Error('The deleted original must remain an undoable native item');
    expect(originalItem.deleted).toBe(true);
    expect(originalItem.redone).not.toBeNull();
    const restored = bodyNativeItem(body.doc, id);
    if (restored === null) throw new Error('The local redone chain did not restore the original character');
    expect(bodyNativeItemAlive(restored)).toBe(true);
    const restoredToken = `${name.source}/${restored.item.id.client}:${restored.item.id.clock + restored.offset}`;
    expect(units[offset].token).toBe(restoredToken);
    expect(units[offset].source).toBe(name.source);
    expect(units[offset].token).not.toBe(name.token);
    expect(isNamedCharacterAlive(index, name)).toBe(true);
    expect(resolveBodyPoint(index, name)).toEqual({ status: 'resolved', pos: owner.contentFrom + offset, epoch: index.epoch });
  }
}

describe('actual command producer provenance', () => {
  it('keeps first-child Backspace inline and promoted descendants on their original native sources', () => {
    const doc = fixture([
      { id: 'P', text: 'AA' }, { id: 'K', text: 'AA', parent: 'children' },
      { id: 'G', text: 'AA', parent: 'grandchildren' }, { id: 'S', text: 'AA', parent: 'children' }, { id: 'Z', text: 'AA' },
    ], [
      { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
      { id: 'grandchildren', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'K', order: 'z' },
    ]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AA', 'paragraph', {}, [block(schema, 'K', 'AA', 'paragraph', {}, [block(schema, 'G', 'AA')]), block(schema, 'S', 'AA')]), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'K', 0);
    press(author, 'Backspace');
    const after = documentOf(schema, [block(schema, 'P', 'AAAA', 'paragraph', {}, [block(schema, 'G', 'AA'), block(schema, 'S', 'AA')]), block(schema, 'Z', 'AA')]);
    complete(author, peer, before, after, ownership(original), [['P', [...ids(original, 'P'), ...ids(original, 'K')]], ['G', ids(original, 'G')], ['S', ids(original, 'S')], ['Z', ids(original, 'Z')]], original);
  });

  it('keeps ordinary sibling Backspace as a StepMap-preserving control', () => {
    const doc = fixture([{ id: 'P', text: 'AA' }, { id: 'K', text: 'AA' }, { id: 'Z', text: 'AA' }]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AA'), block(schema, 'K', 'AA'), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'K', 0);
    press(author, 'Backspace');
    const after = documentOf(schema, [block(schema, 'P', 'AAAA'), block(schema, 'Z', 'AA')]);
    complete(author, peer, before, after, ownership(original), [['P', [...ids(original, 'P'), ...ids(original, 'K')]], ['Z', ids(original, 'Z')]], original);
  });

  it('keeps cross-level Delete inline and lifted next-block children on their native sources', () => {
    const doc = fixture([
      { id: 'P', text: 'AA' }, { id: 'K', text: 'AA', parent: 'children' },
      { id: 'N', text: 'AA' }, { id: 'G', text: 'AA', parent: 'next-children' }, { id: 'Z', text: 'AA' },
    ], [
      { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
      { id: 'next-children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'N', order: 'z' },
    ]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AA', 'paragraph', {}, [block(schema, 'K', 'AA')]), block(schema, 'N', 'AA', 'paragraph', {}, [block(schema, 'G', 'AA')]), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'K', 2);
    press(author, 'Delete');
    const after = documentOf(schema, [block(schema, 'P', 'AA', 'paragraph', {}, [block(schema, 'K', 'AAAA')]), block(schema, 'G', 'AA'), block(schema, 'Z', 'AA')]);
    complete(author, peer, before, after, ownership(original), [['P', ids(original, 'P')], ['K', [...ids(original, 'K'), ...ids(original, 'N')]], ['G', ids(original, 'G')], ['Z', ids(original, 'Z')]], original);
  });

  it.each([
    ['paragraph', false], ['paragraph', true], ['bulletListItem', true], ['numberedListItem', true], ['checkListItem', true],
  ] as const)('keeps split %s quoted=%s as a StepMap-preserving control including children', (type, quoted) => {
    const attrs = { quoted };
    const doc = fixture([{ id: 'P', text: 'AAAA', type, attrs }, { id: 'K', text: 'AA', parent: 'children' }, { id: 'Z', text: 'AA' }], [
      { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
    ]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AAAA', type, attrs, [block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'P', 2);
    press(author, 'Enter');
    const nextId: unknown = author.editor.prosemirrorState.doc.firstChild?.child(1).attrs['id'];
    expect(typeof nextId).toBe('string');
    if (typeof nextId !== 'string') throw new Error('The real UniqueID append did not name the split block');
    expect(original.body.records.has(nextId)).toBe(false);
    const after = documentOf(schema, [block(schema, 'P', 'AA', type, attrs), block(schema, nextId, 'AA', type, attrs, [block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')]);
    complete(author, peer, before, after, ownership(original), [['P', ids(original, 'P').slice(0, 2)], [nextId, ids(original, 'P').slice(2)], ['K', ids(original, 'K')], ['Z', ids(original, 'Z')]], original);
  });

  it.each([false, true])('keeps toggle heading Enter sources and child ordering when open=%s', (isOpen) => {
    toggle(isOpen);
    const attrs = { level: 2, isToggleable: true };
    const doc = fixture([{ id: 'P', text: 'AAAA', type: 'heading', attrs }, { id: 'K', text: 'AA', parent: 'children' }, { id: 'Z', text: 'AA' }], [
      { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
    ]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AAAA', 'heading', attrs, [block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'P', 2);
    press(author, 'Enter');
    const old = rowById(author.editor.prosemirrorState.doc, 'P');
    if (old === undefined) throw new Error('The heading disappeared');
    const newBlock = isOpen ? old.node.lastChild?.firstChild : author.editor.prosemirrorState.doc.firstChild?.child(1);
    const nextId: unknown = newBlock?.attrs['id'];
    if (typeof nextId !== 'string') throw new Error('The real heading Enter append did not name its new block');
    expect(original.body.records.has(nextId)).toBe(false);
    const after = isOpen
      ? documentOf(schema, [block(schema, 'P', 'AA', 'heading', attrs, [block(schema, nextId, 'AA'), block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')])
      : documentOf(schema, [block(schema, 'P', 'AA', 'heading', attrs, [block(schema, 'K', 'AA')]), block(schema, nextId, 'AA'), block(schema, 'Z', 'AA')]);
    const p = ids(original, 'P');
    const afterIds: Ownership = isOpen
      ? [['P', p.slice(0, 2)], [nextId, p.slice(2)], ['K', ids(original, 'K')], ['Z', ids(original, 'Z')]]
      : [['P', p.slice(0, 2)], ['K', ids(original, 'K')], [nextId, p.slice(2)], ['Z', ids(original, 'Z')]];
    complete(author, peer, before, after, ownership(original), afterIds, original);
  });

  it('preserves native plain conversion sources while filtering only their displayed marks', () => {
    const doc = fixture([{ id: 'P', text: 'AAAA' }, { id: 'K', text: 'AA', parent: 'children' }, { id: 'Z', text: 'AA' }], [
      { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
    ]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const schema = author.editor.pmSchema;
    const before = documentOf(schema, [block(schema, 'P', 'AAAA', 'paragraph', {}, [block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')]);
    expectFrame(author, before, ownership(original), original);
    select(author, 'P', 2);
    act(() => { runBlockType(author.editor, 'code-block', 'P'); });
    const after = documentOf(schema, [block(schema, 'P', 'AAAA', 'codeBlock', {}, [block(schema, 'K', 'AA')]), block(schema, 'Z', 'AA')]);
    complete(author, peer, before, after, ownership(original), ownership(original), original);
  });

  it('gives explicit same-text replacement fresh sources despite reusing the old block id', () => {
    const doc = fixture([{ id: 'P', text: 'AAAA' }, { id: 'Z', text: 'AA' }]);
    const original = native(doc);
    const author = open(doc);
    const peer = open(clone(doc));
    const originalOwner = original.owners.find((owner) => owner.id === 'P')!;
    const untouched = original.owners.find((owner) => owner.id === 'Z')!;
    const threads = documentCommentThreads(doc).toJSON();
    const oldNames = replacementNames(author);
    expect(oldNames).toHaveLength(4);
    const before = documentOf(author.editor.pmSchema, [block(author.editor.pmSchema, 'P', 'AAAA'), block(author.editor.pmSchema, 'Z', 'AA')]);
    act(() => { author.editor.replaceBlocks(['P'], [{ id: 'P', type: 'paragraph', content: 'AAAA' }] as never); });
    expect(author.runtime.read().status).toBe('active');
    const now = native(doc);
    const fresh = now.owners.find((owner) => owner.id === 'P')!.units;
    expect(fresh.map((unit) => unit.value).join('')).toBe('AAAA');
    expect(fresh).toHaveLength(4);
    expect(fresh.every((unit) => !ids(original, 'P').includes(unit.id))).toBe(true);
    expect(fresh.every((unit) => !originalOwner.units.some((prior) => prior.source === unit.source))).toBe(true);
    expect(new Set(fresh.map((unit) => unit.id)).size).toBe(4);
    expect(now.owners.find((owner) => owner.id === 'Z')!.units.map(payload)).toEqual(untouched.units.map(payload));
    const freshNames = replacementNames(author);
    expect(freshNames).toHaveLength(4);
    for (const name of oldNames) {
      expect(isNamedCharacterAlive(replacementIndex(author), name)).toBe(false);
      const id = bodyTokenId(name.source, name.token);
      if (id === null) throw new Error('The original character must have a native token');
      expect(Y.getItem(doc.store, id).deleted).toBe(true);
    }
    const after = documentOf(author.editor.pmSchema, [block(author.editor.pmSchema, 'P', 'AAAA', 'paragraph', {}, [], false), block(author.editor.pmSchema, 'Z', 'AA')]);
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(author.userUpdates).toBe(1);
    expect(author.history.undoStack).toHaveLength(1);
    exchange(author, peer);
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(native(peer.doc).owners).toEqual(now.owners);
    expect(peer.history.undoStack).toHaveLength(0);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    act(() => { author.history.undo(); });
    exchange(author, peer);
    // A real native deletion is recreated by redoItem; moved units in the other
    // eleven cases retain exact physical IDs and keep their original assertions.
    expectLocalReplacementNames(author, oldNames);
    const restored = native(doc);
    const restoredOwner = restored.owners.find((owner) => owner.id === 'P')!;
    expect({ ...restoredOwner, units: [] }).toEqual({ ...originalOwner, units: [] });
    expect(restoredOwner.units.map((unit) => ({ source: unit.source, value: unit.value, attributes: unit.attributes }))).toEqual(
      originalOwner.units.map((unit) => ({ source: unit.source, value: unit.value, attributes: unit.attributes })),
    );
    expect(restoredOwner.units.map((unit) => unit.source)).toEqual(['S:P', 'S:P', 'S:P', 'S:P']);
    expect(restored.owners.find((owner) => owner.id === 'Z')!.units.map(payload)).toEqual(untouched.units.map(payload));
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
    // Remote frames carry actual new items; no remote local-redone mapping is assumed.
    expect(native(peer.doc).owners).toEqual(restored.owners);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    expect(documentCommentThreads(peer.doc).toJSON()).toEqual(threads);
    expect(author.history.undoStack).toHaveLength(0);
    expect(author.history.redoStack).toHaveLength(1);
    for (const name of freshNames) expect(isNamedCharacterAlive(replacementIndex(author), name)).toBe(false);
    act(() => { author.history.redo(); });
    exchange(author, peer);
    expectLocalReplacementNames(author, freshNames);
    for (const name of oldNames) expect(isNamedCharacterAlive(replacementIndex(author), name)).toBe(false);
    const redone = native(doc);
    const redoneOwner = redone.owners.find((owner) => owner.id === 'P')!;
    expect(redoneOwner.units.map((unit) => ({ source: unit.source, value: unit.value, attributes: unit.attributes }))).toEqual(
      fresh.map((unit) => ({ source: unit.source, value: unit.value, attributes: unit.attributes })),
    );
    expect(redone.owners.find((owner) => owner.id === 'Z')!.units.map(payload)).toEqual(untouched.units.map(payload));
    expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(native(peer.doc).owners).toEqual(redone.owners);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    expect(author.history.undoStack).toHaveLength(1);
    expect(author.history.redoStack).toHaveLength(0);
    const reopened = open(clone(doc));
    expect(reopened.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expect(native(reopened.doc).owners).toEqual(redone.owners);
    expect(documentCommentThreads(reopened.doc).toJSON()).toEqual(threads);
    expect(reopened.history.undoStack).toHaveLength(0);
  });
});
