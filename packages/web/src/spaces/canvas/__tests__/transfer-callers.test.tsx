// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Paste and snapshot when their body goes through a transfer upload
 * (inner#1006 W11, W12): a failed transfer is said with the copy each already
 * uses, and a paste's nodes still appear only once the server has answered,
 * which now includes the time the transfer takes.
 *
 * `bodyOrTransfer` is replaced here so the transfer can fail or be held; the
 * request helpers are replaced so that a paste or snapshot that skips it
 * succeeds at once, which is what makes the cases tell the two apart.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { t } from '@breatic/shared';
import type * as RequestModule from '@web/data/api/request';

const transfer = vi.hoisted(() => ({ bodyOrTransfer: vi.fn() }));
vi.mock('@web/data/upload/transfer-body', () => transfer);
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<typeof RequestModule>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));
vi.mock('@web/lib/toast', () => ({
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
vi.mock('@web/data/yjs/canvas-space', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readTextBodies: vi.fn(() => new Map([['n-1', 'what it says now']])),
}));

import { apiPost } from '@web/data/api/request';
import * as canvasSpace from '@web/data/yjs/canvas-space';
import { _resetForTests, docName, getDoc } from '@web/data/yjs/manager';
import { toast } from '@web/lib/toast';
import { useCurrentUserStore } from '@web/stores/current-user';
import { keepSnapshot } from '@web/spaces/canvas/keep-snapshot';
import { CLIPBOARD_VERSION, type ClipboardPayload } from '@web/spaces/canvas/node-clipboard';
import { useNodeCreation } from '@web/spaces/canvas/use-node-creation';

const P = 'p1';
const S = 's1';

/** A clipboard holding one picture with content, which has a history row to register. */
const PICTURE: ClipboardPayload = {
  version: CLIPBOARD_VERSION,
  picked: ['a'],
  nodes: [{ id: 'a', type: 'image', position: { x: 0, y: 0 }, data: { content: 'a.png' } }],
  edges: [],
};

/**
 * Let pending promise callbacks run.
 * @returns Once they have.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTests();
  getDoc(docName.canvasSpace(P, S));
  useCurrentUserStore.getState().setUser({
    id: 'u-9',
    name: 'Ada',
    email: 'ada@example.com',
    personalStudio: null,
    membershipTier: 'base',
  });
  // Skipping the transfer would succeed at once: paste answers an empty
  // map, snapshot a row id.
  vi.mocked(apiPost).mockImplementation(async (url: string) =>
    url === '/canvas/paste' ? { map: {} } : { id: 'h-1' },
  );
});

describe('a transfer that fails says what each caller already says (W11)', () => {
  it('a paste says canvas.paste.failed and writes nothing', async () => {
    transfer.bodyOrTransfer.mockRejectedValue(new Error('transfer failed'));
    const { result } = renderHook(() => useNodeCreation(P, S));

    const ids = await result.current.pastePayload(PICTURE, { dx: 0, dy: 0 });

    expect(ids).toBeNull();
    expect(vi.mocked(toast.error).mock.calls).toEqual([[t('canvas.paste.failed')]]);
    expect(canvasSpace.readNodes(getDoc(docName.canvasSpace(P, S)))).toEqual([]);
    expect(vi.mocked(apiPost)).toHaveBeenCalledTimes(0);
  });

  it('a snapshot says canvas.history.snapshotFailed', async () => {
    transfer.bodyOrTransfer.mockRejectedValue(new Error('transfer failed'));
    const onKept = vi.fn();

    await keepSnapshot({ projectId: P, spaceId: S, nodeId: 'n-1', onKept });

    expect(vi.mocked(toast.error).mock.calls).toEqual([[t('canvas.history.snapshotFailed')]]);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(0);
    expect(onKept).toHaveBeenCalledTimes(0);
  });
});

describe('a paste waits for its transfer before any node appears (W12)', () => {
  it('writes the copies only after the transfer and the server answered', async () => {
    let release: (value: unknown) => void = () => undefined;
    transfer.bodyOrTransfer.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { result } = renderHook(() => useNodeCreation(P, S));

    const done = result.current.pastePayload(PICTURE, { dx: 0, dy: 0 });
    await flush();

    expect(transfer.bodyOrTransfer).toHaveBeenCalledTimes(1);
    expect(canvasSpace.readNodes(getDoc(docName.canvasSpace(P, S)))).toEqual([]);

    release({ transfer: 'transfer/k.transfer' });
    const ids = await done;

    expect(ids).toHaveLength(1);
    expect(canvasSpace.readNodes(getDoc(docName.canvasSpace(P, S))).map((n) => n.id)).toEqual(ids);
    expect(vi.mocked(apiPost).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/canvas/paste', { transfer: 'transfer/k.transfer' }],
    ]);
  });
});
