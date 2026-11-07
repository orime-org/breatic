// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec RQ-01, RQ-02): a canvas paste asks
 * `canAdd` before `canvasApi.paste`, and the write after the answer is an
 * `add`, refused when the Space filled up meanwhile. A refused paste fetches
 * no external clone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY } from '@breatic/shared';

vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { assetsApi } from '@web/data/api';
import { canvasApi } from '@web/data/api/canvas';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { useCurrentUserStore } from '@web/stores/current-user';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';
import { CLIPBOARD_VERSION, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import {
  P_FULL,
  SIZE_COPY_EN,
  enterSize,
  expectSizeToast,
  pushSize,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p-paste';
const SID = 's-paste';
const NAME = docName.canvasSpace(PID, SID);

/**
 * A picture whose content has a history row (so the server is asked first)
 * and an external picture whose address is fetched into storage after the
 * write.
 */
const PAYLOAD: ClipboardPayload = {
  version: CLIPBOARD_VERSION,
  picked: ['a', 'c'],
  nodes: [
    { id: 'a', type: 'image', position: { x: 10, y: 20 }, data: { name: 'Hero', content: 'https://cdn.example.test/a.png' } },
    { id: 'c', type: 'image', position: { x: 400, y: 20 }, external: true, data: { name: 'Web', content: 'https://example.com/c.png' } },
  ],
  edges: [],
};

type PasteAnswer = Awaited<ReturnType<typeof canvasApi.paste>>;

/**
 * A promise settled from outside.
 * @returns The promise and its settle function.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
 * Opens the Space in one size state and the paste hook.
 * @param code - The size state.
 * @returns The document and the paste.
 */
function openAt(code: SizeCode): { doc: Y.Doc; paste: ReturnType<typeof useNodeCreation>['pastePayload'] } {
  const doc = getDoc(NAME);
  enterSize(NAME, code);
  const { result } = renderHook(() => useNodeCreation(PID, SID));
  vi.mocked(toast.warning).mockClear();
  return { doc, paste: result.current.pastePayload };
}

beforeEach(() => {
  useCurrentUserStore.getState().setUser({ id: 'u-9', name: 'Ada', email: 'ada@example.com', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(canvasApi, 'ingestUrl').mockResolvedValue(undefined as never);
  vi.spyOn(assetsApi, 'ingestUrl').mockResolvedValue({ storage_key: 'k' });
});

afterEach(() => {
  clearAllDocSizes();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('RQ-01 a paste into a Space that cannot take an add asks the server nothing', () => {
  it.each([
    ['F', SIZE_COPY_EN.T_ADD],
    ['O', SIZE_COPY_EN.T_OVER],
    ['Z', null],
  ] as const)('RQ-01 [%s] returns null, calls neither paste nor ingest, writes nothing', async (code, sentence) => {
    const { doc, paste } = openAt(code);
    const spy = vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
    const before = Y.encodeStateAsUpdate(doc);
    expect(await paste(PAYLOAD, { dx: 0, dy: 0 })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(canvasApi.ingestUrl).not.toHaveBeenCalled();
    expect(assetsApi.ingestUrl).not.toHaveBeenCalled();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual([]);
    expectSizeToast(sentence);
  });

  it('RQ-01 [W] a paste with room asks the server once and lands both nodes (control)', async () => {
    const { doc, paste } = openAt('W');
    const spy = vi.spyOn(canvasApi, 'paste').mockResolvedValue({ map: {} });
    const ids = await paste(PAYLOAD, { dx: 0, dy: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ids).toHaveLength(2);
    expect(nodeIds(doc).sort()).toEqual([...ids!].sort());
    expect(canvasApi.ingestUrl).toHaveBeenCalledTimes(1);
    expectSizeToast(null);
  });
});

describe('RQ-02 the Space fills up while the paste request is pending', () => {
  it('RQ-02 refuses the write as an add, warns once and fetches no external clone', async () => {
    const answer = deferred<PasteAnswer>();
    const { doc, paste } = openAt('N');
    vi.spyOn(canvasApi, 'paste').mockReturnValue(answer.promise);
    const before = Y.encodeStateAsUpdate(doc);
    const done = paste(PAYLOAD, { dx: 0, dy: 0 });
    await Promise.resolve();
    expect(canvasApi.paste).toHaveBeenCalledTimes(1);
    pushSize(NAME, P_FULL);
    answer.resolve({ map: {} });
    expect(await done).toBeNull();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual([]);
    expect(canvasApi.ingestUrl).not.toHaveBeenCalled();
    expect(assetsApi.ingestUrl).not.toHaveBeenCalled();
    expectSizeToast(SIZE_COPY_EN.T_ADD);
  });
});
