// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { BodyRecord, BodyTreeUnit, BodyTreeView } from '@breatic/shared';
import { documentBodyFragment, documentBodyRecords, documentBodySource, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared/document-body';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { BodyOriginMirror } from '@web/spaces/document/document-body-provenance';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecDoc, codecFixture, type CodecOwner } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: ReturnType<typeof createDocumentBodyRuntime>;
  readonly undo: ReturnType<typeof createDocumentUndo>;
  readonly host: HTMLElement;
}

type Children = 'empty' | 'single' | 'multiple' | 'nested';
const opened: OpenBody[] = [];

afterEach(() => {
  act(() => {
    for (const body of opened.splice(0).reverse()) {
      body.editor.unmount();
      body.runtime.dispose();
      body.undo.manager.destroy();
      body.host.remove();
    }
    cleanupCodecFixtures();
  });
});

/** Reads actual native identities and payloads. @throws {Error} If the source is incomplete. */
function native(doc: Y.Doc): BodyTreeView {
  const result = readBodyTree(doc);
  if (result.status !== 'ready') throw new Error(`Incomplete quote fixture: ${result.status}`);
  return result.view;
}

/** Seeds the approved empty quoted parent and independently labelled children. @throws {Error} If registration fails. */
function fixture(inCell: boolean, children: Children, quoted = true, parentType = 'paragraph'): Y.Doc {
  const owners: CodecOwner[] = [
    { id: 'P', text: '', type: parentType, attrs: { quoted, ...(parentType === 'heading' ? { level: 2 } : {}) }, parent: inCell ? 'cell' : 'group' },
    { id: 'K', text: children === 'empty' ? '' : 'kid', attrs: { quoted: true }, parent: 'children' },
    ...(children === 'nested' ? [{ id: 'N', text: 'deep', attrs: { quoted: true }, parent: 'nested' }] : []),
    ...(children === 'single' || children === 'empty' ? [] : [{ id: 'J', text: 'kid', attrs: { quoted: true }, parent: 'children' }]),
  ];
  const containers: BodyRecord[] = [
    ...(inCell ? [
      { id: 'table', kind: 'container' as const, type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'A' },
      { id: 'row', kind: 'container' as const, type: 'docTableRow', attrs: { id: 'row' }, parent: 'table', order: 'A' },
      { id: 'cell', kind: 'container' as const, type: 'docTableCell', attrs: { id: 'cell', colspan: 1, rowspan: 1, colwidth: null }, parent: 'row', order: 'A' },
    ] : []),
    { id: 'children', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'P', order: 'z' },
    ...(children === 'nested' ? [{ id: 'nested', kind: 'container' as const, type: 'blockGroup', attrs: {}, parent: 'K', order: 'z' }] : []),
  ];
  const doc = codecFixture(owners, containers);
  registerDocumentBodyRecords(doc, {
    groups: [{ id: 'quote-marks', facts: ['quote-bold', 'quote-link'], history: 'base' }],
    facts: [
      { id: 'quote-bold', kind: 'mark', group: 'quote-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
      { id: 'quote-link', kind: 'mark', group: 'quote-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/quote' } } },
    ],
  });
  documentBodyRecords(doc).enabled.set('quote-marks', true);
  for (const owner of owners) {
    if (owner.text === '') continue;
    documentBodySource(doc, `S:${owner.id}`).format(1, owner.text.length, {
      'mark:bold': { factId: 'quote-bold' }, 'mark:link': { factId: 'quote-link' },
      'vendor-payload': { owner: owner.id, keep: [7, true] },
    });
  }
  return doc;
}

/** Opens the production records factory and its actual undo extension. @throws {Error} If assembly fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const undo = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:quote-producers', origin, runtime, history: undo.manager }, extensions: [undo.extension] });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, undo, host };
  opened.push(body);
  document.body.append(host);
  act(() => editor.mount(host));
  expect(runtime.read().status).toBe('active');
  undo.manager.clear();
  undo.manager.stopCapturing();
  return body;
}

/** Copies native state into an independent document. @throws {Error} If Yjs rejects the bytes. */
function clone(doc: Y.Doc): Y.Doc {
  const copied = codecDoc();
  Y.applyUpdate(copied, Y.encodeStateAsUpdate(doc));
  return copied;
}

