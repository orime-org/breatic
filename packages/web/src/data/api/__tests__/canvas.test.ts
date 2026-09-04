// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * canvasApi tests — the session-cached canvas limits knob (#1782).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/request', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

import { apiDelete, apiGet } from '@web/data/api/request';
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

describe('canvasApi node tasks — the rows behind a node\'s four counts (#186)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks for one node\'s tasks with the project and space it sits in', async () => {
    // The tenancy check needs the project; the space names the document the
    // server republishes this node's counts to (§4.6.7). Neither is in the
    // path.
    vi.mocked(apiGet).mockResolvedValue({ tasks: [] });

    const tasks = await canvasApi.listNodeTasks('node-1', 'proj-1', 'space-1');

    expect(tasks).toEqual([]);
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith(
      '/canvas/nodes/node-1/tasks',
      { params: { project_id: 'proj-1', space_id: 'space-1' } },
    );
  });

  it('hands back the rows with what each one landed on the node', async () => {
    const row = {
      id: 't-1',
      projectId: 'proj-1',
      spaceId: 'space-1',
      nodeId: 'node-1',
      kind: 'upload',
      status: 'done',
      startedByUserId: 'u-1',
      startedAt: '2026-09-03T00:00:00.000Z',
      budgetMs: 900_000,
      label: 'sunset.jpg',
      errorMessage: null,
      nodeHistoryId: 'h-1',
      content: 'https://cdn.invalid/sunset.jpg',
      coverUrl: null,
    };
    vi.mocked(apiGet).mockResolvedValue({ tasks: [row] });

    const tasks = await canvasApi.listNodeTasks('node-1', 'proj-1', 'space-1');

    expect(tasks).toEqual([row]);
  });

  it('names the node the caller is looking at when dropping a record', async () => {
    // The row may be gone from the table already; the counts are recomputed
    // for the node the caller says they are on, so the server needs it.
    vi.mocked(apiDelete).mockResolvedValue({
      removed: true,
      counts: { running: 0, done: 0, failed: 0, expired: 0 },
    });

    const res = await canvasApi.dismissNodeTask('t-1', {
      projectId: 'proj-1',
      spaceId: 'space-1',
      nodeId: 'node-1',
    });

    expect(res.removed).toBe(true);
    expect(vi.mocked(apiDelete)).toHaveBeenCalledWith(
      '/canvas/node-tasks/t-1',
      {
        params: {
          project_id: 'proj-1',
          space_id: 'space-1',
          node_id: 'node-1',
        },
      },
    );
  });
});
