// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('@web/data/api/request', () => ({
  apiGet: transport.apiGet,
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  runOnceRequest: vi.fn(),
}));

import {
  fetchCreditOverview,
  fetchCreditLots,
  fetchCreditLedger,
  fetchProjectCredits,
  fetchStudioCredits,
} from '@web/data/api/credits';
import { paymentApi } from '@web/data/api/payment';

type Resource = 'overview' | 'lots' | 'ledger' | 'project' | 'studio' | 'history';

/**
 * Read each public credit resource through its existing production wrapper.
 * @param resource - The resource whose contract is exercised.
 * @returns The decoded response.
 */
function read(resource: Resource): Promise<unknown> {
  switch (resource) {
    case 'overview': return fetchCreditOverview();
    case 'lots': return fetchCreditLots({ lifecycle: 'active', cursor: 'next' });
    case 'ledger': return fetchCreditLedger({ studioId: 'studio-1', cursor: 'next' });
    case 'project': return fetchProjectCredits('project/1');
    case 'studio': return fetchStudioCredits('studio/1', 'next');
    case 'history': return paymentApi.history('next');
  }
}

const position = {
  spendable: '18014398509.470000', held: '0.010000', available: '18014398509.460000',
};
const overview = {
  billing: true, assignedCredits: '18014398509.470000', unassignedCredits: '0.000000',
  underRefundCredits: '0.000000', studios: [],
};
const page = { items: [], nextCursor: null };
const studio = { ...position, debt: '0.000000', lots: [], ledger: page };
const lot = {
  id: '00000000-0000-4000-8000-000000000001', sourceKind: 'payment',
  purchasedCredits: '100.000000', remainingCredits: '100.000000',
  designatedStudioId: null, designatedStudioName: null, designated: false,
  paidCents: 100, currency: 'usd', lifecycle: 'active', refundAttempts: 0,
  everSpent: false, everRestored: false, createdAt: '2026-10-31T00:00:00.000Z',
};
const ledger = {
  id: '00000000-0000-4000-8000-000000000002', kind: 'generation',
  actorUserId: null, actorName: null, studioId: null, studioName: null,
  projectId: null, projectName: null, model: null, provider: null,
  amount: '-0.010000', createdAt: '2026-10-31T00:00:00.000Z',
};
const purchase = {
  rowId: '00000000-0000-4000-8000-000000000003', sourceKind: 'payment',
  paymentId: '00000000-0000-4000-8000-000000000003',
  amountCents: 100, totalCents: 120, taxCents: 20, currency: 'usd',
  creditsGranted: '100.000000', remainingCredits: '100.000000', lifecycle: 'active',
  designatedStudioId: null, designatedStudioName: null, status: 'completed',
  createdAt: '2026-10-31T00:00:00.000Z', canResend: true,
};
const cases: { resource: Resource; path: string; params: Record<string, string>; data: unknown }[] = [
  { resource: 'overview', path: '/credits/overview', params: {}, data: overview },
  { resource: 'lots', path: '/credits/lots', params: { lifecycle: 'active', cursor: 'next' }, data: { ...page, items: [lot] } },
  { resource: 'ledger', path: '/credits/ledger', params: { studioId: 'studio-1', cursor: 'next' }, data: { ...page, items: [ledger] } },
  { resource: 'project', path: '/projects/project%2F1/credits', params: {}, data: position },
  { resource: 'studio', path: '/studio/studio%2F1/credits', params: { cursor: 'next' }, data: studio },
  { resource: 'history', path: '/payment/history', params: { cursor: 'next' }, data: { ...page, items: [purchase] } },
];

beforeEach(() => { transport.apiGet.mockReset(); });

describe('decimal credit client contracts', () => {
  it.each(cases)('M18 sends decimal-v1 when reading $resource', async ({ resource, path, params, data }) => {
    transport.apiGet.mockResolvedValue(data);
    await expect(read(resource)).resolves.toEqual(data);
    expect(transport.apiGet).toHaveBeenCalledTimes(1);
    expect(transport.apiGet).toHaveBeenCalledWith(path, {
      params: { ...params, amountFormat: 'decimal-v1' },
    });
  });

  it.each([
    { resource: 'overview' as const, data: { ...overview, assignedCredits: 18014398509.47 } },
    { resource: 'project' as const, data: { ...position, available: 18014398509.46 } },
    { resource: 'studio' as const, data: { ...studio, debt: 0 } },
    { resource: 'lots' as const, data: { ...page, items: [{ ...lot, purchasedCredits: 100 }] } },
    { resource: 'ledger' as const, data: { ...page, items: [{ ...ledger, amount: -0.01 }] } },
    { resource: 'history' as const, data: { ...page, items: [{ ...purchase, creditsGranted: 100 }] } },
  ])('M18 rejects legacy numeric amounts from $resource', async ({ resource, data }) => {
    transport.apiGet.mockResolvedValue(data);
    await expect(read(resource)).rejects.toThrow();
    expect(transport.apiGet).toHaveBeenCalledTimes(1);
  });

  it('M18 rejects malformed precision before returning a project balance', async () => {
    transport.apiGet.mockResolvedValue({ ...position, available: '0.0000001' });
    await expect(fetchProjectCredits('project-1')).rejects.toThrow();
  });

  it('M18 retains exact aggregate digits and negative available balances', async () => {
    const exact = { spendable: '-0.000001', held: '199999999999999.999998', available: '-0.000001' };
    transport.apiGet.mockResolvedValue(exact);
    await expect(fetchProjectCredits('project-1')).resolves.toEqual(exact);
  });
});
