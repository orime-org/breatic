// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type BodyJsonObject, type BodyTreeView } from '@breatic/shared';
import { documentBodyFragment, documentBodyRecords, documentBodySource, documentCommentThreads, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';
import { landingFor, moveRowTo } from '@web/spaces/document/document-drag-move';
import { rowById } from '@web/spaces/document/document-row-by-id';
import { cleanupCodecFixtures, codecDoc, codecFixture, codecParagraph } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

type Scenario = 'paragraph' | 'table' | 'media';

interface OpenBody {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly runtime: DocumentBodyRuntime;
  readonly history: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
}

const opened: OpenBody[] = [];
const paragraphAttrs: BodyJsonObject = { textAlignment: 'center', quoted: true };
const mediaAttrs: BodyJsonObject = {
  url: 'https://example.com/moved.png', name: 'moved.png', caption: 'Original caption',
  previewWidth: 320, mediaWidth: 640, mediaHeight: 480, textAlignment: 'right', quoted: true,
};

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

/** Reads native identities independently of the PM projection. @throws {Error} If fixture dependencies are incomplete. */
function native(doc: Y.Doc): BodyTreeView {
  const read = readBodyTree(doc);
  if (read.status !== 'ready') throw new Error(`Incomplete drag fixture: ${read.status}`);
  return read.view;
}

/** Registers independent repeated native words and a full carried subtree. @throws {Error} If fixture registration fails. */
function fixture(scenario: Scenario): Y.Doc {
  const doc = scenario === 'table'
    ? codecFixture([
      { id: 'A', text: 'AA' }, { id: 'L', text: 'AA', parent: 'left' },
      { id: 'R', text: 'AA', attrs: paragraphAttrs, parent: 'right' }, { id: 'C', text: 'AA' },
    ], [
      { id: 'table', kind: 'container', type: 'docTable', attrs: { id: 'table' }, parent: 'group', order: 'B' },
      { id: 'row', kind: 'container', type: 'docTableRow', attrs: { id: 'row' }, parent: 'table', order: 'A' },
      { id: 'left', kind: 'container', type: 'docTableCell', attrs: { id: 'left', colspan: 1, rowspan: 1, colwidth: [120] }, parent: 'row', order: 'A' },
      { id: 'right', kind: 'container', type: 'docTableCell', attrs: { id: 'right', colspan: 1, rowspan: 1, colwidth: [180] }, parent: 'row', order: 'B' },
    ])
    : scenario === 'media'
      ? codecFixture([
        { id: 'A', text: 'AA' }, { id: 'M', type: 'image', text: '', attrs: mediaAttrs },
        { id: 'T', text: 'AA', attrs: paragraphAttrs, parent: 'nested' }, { id: 'C', text: 'AA' },
      ], [{ id: 'nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'M', order: 'z' }])
      : codecFixture([{ id: 'A', text: 'AA' }, { id: 'M', text: 'AA', attrs: paragraphAttrs }, { id: 'C', text: 'AA' }]);
  registerDocumentBodyRecords(doc, {
    groups: [{ id: 'drag-marks', facts: ['drag-bold', 'drag-link', 'drag-comment'], history: 'base' }],
    facts: [
      { id: 'drag-bold', kind: 'mark', group: 'drag-marks', dependencies: [], payload: { type: 'bold', attrs: {} } },
      { id: 'drag-link', kind: 'mark', group: 'drag-marks', dependencies: [], payload: { type: 'link', attrs: { href: 'https://example.com/original' } } },
      { id: 'drag-comment', kind: 'mark', group: 'drag-marks', dependencies: [], payload: { type: 'comment', attrs: { threadId: 'drag-thread', orphan: false } } },
    ],
  });
  documentBodyRecords(doc).enabled.set('drag-marks', true);
  const marked = scenario === 'table' ? 'R' : scenario === 'media' ? 'T' : 'M';
  documentBodySource(doc, `S:${marked}`).format(1, 2, {
    'mark:bold': { factId: 'drag-bold' }, 'mark:link': { factId: 'drag-link' },
    'mark:comment:drag-thread': { factId: 'drag-comment' }, 'vendor-payload': { keep: ['original', 7] },
  });
  documentCommentThreads(doc).set('drag-thread', {
    id: 'drag-thread', resolved: false, createdAt: '2026-10-25T12:00:00.000Z',
    comments: [{ id: 'drag-comment-body', userId: 'author', body: [{ type: 'text', text: 'Original moved words' }] }],
  });
  return doc;
}

/** Opens the actual records factory and origin-scoped native history. @throws {Error} If actual assembly fails. */
function open(doc: Y.Doc): OpenBody {
  const origin = {};
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const history = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]) });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc), body: { document: 'document:drag-producers', origin, runtime, history } });
  const host = document.createElement('div');
  const body = { doc, editor, runtime, history, origin, host };
  opened.push(body);
  document.body.appendChild(host);
  act(() => editor.mount(host));
  return body;
}

/** Clones actual source updates into a genuinely independent client. @throws {Error} If Yjs rejects bytes. */
function clone(doc: Y.Doc): Y.Doc {
  const peer = codecDoc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return peer;
}

/** Constructs independently expected original marks and complete wrapper attributes. @throws {RangeError} If the real schema rejects the fixture. */
function markedParagraph(schema: Schema, id: string): PMNode {
  return schema.node('blockContainer', { id }, schema.node('paragraph', paragraphAttrs, schema.text('AA', [
    schema.mark('bold'), schema.mark('link', { href: 'https://example.com/original' }),
    schema.mark('comment', { threadId: 'drag-thread', orphan: false }),
  ])));
}

