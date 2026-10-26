// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  documentBodyFragment,
  documentBodySource,
  documentCommentThreads,
  readBodyTree,
  registerDocumentBodyRecords,
  type BodyTreeView,
} from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { cleanupCodecFixtures, codecDoc, codecFixture, codecParagraph } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
}

const opened: OpenBody[] = [];

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
});

/** Reads original native units from the real shared source, independent of accepted PM text. @throws {Error} If body dependencies are incomplete. */
function native(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete move producer fixture: ${read.status}`);
  return read.view;
}

/** Seeds repeated words with independently named native sources and original B marks. @throws {Error} If source registration fails. */
function fixture(): Y.Doc {
  const doc = codecFixture([{ id: 'A', text: 'AA' }, { id: 'B', text: 'AA' }, { id: 'C', text: 'AA' }]);
  registerDocumentBodyRecords(doc, { groups: [{ id: 'seed-marks', facts: ['seed-bold', 'seed-link', 'seed-comment'], history: 'base' }], facts: [
    { id: 'seed-bold', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
    { id: 'seed-link', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/b' } } },
    { id: 'seed-comment', kind: 'mark', group: 'seed-marks', dependencies: [], payload: { type: 'comment', attrs: { threadId: 'thread-B', orphan: false } } },
  ] });
  documentBodySource(doc, 'S:B').format(1, 2, {
    'mark:bold': { factId: 'seed-bold' },
    'mark:link': { factId: 'seed-link' },
    'mark:comment:thread-B': { factId: 'seed-comment' },
  });
  documentCommentThreads(doc).set('thread-B', {
    id: 'thread-B', resolved: false, createdAt: '2026-10-25T12:00:00.000Z',
    comments: [{ id: 'comment-B', userId: 'author', body: [{ type: 'text', text: 'Original moved words' }] }],
  });
  return doc;
}

/** Opens the actual records factory with origin-scoped native history. @throws {Error} If editor construction fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:move-producers', origin, runtime, history } });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, history, origin, host };
  opened.push(body);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return body;
}

/** Creates an independent native client sharing exactly the current source snapshot. @throws {Error} If Yjs rejects the snapshot. */
function clone(doc: Y.Doc): Y.Doc {
  const peer = codecDoc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return peer;
}

/** Builds the complete independently expected document with marks on the original B only. @throws {RangeError} If expected nodes violate the installed schema. */
function expected(schema: Schema, order: readonly string[]): PMNode {
  return schema.node('doc', null, schema.node('blockGroup', null, order.map((id) => id === 'B'
    ? schema.node('blockContainer', { id }, schema.node('paragraph', null, schema.text('AA', [
      schema.mark('bold'), schema.mark('link', { href: 'https://example.com/b' }), schema.mark('comment', { threadId: 'thread-B', orphan: false }),
    ])))
    : codecParagraph(schema, id, 'AA'),
  )));
}

/** Places the caret by its stable actual owner handle despite all three repeated words. @throws {Error} If the actual binding has no target. */
function selectB(body: OpenBody): void {
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  const target = binding?.read().index.owners.get('B');
  if (target === undefined) throw new Error('The actual B owner is absent');
  act(() => {
    const view = body.editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target.contentFrom + 1)));
  });
}

/** Dispatches one real platform spelling through the installed handleKeyDown chain. @throws {Error} If an actual handler fails. */
function press(body: OpenBody, key: 'ArrowUp' | 'ArrowDown', modifier: 'meta' | 'ctrl'): boolean {
  const view = body.editor.prosemirrorView;
  const event = new KeyboardEvent('keydown', { key, shiftKey: true, metaKey: modifier === 'meta', ctrlKey: modifier === 'ctrl', bubbles: true });
  let handled = false;
  act(() => { handled = view.someProp('handleKeyDown', (handler) => handler(view, event)) === true; });
  return handled;
}

/** Checks actual native identity and full PM JSON against the independent row-order model. @throws {Error} If native dependencies are incomplete. */
function expectState(body: OpenBody, order: readonly string[], ids: ReadonlyMap<string, readonly string[]>): void {
  expect(body.runtime.read().status).toBe('active');
  const source = native(body.doc);
  expect(source.owners.map((owner) => owner.id)).toEqual(order);
  expect(source.owners.map((owner) => owner.units.map((unit) => unit.value).join(''))).toEqual(['AA', 'AA', 'AA']);
  const wanted = order.flatMap((id) => ids.get(id)!);
  expect(source.owners.flatMap((owner) => owner.units.map((unit) => unit.id))).toEqual(wanted);
  expect(new Set(wanted).size).toBe(6);
  expect(body.editor.prosemirrorState.doc.toJSON()).toEqual(expected(body.editor.pmSchema, order).toJSON());
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The actual records binding is absent');
  expect(binding.read().units.map((unit) => unit.token)).toEqual(wanted);
}

/** Exchanges actual native frames in both directions and delivers duplicate frames. @throws {Error} If Yjs rejects an update. */
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

describe('actual body move producer provenance', () => {
  it.each([
    ['ctrl', 'ArrowUp'], ['ctrl', 'ArrowDown'], ['meta', 'ArrowUp'], ['meta', 'ArrowDown'],
  ] as const)('keeps native row identity through Shift %s %s and its author undo redo', (modifier, key) => {
    const doc = fixture();
    const source = native(doc);
    const ids = new Map(source.owners.map((owner) => [owner.id, owner.units.map((unit) => unit.id)]));
    const marks = structuredClone(source.owners.find((owner) => owner.id === 'B')!.units.map((unit) => unit.attributes));
    const thread = documentCommentThreads(doc).toJSON();
    const author = open(doc);
    const peer = open(clone(doc));
    const before = ['A', 'B', 'C'];
    const after = key === 'ArrowUp' ? ['B', 'A', 'C'] : ['A', 'C', 'B'];
    expectState(author, before, ids);
    expectState(peer, before, ids);
    selectB(author);
    let userUpdates = 0;
    doc.on('update', (_update, origin) => { if (origin === author.origin) userUpdates += 1; });

    const handled = press(author, key, modifier);

    // A missing chord is distinct from an accepted move losing native identity.
    expect(handled, 'The actual keyboard chain must claim this chord').toBe(true);
    expectState(author, after, ids);
    expect(native(doc).owners.find((owner) => owner.id === 'B')!.units.map((unit) => unit.attributes)).toEqual(marks);
    expect(documentCommentThreads(doc).toJSON()).toEqual(thread);
    expect(author.history.undoStack).toHaveLength(1);
    expect(userUpdates).toBe(1);
    exchange(author, peer);
    expectState(peer, after, ids);
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(author.editor.prosemirrorState.doc.toJSON());
    expect(documentCommentThreads(peer.doc).toJSON()).toEqual(thread);
    expect(peer.history.undoStack).toHaveLength(0);

    act(() => { author.history.undo(); });
    exchange(author, peer);
    expectState(author, before, ids);
    expectState(peer, before, ids);
    expect(author.history.undoStack).toHaveLength(0);
    expect(author.history.redoStack).toHaveLength(1);
    expect(documentCommentThreads(doc).toJSON()).toEqual(thread);
    act(() => { author.history.redo(); });
    exchange(author, peer);
    expectState(author, after, ids);
    expectState(peer, after, ids);
    expect(native(doc).owners.find((owner) => owner.id === 'B')!.units.map((unit) => unit.attributes)).toEqual(marks);
    const reopened = open(clone(doc));
    expectState(reopened, after, ids);
    expect(reopened.history.undoStack).toHaveLength(0);
  });
});
