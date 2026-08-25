// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import type { StudioCreditsView } from '@breatic/shared';

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
function credits(over: Partial<StudioCreditsView> = {}): StudioCreditsView {
  return {
    spendable: 4910,
    debt: 0,
    lots: [
      {
        id: 'lot-1',
        purchasedCredits: 4550,
        remainingCredits: 3120,
        designatedStudioId: 's1',
        lifecycle: 'active',
        refundAttempts: 0,
        buyerName: '张伟',
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    ],
    ledger: {
      items: [
        {
          id: 'e1',
          kind: 'generation',
          actorUserId: 'u-guest',
          actorName: '李静',
          projectId: 'p1',
          projectName: '夏季广告片',
          model: 'seedance-1.5-pro',
          provider: 'volcengine',
          charged: -42.5,
          consumed: -42.5,
          owed: 0,
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
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-spendable')).toHaveTextContent('4,910');
    expect(fetchStudioCredits).toHaveBeenCalledWith('acme', undefined);
  });

  it('列出这个 studio 的每一笔，显示剩多少、一共多少', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    const lot = await screen.findByTestId('studio-lot-lot-1');
    expect(lot).toHaveTextContent('3,120');
    expect(lot).toHaveTextContent('4,550');
  });

  it('流水每行说得出谁花的、在哪个 project、用了哪个模型', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

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
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-credits-unassigned-notice')).toBeInTheDocument();
  });

  it('names the four situations apart, since a bare figure does not', async () => {
    // 4910, 0, 0 and -320 on their own do not say which situation this studio
    // is in — the two zeroes read identically, and a negative figure needs
    // saying out loud. "Nothing was ever assigned here", "it was all spent"
    // and "it owes" each get their own sentence, and each sentence points at
    // what to do next.
    const cases = [
      {
        head: { spendable: 4910, debt: 0 },
        hint: 'Generating in this Studio\'s Projects spends these credits.',
        prompt: null,
      },
      {
        head: { spendable: 0, debt: 0, lots: [] },
        hint: 'No credits are assigned to this Studio yet.',
        prompt: 'Credits have to be assigned to a Studio before they can be spent.',
      },
      {
        head: { spendable: 0, debt: 0 },
        hint: 'This Studio has spent all of its credits.',
        prompt: 'Assign more credits from your account credits.',
      },
      {
        head: { spendable: -320, debt: 320 },
        hint: 'Credits assigned next will pay off what is owed first.',
        prompt: 'they pay off what is owed first',
      },
    ];

    for (const c of cases) {
      fetchStudioCredits.mockReset();
      fetchStudioCredits.mockResolvedValue(credits(c.head));
      const view = renderTab(<CreditsTab slug='acme' />);
      await screen.findByTestId('studio-spendable');
      expect(document.body).toHaveTextContent(c.hint);
      const notice = screen.queryByTestId('studio-credits-unassigned-notice');
      if (c.prompt === null) expect(notice).toBeNull();
      else expect(notice).toHaveTextContent(c.prompt);
      view.unmount();
    }
  });

  it('有积分时不显示那条提示', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    await screen.findByTestId('studio-spendable');
    expect(
      screen.queryByTestId('studio-credits-unassigned-notice'),
    ).not.toBeInTheDocument();
  });

  it('取完了就不再监听滚到底', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    await screen.findByTestId('studio-ledger-e1');
    await waitFor(() => expect(reachEnd).toBeNull());
  });

  it('还有下一页时不画「到底了」，也不画按钮', async () => {
    // 翻页靠滚到底自动触发，界面上没有可点的东西。
    fetchStudioCredits.mockResolvedValue(
      credits({ ledger: { items: credits().ledger.items, nextCursor: 'c1' } }),
    );
    renderTab(<CreditsTab slug='acme' />);

    await screen.findByTestId('studio-ledger-e1');
    expect(screen.queryByTestId('studio-ledger-end')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more|更多/i })).not.toBeInTheDocument();
  });

  it('取完了才画「到底了」', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-ledger-end')).toBeInTheDocument();
  });

  it('拿到下一页的游标之后，用它去取下一页', async () => {
    const first = credits({
      ledger: { items: credits().ledger.items, nextCursor: 'cursor-1' },
    });
    const second = credits({
      ledger: {
        items: [{ ...credits().ledger.items[0]!, id: 'e2', charged: -8 }],
        nextCursor: null,
      },
    });
    fetchStudioCredits
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    renderTab(<CreditsTab slug='acme' />);
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

    renderTab(<CreditsTab slug='acme' />);
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

    renderTab(<CreditsTab slug='acme' />);
    await screen.findByTestId('studio-ledger-e1');
    reachEnd!();
    await screen.findByTestId('studio-ledger-page-error');

    expect(reachEnd).not.toBeNull();
  });
  it('每一笔充值都写着谁买的', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-lot-lot-1')).toHaveTextContent(
      '张伟',
    );
  });

  it('充值记录末尾有一行合计，等于上面那个可用额', async () => {
    // 这一块解释的就是上面那个数怎么来的。没有合计，它跟那个数之间没有看得
    // 见的算术关系。
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-lots-total')).toHaveTextContent(
      '4,910',
    );
  });

  it('欠着账时可用额是负数，欠账在充值记录里单独一行', async () => {
    fetchStudioCredits.mockResolvedValue(
      credits({
        spendable: -320,
        debt: 320,
        lots: [{ ...credits().lots![0]!, remainingCredits: 0 }],
      }),
    );
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-spendable')).toHaveTextContent(
      '-320',
    );
    expect(screen.getByTestId('studio-lots-debt')).toHaveTextContent('-320');
    expect(screen.getByTestId('studio-lots-total')).toHaveTextContent('-320');
  });

  it('一笔都没有却欠着账：欠账和合计照样列出来', async () => {
    // 这一块解释的就是上面那个数怎么来的，而这一格最需要解释：屏幕上写着
    // -320，下面得说得出这 -320 是「0 笔减去 320 欠账」。
    fetchStudioCredits.mockResolvedValue(
      credits({ spendable: -320, debt: 320, lots: [] }),
    );
    renderTab(<CreditsTab slug='acme' />);

    expect(await screen.findByTestId('studio-lots-debt')).toHaveTextContent(
      '-320',
    );
    expect(screen.getByTestId('studio-lots-total')).toHaveTextContent('-320');
  });

  it('一笔都没有也不欠账时，这一块才是空态', async () => {
    fetchStudioCredits.mockResolvedValue(
      credits({ spendable: 0, debt: 0, lots: [] }),
    );
    renderTab(<CreditsTab slug='acme' />);

    await screen.findByTestId('studio-spendable');
    expect(screen.queryByTestId('studio-lots-debt')).toBeNull();
    expect(screen.queryByTestId('studio-lots-total')).toBeNull();
  });

  it('扣不满的生成：金额是实扣，下面标消耗多少、欠多少', async () => {
    fetchStudioCredits.mockResolvedValue(
      credits({
        ledger: {
          items: [
            {
              ...credits().ledger.items[0]!,
              charged: -30,
              consumed: -350,
              owed: -320,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    renderTab(<CreditsTab slug='acme' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    expect(row).toHaveTextContent('-30');
    expect(row).toHaveTextContent('350');
    expect(row).toHaveTextContent('320');
  });

  it('一笔都扣不到的生成：金额是 0，下面标消耗多少、欠多少', async () => {
    // 这一行的三个数是后端算出来的：一笔都锁不到时 allocations 为空，一行
    // spend 都不写，只写一行 debt_incurred，所以实扣恰好是 0 而欠额是全额。
    // 它跟真正的「没扣费」区别在 owed，不在 charged。
    fetchStudioCredits.mockResolvedValue(
      credits({
        ledger: {
          items: [
            {
              ...credits().ledger.items[0]!,
              charged: 0,
              consumed: -42.5,
              owed: -42.5,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    renderTab(<CreditsTab slug='acme' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    expect(within(row).getByTestId('studio-ledger-note')).toHaveTextContent(
      'owed 42.5',
    );
  });

  it('没扣费的生成：欠额是 0，小字说的是没扣费', async () => {
    // 支付关掉的部署，用量照记、没有笔可扣，也不欠谁的账。
    fetchStudioCredits.mockResolvedValue(
      credits({
        ledger: {
          items: [
            {
              ...credits().ledger.items[0]!,
              charged: 0,
              consumed: -42.5,
              owed: 0,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    renderTab(<CreditsTab slug='acme' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    const note = within(row).getByTestId('studio-ledger-note');
    expect(note).toHaveTextContent('not charged');
    expect(note).not.toHaveTextContent('owed');
  });

  it('抵扣欠账那行把中间两列合起来写这是什么事', async () => {
    // 它不发生在任何 project 里，也不用任何模型。往那两列填值就是编造。
    fetchStudioCredits.mockResolvedValue(
      credits({
        ledger: {
          items: [
            {
              ...credits().ledger.items[0]!,
              kind: 'debt_repayment',
              projectId: null,
              projectName: null,
              model: null,
              provider: null,
              charged: -150,
              consumed: 0,
              owed: 0,
            },
          ],
          nextCursor: null,
        },
      }),
    );
    renderTab(<CreditsTab slug='acme' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    const merged = within(row).getByTestId('studio-ledger-event');
    expect(merged).toHaveAttribute('colspan', '2');
    expect(row).toHaveTextContent('-150');
  });

  it('消耗和实扣相等时不标小字', async () => {
    fetchStudioCredits.mockResolvedValue(credits());
    renderTab(<CreditsTab slug='acme' />);

    const row = await screen.findByTestId('studio-ledger-e1');
    expect(within(row).queryByTestId('studio-ledger-note')).toBeNull();
  });
});
