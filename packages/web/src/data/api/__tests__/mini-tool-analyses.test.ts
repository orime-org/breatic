// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it, vi } from 'vitest';
import { miniToolAnalysesApi, miniToolAnalysisQuery } from '../mini-tool-analyses';
import { apiGet, apiPost } from '../request';

vi.mock('../request', async (importOriginal) => ({ ...(await importOriginal<typeof import('../request')>()), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../credits', async (importOriginal) => ({ ...(await importOriginal<typeof import('../credits')>()), noteCreditsChanged: vi.fn() }));

describe('analysis API wire contract', () => {
  it('reads the exact authorized run endpoint and rejects malformed metadata', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ status: 'completed', result: null });
    await expect(miniToolAnalysesApi.get('10000000-0000-4000-8000-000000000001')).rejects.toThrow();
    expect(apiGet).toHaveBeenCalledWith('/mini-tools/analyses/10000000-0000-4000-8000-000000000001');
  });
  it('retains the same cache key for collaborator reads and admission', () => {
    expect(miniToolAnalysisQuery('run-1').queryKey).toEqual(['mini-tool-analysis', 'run-1']);
  });
  it('does not submit a malformed editable draft', async () => {
    await expect(miniToolAnalysesApi.start({} as never, 'press-key')).rejects.toThrow();
    expect(apiPost).toHaveBeenCalledTimes(0);
  });
});
