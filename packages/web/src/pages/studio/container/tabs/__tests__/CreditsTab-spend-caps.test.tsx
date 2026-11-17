// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The spend caps section of a Studio's credits tab (inner#1968, test spec
 * H-34; the confirmed demo's "Studio · 积分 · 花费上限" page).
 *
 * A team studio's admin sees "花费上限": the studio's monthly total, the
 * per-person default, what the studio spent this month, when it resets, and a
 * row per member with their relation, what they spent and the cap in force,
 * with "单独设置…" and, on an override, "恢复默认"; a former member's row is
 * read-only. A personal studio has no such section; a member who is not admin
 * sees neither the section nor a way to edit.
 *
 * Shape this suite chose where the design names none: the tab reads
 * `GET /studio/:slug/spend-limits` through `apiGet`, and the server's 403 (not
 * admin) or 404 (personal studio) is what hides the section.
 */

import type { CreditDecimal, StudioCreditsView } from '@breatic/shared';

import type { ReactElement } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { setLocale } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import type * as CreditsApi from '@web/data/api/credits';
import type * as RequestApi from '@web/data/api/request';

const fetchStudioCredits = vi.fn();
vi.mock('@web/data/api/credits', async (importOriginal) => ({
  ...(await importOriginal<typeof CreditsApi>()),
  fetchStudioCredits: (...args: unknown[]) => fetchStudioCredits(...args),
}));
const spendLimits = vi.fn();
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<typeof RequestApi>();
  return {
    ...actual,
    apiGet: (url: string, ...rest: unknown[]) => (/\/spend-limits$/.test(url) ? spendLimits(url) : (actual.apiGet as (...a: unknown[]) => unknown)(url, ...rest)),
  };
});
vi.mock('@web/lib/use-scrolled-to-end', () => ({
  useScrolledToEnd: () => ({ scrollerRef: () => {}, sentinelRef: () => {} }),
}));

const CREDITS: StudioCreditsView = {
  spendable: '3416.500000' as CreditDecimal,
  debt: '0.000000' as CreditDecimal,
  lots: [],
  ledger: { items: [], nextCursor: null },
};

const LIMITS = {
  memberDefault: '300.000000',
  studioMonthly: '2000.000000',
  monthStart: '2026-11-01T00:00:00.000Z',
  nextResetAt: '2026-12-01T00:00:00.000Z',
  studioSpent: '840.000000',
  members: [
    { userId: 'u1', relation: 'studio_member', override: { monthlyCredits: null }, effective: null, spent: '312.000000' },
    { userId: 'u2', relation: 'studio_member', override: null, effective: '300.000000', spent: '186.500000' },
    { userId: 'u3', relation: 'project_collaborator', override: { monthlyCredits: '500.000000' }, effective: '500.000000', spent: '42.000000' },
    { userId: 'u4', relation: 'studio_member', override: { monthlyCredits: '0.000000' }, effective: '0.000000', spent: '0.000000' },
    { userId: 'u6', relation: 'former', override: null, effective: null, spent: '96.000000' },
  ],
};

/**
 * Render the tab with its providers.
 * @param ui - The tab.
 * @returns The render result.
 */
function renderTab(ui: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  setLocale('zh-CN');
  fetchStudioCredits.mockReset();
  fetchStudioCredits.mockResolvedValue(CREDITS);
  spendLimits.mockReset();
});
afterEach(() => setLocale('en'));

describe('H-34 the spend caps section', () => {
  it('shows the admin both caps, the month spent, the reset and each member with their relation, spent and cap in force', async () => {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    expect(await screen.findByText('花费上限')).toBeInTheDocument();
    for (const text of ['Studio 每月总额上限', '每人每月上限默认值', '本月 Studio 已花', '重置于', '本月已花', '生效上限']) {
      expect(screen.getAllByText(text).length, text).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('Studio 成员')).toHaveLength(3);
    expect(screen.getByText('Project 协作者')).toBeInTheDocument();
    expect(screen.getByText('已离开（只读）')).toBeInTheDocument();
    expect(screen.getByText('不限')).toBeInTheDocument();
    expect(screen.getByText('0（禁止花积分）')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '单独设置…' })).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: '恢复默认' })).toHaveLength(3);
    const former = screen.getByText('已离开（只读）').closest('tr')!;
    expect(within(former).queryAllByRole('button')).toHaveLength(0);
  });

  it('shows nothing of it in a personal studio', async () => {
    spendLimits.mockRejectedValue(new ApiException({ status: 404, message: 'not found', fromServer: true }));
    renderTab(<CreditsTab slug='me' />);
    await screen.findByTestId('studio-spendable');
    await waitFor(() => expect(spendLimits).toHaveBeenCalled());
    expect(screen.queryByText('花费上限')).not.toBeInTheDocument();
  });

  it('shows a member who is not admin neither the section nor a way to edit', async () => {
    spendLimits.mockRejectedValue(new ApiException({ status: 403, message: 'forbidden', fromServer: true }));
    renderTab(<CreditsTab slug='acme' />);
    await screen.findByTestId('studio-spendable');
    await waitFor(() => expect(spendLimits).toHaveBeenCalled());
    expect(screen.queryByText('花费上限')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '单独设置…' })).not.toBeInTheDocument();
  });
});

describe('the own-limit dialog', () => {
  /**
   * Open one member's own-limit dialog.
   * @param memberDefault - The per-person default the studio has.
   * @returns The dialog.
   */
  async function openDialog(memberDefault: string | null): Promise<HTMLElement> {
    spendLimits.mockResolvedValue({ ...LIMITS, memberDefault });
    renderTab(<CreditsTab slug='acme' />);
    const [first] = await screen.findAllByRole('button', { name: '单独设置…' });
    await userEvent.click(first!);
    return screen.findByRole('dialog');
  }

  it('sets its options inside the padded body, not against the border', async () => {
    const dialog = await openDialog('300.000000');
    const group = within(dialog).getByRole('radiogroup');
    // DialogBody's own padding, the inset the title and hint above it share.
    expect(group.parentElement).toHaveClass('px-4');
  });
});