/** Uses the real key handler chain rather than replaying shortcut steps. @throws {Error} If no installed handler claims Enter. */
function enter(body: OpenBody): void {
  act(() => body.editor.setTextCursorPosition('P', 'start'));
  const view = body.editor.prosemirrorView;
  let handled = false;
  act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))) === true; });
  expect(handled).toBe(true);
  expect(body.runtime.read().status).toBe('active');
}

/** Reads an exact seeded block including its child tree. @throws {Error} If the expected block is absent. */
function row(doc: PMNode, id: string): NonNullable<ReturnType<typeof rowById>> {
  const result = rowById(doc, id);
  if (result === undefined) throw new Error(`Missing quote block: ${id}`);
  return result;
}

/** Builds the command's exact result from input nodes and only the allocated fresh parent ID. @throws {RangeError} If the expected tree is invalid. */
function expected(before: PMNode, fresh: string, text = '', quoted = true): PMNode {
  const parent = row(before, 'P');
  const schema = before.type.schema;
  const oldParent = schema.node('blockContainer', parent.node.attrs, parent.node.firstChild!);
  const newParent = schema.node('blockContainer', { id: fresh }, [
    schema.node('paragraph', { quoted }, text === '' ? undefined : schema.text(text)),
    parent.node.lastChild!,
  ]);
  return new Transform(before).replaceWith(parent.from, parent.to, [oldParent, newParent]).doc;
}

/** Finds the one fresh content owner without guessing its UUID. @throws {Error} If the command created anything else. */
function freshParent(body: OpenBody, before: BodyTreeView): string {
  const old = new Set(before.owners.map((owner) => owner.id));
  const fresh = native(body.doc).owners.filter((owner) => !old.has(owner.id));
  expect(fresh.map((owner) => owner.units)).toEqual([[]]);
  return fresh[0].id;
}

/** Separates immutable native payload from its current placement. @throws {never} */
function payload(unit: BodyTreeUnit): unknown {
  return { id: unit.id, source: unit.source, value: unit.value, attributes: unit.attributes };
}

/** Checks complete JSON plus exact original native identities, marks and opaque payloads. @throws {Error} If the source is incomplete. */
function expectFrame(body: OpenBody, wanted: PMNode, original: BodyTreeView): void {
  expect(body.runtime.read().status).toBe('active');
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
  const now = native(body.doc);
  for (const owner of original.owners) {
    expect(now.owners.find((candidate) => candidate.id === owner.id)?.units.map(payload)).toEqual(owner.units.map(payload));
  }
  const tokens = now.owners.flatMap((owner) => owner.units.map((unit) => unit.id));
  expect(new Set(tokens).size).toBe(tokens.length);
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The production quote binding is absent');
  expect(binding.read().index.doc.toJSON()).toEqual(wanted.toJSON());
  expect(() => wanted.check()).not.toThrow();
}

/** Exchanges genuine native deltas and duplicates them to test idempotent delivery. @throws {Error} If Yjs rejects an update. */
function exchange(a: OpenBody, b: OpenBody): void {
  act(() => {
    for (let round = 0; round < 2; round += 1) {
      const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
      const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
      for (const [doc, update] of [[a.doc, toA], [b.doc, toB]] as const) {
        Y.applyUpdate(doc, update, 'peer');
        Y.applyUpdate(doc, update, 'peer');
      }
    }
  });
}

/** Types into the actual child owner from its current published index. @throws {Error} If the target is absent. */
function typeAtChild(body: OpenBody): void {
  const view = body.editor.prosemirrorView;
  const owner = bodyBindingOf(view.state)?.read().index.owners.get('K');
  if (owner === undefined) throw new Error('The original quote child is absent');
  act(() => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, owner.contentTo))));
  // BlockNote's installed Link has inclusive=false: at the end of kid,
  // insertText inherits bold but leaves the existing link boundary intact.
  expect(view.state.schema.marks['link'].spec.inclusive).toBe(false);
  expect((view.state.storedMarks ?? view.state.selection.$from.marks()).map((mark) => mark.toJSON())).toEqual([{ type: 'bold' }]);
  act(() => view.dispatch(view.state.tr.insertText('!')));
  expect(body.runtime.read().status).toBe('active');
}

/** Builds the independently specified empty-predecessor command frames. @throws {RangeError} If the schema rejects the expected nodes. */
function siblingDocument(schema: Schema, owners: readonly (readonly [string, string])[]): PMNode {
  return schema.node('doc', null, schema.node('blockGroup', null, owners.map(([id, text]) => schema.node('blockContainer', { id }, schema.node('paragraph', null, text === '' ? undefined : schema.text(text))))));
}

