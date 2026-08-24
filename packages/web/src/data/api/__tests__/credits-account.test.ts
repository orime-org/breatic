// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiGet = vi.fn();
const apiPatch = vi.fn();
vi.mock('@web/data/api/request', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPatch: (...args: unknown[]) => apiPatch(...args),
}));

const {
  fetchCreditOverview,
  fetchCreditLots,
  fetchCreditLedger,
  designateCreditLot,
} = await import('@web/data/api/credits');

describe('the four account-level reads and writes', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({});
    apiPatch.mockReset().mockResolvedValue({});
  });

  it('asks /credits/overview for the overview, with no parameters', async () => {
    await fetchCreditOverview();
    expect(apiGet).toHaveBeenCalledWith('/credits/overview');
  });

  it('sends no query string when the purchases are not narrowed', async () => {
    await fetchCreditLots();
    expect(apiGet).toHaveBeenCalledWith('/credits/lots', { params: undefined });
  });

  it('carries both the lifecycle and the cursor', async () => {
    await fetchCreditLots({ lifecycle: 'active', cursor: 'c1' });
    expect(apiGet).toHaveBeenCalledWith('/credits/lots', {
      params: { lifecycle: 'active', cursor: 'c1' },
    });
  });

  it('narrows the ledger to one studio and sends nothing else', async () => {
    await fetchCreditLedger({ studioId: 's1' });
    expect(apiGet).toHaveBeenCalledWith('/credits/ledger', {
      params: { studioId: 's1' },
    });
  });

  it('takes a purchase back with null rather than an empty string', async () => {
    // An empty string reaches the route's schema as a uuid that fails to
    // validate. Null is the instruction to take the purchase back.
    await designateCreditLot('l1', null);
    expect(apiPatch).toHaveBeenCalledWith('/credits/lots/l1/designation', {
      studioId: null,
    });
  });

  it('escapes the purchase id before it reaches the path', async () => {
    await designateCreditLot('a/b', 's1');
    expect(apiPatch).toHaveBeenCalledWith('/credits/lots/a%2Fb/designation', {
      studioId: 's1',
    });
  });
});
