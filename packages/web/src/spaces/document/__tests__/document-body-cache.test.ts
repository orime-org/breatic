// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it } from 'vitest';
import { act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  documentBodySource, encodeInitialSpaceContent, readBodyTree, readDocumentBodyRecords, registerDocumentBodyRecords,
} from '@breatic/shared';

import {
  _resetDocumentEditorCacheForTests, adoptDocumentEditor, evictDocumentEditor, getDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { DocumentBodyBindingAccess } from '@web/spaces/document/document-body-binding-types';
import type { DocumentBodyRuntime } from '@web/spaces/document/document-body-runtime-types';

const NAME = 'project-16190000-1111-4111-8111-111111111111/document-16190000-2222-4222-8222-222222222222';
const docs: Y.Doc[] = [];
const providers: Awareness[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  act(() => _resetDocumentEditorCacheForTests());
  providers.splice(0).forEach((awareness) => awareness.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
  hosts.splice(0).forEach((host) => host.remove());
});

/** Builds the same cache input used by the actual document UI. */
function fixture(): { doc: Y.Doc; inputs: Parameters<typeof getDocumentEditor>[2] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  docs.push(doc);
  const awareness = new Awareness(doc);
  providers.push(awareness);
  return { doc, inputs: { caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true } };
}

/** Reads the actual source binding owned by the cached handle. */
function binding(handle: DocumentEditorHandle): DocumentBodyBindingAccess {
  const current = bodyBindingOf(handle.editor.prosemirrorState);
  expect(current?.document).toBe(NAME);
  if (current === null) throw new Error('The cache did not construct the records binding');
  return current;
}

/** Adopts the existing surface instead of unmounting a document during tab changes. */
function show(handle: DocumentEditorHandle): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  act(() => adoptDocumentEditor(handle, host));
  return host;
}

/** Keeps the original failure and recovery material attached to this exact handle. */
function fail(current: DocumentBodyBindingAccess): Error {
  const error = new Error('cache-binding-failure');
  current.runtime.fail({ phase: 'preflighting', error, batch: 'cache-batch', epoch: current.read().epoch,
    accepted: current.read().doc, selection: null, journal: null, lastGood: current.read(), writeStarted: false, writeReturned: false });
  return error;
}