/** Compares independent native source ownership and payloads, including repeated text. @throws {Error} If the native source is incomplete. */
function expectNativeOwners(body: OpenBody, wanted: readonly (readonly [string, readonly unknown[]])[]): void {
  expect(native(body.doc).owners.map((owner) => [owner.id, owner.units.map(payload)])).toEqual(wanted);
}

describe('records quote Enter source producers', () => {
  for (const inCell of [false, true]) {
    for (const children of ['empty', 'single', 'multiple', 'nested'] as const) {
      it(`preserves ${children} children when opening an empty quote inCell=${inCell}`, () => {
        const author = open(fixture(inCell, children));
        const before = author.editor.prosemirrorState.doc;
        const original = native(author.doc);
        const peer = open(clone(author.doc));
        enter(author);
        const fresh = freshParent(author, original);
        const after = expected(before, fresh);
        expectFrame(author, after, original);
        expect(author.undo.manager.undoStack).toHaveLength(1);
        exchange(author, peer);
        expectFrame(peer, after, original);
        expect(peer.undo.manager.undoStack).toHaveLength(0);
        act(() => { author.undo.manager.undo(); });
        exchange(author, peer);
        expectFrame(author, before, original);
        expectFrame(peer, before, original);
        expect(author.undo.manager.redoStack).toHaveLength(1);
        act(() => { author.undo.manager.redo(); });
        exchange(author, peer);
        expectFrame(author, after, original);
        expectFrame(peer, after, original);
        const reopened = open(clone(author.doc));
        expectFrame(reopened, after, original);
        author.undo.manager.stopCapturing();
        act(() => author.editor.setTextCursorPosition(fresh, 'start'));
        act(() => author.editor.prosemirrorView.dispatch(author.editor.prosemirrorState.tr.insertText('next')));
        expectFrame(author, expected(before, fresh, 'next'), original);
        act(() => { author.undo.manager.undo(); });
        expectFrame(author, after, original);
      });
    }
    for (const observed of [false, true]) {
      it(`retains peer input with observed=${observed} quote transfer inCell=${inCell}`, () => {
        const author = open(fixture(inCell, 'nested'));
        const before = author.editor.prosemirrorState.doc;
        const original = native(author.doc);
        const peer = open(clone(author.doc));
        enter(author);
        const fresh = freshParent(author, original);
        const after = expected(before, fresh);
        if (observed) exchange(author, peer);
        typeAtChild(peer);
        // Undo before receiving the peer's support, as the approved history case requires.
        act(() => { author.undo.manager.undo(); });
        exchange(author, peer);
        const supported = observed ? after : before;
        const child = row(supported, 'K');
        const wanted = new Transform(supported).insert(child.from + 2 + 3, supported.type.schema.text('!', [supported.type.schema.mark('bold')])).doc;
        expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
        expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
        expect(author.runtime.read().status).toBe('active');
        expect(peer.runtime.read().status).toBe('active');
        for (const body of [author, peer]) {
          for (const owner of original.owners) {
            expect(native(body.doc).owners.find((candidate) => candidate.id === owner.id)?.units.slice(0, owner.units.length).map(payload)).toEqual(owner.units.map(payload));
          }
        }
        act(() => { peer.undo.manager.undo(); });
        exchange(author, peer);
        expectFrame(author, before, original);
        expectFrame(peer, before, original);
        act(() => { peer.undo.manager.redo(); });
        exchange(author, peer);
        expect(author.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
        expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
        const reopened = open(clone(author.doc));
        expect(reopened.editor.prosemirrorState.doc.toJSON()).toEqual(wanted.toJSON());
      });
    }
  }
});

describe('records ordinary empty-parent Enter source producers', () => {
  for (const inCell of [false, true]) {
    it(`preserves the ordinary empty heading and carries its child inCell=${inCell}`, () => {
      const author = open(fixture(inCell, 'single', false, 'heading'));
      const before = author.editor.prosemirrorState.doc;
      const original = native(author.doc);
      const peer = open(clone(author.doc));
      enter(author);
      const fresh = freshParent(author, original);
      const after = expected(before, fresh, '', false);
      expectFrame(author, after, original);
      exchange(author, peer);
      expectFrame(peer, after, original);
      act(() => { author.undo.manager.undo(); });
      exchange(author, peer);
      expectFrame(author, before, original);
      expectFrame(peer, before, original);
      act(() => { author.undo.manager.redo(); });
      exchange(author, peer);
      expectFrame(author, after, original);
      expectFrame(peer, after, original);
    });
    for (const children of ['empty', 'single', 'multiple', 'nested'] as const) {
      it(`preserves ${children} children when opening an ordinary empty parent inCell=${inCell}`, () => {
        const author = open(fixture(inCell, children, false));
        const before = author.editor.prosemirrorState.doc;
        const original = native(author.doc);
        const peer = open(clone(author.doc));
        enter(author);
        const fresh = freshParent(author, original);
        const after = expected(before, fresh, '', false);
        expectFrame(author, after, original);
        expect(author.undo.manager.undoStack).toHaveLength(1);
        exchange(author, peer);
        expectFrame(peer, after, original);
        act(() => { author.undo.manager.undo(); });
        exchange(author, peer);
        expectFrame(author, before, original);
        expectFrame(peer, before, original);
        act(() => { author.undo.manager.redo(); });
        exchange(author, peer);
        expectFrame(author, after, original);
        expectFrame(peer, after, original);
        const reopened = open(clone(author.doc));
        expectFrame(reopened, after, original);
      });
    }
  }
});

describe('records empty-predecessor Backspace source producers', () => {
  it('preserves all original sources when the same-markup current block replaces an empty predecessor', () => {
    const doc = codecFixture([{ id: 'A', text: 'AABA' }, { id: 'B', text: 'AA' }, { id: 'E', text: '' }]);
    documentBodySource(doc, 'S:A').format(1, 4, { 'vendor-payload': { owner: 'A', keep: true } });
    documentBodySource(doc, 'S:B').format(1, 2, { 'vendor-payload': { owner: 'B', keep: true } });
    const author = open(doc);
    const initial = native(doc);
    expect(initial.owners.map((owner) => [owner.id, owner.units.length])).toEqual([['A', 4], ['B', 2], ['E', 0]]);
    const labels = initial.owners.flatMap((owner) => owner.units.map(payload));
    const view = author.editor.prosemirrorView;
    const frame = bodyBindingOf(view.state)!.read();
    const from = frame.index.owners.get('A')!;
    const to = frame.index.owners.get('B')!;
    const mirror = new BodyOriginMirror(view.state.tr, {
      sourceAt: new Map(frame.units.map((unit) => [unit.pos, unit.token])),
      sourceOrigins: new Map(frame.units.map((unit) => [unit.token, unit.origin])),
    });
    mirror.moveRange(from.contentFrom, from.contentTo, to.contentFrom);
    act(() => view.dispatch(mirror.tr));
    const before = siblingDocument(author.editor.pmSchema, [['A', ''], ['B', 'AABAAA'], ['E', '']]);
    const after = siblingDocument(author.editor.pmSchema, [['B', 'AABAAA'], ['E', '']]);
    expect(author.runtime.read().status).toBe('active');
    expect(view.state.doc.toJSON()).toEqual(before.toJSON());
    expectNativeOwners(author, [['A', []], ['B', labels], ['E', []]]);
    const peer = open(clone(doc));
    author.undo.manager.clear();
    author.undo.manager.stopCapturing();
    act(() => author.editor.setTextCursorPosition('B', 'start'));
    let handled = false;
    act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))) === true; });
    expect(handled).toBe(true);
    expect(author.runtime.read().status).toBe('active');
    expect(view.state.doc.toJSON()).toEqual(after.toJSON());
    expectNativeOwners(author, [['B', labels], ['E', []]]);
    expect(author.undo.manager.undoStack).toHaveLength(1);
    exchange(author, peer);
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
    expectNativeOwners(peer, [['B', labels], ['E', []]]);
    act(() => { author.undo.manager.undo(); });
    exchange(author, peer);
    for (const body of [author, peer]) {
      expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(before.toJSON());
      expectNativeOwners(body, [['A', []], ['B', labels], ['E', []]]);
    }
    act(() => { author.undo.manager.redo(); });
    exchange(author, peer);
    for (const body of [author, peer, open(clone(doc))]) {
      expect(body.runtime.read().status).toBe('active');
      expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(after.toJSON());
      expectNativeOwners(body, [['B', labels], ['E', []]]);
    }
  });
});
