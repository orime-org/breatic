// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const { toast } = vi.hoisted(() => ({
  toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

vi.mock('@web/lib/toast', () => ({ toast }));
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@hocuspocus/provider', async (importOriginal) =>
  (await import('@web/data/yjs/__tests__/helpers/doc-size-driver')).mockProviderModule(await importOriginal()));

import { COLLAB_DOCUMENT_TOO_LARGE_REASON, COLLAB_REAUTH_REASONS, isReauthCloseReason } from '@breatic/shared';
import {
  latestProvider, push, refuse, resetProviderSpies, type ProviderSpy,
} from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { COPY_EN, F_FULL, F_WARNING } from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';
import { readDocSize } from '@web/data/yjs/doc-size';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { getCanvasUndoManager } from '@web/data/yjs/canvas-space';
import { getDoc, _resetForTests } from '@web/data/yjs/manager';
import { getTimelineMediaDraft } from '@web/spaces/timeline/timeline-media-draft';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = 'project-p1/canvas-s1';

/**
 * Opens a Space document the way a tab does.
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
function open(name = NAME): ProviderSpy {
  return acquireDocProvider(name, getDoc(name)) as unknown as ProviderSpy;
}

/**
 * Messages passed to toast.warning, in order.
 * @returns The first arguments.
 * @throws {never} Never.
 */
function warnings(): unknown[] {
  return toast.warning.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  changeLocale('en');
  resetProviderSpies();
  vi.clearAllMocks();
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('resetDocument after a size refusal (design 5.3)', () => {
  it('W-118 leaves providerMap before destroying the provider, so no CLOSE is sent', () => {
    const provider = open();
    expect(provider.configuration.websocketProvider.configuration.providerMap.has(NAME)).toBe(true);
    refuse(provider);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(provider.mappedAtDestroy).toEqual([false]);
  });

  it('W-119 destroys the old document and provider and leaves other documents alone', () => {
    const oldDoc = getDoc(NAME);
    const provider = open();
    const sibling = open('project-p1/canvas-s2');
    const meta = open('project-p1/meta');
    act(() => { oldDoc.getMap('nodesMap').set('bad', new Y.Map()); });
    refuse(provider);
    expect(oldDoc.isDestroyed).toBe(true);
    const fresh = getDoc(NAME);
    expect(fresh).not.toBe(oldDoc);
    expect(fresh.getMap('nodesMap').has('bad')).toBe(false);
    // The Space subtree mounts again and acquires the rebuilt document (step 4).
    acquireDocProvider(NAME, fresh);
    const next = latestProvider(NAME);
    expect(next).not.toBe(provider);
    expect(next.configuration.name).toBe(NAME);
    expect(next.document).toBe(fresh);
    expect(next.attach).toHaveBeenCalledTimes(1);
    expect(sibling.destroy).toHaveBeenCalledTimes(0);
    expect(meta.destroy).toHaveBeenCalledTimes(0);
  });

  it('W-121 sets resyncing and shows the resync toast once', () => {
    const provider = open();
    push(provider, F_FULL);
    refuse(provider);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    expect(warnings()).toEqual([COPY_EN.T_RESYNC]);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it.each([
    [COLLAB_REAUTH_REASONS.permissionChanged, 1],
    [COLLAB_REAUTH_REASONS.sessionEnded, 1],
    ['', 0],
    ['Forbidden', 0],
  ] as const)('W-122 a close for %j does not rebuild the document', (reason, reopened) => {
    const doc = getDoc(NAME);
    const provider = open();
    push(provider, F_WARNING);
    act(() => { provider.emit('close', { event: { code: 1000, reason } }); });
    expect(getDoc(NAME)).toBe(doc);
    expect(doc.isDestroyed).toBe(false);
    expect(provider.destroy).toHaveBeenCalledTimes(0);
    expect(readDocSize(NAME).phase).toBe('warning');
    expect(warnings().filter((message) => message === COPY_EN.T_RESYNC)).toHaveLength(0);
    expect(provider.onOpen).toHaveBeenCalledTimes(reopened);
  });

  it('W-122 the size refusal is not a re-authentication reason and does not reopen the provider', () => {
    expect(isReauthCloseReason(COLLAB_DOCUMENT_TOO_LARGE_REASON)).toBe(false);
    const provider = open();
    refuse(provider);
    expect(provider.onOpen).toHaveBeenCalledTimes(0);
  });

  it('W-123 the canvas undo stack goes with the old document', () => {
    const oldDoc = getDoc(NAME);
    const provider = open();
    const undo = getCanvasUndoManager(oldDoc, NAME);
    const origin = Symbol('test-undo');
    undo.addTrackedOrigin(origin);
    act(() => { oldDoc.transact(() => oldDoc.getMap('nodesMap').set('n1', new Y.Map()), origin); });
    expect(undo.undoStack).toHaveLength(1);
    refuse(provider);
    const fresh = getDoc(NAME);
    expect(getCanvasUndoManager(fresh, NAME).undoStack).toHaveLength(0);
  });

  it('W-123 the timeline material draft goes with the old document', () => {
    const name = 'project-p1/timeline-s3';
    const oldDoc = getDoc(name);
    const provider = open(name);
    const inputs = { projectId: 'p1', spaceId: 's3', queryClient: new QueryClient() };
    const draft = getTimelineMediaDraft(oldDoc, name, inputs);
    const initial = draft.getSnapshot();
    draft.setCanWrite(true);
    draft.open(0);
    expect(draft.getSnapshot().open).toBe(true);
    refuse(provider);
    const fresh = getDoc(name);
    expect(getTimelineMediaDraft(fresh, name, inputs).getSnapshot()).toEqual(initial);
    expect(initial.open).toBe(false);
  });
});