describe('records runtime at the existing editor cache boundary', () => {
  it('constructs one handle runtime and native history before adopting its surface', () => {
    const { doc, inputs } = fixture();
    const before = Y.encodeStateAsUpdate(doc);
    let handle: DocumentEditorHandle;
    act(() => { handle = getDocumentEditor(doc, NAME, inputs); });
    const current = binding(handle!);
    const declared = handle! as DocumentEditorHandle & { runtime?: DocumentBodyRuntime };
    expect(declared.runtime).toBe(current.runtime);
    expect(current.history).toBe(handle!.undoManager);
    show(handle!);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(current.runtime.read().status).toBe('active');
    expect(current.history.undoStack).toHaveLength(0);
  });

  it('keeps a sticky failure and the same caption owner across cache role and surface changes', () => {
    const { doc, inputs } = fixture();
    const handle = getDocumentEditor(doc, NAME, inputs);
    const current = binding(handle);
    const firstSurface = show(handle);
    handle.captionDrafts.event('media', { type: 'open', caption: 'Shared', readOnly: false, exists: true });
    const session = handle.captionDrafts.get('media')!.session;
    handle.captionDrafts.event('media', { type: 'input', session, value: 'Local completed' });
    let error: Error;
    act(() => { error = fail(current); });
    const before = Y.encodeStateAsUpdate(doc);
    for (const editable of [false, true]) {
      let cached: DocumentEditorHandle;
      act(() => { cached = getDocumentEditor(doc, NAME, { ...inputs, editable }); });
      expect(cached!).toBe(handle);
      expect(cached!.captionDrafts).toBe(handle.captionDrafts);
      expect(binding(cached!).runtime).toBe(current.runtime);
      expect(current.runtime.read()).toMatchObject({ status: 'failed', failure: { error: error! } });
      expect(cached!.editor.isEditable).toBe(false);
    }
    show(handle);
    expect(firstSurface.contains(handle.surface)).toBe(false);
    expect(handle.captionDrafts.get('media')).toMatchObject({ value: 'Local completed', session });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('disposes the old incarnation at eviction while the same source Doc stays alive', () => {
    const { doc, inputs } = fixture();
    const first = getDocumentEditor(doc, NAME, inputs);
    const previous = binding(first);
    show(first);
    const before = Y.encodeStateAsUpdate(doc);
    act(() => evictDocumentEditor(NAME));
    expect(previous.runtime.read().status).toBe('disposed');
    expect(previous.canWrite()).toBe(false);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    const next = getDocumentEditor(doc, NAME, inputs);
    const current = binding(next);
    expect(next).not.toBe(first);
    expect(current.runtime.incarnation).not.toBe(previous.runtime.incarnation);
    expect(next.captionDrafts.all()).toEqual([]);
    expect(current.runtime.read().status).toBe('active');
  });

  it('continues receiving source facts while a failed view holds its last good frame', () => {
    const { doc, inputs } = fixture();
    const handle = getDocumentEditor(doc, NAME, inputs);
    const current = binding(handle);
    show(handle);
    act(() => { fail(current); });
    const lastGood = handle.editor.prosemirrorState.doc;
    const revision = current.runtime.revision();
    const peer = new Y.Doc();
    docs.push(peer);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const records = readDocumentBodyRecords(peer);
    if (records.status !== 'ready') throw new Error('The original cache source is incomplete');
    const source = records.body.sources.keys().next().value;
    if (source === undefined) throw new Error('The initial native source is missing');
    registerDocumentBodyRecords(peer, { contexts: [{ id: 'peer-context', dependencies: [] }] });
    documentBodySource(peer, source).insert(1, 'P', { ctx: 'peer-context' });
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'peer'));
    expect(documentBodySource(doc, source).toString()).toBe('P');
    expect(current.runtime.revision()).toBe(revision + 1);
    expect(current.runtime.read().status).toBe('failed');
    expect(handle.editor.prosemirrorState.doc).toBe(lastGood);
  });

  it('accepts a new edit after eviction and reopening over the same surviving source', () => {
    const { doc, inputs } = fixture();
    const first = getDocumentEditor(doc, NAME, inputs);
    show(first);
    act(() => first.editor.prosemirrorView.dispatch(first.editor.prosemirrorState.tr.insertText('A', 3)));
    expect(first.editor.prosemirrorState.doc.textContent).toBe('A');
    const before = readBodyTree(doc);
    if (before.status !== 'ready') throw new Error('The accepted first input must be native');
    const original = before.view.owners.flatMap((owner) => owner.units.map((unit) => unit.id));
    act(() => evictDocumentEditor(NAME));
    const next = getDocumentEditor(doc, NAME, inputs);
    show(next);
    act(() => next.editor.prosemirrorView.dispatch(next.editor.prosemirrorState.tr.insertText('B', 4)));
    expect(next.editor.prosemirrorState.doc.textContent).toBe('AB');
    expect(binding(next).runtime.read().status).toBe('active');
    const after = readBodyTree(doc);
    if (after.status !== 'ready') throw new Error('Reopened input must be native');
    const units = after.view.owners.flatMap((owner) => owner.units);
    expect(units.map((unit) => unit.value).join('')).toBe('AB');
    expect(units.filter((unit) => original.includes(unit.id)).map((unit) => unit.id)).toEqual(original);
    expect(next.undoManager.undoStack).toHaveLength(1);
    act(() => { next.editor.undo(); });
    expect(next.editor.prosemirrorState.doc.textContent).toBe('A');
    act(() => { next.editor.redo(); });
    expect(next.editor.prosemirrorState.doc.textContent).toBe('AB');
  });
});
