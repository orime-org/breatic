// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { act } from '@testing-library/react';
import { captureException } from '@sentry/react';
import type * as SentryModule from '@sentry/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { documentBodyFragment, documentBodyRecords, documentBodySource, readBodyTree, registerDocumentBodyRecords } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import type { DocumentBodyBindingAccess } from '@web/spaces/document/document-body-binding-types';
import type { BodyProjection } from '@web/spaces/document/document-body-codec-types';
import { createDocumentBodyRuntime } from '@web/spaces/document/document-body-runtime';
import { createDocumentUndo } from '@web/spaces/document/document-undo-blocknote';
import { cleanupCodecFixtures, codecDoc, codecFixture } from '@web/spaces/document/__tests__/document-body-codec-fixtures';

vi.mock('@sentry/react', async (original) => ({
  ...await original<typeof SentryModule>(),
  captureException: vi.fn(() => 'body-event-id'),
}));

beforeEach(() => vi.clearAllMocks());

/** Real resources retain the same document lifetime as the production handle. */
interface Client {
  readonly doc: Y.Doc;
  readonly editor: ReturnType<typeof buildDocumentEditor>;
  readonly binding: DocumentBodyBindingAccess;
  readonly manager: Y.UndoManager;
  readonly origin: object;
  readonly host: HTMLElement;
}

const clients: Client[] = [];

/** Mounts the real records binding and native history on the independent AB fixture. */
function open(): Client {
  const doc = codecFixture([{ id: 'A', text: 'AB' }]);
  const runtime = createDocumentBodyRuntime(doc, () => undefined);
  const origin = {};
  const history = createDocumentUndo(doc, { runtime, origin });
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc),
    body: { document: 'document:failure-contract', runtime, history: history.manager, origin }, extensions: [history.extension] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => editor.mount(host));
  const binding = bodyBindingOf(editor.prosemirrorState);
  if (binding === null) throw new Error('Missing actual records binding');
  const client = { doc, editor, binding, manager: history.manager, origin, host };
  clients.push(client);
  return client;
}

/** Reads actual visible source characters independently of the editor's retained view. */
function sourceText(doc: Y.Doc): string {
  const result = readBodyTree(doc);
  if (result.status !== 'ready') throw new Error('Expected complete actual source');
  return result.view.owners.flatMap((owner) => owner.units.map((unit) => unit.value)).join('');
}

afterEach(() => {
  act(() => {
    for (const client of clients.splice(0)) {
      client.binding.dispose();
      client.manager.destroy();
      client.editor.unmount();
      client.host.remove();
    }
    cleanupCodecFixtures();
  });
});

