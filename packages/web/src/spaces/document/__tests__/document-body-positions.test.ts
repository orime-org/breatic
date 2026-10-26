// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state';
import type { Schema } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';

import { documentBodySource } from '@breatic/shared';

import { projectBodyTree } from '@web/spaces/document/document-body-codec';
import type { BodyProjectionIndex } from '@web/spaces/document/document-body-codec-types';
import { isNamedCharacterAlive, nameBodyPoint, nameBodySelection, resolveBodyPoint, resolveBodySelection } from '@web/spaces/document/document-body-positions';
import { bodyEdgeBetween, bodyEdgePos } from '@web/spaces/document/document-body-edge-selection';
import { cleanupCodecFixtures, codecFacts, codecFixture, codecSchema, codecTableFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

afterEach(cleanupCodecFixtures);

/**
 * Requires the production final index rather than a position mapping stub.
 * @param doc - The document being inspected.
 * @param schema - The actual installed editor schema.
 * @param epoch - The final projection epoch.
 * @param document - The owning document identity.
 * @returns The complete production final index.
 * @throws {Error} If the native fixture is incomplete.
 */
function indexOf(doc: Y.Doc, schema: Schema, epoch = 1, document = 'document-one'): BodyProjectionIndex {
  const result = projectBodyTree(doc, schema, { document, epoch });
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected a final index');
  return result.projection.index;
}

/**
 * Hides exactly one owner using the approved explicit delete fact.
 * @param doc - The document being inspected.
 * @param owner - The stable content owner identifier.
 * @throws {Error} If fact registration fails.
 */
function hide(doc: Y.Doc, owner: string): void {
  const group = `delete:${owner}`;
  codecFacts(doc, group, [{ id: `${group}:fact`, group, kind: 'delete', owner, dependencies: [] }]);
}

describe('common native body point and selection names', () => {
  it('resolves named text after peer insertion and structural transfer', () => {
    const schema = codecSchema();
    const doc = codecFixture();
    const initial = indexOf(doc, schema);
    const name = nameBodyPoint(initial, { kind: 'text', pos: 4, assoc: 1 });
    expect(name).toMatchObject({ version: 1, document: 'document-one', kind: 'text', source: 'S:A', token: initial.units[1].token, assoc: 1 });
    const originalName = Y.encodeRelativePosition(name.kind === 'text' ? name.relative : (() => { throw new Error('Expected native text name'); })());

    documentBodySource(doc, 'S:A').insert(1, 'XX', { ctx: 'base' });
    codecFacts(doc, 'move', [{ id: 'move:A', kind: 'structure', group: 'move', dependencies: [], edges: [{ child: 'A', parent: 'group', order: 'z', counter: 1 }] }]);
    const next = indexOf(doc, schema, 2);
    expect(next.doc.textContent).toBe('xyXXABC');
    expect(resolveBodyPoint(next, name)).toEqual({ status: 'resolved', pos: 12, epoch: 2 });
    expect(isNamedCharacterAlive(next, name)).toBe(true);
    expect(next.units.find((unit) => unit.token === initial.units[1].token)!.pos).toBe(12);
    expect(Y.encodeRelativePosition(name.kind === 'text' ? name.relative : (() => { throw new Error('Expected native text name'); })())).toEqual(originalName);
  });

  it('resolves a visible container gap between child blocks promoted from a detached owner', () => {
    const schema = codecSchema();
    const doc = codecFixture([
      { id: 'A', text: 'A' }, { id: 'C', text: 'C', parent: 'nested' },
      { id: 'D', text: 'D', parent: 'nested' }, { id: 'B', text: 'B' },
    ], [{ id: 'nested', kind: 'container', type: 'blockGroup', attrs: {}, parent: 'A', order: 'zz' }]);
    codecFacts(doc, 'move', [{ id: 'move-facet', kind: 'structure', group: 'move', dependencies: [],
      edges: [{ child: 'F:A', parent: 'F:B', counter: 1, order: '\uffff' }] }]);
    const initial = indexOf(doc, schema);
    expect(initial.doc.textContent).toBe('CDBA');
    expect(initial.doc.firstChild!.content.content.map((node) => node.attrs['id'])).toEqual(['C', 'D', 'B']);
    const bytes = Y.encodeStateAsUpdate(doc);
    const name = nameBodyPoint(initial, { kind: 'gap', parent: 'group', left: 'C', right: 'D', assoc: 1 });
    expect(resolveBodyPoint(initial, name)).toEqual({ status: 'resolved', pos: 6, epoch: 1 });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
      documentBodySource(peer, 'S:C').insert(1, 'P', { ctx: 'base' });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
      const next = indexOf(doc, schema, 2);
      expect(next.doc.textContent).toBe('PCDBA');
      expect(resolveBodyPoint(next, name)).toEqual({ status: 'resolved', pos: 7, epoch: 2 });
    } finally {
      peer.destroy();
    }
  });

  it('separates a deleted point from a live character and follows native redone identities', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'ABC' }]);
    const source = documentBodySource(doc, 'S:A');
    const initial = indexOf(doc, schema);
    const name = nameBodyPoint(initial, { kind: 'text', pos: 4, assoc: 1 });
    const user = Symbol('user-delete');
    const undo = new Y.UndoManager(source, { trackedOrigins: new Set([user]) });
    try {
      doc.transact(() => source.delete(2, 1), user);
      const deleted = indexOf(doc, schema, 2);
      expect(deleted.doc.textContent).toBe('AC');
      expect(resolveBodyPoint(deleted, name)).toEqual({ status: 'resolved', pos: 4, epoch: 2 });
      expect(isNamedCharacterAlive(deleted, name)).toBe(false);

      undo.undo();
      const restored = indexOf(doc, schema, 3);
      expect(restored.doc.textContent).toBe('ABC');
      expect(resolveBodyPoint(restored, name)).toEqual({ status: 'resolved', pos: 4, epoch: 3 });
      expect(isNamedCharacterAlive(restored, name)).toBe(true);
      expect(restored.units[1].token).not.toBe(initial.units[1].token);

      undo.redo();
      const redone = indexOf(doc, schema, 4);
      expect(redone.doc.textContent).toBe('AC');
      expect(resolveBodyPoint(redone, name)).toEqual({ status: 'resolved', pos: 4, epoch: 4 });
      expect(isNamedCharacterAlive(redone, name)).toBe(false);
    } finally {
      undo.destroy();
    }
  });

  it('distinguishes dependency runtime visibility and document outcomes', () => {
    const schema = codecSchema();
    const doc = codecFixture();
    const initial = indexOf(doc, schema);
    const name = nameBodyPoint(initial, { kind: 'text', pos: 4, assoc: 1 });
    expect(resolveBodyPoint(initial, name, { runtime: 'waiting', missing: ['context:peer'] })).toEqual({ status: 'bindingUnavailable', runtime: 'waiting' });
    expect(resolveBodyPoint(initial, name, { runtime: 'failed' })).toEqual({ status: 'bindingUnavailable', runtime: 'failed' });
    expect(resolveBodyPoint(initial, name, { runtime: 'disposed' })).toEqual({ status: 'bindingUnavailable', runtime: 'disposed' });
    expect(resolveBodyPoint(indexOf(doc, schema, 2, 'different-document'), name)).toEqual({ status: 'otherDocument' });

    documentBodySource(doc, 'S:A').format(2, 1, { ctx: 'peer' });
    expect(resolveBodyPoint(initial, name)).toEqual({ status: 'pendingDependency', missing: ['context:peer'] });
    documentBodySource(doc, 'S:A').format(2, 1, { ctx: 'base' });
    hide(doc, 'A');
    const hidden = indexOf(doc, schema, 3);
    expect(resolveBodyPoint(hidden, name)).toEqual({ status: 'hidden' });
    expect(isNamedCharacterAlive(hidden, name)).toBe(true);
    expect(resolveBodyPoint(hidden, { version: 1, document: 'document-one', kind: 'node', node: 'never-registered', side: 'before' })).toEqual({ status: 'gone' });
  });

  it('resolves node sides and gap affinity using surviving neighbors and container boundaries', () => {
    const schema = codecSchema();
    const doc = codecFixture([{ id: 'A', text: 'A' }, { id: 'B', text: 'B' }, { id: 'C', text: 'C' }]);
    const initial = indexOf(doc, schema);
    const left = nameBodyPoint(initial, { kind: 'gap', parent: 'group', left: 'A', right: 'B', assoc: -1 });
    const right = nameBodyPoint(initial, { kind: 'gap', parent: 'group', left: 'A', right: 'B', assoc: 1 });
    const before = nameBodyPoint(initial, { kind: 'node', node: 'B', side: 'before' });
    const after = nameBodyPoint(initial, { kind: 'node', node: 'B', side: 'after' });
    const inside = nameBodyPoint(initial, { kind: 'node', node: 'B', side: 'inside' });
    expect(resolveBodyPoint(initial, before)).toEqual({ status: 'resolved', pos: 6, epoch: 1 });
    expect(resolveBodyPoint(initial, after)).toEqual({ status: 'resolved', pos: 11, epoch: 1 });
    expect(resolveBodyPoint(initial, inside)).toEqual({ status: 'resolved', pos: 8, epoch: 1 });
    expect(resolveBodyPoint(initial, left)).toEqual({ status: 'resolved', pos: 6, epoch: 1 });
    expect(resolveBodyPoint(initial, right)).toEqual({ status: 'resolved', pos: 6, epoch: 1 });

    hide(doc, 'A');
    const oneGone = indexOf(doc, schema, 2);
    expect(resolveBodyPoint(oneGone, left)).toEqual({ status: 'resolved', pos: 1, epoch: 2 });
    expect(resolveBodyPoint(oneGone, right)).toEqual({ status: 'resolved', pos: 1, epoch: 2 });
    hide(doc, 'B');
    const bothGone = indexOf(doc, schema, 3);
    expect(resolveBodyPoint(bothGone, left)).toEqual({ status: 'resolved', pos: 1, epoch: 3 });
    expect(resolveBodyPoint(bothGone, right)).toEqual({ status: 'resolved', pos: 6, epoch: 3 });
  });

  it('preserves text node cell body-edge and all selection kinds on the same final index', () => {
    const schema = codecSchema();
    const doc = codecTableFixture();
    const initial = indexOf(doc, schema);
    const selections: Selection[] = [
      TextSelection.create(initial.doc, 6, 9),
      NodeSelection.create(initial.doc, 4),
      new CellSelection(initial.doc.resolve(3), initial.doc.resolve(13)),
      bodyEdgeBetween(initial.doc, bodyEdgePos(initial.doc, 'start'), 8),
      bodyEdgeBetween(initial.doc, 8, bodyEdgePos(initial.doc, 'end')),
      new AllSelection(initial.doc),
    ];
    const names = selections.map((selection) => nameBodySelection(initial, selection));
    expect(names.map((name) => name.kind)).toEqual(['text', 'node', 'cell', 'bodyEdge', 'bodyEdge', 'all']);
    for (const [ordinal, name] of names.entries()) {
      const result = resolveBodySelection(initial, name);
      expect(result.status).toBe('resolved');
      if (result.status !== 'resolved') throw new Error('Expected named selection restoration');
      expect(result.selection.toJSON()).toEqual(selections[ordinal].toJSON());
      expect(result.epoch).toBe(1);
    }
    const user = Symbol('insert');
    const source = documentBodySource(doc, 'S:L');
    const history = new Y.UndoManager(source, { trackedOrigins: new Set([user]) });
    try {
      doc.transact(() => source.insert(1, 'XX', { ctx: 'base' }), user);
      history.undo();
      const restored = indexOf(doc, schema, 3);
      for (const [ordinal, name] of names.entries()) {
        const result = resolveBodySelection(restored, name);
        expect(result.status).toBe('resolved');
        if (result.status !== 'resolved') throw new Error('Expected selection after native undo');
        expect(result.selection.toJSON()).toEqual(selections[ordinal].toJSON());
        expect(result.epoch).toBe(3);
      }
    } finally {
      history.destroy();
    }
  });

  it('falls back to a legal near selection when a selected registered block is hidden', () => {
    const schema = codecSchema();
    const doc = codecFixture();
    const initial = indexOf(doc, schema);
    const name = nameBodySelection(initial, NodeSelection.create(initial.doc, 1));
    hide(doc, 'A');
    const next = indexOf(doc, schema, 2);
    const result = resolveBodySelection(next, name);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('Expected legal fallback selection');
    expect(result.selection.toJSON()).toEqual({ type: 'text', anchor: 3, head: 3 });
    expect(result.selection.$anchor.doc).toBe(next.doc);
  });
});
