// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  CreditLedgerView,
  CreditLotView,
  CreditOverview,
  StudioCreditSummary,
} from '@breatic/shared';

import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';
import { useCurrentUserStore } from '@web/stores/current-user';

const fetchCreditOverview = vi.fn();
const fetchCreditLots = vi.fn();
const fetchCreditLedger = vi.fn();
const designateCreditLot = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: () => fetchCreditOverview(),
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  fetchCreditLedger: (...args: unknown[]) => fetchCreditLedger(...args),
  designateCreditLot: (...args: unknown[]) => designateCreditLot(...args),
}));

const listUserStudios = vi.fn();
vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listUserStudios: () => listUserStudios() },
}));

const toastWarning = vi.fn();
vi.mock('@web/lib/toast', () => ({
  toast: { warning: (...a: unknown[]) => toastWarning(...a), error: vi.fn() },
}));

const ALEX = {
  id: 'u1',
  name: 'Alex',
  email: 'alex@x.example',
  personalStudio: { name: 'Alex', slug: 'alex', avatarUrl: null },
  membershipTier: 'base' as const,
};

/**
 * One studio's line on the overview.
 * @param over - Fields to override.
 * @returns The summary.
 */
function studio(over: Partial<StudioCreditSummary> = {}): StudioCreditSummary {
  return {
    studioId: 's1',
    studioName: 'Orime Studio',
    studioSlug: 'orime',
    deleted: false,
    spendable: 2400,
    debt: 0,
    spent: 1280,
    lotCount: 1,
    ...over,
  };
}

/**
 * What the account holds.
 * @param over - Fields to override.
 * @returns The overview.
 */
function overview(over: Partial<CreditOverview> = {}): CreditOverview {
  return {
    assignedCredits: 3640,
    unassignedCredits: 1790,
    billing: true,
    studios: [studio()],
    ...over,
  };
}

/**
 * One purchase.
 * @param over - Fields to override.
 * @returns The purchase.
 */
function lot(over: Partial<CreditLotView> = {}): CreditLotView {
  return {
    id: 'l1',
    purchasedCredits: 4550,
    remainingCredits: 2400,
    designatedStudioId: 's1',
    designatedStudioName: 'Orime Studio',
    paidCents: 5000,
    currency: 'usd',
    lifecycle: 'active',
    refundAttempts: 0,
    createdAt: '2026-08-21T10:00:00.000Z',
    ...over,
  };
}

/**
 * One generation's line.
 * @param over - Fields to override.
 * @returns The line.
 */
function entry(over: Partial<CreditLedgerView> = {}): CreditLedgerView {
  return {
    id: 'e1',
    actorUserId: 'u2',
    actorName: 'Lin',
    studioId: 's1',
    studioName: 'Orime Studio',
    projectId: 'p1',
    projectName: 'Autumn keyvisual',
    model: 'seedream-4.0',
    provider: 'volcengine',
    charged: -120,
    consumed: -120,
    owed: 0,
    createdAt: '2026-08-22T10:00:00.000Z',
    ...over,
  };
}

/**
 * Open the overlay on one section.
 * @param section - Which section to show.
 * @returns The userEvent session, for the tests that go on interacting.
 */
async function openOn(
  section: CreditsSectionId,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <CreditsOverlay open onOpenChange={vi.fn()} />
    </QueryClientProvider>,
  );
  await screen.findByTestId('credits-index');
  if (section !== 'overview') {
    await user.click(document.getElementById(`credits-tab-${section}`)!);
  }
  return user;
}

/**
 * The panel's text, once whatever it reads has arrived.
 * @returns The panel.
 */
async function panel(): Promise<HTMLElement> {
  const element = await screen.findByRole('tabpanel');
  await waitFor(() => {
    expect(element.querySelector('[data-testid="credits-skeleton"]')).toBeNull();
  });
  return element;
}

