// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { encodeInitialSpaceContent } from '@breatic/shared';
import { Awareness } from 'y-protocols/awareness';

import { captionDraftsFor, createCaptionDrafts } from '@web/spaces/document/document-caption-drafts';
import { evictDocumentEditor, getDocumentEditor } from '@web/spaces/document/document-editor-cache';

describe('document caption drafts', () => {
  const context = { caption: 'Shared A', readOnly: false, exists: true };

  it.each([false, true])('opens from the current shared caption with readOnly=%s', (readOnly) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context, readOnly });
    expect(drafts.get('video')).toMatchObject({
      blockId: 'video', phase: readOnly ? 'suspended' : 'editing',
      base: 'Shared A', value: 'Shared A', shared: 'Shared A', dirty: false, composing: false,
    });
    expect(drafts.get('video')).toBe(drafts.get('video'));
    expect(drafts.all()).toBe(drafts.all());
  });

  it.each([false, true])('adopts a shared change in a clean draft with readOnly=%s', (readOnly) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context, readOnly });
    drafts.event('video', { type: 'sync', ...context, readOnly, caption: 'Shared B' });
    expect(drafts.get('video')).toMatchObject({ base: 'Shared B', value: 'Shared B', dirty: false });
    const write = vi.fn();
    drafts.event('video', { type: 'commit', ...context, readOnly, caption: 'Shared B', session: drafts.get('video')!.session, write });
    expect(write).not.toHaveBeenCalled();
    expect(drafts.get('video')!.phase).toBe(readOnly ? 'suspended' : 'closed');
  });

  it.each([false, true])('retains the editing baseline across a shared change with readOnly=%s', (readOnly) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'input', session, value: 'Local draft' });
    drafts.event('video', { type: 'sync', ...context, caption: 'Shared B', readOnly });
    expect(drafts.get('video')).toMatchObject({ base: 'Shared A', value: 'Local draft', shared: 'Shared B', dirty: true });
    drafts.event('video', { type: 'cancel', session, caption: 'Shared B' });
    expect(drafts.get('video')).toMatchObject({ phase: 'closed', base: 'Shared B', value: 'Shared B', dirty: false });
  });

  it('uses the latest shared value when an unchanged draft closes', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'input', session, value: 'Changed locally' });
    drafts.event('video', { type: 'sync', ...context, caption: 'Shared B' });
    drafts.event('video', { type: 'input', session, value: 'Shared A' });
    const write = vi.fn();
    drafts.event('video', { type: 'commit', ...context, caption: 'Shared B', session, write });
    expect(write).not.toHaveBeenCalled();
    expect(drafts.get('video')).toMatchObject({ phase: 'closed', base: 'Shared B', value: 'Shared B', dirty: false });
  });

  it('follows shared captions while closed and opens with the latest baseline', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'sync', ...context });
    drafts.event('video', { type: 'sync', ...context, caption: 'Shared B' });
    expect(drafts.get('video')).toMatchObject({ phase: 'closed', base: 'Shared B', value: 'Shared B', dirty: false });
    drafts.event('video', { type: 'open', ...context, caption: 'Shared C' });
    expect(drafts.get('video')).toMatchObject({ phase: 'editing', base: 'Shared C', value: 'Shared C', dirty: false });
  });

  it('rejects input and commit from an explicitly cancelled session after reopening', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'input', session, value: 'Discarded' });
    drafts.event('video', { type: 'cancel', session, caption: 'Shared B' });
    drafts.event('video', { type: 'open', ...context, caption: 'Shared B' });
    const reopened = drafts.get('video');
    const write = vi.fn();
    drafts.event('video', { type: 'input', session, value: 'Late discarded text' });
    drafts.event('video', { type: 'commit', ...context, session, write });
    expect(drafts.get('video')).toBe(reopened);
    expect(write).not.toHaveBeenCalled();
    expect(reopened).toMatchObject({ phase: 'editing', value: 'Shared B', base: 'Shared B', dirty: false });
  });

  it.each([false, true])('defers shared updates during composition, localChange=%s', (changed) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'composition-start', session, value: 'Shared A' });
    drafts.event('video', { type: 'sync', ...context, caption: 'Shared B' });
    expect(drafts.get('video')).toMatchObject({ base: 'Shared A', value: 'Shared A', composing: true });
    drafts.event('video', { type: 'composition-end', session, value: changed ? 'Composed text' : 'Shared A' });
    expect(drafts.get('video')).toMatchObject({
      composing: false, base: changed ? 'Shared A' : 'Shared B',
      value: changed ? 'Composed text' : 'Shared B', dirty: changed,
    });
  });

  it('preserves composition and local text while permission is revoked and restored', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'composition-start', session, value: 'Pending' });
    drafts.event('video', { type: 'sync', ...context, readOnly: true });
    const write = vi.fn();
    drafts.event('video', { type: 'commit', ...context, readOnly: true, session, write });
    drafts.event('video', { type: 'cancel', session, caption: 'Shared A' });
    expect(drafts.get('video')).toMatchObject({ phase: 'suspended', value: 'Pending', composing: true, session });
    drafts.event('video', { type: 'composition-end', session, value: 'Completed' });
    drafts.event('video', { type: 'sync', ...context });
    drafts.event('video', { type: 'commit', ...context, session, write });
    expect(write).toHaveBeenCalledExactlyOnceWith('Completed');
    expect(drafts.get('video')).toMatchObject({ phase: 'closed', base: 'Completed', value: 'Completed', composing: false, dirty: false });
  });

  it.each([
    { readOnly: true, exists: true, phase: 'suspended' },
    { readOnly: false, exists: false, phase: 'retained' },
  ])('reads current permission and target presence on a late commit: $phase', ({ readOnly, exists, phase }) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'input', session, value: 'Local draft' });
    const write = vi.fn();
    drafts.event('video', { type: 'commit', ...context, readOnly, exists, session, write });
    expect(write).not.toHaveBeenCalled();
    expect(drafts.get('video')).toMatchObject({ phase, value: 'Local draft', base: 'Shared A', dirty: true });
  });

  it('keeps an editable composing draft open on commit', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'composition-start', session, value: 'Composing' });
    const write = vi.fn();
    drafts.event('video', { type: 'commit', ...context, session, write });
    expect(write).not.toHaveBeenCalled();
    expect(drafts.get('video')).toMatchObject({ phase: 'editing', value: 'Composing', composing: true });
  });

  it('keeps the original draft if the shared writer throws', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'input', session, value: 'Unsaved' });
    const before = drafts.get('video');
    expect(() => drafts.event('video', { type: 'commit', ...context, session, write: () => { throw new Error('write failed'); } })).toThrow('write failed');
    expect(drafts.get('video')).toBe(before);
  });

  it.each([false, true])('retains a deleted target and restores the same id with readOnly=%s', (readOnly) => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'composition-start', session, value: 'Local draft' });
    drafts.event('video', { type: 'sync', ...context, exists: false });
    expect(drafts.get('video')).toMatchObject({ phase: 'retained', value: 'Local draft', composing: false });
    drafts.event('video', { type: 'composition-end', session, value: 'Late event' });
    drafts.event('video', { type: 'sync', ...context, caption: 'Shared B', readOnly });
    expect(drafts.get('video')).toMatchObject({ phase: readOnly ? 'suspended' : 'editing', value: 'Local draft', base: 'Shared A', shared: 'Shared B', dirty: true });
    expect(drafts.all().map((draft) => draft.blockId)).toEqual(['video']);
  });

  it('preserves the current DOM value across detachment and rejects old-session events', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    const session = drafts.get('video')!.session;
    drafts.event('video', { type: 'composition-start', session, value: 'Earlier' });
    drafts.event('video', { type: 'detach', session, value: 'Final DOM value' });
    const detached = drafts.get('video');
    expect(detached).toMatchObject({ phase: 'editing', value: 'Final DOM value', composing: false });
    const write = vi.fn();
    drafts.event('video', { type: 'input', session, value: 'Stale input' });
    drafts.event('video', { type: 'composition-end', session, value: 'Stale composition' });
    drafts.event('video', { type: 'commit', ...context, session, write });
    expect(drafts.get('video')).toBe(detached);
    expect(write).not.toHaveBeenCalled();
    drafts.event('video', { type: 'commit', ...context, session: detached!.session, write });
    expect(write).toHaveBeenCalledExactlyOnceWith('Final DOM value');
  });

  it('isolates blocks and publishes stable snapshots only when state changes', () => {
    const drafts = createCaptionDrafts();
    const heard = vi.fn();
    const unsubscribe = drafts.subscribe(heard);
    drafts.event('video', { type: 'open', ...context });
    const snapshot = drafts.all();
    drafts.event('video', { type: 'sync', ...context });
    expect(drafts.all()).toBe(snapshot);
    expect(heard).toHaveBeenCalledTimes(1);
    drafts.event('audio', { type: 'open', ...context, caption: 'Audio' });
    expect(drafts.get('video')!.value).toBe('Shared A');
    expect(drafts.get('audio')!.value).toBe('Audio');
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
    drafts.event('audio', { type: 'input', session: drafts.get('audio')!.session, value: 'New audio' });
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('ignores local events for unknown or closed inputs', () => {
    const drafts = createCaptionDrafts();
    drafts.event('unknown', { type: 'input', session: 0, value: 'Stale' });
    expect(drafts.all()).toEqual([]);
    drafts.event('video', { type: 'sync', ...context });
    const before = drafts.get('video');
    const write = vi.fn();
    drafts.event('video', { type: 'input', session: 0, value: 'Stale' });
    drafts.event('video', { type: 'commit', ...context, session: 0, write });
    expect(drafts.get('video')).toBe(before);
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects events after disposal and releases retained text', () => {
    const drafts = createCaptionDrafts();
    drafts.event('video', { type: 'open', ...context });
    drafts.event('video', { type: 'input', session: drafts.get('video')!.session, value: 'Local' });
    drafts.dispose();
    const empty = drafts.all();
    drafts.event('video', { type: 'open', ...context });
    expect(drafts.get('video')).toBeUndefined();
    expect(drafts.all()).toBe(empty);
    expect(empty).toEqual([]);
  });

  it('shares one store for an editor and gives a different editor its own store', () => {
    const editor = {};
    expect(captionDraftsFor(editor)).toBe(captionDraftsFor(editor));
    expect(captionDraftsFor({})).not.toBe(captionDraftsFor(editor));
  });

  it('releases the handle-owned draft store when the document editor is evicted', () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    const awareness = new Awareness(doc);
    const handle = getDocumentEditor(doc, 'caption-cache', { caretProvider: { awareness }, readWho: () => ({ role: 'editor', viewerId: 'u1' }), editable: true });
    try {
      expect(handle.captionDrafts).toBe(captionDraftsFor(handle.editor));
      handle.captionDrafts.event('video', { type: 'open', ...context });
      evictDocumentEditor('caption-cache');
      expect(handle.captionDrafts.all()).toEqual([]);
    } finally {
      evictDocumentEditor('caption-cache');
      awareness.destroy();
      doc.destroy();
    }
  });

  it('never creates a local modification from shared updates alone', () => {
    fc.assert(fc.property(fc.string(), fc.array(fc.tuple(fc.string(), fc.boolean()), { minLength: 1, maxLength: 12 }), (initial, updates) => {
      const drafts = createCaptionDrafts();
      drafts.event('video', { type: 'open', ...context, caption: initial });
      for (const [caption, readOnly] of updates) {
        drafts.event('video', { type: 'sync', ...context, caption, readOnly });
        expect(drafts.get('video')).toMatchObject({ base: caption, value: caption, dirty: false });
      }
      drafts.dispose();
    }), { seed: 1619, numRuns: 100 });
  });

  it('preserves a local baseline through shared, role and target changes', () => {
    fc.assert(fc.property(fc.string(), fc.array(fc.tuple(fc.string(), fc.boolean(), fc.boolean()), { minLength: 1, maxLength: 12 }), (initial, updates) => {
      const drafts = createCaptionDrafts();
      drafts.event('video', { type: 'open', ...context, caption: initial });
      drafts.event('video', { type: 'input', session: drafts.get('video')!.session, value: `${initial} local` });
      for (const [caption, readOnly, exists] of updates) {
        drafts.event('video', { type: 'sync', caption, readOnly, exists });
        expect(drafts.get('video')).toMatchObject({ base: initial, value: `${initial} local`, shared: caption, dirty: true });
      }
      drafts.dispose();
    }), { seed: 1620, numRuns: 100 });
  });
});
