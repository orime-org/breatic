// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The spend caps section of a Studio's credits tab (inner#1968, test spec
 * H-34; the confirmed demo's "Studio · 积分 · 花费上限" page).
 *
 * A team studio's admin sees "花费上限": the studio's monthly total, the
 * per-person default, what the studio spent this month, when it resets, and a
 * row per member with their relation, what they spent and the cap in force,
 * with "单独设置…", whose dialog also puts the person back on the default; a
 * former member's row is read-only. A personal studio has no such section; a member who is not admin
 * sees neither the section nor a way to edit.
 *
 * Shape this suite chose where the design names none: the tab reads
 * `GET /studio/:slug/spend-limits` through `apiGet`, and the server's 403 (not
 * admin) or 404 (personal studio) is what hides the section.
 */

import type { CreditDecimal, StudioCreditsView } from '@breatic/shared';

import type { ReactElement } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCurrentUserStore } from '@web/stores/current-user';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { setLocale } from '@breatic/shared';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { CreditsTab } from '@web/pages/studio/container/tabs/CreditsTab';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type * as CreditsApi from '@web/data/api/credits';
import type * as RequestApi from '@web/data/api/request';

const fetchStudioCredits = vi.fn();
vi.mock('@web/data/api/credits', async (importOriginal) => ({
  ...(await importOriginal<typeof CreditsApi>()),
  fetchStudioCredits: (...args: unknown[]) => fetchStudioCredits(...args),
}));
const spendLimits = vi.fn();
const users = vi.fn((): Promise<unknown[]> => Promise.resolve([]));
const put = vi.fn();
const remove = vi.fn();
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<typeof RequestApi>();
  return {
    ...actual,
    apiGet: (url: string, ...rest: unknown[]) => (/\/spend-limits$/.test(url) ? spendLimits(url) : url === '/users' ? users() : (actual.apiGet as (...a: unknown[]) => unknown)(url, ...rest)),
    apiPut: (...args: unknown[]) => put(...args),
    apiDelete: (...args: unknown[]) => remove(...args),
  };
});
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
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
  return render(<QueryClientProvider client={client}><TooltipProvider><MemoryRouter>{ui}</MemoryRouter></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => {
  setLocale('zh-CN');
  fetchStudioCredits.mockReset();
  fetchStudioCredits.mockResolvedValue(CREDITS);
  spendLimits.mockReset();
  put.mockReset();
  remove.mockReset();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
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
    const former = screen.getByText('已离开（只读）').closest('tr')!;
    expect(within(former).queryAllByRole('button')).toHaveLength(0);
  });

  // inner#1968 visual round 1: the spent column lines its decimal points up, and the admin finds their own row.
  it('writes each member\'s spend to two decimals and marks the viewer\'s own row', async () => {
    useCurrentUserStore.getState().setUser({ id: 'u2', name: 'u2', email: 'u2@x.test', personalStudio: null, membershipTier: 'team' });
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    const own = (await screen.findByText('186.50')).closest('tr')!;
    expect(screen.getByText('312.00')).toBeInTheDocument();
    expect(own).toHaveTextContent('(你)');
    expect(screen.getAllByText('(你)')).toHaveLength(1);
  });

  // inner#1968 visual round 2: one action per row keeps every row one line high in every language.
  it('gives each current member one action, the own-limit dialog', async () => {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    await screen.findByText('花费上限');
    for (const name of ['Studio 成员', 'Project 协作者']) {
      for (const cell of screen.getAllByText(name)) expect(within(cell.closest('tr')!).getAllByRole('button')).toHaveLength(1);
    }
  });

  // inner#1968 visual round 2: Japanese breaks "メンバー" only between words.
  it('breaks a relation only between words', async () => {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    expect(await screen.findByText('Project 协作者')).toHaveClass('break-keep');
  });

  // inner#1968 visual round 2: a name cut short shows in full under the pointer.
  it('shows a member\'s whole name when the pointer rests on it', async () => {
    const long = 'alexandria-montgomery-fitzwilliam-the-third';
    users.mockResolvedValueOnce([{ id: 'u3', email: 'a@x.test', username: long, avatar_url: null }]);
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    await userEvent.hover(await screen.findByText(long));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(long);
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

describe('the spend caps section when it cannot be read', () => {
  it('says so and reads again on Try again, for an answer other than 403 or 404', async () => {
    spendLimits.mockRejectedValueOnce(new ApiException({ status: 502, message: 'bad gateway', fromServer: false }));
    spendLimits.mockResolvedValueOnce(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    expect(await screen.findByText('无法读取花费上限。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '再试一次' }));
    expect(await screen.findByText('Studio 每月总额上限')).toBeInTheDocument();
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

  // inner#1968 visual round 2: the default is one of the dialog's choices.
  it('opens on the default for a person without a limit of their own, on their own limit otherwise', async () => {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    const [own, onDefault] = await screen.findAllByRole('button', { name: '单独设置…' });
    await userEvent.click(onDefault!);
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: '使用默认（300 积分）' })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(own!);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: '不限' })).toBeChecked();
  });

  it('puts a person back on the default from the dialog, waiting on Save until the answer is in', async () => {
    let answer: () => void = () => {};
    remove.mockImplementation(() => new Promise<void>((resolve) => { answer = resolve; }));
    const dialog = await openDialog('300.000000');
    await userEvent.click(within(dialog).getByRole('radio', { name: '使用默认（300 积分）' }));
    const save = within(dialog).getByRole('button', { name: '保存' });
    await userEvent.click(save);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('/studio/acme/members/u1/spend-limit'));
    expect(put).not.toHaveBeenCalled();
    expect(save).toHaveAttribute('aria-busy', 'true');
    await act(async () => { answer(); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('sends nothing for a person already on the default', async () => {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    const [, onDefault] = await screen.findAllByRole('button', { name: '单独设置…' });
    await userEvent.click(onDefault!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('sets its options inside the padded body, not against the border', async () => {
    const dialog = await openDialog('300.000000');
    const group = within(dialog).getByRole('radiogroup');
    // DialogBody's own padding, the inset the title and hint above it share.
    expect(group.parentElement).toHaveClass('px-4');
  });

  it.each([
    ['300.000000', '现在默认 300 积分'],
    [null, '现在默认 不限'],
    ['0.000000', '现在默认 0（禁止花积分）'],
  ])('names the current default %s in its hint', async (memberDefault, text) => {
    const dialog = await openDialog(memberDefault);
    expect(within(dialog).getByText(new RegExp(text.replace(/[()（）]/g, '.')))).toBeInTheDocument();
  });
});

describe('editing the two limits', () => {
  /**
   * Show the section and type an amount into the Studio's total.
   * @param text - What the admin types.
   * @returns The total's input.
   */
  async function typeStudioTotal(text: string): Promise<HTMLElement> {
    spendLimits.mockResolvedValue(LIMITS);
    renderTab(<CreditsTab slug='acme' />);
    await screen.findByText('花费上限');
    const [total] = screen.getAllByRole('textbox');
    await userEvent.clear(total!);
    if (text !== '') await userEvent.type(total!, text);
    return total!;
  }

  it.each(['-1', '1e3', '0x10', '10.001', '1,0,0', '10,00', '1000000001', ''])('says why %j cannot be saved and sends nothing', async (text) => {
    await typeStudioTotal(text);
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(save);
    expect(put).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('请填写 0 到 1,000,000,000 之间的积分，最多两位小数。');
  });

  it('sends an amount with two decimals as it shows', async () => {
    put.mockResolvedValue({});
    await typeStudioTotal('10.05');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/studio/acme/spend-limits', { studioMonthly: 10.05, memberDefault: 300 }));
  });

  // The page shows every amount with thousands separators, so an amount typed
  // the same way is the same amount.
  it.each([['1,000', 1000], ['1,234.5', 1234.5], ['1,000,000,000', 1000000000]])('sends %j typed with thousands separators as %d', async (text, credits) => {
    put.mockResolvedValue({});
    await typeStudioTotal(text);
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/studio/acme/spend-limits', { studioMonthly: credits, memberDefault: 300 }));
  });

  it('counts a total typed as the same amount as unchanged', async () => {
    await typeStudioTotal('2000.0');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('says the server\'s own sentence when the server refuses the save', async () => {
    put.mockRejectedValue(new ApiException({ status: 422, message: 'The server says no.', fromServer: true }));
    await typeStudioTotal('500');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The server says no.'));
  });

  it('keeps an unsaved Studio total when a person\'s own limit is restored meanwhile', async () => {
    const total = await typeStudioTotal('500');
    remove.mockResolvedValue({});
    spendLimits.mockResolvedValue({ ...LIMITS, members: LIMITS.members.map((m) => (m.userId === 'u3' ? { ...m, override: null, effective: '300.000000' } : m)) });
    const [, , u3] = screen.getAllByRole('button', { name: '单独设置…' });
    await userEvent.click(u3!);
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: '使用默认（300 积分）' }));
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(spendLimits).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(total).toHaveValue('500');
  });
});