describe('积分覆盖层的七项', () => {
  beforeEach(() => {
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    fetchCreditOverview.mockReset().mockResolvedValue(overview());
    fetchCreditLots
      .mockReset()
      .mockResolvedValue({ items: [lot()], nextCursor: null });
    fetchCreditLedger
      .mockReset()
      .mockResolvedValue({ items: [entry()], nextCursor: null });
    designateCreditLot.mockReset().mockResolvedValue(lot());
    listUserStudios.mockReset().mockResolvedValue([
      { id: 's1', name: 'Orime Studio', myStudioRole: 'admin' },
      { id: 's2', name: 'Design squad', myStudioRole: 'guest' },
    ]);
    toastWarning.mockReset();
  });

  describe('总览', () => {
    it('三个数各自报，账号总额是另外两个之和', async () => {
      await openOn('overview');
      const body = await panel();

      // 三个数不是一回事：未指定的花不出去，加总掩盖了这件事。
      expect(body).toHaveTextContent('5,430');
      expect(body).toHaveTextContent('1,790');
      expect(body).toHaveTextContent('3,640');
    });

    it('分布把每个 studio 和未指定各列一条', async () => {
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent('Orime Studio 2,400');
      expect(body).toHaveTextContent(/Unassigned 1,790/);
    });

    it('一分钱没有时不画分布，改成说该怎么办', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({ assignedCredits: 0, unassignedCredits: 0, studios: [] }),
      );
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent(/assigned to a Studio/i);
      expect(body.querySelector('ul')).toBeNull();
    });

    it('这个部署不计积分时三个数都给破折号', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent(/does not charge credits/i);
      expect(body).not.toHaveTextContent('5,430');
    });
  });

  describe('充值记录', () => {
    it('每笔报实付、日期、剩余、共买了多少、指给了谁', async () => {
      await openOn('lots');
      const body = await panel();

      // 实付领头：这是拿去跟账单对的那个数。
      expect(body).toHaveTextContent('$50.00');
      expect(body).toHaveTextContent('2026-08-21');
      expect(body).toHaveTextContent('2,400');
      expect(body).toHaveTextContent('of 4,550');
      expect(body).toHaveTextContent('Assigned to Orime Studio');
    });

    it('有没指定的就提示，指定数报得准', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [
          lot(),
          lot({ id: 'l2', designatedStudioId: null, designatedStudioName: null }),
          lot({ id: 'l3', designatedStudioId: null, designatedStudioName: null }),
        ],
        nextCursor: null,
      });
      await openOn('lots');
      const body = await panel();

      expect(body).toHaveTextContent('2 purchases are unassigned');
    });

    it('退款流程里那笔虽然也没指定，但不算进这个提示', async () => {
      // 申请退款那一刻它就脱离了所有 studio，而且不许再被指定 —— 提示要用户
      // 去指定它，是让人去做一件做不到的事。
      fetchCreditLots.mockResolvedValue({
        items: [
          lot(),
          lot({
            id: 'l4',
            lifecycle: 'refund_pending',
            designatedStudioId: null,
            designatedStudioName: null,
          }),
        ],
        nextCursor: null,
      });
      await openOn('lots');
      const body = await panel();

      expect(body).not.toHaveTextContent(/are unassigned/);
    });

    it('全都指定了就不提示', async () => {
      await openOn('lots');
      const body = await panel();

      expect(body).not.toHaveTextContent(/are unassigned/);
    });

    it('不计积分的部署根本不去读这个端点', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('lots');
      const body = await panel();

      expect(body).toHaveTextContent(/does not charge credits/i);
      expect(fetchCreditLots).not.toHaveBeenCalled();
    });

    it('读失败给一句话，不是空白', async () => {
      fetchCreditLots.mockRejectedValue(new Error('nope'));
      await openOn('lots');

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  });

  describe('消耗流水', () => {
    it('一次生成一行，六列都在', async () => {
      await openOn('ledger');
      const body = await panel();

      const rows = body.querySelectorAll('tbody tr');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toHaveTextContent('2026-08-22');
      expect(row).toHaveTextContent('Lin');
      expect(row).toHaveTextContent('Orime Studio');
      expect(row).toHaveTextContent('Autumn keyvisual');
      expect(row).toHaveTextContent('seedream-4.0');
      expect(row).toHaveTextContent('-120');
    });

    it('欠了账的那次，把用掉多少和欠了多少分开说', async () => {
      fetchCreditLedger.mockResolvedValue({
        items: [entry({ charged: -120, consumed: -240, owed: -120 })],
        nextCursor: null,
      });
      await openOn('ledger');
      const body = await panel();

      // 花出去的和用掉的在欠账时不是一个数，两个都得报。
      expect(body).toHaveTextContent('used 240, of which 120 went on the tab');
    });

    it('没扣费的那次说清是没扣费，不是零消耗', async () => {
      fetchCreditLedger.mockResolvedValue({
        items: [entry({ charged: 0, consumed: -42, owed: 0 })],
        nextCursor: null,
      });
      await openOn('ledger');
      const body = await panel();

      expect(body).toHaveTextContent('used 42, not charged');
    });

    it('按 studio 筛时把那个 id 带给端点', async () => {
      const user = await openOn('ledger');
      await panel();

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Orime Studio' }));

      await waitFor(() => {
        expect(fetchCreditLedger).toHaveBeenLastCalledWith(
          expect.objectContaining({ studioId: 's1' }),
        );
      });
    });

    it('不计积分的部署照常列用量', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('ledger');
      const body = await panel();

      // 花不花钱和用没用过是两件事，后者照记。
      expect(fetchCreditLedger).toHaveBeenCalled();
      expect(body).toHaveTextContent('seedream-4.0');
    });
  });

  describe('各 Studio', () => {
    it('一行报四样：可用、欠账、已消耗、已指定几个包', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({ studios: [studio({ debt: 120 })] }),
      );
      await openOn('studios');
      const body = await panel();

      expect(body).toHaveTextContent('2,400');
      expect(body).toHaveTextContent('owes 120');
      expect(body).toHaveTextContent('spent 1,280');
      expect(body).toHaveTextContent('1 purchases assigned to it');
    });

    it('已删的 studio 留着，消耗照报，可用额给破折号', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({
          studios: [
            studio({
              studioId: 's3',
              studioName: '',
              deleted: true,
              spendable: 0,
              spent: 880,
              lotCount: 0,
            }),
          ],
        }),
      );
      await openOn('studios');
      const body = await panel();

      // 那笔钱真的花过，删掉这一行会让消耗那一列对不上。
      expect(body).toHaveTextContent('spent 880');
      expect(body).toHaveTextContent('Deleted');
      expect(body).toHaveTextContent('—');
    });
  });

  describe('购买积分', () => {
    it('给可用额和计价说明，不出五档也不出去支付', async () => {
      await openOn('buy');
      const body = await panel();

      expect(body).toHaveTextContent('5,430');
      expect(body).toHaveTextContent('1 credit = 1 US cent');
      expect(body).toHaveTextContent(/opens soon/i);
      expect(body.querySelectorAll('button')).toHaveLength(0);
    });

    it('不计积分的部署不出充值引导', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('buy');
      const body = await panel();

      expect(body).not.toHaveTextContent(/opens soon/i);
      expect(body).toHaveTextContent(/does not charge credits/i);
    });
  });

  describe('指定', () => {
    it('只问 active 的那些', async () => {
      await openOn('assign');
      await panel();

      expect(fetchCreditLots).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: 'active' }),
      );
    });

    it('下拉里只有自己是 admin 的 studio', async () => {
      const user = await openOn('assign');
      await panel();

      await user.click(screen.getByRole('combobox'));

      expect(await screen.findByRole('option', { name: 'Orime Studio' })).toBeInTheDocument();
      // 访客身份那个 studio 指不了，摆上去只是把一次拒绝摆出来。
      expect(screen.queryByRole('option', { name: 'Design squad' })).toBeNull();
    });

    it('改了就把这一笔发给端点', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [lot({ designatedStudioId: null, designatedStudioName: null })],
        nextCursor: null,
      });
      const user = await openOn('assign');
      await panel();

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Orime Studio' }));

      await waitFor(() => {
        expect(designateCreditLot).toHaveBeenCalledWith('l1', 's1');
      });
    });

    it('取消指定发的是 null，不是空串', async () => {
      const user = await openOn('assign');
      await panel();

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Unassigned' }));

      await waitFor(() => {
        expect(designateCreditLot).toHaveBeenCalledWith('l1', null);
      });
    });
  });

  describe('退款', () => {
    it('可退的列出来，按钮变暗但仍可按，按了说为什么', async () => {
      const user = await openOn('refunds');
      const body = await panel();

      const button = within(body).getByRole('button', { name: /refund/i });
      // 变暗不是 disabled：按不动的控件也是问不出所以然的控件。
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toHaveAttribute('disabled');

      await user.click(button);
      expect(toastWarning).toHaveBeenCalled();
    });

    it('审核中的和被驳回过的各自列出来', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [
          lot({ id: 'l4', lifecycle: 'refund_pending', designatedStudioId: null }),
          lot({ id: 'l5', refundAttempts: 1 }),
        ],
        nextCursor: null,
      });
      await openOn('refunds');
      const body = await panel();

      expect(body).toHaveTextContent(/Under review/);
      // 被驳回过的生命周期回到了 active，只有尝试次数记得这件事。
      expect(body).toHaveTextContent(/Refused/);
    });

    it('没有可退的也没申请过时说一句就完', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [lot({ remainingCredits: 0, lifecycle: 'depleted' })],
        nextCursor: null,
      });
      await openOn('refunds');
      const body = await panel();

      expect(body).toHaveTextContent(/Nothing can be refunded/i);
    });
  });
});
