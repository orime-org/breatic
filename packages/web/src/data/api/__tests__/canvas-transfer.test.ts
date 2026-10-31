// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Paste and snapshot send what `bodyOrTransfer` hands back (inner#1006 W09):
 * the reference when the body went through a transfer upload, the body itself
 * otherwise. The project the body names is the one the transfer is filed under.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasPasteInput } from '@breatic/shared';

const transfer = vi.hoisted(() => ({ bodyOrTransfer: vi.fn() }));
vi.mock('@web/data/upload/transfer-body', () => transfer);
vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({})),
  apiDelete: vi.fn(),
  runOnceRequest: vi.fn(),
}));

import { apiPost } from '@web/data/api/request';
import { canvasApi } from '@web/data/api/canvas';

const P = '11111111-1111-4111-8111-111111111111';
const REFERENCE = { transfer: 'transfer/k.transfer' };

const PASTE: CanvasPasteInput = {
  project_id: P,
  urls: [],
  pairs: [],
  history: [],
};
const SNAPSHOT = { project_id: P, node_id: '22222222-2222-4222-8222-222222222222', text: 'words' };

describe('paste and snapshot go through bodyOrTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the reference when the body was transferred', async () => {
    transfer.bodyOrTransfer.mockResolvedValue(REFERENCE);

    await canvasApi.paste(PASTE);
    await canvasApi.snapshotNodeText(SNAPSHOT);

    expect(vi.mocked(apiPost).mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['/canvas/paste', REFERENCE],
      ['/canvas/node-history/snapshot', REFERENCE],
    ]);
    expect(transfer.bodyOrTransfer.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [P, PASTE],
      [P, SNAPSHOT],
    ]);
  });

  it('sends the original object when bodyOrTransfer returns it', async () => {
    transfer.bodyOrTransfer.mockImplementation(async (_project: string, body: unknown) => body);

    await canvasApi.paste(PASTE);
    await canvasApi.snapshotNodeText(SNAPSHOT);

    expect(transfer.bodyOrTransfer).toHaveBeenCalledTimes(2);
    const [pasteCall, snapshotCall] = vi.mocked(apiPost).mock.calls;
    expect(pasteCall?.[0]).toBe('/canvas/paste');
    expect(pasteCall?.[1]).toBe(PASTE);
    expect(snapshotCall?.[0]).toBe('/canvas/node-history/snapshot');
    expect(snapshotCall?.[1]).toBe(SNAPSHOT);
  });
});
