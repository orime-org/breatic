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
