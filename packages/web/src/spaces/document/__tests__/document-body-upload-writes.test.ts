// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { encodeInitialSpaceContent, readBodyTree } from '@breatic/shared/document-body';

import type { StoredUpload } from '@web/data/upload/media-upload';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { _resetDocumentEditorCacheForTests, adoptDocumentEditor, evictDocumentEditor, getDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { createDocumentUploader, type DocumentUploaderDeps } from '@web/spaces/document/document-uploads';
import { uploadSlots } from '@web/spaces/document/document-upload-slots';

const docs: Y.Doc[] = [];
const cursors: Awareness[] = [];
const hosts: HTMLElement[] = [];
const STATES = ['waiting', 'failed', 'disposed'] as const;
type State = typeof STATES[number];

/** Mounts the actual upload owner so successful writes pass through the real view update. */
function mount(handle: DocumentEditorHandle): void {
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  act(() => adoptDocumentEditor(handle, host));
}

/** Opens the production records factory with its actual upload slot plugin. */
function open(): { doc: Y.Doc; handle: DocumentEditorHandle; name: string } {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const awareness = new Awareness(doc);
  cursors.push(awareness);
  const name = `document:upload-${docs.length}`;
  const handle = getDocumentEditor(doc, name, {
    caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
  });
  return { doc, handle, name };
}

/** Pauses only the runtime so readonly presentation cannot stand in for final admission. */
function pause(handle: DocumentEditorHandle, state: State): void {
  const binding = bodyBindingOf(handle.editor.prosemirrorState);
  if (binding === null) throw new Error('Missing actual records binding');
  if (state === 'waiting') handle.runtime.wait(['context:later']);
  else if (state === 'disposed') handle.runtime.dispose();
  else handle.runtime.fail({ phase: 'idle', error: new Error('upload failure'), batch: null,
    epoch: binding.read().epoch, accepted: binding.read().doc, selection: null, journal: null,
    lastGood: binding.read(), writeStarted: false, writeReturned: false });
}

/** Builds actual uploader dependencies with explicit deferred network completion. */
function dependencies(): { deps: DocumentUploaderDeps; finish: (stored: StoredUpload) => void; fail: (error: unknown) => void } {
  let finish: (stored: StoredUpload) => void = () => { throw new Error('Upload has not started'); };
  let fail: (error: unknown) => void = () => { throw new Error('Upload has not started'); };
  const deps: DocumentUploaderDeps = {
    maxUploadBytes: () => Promise.resolve(Infinity),
    upload: vi.fn(() => new Promise<StoredUpload>((resolve, reject) => { finish = resolve; fail = reject; })),
    register: vi.fn(), unregister: vi.fn(), refuse: vi.fn(), undo: { stopCapturing: vi.fn() },
  };
  return { deps, finish: (stored) => finish(stored), fail: (error) => fail(error) };
}

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  cursors.splice(0).forEach((awareness) => awareness.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
  hosts.splice(0).forEach((host) => host.remove());
});

