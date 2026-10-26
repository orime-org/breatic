// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';

import type { StoredUpload } from '@web/data/upload/media-upload';
import { bodyBindingOf } from '@web/spaces/document/document-body-binding-key';
import { _resetDocumentEditorCacheForTests, getDocumentEditor, type DocumentEditorHandle } from '@web/spaces/document/document-editor-cache';
import { createDocumentUploader, type DocumentUploaderDeps } from '@web/spaces/document/document-uploads';
import { uploadSlots } from '@web/spaces/document/document-upload-slots';

const docs: Y.Doc[] = [];
const cursors: Awareness[] = [];
const STATES = ['waiting', 'failed', 'disposed'] as const;
type State = typeof STATES[number];

/** Opens the production records factory with its actual upload slot plugin. */
function open(): { doc: Y.Doc; handle: DocumentEditorHandle } {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  const awareness = new Awareness(doc);
  cursors.push(awareness);
  const handle = getDocumentEditor(doc, `document:upload-${docs.length}`, {
    caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true,
  });
  return { doc, handle };
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
function dependencies(): { deps: DocumentUploaderDeps; finish: (stored: StoredUpload) => void } {
  let finish: (stored: StoredUpload) => void = () => { throw new Error('Upload has not started'); };
  const deps: DocumentUploaderDeps = {
    maxUploadBytes: () => Promise.resolve(Infinity),
    upload: vi.fn(() => new Promise<StoredUpload>((resolve) => { finish = resolve; })),
    register: vi.fn(), unregister: vi.fn(), refuse: vi.fn(), undo: { stopCapturing: vi.fn() },
  };
  return { deps, finish: (stored) => finish(stored) };
}

afterEach(() => {
  _resetDocumentEditorCacheForTests();
  cursors.splice(0).forEach((awareness) => awareness.destroy());
  docs.splice(0).forEach((doc) => doc.destroy());
});

describe('actual uploader await and final writer admission', () => {
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