describe('actual body binding failure and dependency contracts', () => {
  it('isolates a throwing error reporter and preserves the original failure and ongoing source updates', () => {
    const client = open();
    const error = new Error('native writer observer failure');
    const reportingError = new Error('error reporter failure');
    vi.mocked(captureException).mockImplementationOnce(() => { throw reportingError; });
    const enabled = documentBodyRecords(client.doc).enabled;
    /** Throws after USER changes the source, before the binding observes completion. */
    const fail = (): void => { throw error; };
    enabled.observe(fail);
    try {
      expect(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('X', 4))).not.toThrow();
    } finally {
      enabled.unobserve(fail);
    }
    expect(client.binding.runtime.read().failure?.error).toBe(error);
    expect(client.binding.runtime.read().status).toBe('failed');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(sourceText(client.doc)).toBe('AXB');
    const peer = codecDoc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(client.doc));
    documentBodySource(peer, 'S:A').insert(1, 'P', { ctx: 'base' });
    Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(peer));
    expect(sourceText(client.doc)).toBe('PAXB');
    expect(client.binding.runtime.read().failure?.error).toBe(error);
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
  });

  it('retains accepted input and last good state when a real registration observer throws before USER', () => {
    const client = open();
    const before = client.binding.read();
    const error = new Error('registration observer failure');
    let userUpdates = 0;
    /** Throws at the actual REG update while still observing actual user writes. */
    const fail = (_bytes: Uint8Array, origin: unknown): void => {
      if (origin === client.origin) userUpdates += 1;
      if (client.binding.phase() === 'registering') throw error;
    };
    client.doc.on('update', fail);
    try {
      act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('X', 4)));
    } finally {
      client.doc.off('update', fail);
    }
    const snapshot = client.binding.runtime.read();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toMatchObject({ error, phase: 'registering', writeStarted: false, writeReturned: false });
    expect(captureException).toHaveBeenCalledExactlyOnceWith(error, {
      tags: { error_boundary: 'document-body', phase: 'registering' },
      extra: { document: 'document:failure-contract', batch: snapshot.failure!.batch, epoch: snapshot.failure!.epoch,
        writeStarted: false, writeReturned: false },
    });
    expect((snapshot.failure!.accepted as PMNode).textContent).toBe('AXB');
    const retained = snapshot.failure!.lastGood as BodyProjection;
    expect(retained.doc).toBe(before.doc);
    expect(retained.index.doc).toBe(before.index.doc);
    expect(retained.index.nodes).toBe(before.index.nodes);
    expect(retained.units).toBe(before.units);
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
    expect(sourceText(client.doc)).toBe('AB');
    expect(userUpdates).toBe(0);
    expect(client.manager.undoStack).toHaveLength(0);
    expect(client.binding.canWrite()).toBe(false);
    const bytes = Y.encodeStateAsUpdate(client.doc);
    act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('REJECTED', 3)));
    expect(Y.encodeStateAsUpdate(client.doc)).toEqual(bytes);
    expect(client.binding.runtime.read().failure).toBe(snapshot.failure);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('records truthful source writes after a USER observer throws and keeps emitting peer source updates', () => {
    const client = open();
    const before = client.binding.read();
    const error = new Error('user observer failure');
    let sourceEvents = 0;
    /** Counts actual source update notifications even when the display is paused. */
    const sourceUpdated = (): void => { sourceEvents += 1; };
    /** Fails only after the actual native USER has changed the source. */
    const fail = (_event: Y.YMapEvent<boolean>, transaction: Y.Transaction): void => { if (transaction.origin === client.origin) throw error; };
    client.doc.on('update', sourceUpdated);
    const enabled = documentBodyRecords(client.doc).enabled;
    enabled.observe(fail);
    try {
      act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('X', 4)));
    } finally {
      enabled.unobserve(fail);
    }
    const snapshot = client.binding.runtime.read();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toMatchObject({ error, phase: 'committing', writeStarted: true, writeReturned: false });
    expect((snapshot.failure!.accepted as PMNode).textContent).toBe('AXB');
    const retained = snapshot.failure!.lastGood as BodyProjection;
    expect(retained.doc).toBe(before.doc);
    expect(retained.index.doc).toBe(before.index.doc);
    expect(retained.index.nodes).toBe(before.index.nodes);
    expect(retained.units).toBe(before.units);
    expect(sourceText(client.doc)).toBe('AXB');
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
    const peer = codecDoc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(client.doc));
    expect(sourceText(peer)).toBe('AXB');
    documentBodySource(peer, 'S:A').insert(1, 'P', { ctx: 'base' });
    const eventsBeforePeer = sourceEvents;
    act(() => Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(peer), 'peer'));
    expect(sourceText(client.doc)).toBe('PAXB');
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
    expect(sourceEvents).toBe(eventsBeforePeer + 1);
    expect(client.binding.runtime.read().failure).toBe(snapshot.failure);
    const reopenedSource = codecDoc();
    Y.applyUpdate(reopenedSource, Y.encodeStateAsUpdate(client.doc));
    expect(sourceText(reopenedSource)).toBe('PAXB');
    client.doc.off('update', sourceUpdated);
  });

  it('retains already published source truth when a final applied listener fails', () => {
    const client = open();
    const error = new Error('applied consumer failure');
    const stop = client.binding.subscribeApplied(() => { throw error; });
    try {
      act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('X', 4)));
    } finally {
      stop();
    }
    const snapshot = client.binding.runtime.read();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toMatchObject({ error, phase: 'projecting', writeStarted: true, writeReturned: true });
    expect((snapshot.failure!.accepted as PMNode).textContent).toBe('AXB');
    expect(sourceText(client.doc)).toBe('AXB');
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AXB');
    expect(client.manager.undoStack).toHaveLength(1);
    expect(client.editor.undo()).toBe(false);
    expect(sourceText(client.doc)).toBe('AXB');
  });

  it('holds the exact last good index until a real missing dependency arrives', () => {
    const client = open();
    const before = client.binding.read();
    const peer = codecDoc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(client.doc));
    documentBodySource(peer, 'S:A').insert(1, 'P', { ctx: 'later' });
    act(() => Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(peer), 'peer'));
    expect(client.binding.runtime.read()).toMatchObject({ status: 'waiting', missing: ['context:later'] });
    expect(client.binding.read()).toBe(before);
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
    expect(client.editor.isEditable).toBe(false);
    const pendingBytes = Y.encodeStateAsUpdate(client.doc);
    act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('REJECTED', 3)));
    expect(Y.encodeStateAsUpdate(client.doc)).toEqual(pendingBytes);
    registerDocumentBodyRecords(peer, { contexts: [{ id: 'later', dependencies: [] }] });
    act(() => Y.applyUpdate(client.doc, Y.encodeStateAsUpdate(peer), 'peer'));
    expect(client.binding.runtime.read().status).toBe('active');
    expect(client.editor.prosemirrorState.doc.textContent).toBe('PAB');
    expect(sourceText(client.doc)).toBe('PAB');
    expect(client.binding.read().index.doc).toBe(client.editor.prosemirrorState.doc);
    expect(client.binding.canWrite()).toBe(true);
    expect(client.manager.undoStack).toHaveLength(0);
  });

  it('rechecks current permission after actual registration without writing USER', () => {
    const client = open();
    let userUpdates = 0;
    /** Changes the real editor preference after zero-effect registration. */
    const revoke = (_bytes: Uint8Array, origin: unknown): void => {
      if (origin === client.origin) userUpdates += 1;
      if (client.binding.phase() === 'registering') client.editor.isEditable = false;
    };
    client.doc.on('update', revoke);
    try {
      act(() => client.editor.prosemirrorView.dispatch(client.editor.prosemirrorState.tr.insertText('X', 4)));
    } finally {
      client.doc.off('update', revoke);
    }
    const snapshot = client.binding.runtime.read();
    expect(snapshot.status).toBe('failed');
    expect(snapshot.failure).toMatchObject({ writeStarted: false, writeReturned: false });
    expect((snapshot.failure!.accepted as PMNode).textContent).toBe('AXB');
    expect(sourceText(client.doc)).toBe('AB');
    expect(client.editor.prosemirrorState.doc.textContent).toBe('AB');
    expect(userUpdates).toBe(0);
    expect(client.manager.undoStack).toHaveLength(0);
  });
});