describe('actual uploader await and final writer admission', () => {
  it.each(['registering', 'committing', 'projecting'] as const)('keeps the existing upload slot and file when its actual insertion fails while %s', async (phase) => {
    const { doc, handle } = open();
    mount(handle);
    const { deps, finish } = dependencies();
    const uploader = createDocumentUploader({ ...deps, undo: handle.undoManager });
    const view = handle.editor.prosemirrorView;
    const file = new File(['original bytes'], 'original.png', { type: 'image/png' });
    await act(async () => uploader.start(view, [file], () => 1, false));
    const slot = uploadSlots(view.state)[0];
    expect(slot).toMatchObject({ name: file.name, phase: 'uploading', blockId: null });
    expect(deps.upload).toHaveBeenCalledExactlyOnceWith(file, expect.any(Function));
    const binding = bodyBindingOf(view.state)!;
    const error = new Error(`Upload ${phase} failed`);
    /** Throws at an actual source phase after its genuine mutation boundary. */
    const fail = (): void => { if (binding.phase() === phase) throw error; };
    if (phase !== 'projecting') doc.on('update', fail);
    const stop = phase === 'projecting' ? binding.subscribeApplied(() => { throw error; }) : (): void => undefined;
    try {
      await act(async () => {
        finish({ assetId: 'stored-image', fileUrl: 'https://example.com/original.png', kind: 'image', width: null, height: null });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    } finally {
      doc.off('update', fail);
      stop();
    }
    expect(handle.runtime.read().status).toBe('failed');
    expect(handle.runtime.read().failure).toMatchObject({ error, phase });
    expect(uploadSlots(view.state)).toEqual([expect.objectContaining({ id: slot.id, name: file.name, phase: 'failed', blockId: null })]);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(slot.id);
    expect(deps.unregister).toHaveBeenCalledExactlyOnceWith(slot.id);
    const source = readBodyTree(doc);
    expect(source.status).toBe('ready');
    if (source.status !== 'ready') throw new Error('Expected complete current upload source');
    expect(source.view.owners.filter((owner) => owner.type === 'image').map((owner) => owner.attrs['url'])).toEqual(phase === 'registering' ? [] : ['https://example.com/original.png']);
    uploader.retry(view, slot.id);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.upload).mock.calls[0][0]).toBe(file);
    const bytes = Y.encodeStateAsUpdate(doc);
    act(() => uploader.remove(view, slot.id));
    expect(uploadSlots(view.state)).toEqual([]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(bytes);
    expect(deps.unregister).toHaveBeenCalledTimes(1);
  });

  it('consumes the original upload slot after one successful native write and preserves one undo redo', async () => {
    const { doc, handle } = open();
    mount(handle);
    const { deps, finish } = dependencies();
    const uploader = createDocumentUploader({ ...deps, undo: handle.undoManager });
    const view = handle.editor.prosemirrorView;
    const file = new File(['original bytes'], 'original.png', { type: 'image/png' });
    await act(async () => uploader.start(view, [file], () => 1, false));
    const slot = uploadSlots(view.state)[0];
    const before = view.state.doc.toJSON();
    await act(async () => {
      finish({ assetId: 'stored-image', fileUrl: 'https://example.com/original.png', kind: 'image', width: 320, height: 180 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(handle.runtime.read().status).toBe('active');
    expect(uploadSlots(view.state)).toEqual([]);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(slot.id);
    expect(deps.unregister).toHaveBeenCalledExactlyOnceWith(slot.id);
    const source = readBodyTree(doc);
    expect(source.status).toBe('ready');
    if (source.status !== 'ready') throw new Error('Expected complete current upload source');
    expect(source.view.owners.filter((owner) => owner.type === 'image').map((owner) => ({ url: owner.attrs['url'], name: owner.attrs['name'] }))).toEqual([{ url: 'https://example.com/original.png', name: file.name }]);
    const after = view.state.doc.toJSON();
    expect(handle.undoManager.undoStack).toHaveLength(1);
    act(() => { handle.undoManager.undo(); });
    expect(view.state.doc.toJSON()).toEqual(before);
    act(() => { handle.undoManager.redo(); });
    expect(view.state.doc.toJSON()).toEqual(after);
    expect(uploadSlots(view.state)).toEqual([]);
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('cleans up once without dispatching to a closed view when its network result is %s', async (ending) => {
    const { doc, handle, name } = open();
    const host = document.createElement('div');
    document.body.append(host);
    adoptDocumentEditor(handle, host);
    const { deps, finish, fail } = dependencies();
    const uploader = createDocumentUploader(deps);
    const view = handle.editor.prosemirrorView;
    await uploader.start(view, [new File(['data'], 'image.png', { type: 'image/png' })], () => 1, false);
    const slot = uploadSlots(view.state)[0];
    evictDocumentEditor(name);
    expect(view.isDestroyed).toBe(true);
    const dispatch = vi.spyOn(view, 'dispatch');
    const nextDoc = new Y.Doc();
    docs.push(nextDoc);
    Y.applyUpdate(nextDoc, encodeInitialSpaceContent('document'));
    const cursor = new Awareness(nextDoc);
    cursors.push(cursor);
    const next = getDocumentEditor(nextDoc, name, {
      caretProvider: { awareness: cursor }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
    });
    expect(next.runtime.incarnation).not.toBe(handle.runtime.incarnation);
    const before = Y.encodeStateAsUpdate(doc);
    const nextBefore = Y.encodeStateAsUpdate(nextDoc);
    try {
      if (ending === 'resolve') finish({ assetId: 'stored-image', fileUrl: 'https://example.com/stored.png', kind: 'image', width: null, height: null });
      else fail(new Error('old network request failed'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatch).not.toHaveBeenCalled();
      expect(deps.register).toHaveBeenCalledExactlyOnceWith(slot.id);
      expect(deps.unregister).toHaveBeenCalledExactlyOnceWith(slot.id);
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(Y.encodeStateAsUpdate(nextDoc)).toEqual(nextBefore);
      expect(next.runtime.read().status).toBe('active');
    } finally {
      dispatch.mockRestore();
      host.remove();
    }
  });

  it.each(STATES)('does not make a gap, slot or network upload after config returns to %s', async (state) => {
    const { doc, handle } = open();
    const { deps } = dependencies();
    let finishConfig: (bytes: number) => void = () => { throw new Error('Config has not started'); };
    const uploader = createDocumentUploader({ ...deps, maxUploadBytes: () => new Promise<number>((resolve) => { finishConfig = resolve; }) });
    const view = handle.editor.prosemirrorView;
    const place = vi.fn(() => 1);
    const start = uploader.start(view, [new File(['data'], 'image.png', { type: 'image/png' })], place, false);
    pause(handle, state);
    const before = Y.encodeStateAsUpdate(doc);
    finishConfig(Infinity);
    await start;
    expect(place).not.toHaveBeenCalled();
    expect(uploadSlots(view.state)).toEqual([]);
    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.unregister).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each(STATES)('keeps the file and slot without a shared block after network completion in %s', async (state) => {
    const { doc, handle } = open();
    const { deps, finish } = dependencies();
    const uploader = createDocumentUploader(deps);
    const view = handle.editor.prosemirrorView;
    const file = new File(['data'], 'image.png', { type: 'image/png' });
    await uploader.start(view, [file], () => 1, false);
    const slot = uploadSlots(view.state)[0];
    expect(slot).toMatchObject({ name: 'image.png', phase: 'uploading' });
    pause(handle, state);
    const before = Y.encodeStateAsUpdate(doc);
    finish({ assetId: 'stored-image', fileUrl: 'https://example.com/stored.png', kind: 'image', width: null, height: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(uploadSlots(view.state)[0]).toMatchObject({ id: slot.id, phase: 'failed', blockId: null });
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(slot.id);
    expect(deps.unregister).toHaveBeenCalledExactlyOnceWith(slot.id);
    uploader.retry(view, slot.id);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    if (state === 'waiting') {
      handle.runtime.resume();
      uploader.retry(view, slot.id);
      expect(deps.upload).toHaveBeenCalledTimes(2);
      expect(vi.mocked(deps.upload).mock.calls[1][0]).toBe(file);
    }
  });
});
