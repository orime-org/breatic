// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap, second design (inner#1790), web test spec section
 * 15: `resetDocument` in `collab-socket.tsx` after collab refuses an update
 * (design 5.4). Y-03, the remount through `OpenSpace`, is in
 * `pages/project/__tests__/OpenSpace.size-reset.test.tsx`.
 */

import { act } from '@testing-library/react';
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
import { push, refuse, resetProviderSpies, type ProviderSpy } from '@web/data/yjs/__tests__/helpers/doc-size-driver';
import { COPY_V2_EN, P_FULL, P_WARNING } from '@web/data/yjs/__tests__/helpers/size-v2-fixtures';
import { MAIN, OFF, cid, clip, seededDoc, timeline, track } from '@web/data/yjs/__tests__/timeline-document-fixtures';
import { readDocSize } from '@web/data/yjs/doc-size';
import { acquireDocProvider, _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { CANVAS_UNDO, getCanvasUndoManager } from '@web/data/yjs/canvas-space';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { evictTimelineEditSession, getTimelineEditSession } from '@web/data/yjs/timeline-edit-session';
import { changeLocale } from '@web/i18n/locale-bootstrap';

const NAME = docName.canvasSpace('p1', 's1');
const EMPTY_STATE = Y.encodeStateAsUpdate(new Y.Doc());

/**
 * Opens a Space document the way a tab does (and the way a rebuilt Space remounts).
 * @param name - Canonical document name.
 * @returns The provider spy of the entry.
 * @throws {Error} When acquiring fails.
 */
function open(name = NAME): ProviderSpy {
  return acquireDocProvider(name, getDoc(name)) as unknown as ProviderSpy;
}

/**
 * Writes one local canvas node into the current document.
 * @param id - The node id.
 * @param name - Canonical document name.
 * @throws {never} Never.
 */
function writeLocalNode(id: string, name = NAME): void {
  const doc = getDoc(name);
  act(() => { doc.transact(() => doc.getMap('nodesMap').set(id, new Y.Map()), CANVAS_UNDO); });
}

/**
 * How many resync toasts were shown.
 * @returns The count.
 * @throws {never} Never.
 */
function resyncToasts(): number {
  return toast.warning.mock.calls.filter((call) => call[0] === COPY_V2_EN.T_RESYNC).length;
}

beforeEach(() => {
  changeLocale('en');
  resetProviderSpies();
  vi.clearAllMocks();
});

afterEach(() => {
  evictTimelineEditSession(docName.timelineSpace('p1', 's3'));
  _resetCollabSocketForTests();
  _resetForTests();
});

describe('resetDocument after a size refusal (Y-01, Y-02, Y-04 to Y-07)', () => {
  it('Y-01 leaves providerMap before destroying the provider and replaces the document', () => {
    const oldDoc = getDoc(NAME);
    const provider = open();
    writeLocalNode('bad');
    expect(provider.configuration.websocketProvider.configuration.providerMap.has(NAME)).toBe(true);
    refuse(provider);
    expect(provider.destroy).toHaveBeenCalledTimes(1);
    expect(provider.mappedAtDestroy).toEqual([false]);
    expect(oldDoc.isDestroyed).toBe(true);
    const fresh = getDoc(NAME);
    expect(fresh).not.toBe(oldDoc);
    expect(fresh.getMap('nodesMap').has('bad')).toBe(false);
  });

  it('Y-02 sets resyncing and shows the resync toast once', () => {
    const provider = open();
    push(provider, P_FULL);
    expect(readDocSize(NAME).phase).toBe('full');
    refuse(provider);
    expect(readDocSize(NAME).phase).toBe('resyncing');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]?.[0]).toBe(COPY_V2_EN.T_RESYNC);
    expect(toast.error).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['an ordinary close', ''],
    ['permissionChanged', COLLAB_REAUTH_REASONS.permissionChanged],
    ['sessionEnded', COLLAB_REAUTH_REASONS.sessionEnded],
  ] as const)('Y-04 %s does not rebuild the document', (_label, reason) => {
    const doc = getDoc(NAME);
    const provider = open();
    push(provider, P_WARNING);
    expect(readDocSize(NAME).phase).toBe('warning');
    act(() => { provider.emit('close', { event: { code: 1000, reason } }); });
    expect(getDoc(NAME)).toBe(doc);
    expect(doc.isDestroyed).toBe(false);
    expect(provider.destroy).toHaveBeenCalledTimes(0);
    expect(readDocSize(NAME).phase).toBe('warning');
    expect(resyncToasts()).toBe(0);
  });

  it('Y-04 the size refusal is not a re-authentication reason', () => {
    expect(isReauthCloseReason(COLLAB_DOCUMENT_TOO_LARGE_REASON)).toBe(false);
    const provider = open();
    refuse(provider);
    expect(provider.onOpen).toHaveBeenCalledTimes(0);
  });

  it('Y-05 a refusal of the rebuilt document rebuilds again; neither refused write comes back', () => {
    const first = open();
    writeLocalNode('bad1');
    refuse(first);
    const secondDoc = getDoc(NAME);
    const second = open();
    expect(second).not.toBe(first);
    writeLocalNode('bad2');
    refuse(second);
    expect(secondDoc.isDestroyed).toBe(true);
    expect(second.mappedAtDestroy).toEqual([false]);
    const thirdDoc = getDoc(NAME);
    expect(thirdDoc).not.toBe(secondDoc);
    const third = open();
    expect(third.document).toBe(thirdDoc);
    expect(Y.encodeStateAsUpdate(thirdDoc)).toEqual(EMPTY_STATE);
    expect(readDocSize(NAME).phase).toBe('resyncing');
  });

  it('Y-06 another Space document and the meta document of the Project are left alone', () => {
    const provider = open();
    const siblingName = docName.canvasSpace('p1', 's2');
    const sibling = open(siblingName);
    const siblingDoc = getDoc(siblingName);
    const metaName = docName.projectMeta('p1');
    const meta = open(metaName);
    const metaDoc = getDoc(metaName);
    push(sibling, P_FULL);
    expect(readDocSize(siblingName).phase).toBe('full');
    refuse(provider);
    expect(sibling.destroy).toHaveBeenCalledTimes(0);
    expect(meta.destroy).toHaveBeenCalledTimes(0);
    expect(getDoc(siblingName)).toBe(siblingDoc);
    expect(getDoc(metaName)).toBe(metaDoc);
    expect(siblingDoc.isDestroyed).toBe(false);
    expect(readDocSize(siblingName).phase).toBe('full');
    expect(readDocSize(metaName).phase).toBe('unknown');
  });

  it('Y-07 the canvas undo stack goes with the old document', () => {
    const oldDoc = getDoc(NAME);
    const provider = open();
    const undo = getCanvasUndoManager(oldDoc, NAME);
    writeLocalNode('n1');
    expect(undo.undoStack).toHaveLength(1);
    refuse(provider);
    expect(getCanvasUndoManager(getDoc(NAME), NAME).undoStack).toHaveLength(0);
  });

  it('Y-07 the timeline edit session history goes with the old document', () => {
    const name = docName.timelineSpace('p1', 's3');
    const x = cid(11);
    const seed = seededDoc(timeline([clip(cid(1), MAIN, 0, 48), clip(x, 'v2', 10, 20)], [track(MAIN, 0), track('v2', 1)]));
    const oldDoc = getDoc(name);
    Y.applyUpdate(oldDoc, Y.encodeStateAsUpdate(seed), 'remote');
    const provider = open(name);
    const session = getTimelineEditSession(oldDoc, name);
    act(() => { session.edit({ operation: 'move', parameters: { clipId: x, startFrame: 40 }, placement: OFF }); });
    expect(session.getSnapshot().canUndo).toBe(true);
    refuse(provider);
    expect(getTimelineEditSession(getDoc(name), name).getSnapshot().canUndo).toBe(false);
  });
});