/** Builds complete expected JSON from the test input and its explicit row order. @throws {RangeError} If expected table or media nodes are invalid. */
function expected(schema: Schema, scenario: Scenario, moved: boolean): PMNode {
  const carried = scenario === 'table'
    ? schema.node('docTable', { id: 'table' }, schema.node('docTableRow', { id: 'row' }, [
      schema.node('docTableCell', { id: 'left', colspan: 1, rowspan: 1, colwidth: [120] }, codecParagraph(schema, 'L', 'AA')),
      schema.node('docTableCell', { id: 'right', colspan: 1, rowspan: 1, colwidth: [180] }, markedParagraph(schema, 'R')),
    ]))
    : scenario === 'media'
      ? schema.node('blockContainer', { id: 'M' }, [
        schema.node('image', mediaAttrs), schema.node('blockGroup', null, markedParagraph(schema, 'T')),
      ])
      : markedParagraph(schema, 'M');
  const first = codecParagraph(schema, 'A', 'AA');
  const last = codecParagraph(schema, 'C', 'AA');
  return schema.node('doc', null, schema.node('blockGroup', null, moved ? [carried, first, last] : [first, carried, last]));
}

/** Verifies native identities, all original source attributes and complete expected PM JSON. @throws {Error} If actual binding or native dependencies are missing. */
function expectState(body: OpenBody, scenario: Scenario, moved: boolean, original: BodyTreeView): void {
  expect(body.runtime.read().status).toBe('active');
  const view = native(body.doc);
  const carried = scenario === 'table' ? ['L', 'R'] : scenario === 'media' ? ['M', 'T'] : ['M'];
  const order = moved ? [...carried, 'A', 'C'] : ['A', ...carried, 'C'];
  expect(view.owners.map((owner) => owner.id)).toEqual(order);
  const old = new Map(original.owners.map((owner) => [owner.id, owner.units]));
  for (const owner of view.owners) {
    expect(owner.units.map((unit) => ({ id: unit.id, value: unit.value, attributes: unit.attributes }))).toEqual(
      old.get(owner.id)!.map((unit) => ({ id: unit.id, value: unit.value, attributes: unit.attributes })),
    );
  }
  const wanted = order.flatMap((id) => old.get(id)!.map((unit) => unit.id));
  expect(new Set(wanted).size).toBe(wanted.length);
  const binding = bodyBindingOf(body.editor.prosemirrorState);
  if (binding === null) throw new Error('The actual drag binding is absent');
  expect(binding.read().units.map((unit) => unit.token)).toEqual(wanted);
  const actual = body.editor.prosemirrorState.doc;
  expect(actual.toJSON()).toEqual(expected(body.editor.pmSchema, scenario, moved).toJSON());
  expect(() => actual.check()).not.toThrow();
  if (scenario === 'table') {
    const table = rowById(actual, 'table');
    if (table === undefined) throw new Error('The actual table is absent');
    const map = TableMap.get(table.node);
    expect([map.width, map.height, map.problems]).toEqual([2, 1, null]);
  }
}

/** Delivers both native update directions twice using independently captured frames. @throws {Error} If Yjs rejects an update. */
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

describe('actual whole-row drag helper provenance at the unit layer', () => {
  it.each(['paragraph', 'table', 'media'] as const)('keeps original %s units and payloads through helper move and author undo redo', (scenario) => {
    const doc = fixture(scenario);
    const original = native(doc);
    const threads = documentCommentThreads(doc).toJSON();
    const author = open(doc);
    const peer = open(clone(doc));
    expectState(author, scenario, false, original);
    expectState(peer, scenario, false, original);
    const before = author.editor.prosemirrorState.doc;
    const carriedId = scenario === 'table' ? 'table' : 'M';
    const row = rowById(before, carriedId);
    const first = rowById(before, 'A');
    if (row === undefined || first === undefined) throw new Error('The actual drop source or target is absent');
    const pointerAt = first.from + 2;
    expect(landingFor(before, pointerAt, row.node)).toBe(first.from);
    let userUpdates = 0;
    doc.on('update', (_update, origin) => { if (origin === author.origin) userUpdates += 1; });

    // This calls the real producer helper; native browser drag selection is not simulated.
    act(() => { moveRowTo(author.editor.prosemirrorView, carriedId, pointerAt); });

    expectState(author, scenario, true, original);
    expect(author.history.undoStack).toHaveLength(1);
    expect(userUpdates).toBe(1);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    exchange(author, peer);
    expectState(peer, scenario, true, original);
    expect(peer.editor.prosemirrorState.doc.toJSON()).toEqual(author.editor.prosemirrorState.doc.toJSON());
    expect(peer.history.undoStack).toHaveLength(0);
    expect(documentCommentThreads(peer.doc).toJSON()).toEqual(threads);

    act(() => { author.history.undo(); });
    exchange(author, peer);
    expectState(author, scenario, false, original);
    expectState(peer, scenario, false, original);
    expect(author.history.undoStack).toHaveLength(0);
    expect(author.history.redoStack).toHaveLength(1);
    act(() => { author.history.redo(); });
    exchange(author, peer);
    expectState(author, scenario, true, original);
    expectState(peer, scenario, true, original);
    expect(documentCommentThreads(doc).toJSON()).toEqual(threads);
    const reopened = open(clone(doc));
    expectState(reopened, scenario, true, original);
    expect(reopened.history.undoStack).toHaveLength(0);
  });
});
