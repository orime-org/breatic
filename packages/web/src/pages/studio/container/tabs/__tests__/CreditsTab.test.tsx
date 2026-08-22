// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import type { StudioCredits } from '@web/data/api/credits';

const fetchStudioCredits = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchStudioCredits: (...args: unknown[]) => fetchStudioCredits(...args),
}));

// jsdom 没有真的滚动，所以捕获这个 hook 收到的回调，在测试里直接调它 ——
// 要问的是「滚到底之后取的是不是下一页」，不是 IntersectionObserver 本身。
let reachEnd: (() => void) | null = null;
vi.mock('@web/lib/use-scrolled-to-end', () => ({
  useScrolledToEnd: (opts: { enabled: boolean; onReachEnd: () => void }) => {
    reachEnd = opts.enabled ? opts.onReachEnd : null;
    return { scrollerRef: () => {}, sentinelRef: () => {} };
  },
}));

/**
 * 一份 studio 积分响应。
 * @param over - 要覆盖的字段。
 * @returns 一个完整响应。
 */
function credits(over: Partial<StudioCredits> = {}): StudioCredits {
  return {
    spendable: 4910,
    lots: [
      {
        id: 'lot-1',
        purchasedCredits: 4550,
        remainingCredits: 3120,
        designatedStudioId: 's1',
        lifecycle: 'active',
        refundAttempts: 0,
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    ],
    ledger: {
      items: [
        {
          id: 'e1',
          entryType: 'spend',
          amount: -42.5,
          actorUserId: 'u-guest',
          actorName: '李静',
          projectName: '夏季广告片',
          studioId: 's1',
          projectId: 'p1',
          lotId: 'lot-1',
          model: 'seedance-1.5-pro',
          provider: 'volcengine',
          tokensUsed: null,
          description: null,
          createdAt: '2026-08-21T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    },
    ...over,
  };
}

/**
 * 渲染这个 tab，带上它需要的两个 provider。
 * @param ui - 要渲染的元素。
 * @returns testing-library 的渲染结果。
 */
function renderTab(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchStudioCredits.mockReset();
  reachEnd = null;
});

describe('CreditsTab', () => {
  it('显示这个 studio 能花多少，数字来自服务器', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    expect(await screen.findByTestId('studio-spendable')).toHaveTextContent('4,910');
    expect(fetchStudioCredits).toHaveBeenCalledWith('acme', undefined);
  });

  it('列出这个 studio 的每一笔，显示剩多少、一共多少', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    const lot = await screen.findByTestId('studio-lot-lot-1');
    expect(lot).toHaveTextContent('3,120');
    expect(lot).toHaveTextContent('4,550');
  });

  it('流水每行说得出谁花的、在哪个 project、用了哪个模型', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    expect(row).toHaveTextContent('李静');
    expect(row).toHaveTextContent('夏季广告片');
    expect(row).toHaveTextContent('seedance-1.5-pro');
    expect(row).toHaveTextContent('-42.5');
  });

  it('一分都没有时说清是没指定，不是空表格', async () => {
    // 买了积分却没指定给这个 studio，是新模型下最常见的「为什么是 0」。
    fetchStudioCredits.mockResolvedValue(
      credits({ spendable: 0, lots: [], ledger: { items: [], nextCursor: null } }),
    );
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    expect(await screen.findByTestId('studio-credits-unassigned-notice')).toBeInTheDocument();
  });

  it('有积分时不显示那条提示', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    await screen.findByTestId('studio-spendable');
    expect(
      screen.queryByTestId('studio-credits-unassigned-notice'),
    ).not.toBeInTheDocument();
  });

  it('访客看到的可用额跟 admin 一样', async () => {
    // 访客在这个 studio 的 project 里生成，花的就是这个池子。
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='guest' />);

    expect(await screen.findByTestId('studio-spendable')).toHaveTextContent('4,910');
  });

  it('取完了就不再监听滚到底', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    await screen.findByTestId('studio-ledger-e1');
    await waitFor(() => expect(reachEnd).toBeNull());
  });

  it('还有下一页时不画「到底了」，也不画按钮', async () => {
    // 翻页靠滚到底自动触发，界面上没有可点的东西。
    fetchStudioCredits.mockResolvedValue(
      credits({ ledger: { items: credits().ledger.items, nextCursor: 'c1' } }),
    );
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    await screen.findByTestId('studio-ledger-e1');
    expect(screen.queryByTestId('studio-ledger-end')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more|更多/i })).not.toBeInTheDocument();
  });

  it('取完了才画「到底了」', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' studioRole='admin' />);

    expect(await screen.findByTestId('studio-ledger-end')).toBeInTheDocument();
  });

  it('拿到下一页的游标之后，用它去取下一页', async () => {
    const first = credits({
      ledger: { items: credits().ledger.items, nextCursor: 'cursor-1' },
    });
    const second = credits({
      ledger: {
        items: [{ ...credits().ledger.items[0]!, id: 'e2', amount: -8 }],
        nextCursor: null,
      },
    });
    fetchStudioCredits
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    renderTab(<CreditsTab slug='acme' studioRole='admin' />);
    await screen.findByTestId('studio-ledger-e1');

    expect(reachEnd).not.toBeNull();
    reachEnd!();

    await waitFor(() => {
      expect(fetchStudioCredits).toHaveBeenLastCalledWith('acme', 'cursor-1');
    });
    expect(await screen.findByTestId('studio-ledger-e2')).toBeInTheDocument();
    // 两页合起来显示，不是后一页把前一页顶掉。
    expect(screen.getByTestId('studio-ledger-e1')).toBeInTheDocument();
  });
  it('下一页没到时说出来，已经读到的照样在', async () => {
    // 失败落在一次翻页上，第一页的可用额、充值记录和已读的流水都还在手里。
    // 底部那块本来就是给这句话留的位置 —— 空着，读者只看到滚动停住了。
    const first = credits({
      ledger: { items: credits().ledger.items, nextCursor: 'cursor-1' },
    });
    fetchStudioCredits
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('network'));

    renderTab(<CreditsTab slug='acme' studioRole='admin' />);
    await screen.findByTestId('studio-ledger-e1');

    expect(reachEnd).not.toBeNull();
    reachEnd!();

    expect(
      await screen.findByTestId('studio-ledger-page-error'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('studio-ledger-e1')).toBeInTheDocument();
    expect(screen.getByTestId('studio-spendable')).toHaveTextContent('4,910');
    expect(screen.queryByTestId('studio-ledger-end')).not.toBeInTheDocument();
  });

  it('下一页失败之后，滚动还能再要一次', async () => {
    // 这一页没到不是终点。监听要留着，读者再滚一下就是再问一次。
    const first = credits({
      ledger: { items: credits().ledger.items, nextCursor: 'cursor-1' },
    });
    fetchStudioCredits
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('network'));

    renderTab(<CreditsTab slug='acme' studioRole='admin' />);
    await screen.findByTestId('studio-ledger-e1');
    reachEnd!();
    await screen.findByTestId('studio-ledger-page-error');

    expect(reachEnd).not.toBeNull();
  });
});
