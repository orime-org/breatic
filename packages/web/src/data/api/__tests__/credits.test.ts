// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * 积分请求打到哪个地址（任务 #11）。
 *
 * 组件那边把这个模块整个换成替身，所以地址是怎么拼出来的只有这里看得见。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/data/api/request', () => ({ apiGet: vi.fn() }));

import { apiGet } from '@web/data/api/request';
import { fetchStudioCredits } from '@web/data/api/credits';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiGet).mockResolvedValue({
    spendable: 0,
    lots: [],
    ledger: { items: [], nextCursor: null },
  });
});

describe('fetchStudioCredits', () => {
  it('按 slug 打到那个 studio 的积分地址', async () => {
    await fetchStudioCredits('acme');
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/studio/acme/credits', {
      params: undefined,
    });
  });

  it('给了游标就带上，没给就不带', async () => {
    // 带一个空的 params 会让第一页的请求地址跟后续页不同，缓存和日志都对不上。
    await fetchStudioCredits('acme', 'cursor-1');
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/studio/acme/credits', {
      params: { cursor: 'cursor-1' },
    });
  });

  it('slug 里的特殊字符按 URL 转义，不直接拼进地址', async () => {
    await fetchStudioCredits('a/b');
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/studio/a%2Fb/credits', {
      params: undefined,
    });
  });
});
