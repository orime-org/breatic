// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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

describe('账号级的四个读写', () => {
  beforeEach(() => {
    apiGet.mockReset().mockResolvedValue({});
    apiPatch.mockReset().mockResolvedValue({});
  });

  it('总览打到 /credits/overview，不带参数', async () => {
    await fetchCreditOverview();
    expect(apiGet).toHaveBeenCalledWith('/credits/overview');
  });

  it('充值记录不带条件时不发空的查询串', async () => {
    await fetchCreditLots();
    expect(apiGet).toHaveBeenCalledWith('/credits/lots', { params: undefined });
  });

  it('充值记录把状态和游标一起带上', async () => {
    await fetchCreditLots({ lifecycle: 'active', cursor: 'c1' });
    expect(apiGet).toHaveBeenCalledWith('/credits/lots', {
      params: { lifecycle: 'active', cursor: 'c1' },
    });
  });

  it('流水按 studio 筛时只带那一个参数', async () => {
    await fetchCreditLedger({ studioId: 's1' });
    expect(apiGet).toHaveBeenCalledWith('/credits/ledger', {
      params: { studioId: 's1' },
    });
  });

  it('取消指定发的是 null，不是空串', async () => {
    // 空串会被路由的 schema 收成一个 uuid 校验失败，而 null 是「取回来」这
    // 个动作本身。
    await designateCreditLot('l1', null);
    expect(apiPatch).toHaveBeenCalledWith('/credits/lots/l1/designation', {
      studioId: null,
    });
  });

  it('积分包 id 进地址前先转义', async () => {
    await designateCreditLot('a/b', 's1');
    expect(apiPatch).toHaveBeenCalledWith('/credits/lots/a%2Fb/designation', {
      studioId: 's1',
    });
  });
});
