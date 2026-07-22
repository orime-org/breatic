// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * canvasApi tests — the session-cached canvas limits knob (#1782).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

import { apiGet } from '@web/data/api/request';
import {
  canvasApi,
  getCachedReferencePoolCap,
} from '@web/data/api/canvas';

describe('canvasApi.fetchLimits — session-cached canvas knobs (#1782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canvasApi.resetLimitsCache();
  });

  it('fetches once and serves later calls from the cache', async () => {
    vi.mocked(apiGet).mockResolvedValue({ referencePoolCap: 50 });

    const first = await canvasApi.fetchLimits();
    const second = await canvasApi.fetchLimits();

    expect(first.referencePoolCap).toBe(50);
    expect(second).toBe(first);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/canvas/limits');
  });

  it('does not cache a failure (next call retries the fetch)', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('boom'));
    await expect(canvasApi.fetchLimits()).rejects.toThrow('boom');

    vi.mocked(apiGet).mockResolvedValue({ referencePoolCap: 50 });
    const cfg = await canvasApi.fetchLimits();
    expect(cfg.referencePoolCap).toBe(50);
    expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(2);
  });

  it('getCachedReferencePoolCap is null before the fetch, the value after', async () => {
    // Sync accessor for gate callbacks: null = knob not loaded yet → the
    // soft cap simply does not gate (degrade-to-uncapped, no fallback
    // constant that could drift from the yaml).
    expect(getCachedReferencePoolCap()).toBeNull();
    vi.mocked(apiGet).mockResolvedValue({ referencePoolCap: 50 });
    await canvasApi.fetchLimits();
    expect(getCachedReferencePoolCap()).toBe(50);
  });
});

describe('canvasApi.listNodeHistory — paginated node history (#1619)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requests the history endpoint with project_id + limit + offset and returns { entries, total }', async () => {
    const page = {
      entries: [
        {
          id: 'h-1',
          entryType: 'generation' as const,
          status: 'success' as const,
          content: 'a.png',
          thumbnailUrl: null,
          errorMessage: null,
          metadata: { model: 'Nano Banana', cost: 58 },
          createdAt: '2026-07-21T00:00:00.000Z',
        },
      ],
      total: 12,
    };
    vi.mocked(apiGet).mockResolvedValue(page);

    const res = await canvasApi.listNodeHistory('node-1', 'proj-1', {
      limit: 20,
      offset: 0,
    });

    // `total` survives — the point of the `{ data: { entries, total } }`
    // envelope (a raw `{ data, total }` sibling shape would drop `total`
    // through apiGet's single `{ data }` unwrap).
    expect(res.total).toBe(12);
    expect(res.entries).toHaveLength(1);
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith(
      '/canvas/nodes/node-1/history',
      { params: { project_id: 'proj-1', limit: 20, offset: 0 } },
    );
  });
});
