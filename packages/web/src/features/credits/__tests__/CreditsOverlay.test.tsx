// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CreditOverview } from '@breatic/shared';

import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import { useCurrentUserStore } from '@web/stores/current-user';

const fetchCreditOverview = vi.fn();
const fetchCreditLots = vi.fn();
const fetchCreditLedger = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: () => fetchCreditOverview(),
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  fetchCreditLedger: (...args: unknown[]) => fetchCreditLedger(...args),
  designateCreditLot: vi.fn(),
}));

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listUserStudios: () => Promise.resolve([]) },
}));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
};

/**
 * An overview with nothing in it, which is what most of these tests need —
 * they ask about the index, not about the figures.
 * @param over - Fields to override.
 * @returns The overview.
 */
function overview(over: Partial<CreditOverview> = {}): CreditOverview {
  return {
    assignedCredits: 0,
    unassignedCredits: 0,
    billing: true,
    studios: [],
    ...over,
  };
}

/**
 * Render the overlay, open.
 * @returns The render result.
 */
function setup(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CreditsOverlay open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('CreditsOverlay', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    fetchCreditOverview.mockReset().mockResolvedValue(overview());
    fetchCreditLots
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: null });
    fetchCreditLedger
      .mockReset()
      .mockResolvedValue({ items: [], nextCursor: null });
  });

  it('索引列出两组七项，顺序固定', async () => {
    setup();

    const index = await screen.findByTestId('credits-index');
    const tabs = index.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(7);
    // 顺序是产品定的：先能问的四项，再能改的三项。
    expect([...tabs].map((tab) => tab.id)).toEqual([
      'credits-tab-overview',
      'credits-tab-lots',
      'credits-tab-ledger',
      'credits-tab-studios',
      'credits-tab-buy',
      'credits-tab-assign',
      'credits-tab-refunds',
    ]);
  });

  it('开着的时候停在总览上', async () => {
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    expect(first).toHaveAttribute('aria-selected', 'true');
    // 只有选中那一项在 Tab 顺序里，否则一个 Tab 键要走七下才出得去。
    expect(first).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('点一项就换一项，只读那一项的数据', async () => {
    const user = userEvent.setup();
    setup();

    await screen.findByTestId('credits-index');
    // 总览这一项不读分页端点。
    expect(fetchCreditLots).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: /Purchases/ }));

    await waitFor(() => {
      expect(fetchCreditLots).toHaveBeenCalled();
    });
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // 换过去了就不再是总览。
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('方向键在索引里上下走，两端绕回去', async () => {
    const user = userEvent.setup();
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: /Purchases/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 第一项往上是最后一项，不是原地不动。
    screen.getByRole('tab', { name: /Overview/ }).focus();
    await user.click(screen.getByRole('tab', { name: /Overview/ }));
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('tab', { name: /Refunds/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('End 跳到最后一项，Home 跳回第一项', async () => {
    const user = userEvent.setup();
    setup();

    const first = await screen.findByRole('tab', { name: /Overview/ });
    first.focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Refunds/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('总览读不出来时给一句话，不是空白', async () => {
    fetchCreditOverview.mockRejectedValue(new Error('nope'));
    setup();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('内容区在一个 Scroller 里，没有裸 overflow', async () => {
    setup();

    const body = await screen.findByRole('tabpanel');
    // Radix 的 viewport 是真正滚的那个元素；面板自己不许再开一个滚动条。
    const viewport = body.closest('[data-radix-scroll-area-viewport]');
    expect(viewport).not.toBeNull();
  });
});
