// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec section 7, paste: the room is reserved
 * before `canvasApi.paste` is asked, the write carries that reservation, and
 * a failed or abandoned paste gives it back.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import en from '@locales/en.json';
import { toast } from '@web/lib/toast';
import { canvasApi } from '@web/data/api/canvas';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { CLIPBOARD_VERSION, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import {
  confirmLatest,
  expectRoom,
  flush,
  handshake,
  latestProvider,
  markSynced,
  openSizedDoc,
  probe,
  pushSize,
  refuseTooLarge,
} from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_AFTER_WRITE,
  F_FULL,
  F_WARNING,
  F_WARNING_TIGHT,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p-paste';
const SID = 's-paste';
const NAME = docName.canvasSpace(PID, SID);

/** Two nodes; the picture's content has a history row, so the paste asks the server first. */
const PAYLOAD: ClipboardPayload = {
  version: CLIPBOARD_VERSION,
  picked: ['a', 'b'],
  nodes: [
    { id: 'a', type: 'image', position: { x: 10, y: 20 }, data: { name: 'Hero', content: 'https://cdn.example.test/a.png' } },
    { id: 'b', type: 'text', position: { x: 400, y: 20 }, data: { content: 'note' } },
  ],
  edges: [],
};

type PasteAnswer = Awaited<ReturnType<typeof canvasApi.paste>>;

/**
 * A promise settled from outside.
 * @returns The promise and its two settle functions.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (err: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The room available now, found by bisecting with released probes.
 * @param upTo - An upper bound known to be at least the room.
 * @returns The largest byte count that still fits.
 */
function roomNow(upTo: number): number {
  let lo = 0;
  let hi = upTo;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (probe(NAME, mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Node ids in a document.
 * @param doc - The canvas document.
 * @returns Its node ids.
 */
function nodeIds(doc: Y.Doc): string[] {
  return [...doc.getMap(CANVAS_NODES_KEY).keys()];
}

/**
 * Opens the Space with the handshake done and one push delivered.
 * @param push - The size push.
 * @returns The document and the paste hook.
 */
async function openAt(push: typeof F_WARNING): Promise<{ doc: Y.Doc; paste: ReturnType<typeof useNodeCreation>['pastePayload'] }> {
  const { doc, provider } = openSizedDoc(NAME);
  await handshake(NAME, provider);
  pushSize(provider, push);
  const { result } = renderHook(() => useNodeCreation(PID, SID));
  return { doc, paste: result.current.pastePayload };
}

beforeEach(() => {
  sizeGateProviders.length = 0;
  useCurrentUserStore.getState().setUser({ id: 'u-9', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
});

afterEach(() => {
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('W-64 the room is reserved before the server is asked, and the write carries it', () => {
  it('holds room while the request is pending, does not take it twice, and frees it after confirm and push', async () => {
    const answer = deferred<PasteAnswer>();
    let pendingRoom = -1;
    const { doc, paste } = await openAt(F_WARNING);
    vi.spyOn(canvasApi, 'paste').mockImplementation(() => {
      pendingRoom = roomNow(F_WARNING.room);
      return answer.promise;
    });
    const done = paste(PAYLOAD, { dx: 0, dy: 0 });
    await flush();
    expect(canvasApi.paste).toHaveBeenCalledTimes(1);
    expect(pendingRoom).toBeLessThan(F_WARNING.room);
    expect(probe(NAME, F_WARNING.room)).toBe(false);
    const beforeResolve = roomNow(F_WARNING.room);
    answer.resolve({ map: {} });
    const ids = await done;
    expect(ids).toHaveLength(2);
    expect(nodeIds(doc).sort()).toEqual([...ids!].sort());
    expect(roomNow(F_WARNING.room)).toBe(beforeResolve);
    await confirmLatest(latestProvider(NAME));
    pushSize(latestProvider(NAME), F_AFTER_WRITE);
    expectRoom(NAME, F_AFTER_WRITE.room);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-65 a full Space is not asked about', () => {
  it('returns null without calling the server and warns once', async () => {
    const { doc, paste } = await openAt(F_FULL);
    const spy = vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
    const before = Y.encodeStateAsUpdate(doc);
    expect(await paste(PAYLOAD, { dx: 0, dy: 0 })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual([]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-66 a paste larger than the room is not asked about', () => {
  it('returns null without calling the server and names the room left', async () => {
    const { doc, paste } = await openAt(F_WARNING_TIGHT);
    const spy = vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
    expect(await paste(PAYLOAD, { dx: 0, dy: 0 })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(nodeIds(doc)).toEqual([]);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-67 a failed request gives the room back', () => {
  it('frees the reservation so an immediate retry goes through', async () => {
    const { doc, paste } = await openAt(F_WARNING);
    const spy = vi.spyOn(canvasApi, 'paste')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ map: {} });
    expect(await paste(PAYLOAD, { dx: 0, dy: 0 })).toBeNull();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(en.canvas.paste.failed);
    expectRoom(NAME, F_WARNING.room);
    const ids = await paste(PAYLOAD, { dx: 0, dy: 0 });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ids).toHaveLength(2);
    expect(nodeIds(doc).sort()).toEqual([...ids!].sort());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('W-68 a paste answered after the document was rebuilt is judged against the new room', () => {
  /**
   * Starts a paste on the open Space, measures what it reserved, then has
   * collab refuse the document and the tab reopen it, the way `OpenSpace`
   * remounts after `resetDocument`.
   * @param push - What the new provider reports before it syncs.
   * @returns The pending paste, the reserved estimate, the new document and the release.
   */
  async function pasteAcrossRebuild(push: typeof F_WARNING): Promise<{ done: Promise<string[] | null>; estimate: number; fresh: Y.Doc; resolve: () => void }> {
    const answer = deferred<PasteAnswer>();
    const { paste } = await openAt(F_WARNING);
    vi.spyOn(canvasApi, 'paste').mockReturnValue(answer.promise);
    const done = paste(PAYLOAD, { dx: 0, dy: 0 });
    await flush();
    const estimate = F_WARNING.room - roomNow(F_WARNING.room);
    expect(estimate).toBeGreaterThan(0);
    refuseTooLarge(latestProvider(NAME));
    const reopened = openSizedDoc(NAME);
    pushSize(reopened.provider, push);
    markSynced(reopened.provider);
    return { done, estimate, fresh: reopened.doc, resolve: () => answer.resolve({ map: {} }) };
  }

  it('refuses the write when the new document has no room for it', async () => {
    const { done, fresh, resolve } = await pasteAcrossRebuild(F_WARNING_TIGHT);
    resolve();
    expect(await done).toBeNull();
    expect(fresh.getMap(CANVAS_NODES_KEY).size).toBe(0);
    const warnings = vi.mocked(toast.warning).mock.calls.map(([message]) => message);
    expect(warnings.filter((m) => m === COPY_EN.T_NO_ROOM('1 B'))).toHaveLength(1);
    expect(warnings.filter((m) => m === COPY_EN.T_RESYNC)).toHaveLength(1);
    expect(warnings).toHaveLength(2);
  });

  it('writes into the new document as an unreserved write when it has room', async () => {
    const { done, estimate, fresh, resolve } = await pasteAcrossRebuild(F_WARNING);
    resolve();
    const ids = await done;
    expect(ids).toHaveLength(2);
    expect([...fresh.getMap(CANVAS_NODES_KEY).keys()].sort()).toEqual([...ids!].sort());
    expect(roomNow(F_WARNING.room)).toBe(F_WARNING.room - estimate);
  });
});

describe('W-69 the Space filling up while the request is pending', () => {
  it('refuses the write and frees the reservation', async () => {
    const answer = deferred<PasteAnswer>();
    const { doc, paste } = await openAt(F_WARNING);
    vi.spyOn(canvasApi, 'paste').mockReturnValue(answer.promise);
    const before = Y.encodeStateAsUpdate(doc);
    const done = paste(PAYLOAD, { dx: 0, dy: 0 });
    await flush();
    pushSize(latestProvider(NAME), F_FULL);
    answer.resolve({ map: {} });
    expect(await done).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    pushSize(latestProvider(NAME), F_WARNING);
    expectRoom(NAME, F_WARNING.room);
  });
});
