// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ apiPatch: vi.fn() }));
vi.mock('@web/data/api/request', () => ({ apiPatch: transport.apiPatch, apiGet: vi.fn(), apiPost: vi.fn(), runOnceRequest: vi.fn() }));
import { designateCreditLot } from '@web/data/api/credits';

const lot = {
  id: 'lot-1', sourceKind: 'payment', purchasedCredits: '100.000000', remainingCredits: '80.000000',
  designatedStudioId: 'studio-1', designatedStudioName: 'Selected Studio', designated: true,
  paidCents: 1000, currency: 'usd', lifecycle: 'active', refundAttempts: 0,
  everSpent: false, everRestored: false, createdAt: '2026-10-31T00:00:00.000Z',
};
beforeEach(() => { transport.apiPatch.mockReset(); });

describe('designation reply uses the exact lot view contract', () => {
  it('retains the void action contract after validating a complete exact-decimal lot', async () => {
    transport.apiPatch.mockResolvedValue(lot);
    await expect(designateCreditLot('lot/1', 'studio-1')).resolves.toBeUndefined();
    expect(transport.apiPatch).toHaveBeenCalledExactlyOnceWith('/credits/lots/lot%2F1/designation', { studioId: 'studio-1' });
  });

  it.each([
    { ...lot, remainingCredits: 80 },
    { ...lot, remainingCredits: '80.0000000' },
    { id: 'lot-1', sourceKind: 'payment', purchasedCredits: '100.000000', remainingCredits: '80.000000', designatedStudioId: 'studio-1', createdAt: '2026-10-31T00:00:00.000Z' },
  ])('rejects a legacy, malformed, or incomplete designation response %#', async (response) => {
    transport.apiPatch.mockResolvedValue(response);
    await expect(designateCreditLot('lot-1', null)).rejects.toThrow();
    expect(transport.apiPatch).toHaveBeenCalledExactlyOnceWith('/credits/lots/lot-1/designation', { studioId: null });
  });
});
