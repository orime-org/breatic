// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 会员面板（任务 #90）。
 *
 * 面板背后只有一个请求，所以它能渲染的每一种样子都由那一个答案决定。这里
 * 钉住的是七种状态各自显示什么：
 *
 *   1. 正常档位：档位名、价格、账号级两项额度、各档对比表，当前那一列高亮。
 *   2. 只列账号级那两项额度，其余四项在对比表里看，不在额度区重复。
 *   3. 自托管：六项数值全列（因为它没有对比表可看），不显示价格、对比表、
 *      升级按钮，但保留联系邮箱。
 *   4. 企业版：不显示上限数字、不显示对比表，说明额度由单独协议约定。
 *   5. 某项超限：数字照实显示并标已超出，进度条满格，跟一句说明。
 *   6. 加载中：骨架，不是整页 spinner。
 *   7. 加载失败：一行错误文案。
 *
 * 升级按钮这一版点了没去处（块八未做），所以它压暗、带「尚未开放」，并且
 * 用 aria-disabled 而不是 disabled —— 后者会把它踢出键盘顺序。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AccountMembership, MembershipLimits } from '@breatic/shared';

import { MembershipPanel } from '@web/features/membership/MembershipPanel';

const membershipMock = vi.fn();
vi.mock('@web/data/api/account', () => ({
  accountApi: {
    membership: (): Promise<AccountMembership> => membershipMock(),
  },
}));

const GIB = 1024 ** 3;

/**
 * 一档的六项上限，按需覆盖。
 * @param over - 要覆盖的字段。
 * @returns 完整的六项。
 */
function limits(over: Partial<MembershipLimits> = {}): MembershipLimits {
  return {
    team_studios: 1,
    projects_per_studio: 100,
    concurrent_editors: 6,
    studio_members: 10,
    project_members: 12,
    storage_bytes: 200 * GIB,
    ...over,
  };
}

/**
 * 一份接口答案，按需覆盖。
 * @param over - 要覆盖的字段。
 * @returns 完整的答案。
 */
function answer(over: Partial<AccountMembership> = {}): AccountMembership {
  return {
    tier: 'pro',
    limits: limits(),
    usage: { teamStudios: 1, storageBytes: 38 * GIB },
    catalog: [
      { tier: 'base', limits: limits({ team_studios: 0, storage_bytes: 5 * GIB }) },
      { tier: 'pro', limits: limits() },
      { tier: 'team', limits: limits({ team_studios: 3, storage_bytes: 500 * GIB }) },
    ],
    ...over,
  };
}

/**
 * 渲染打开着的面板。
 * @returns testing-library 的渲染结果。
 */
function setup(): ReturnType<typeof render> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MembershipPanel open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  membershipMock.mockReset();
});

describe('MembershipPanel', () => {
  it('显示档位、价格和账号级的两项额度', async () => {
    membershipMock.mockResolvedValue(answer());
    setup();

    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'PRO',
    );
    expect(screen.getByText('$12 / month')).toBeInTheDocument();
    expect(screen.getByTestId('quota-team-studios')).toHaveTextContent('1 / 1');
    expect(screen.getByTestId('quota-storage')).toHaveTextContent(
      '38 GiB / 200 GiB',
    );
  });

  it('额度区不重复列 studio 级那四项', async () => {
    // 它们在对比表里逐档列着，用户看得到；在这里再列一遍只会让人以为
    // 那是账号级的数字。
    membershipMock.mockResolvedValue(answer());
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.queryByTestId('quota-projects-per-studio')).toBeNull();
    expect(screen.queryByTestId('quota-studio-members')).toBeNull();
    expect(screen.queryByTestId('quota-project-members')).toBeNull();
    expect(screen.queryByTestId('quota-concurrent-editors')).toBeNull();
  });

  it('对比表列出三档，当前那一档标出来', async () => {
    membershipMock.mockResolvedValue(answer());
    setup();

    const table = await screen.findByRole('table');
    expect(table).toHaveTextContent('Base');
    expect(table).toHaveTextContent('Team');
    // 自托管是部署形态、企业版一家一谈，两者都不在价目表上。
    expect(table).not.toHaveTextContent('Self-hosted');
    expect(screen.getByTestId('compare-column-pro')).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('升级按钮压暗、带「尚未开放」，且仍在键盘顺序里', async () => {
    // 块八没做，按钮点了没去处。HTML disabled 会把它踢出 tab 顺序，
    // 那样靠焦点浏览的人根本遇不到它。
    membershipMock.mockResolvedValue(answer());
    setup();

    const upgrade = await screen.findByTestId('membership-upgrade');
    expect(upgrade).toHaveAttribute('aria-disabled', 'true');
    expect(upgrade).not.toHaveAttribute('disabled');
    expect(upgrade).toHaveTextContent('Not open yet');
  });

  it('自托管把六项全列出来，并且不显示价格、对比表和升级按钮', async () => {
    // 它不在价目表上，没有对比表可看，所以那四项只能在额度区列出来，
    // 否则自托管用户完全看不到自己的上限。
    membershipMock.mockResolvedValue(
      answer({
        tier: 'self_hosted',
        limits: limits({
          team_studios: 9999,
          projects_per_studio: 9999,
          studio_members: 9999,
          project_members: 9999,
          concurrent_editors: 9999,
          storage_bytes: 100 * 1024 ** 4,
        }),
      }),
    );
    setup();

    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'Self-hosted',
    );
    expect(screen.getByTestId('quota-projects-per-studio')).toHaveTextContent(
      '9999',
    );
    expect(screen.getByTestId('quota-concurrent-editors')).toHaveTextContent(
      '9999',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('membership-upgrade')).toBeNull();
    // 联系邮箱保留，措辞换成商用授权与支持条款。
    expect(screen.getByTestId('membership-contact')).toHaveAttribute(
      'href',
      'mailto:breatic@orime.ai',
    );
  });

  it('企业版不显示上限数字，也不显示对比表', async () => {
    // 这一档的上限一家一谈、配置里没有，接口给的就是 null。
    membershipMock.mockResolvedValue(
      answer({ tier: 'enterprise', limits: null }),
    );
    setup();

    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'Enterprise',
    );
    expect(screen.getByTestId('enterprise-quota-note')).toBeInTheDocument();
    expect(screen.queryByTestId('quota-storage')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('超限时照实报数字，并说明已有内容仍可用', async () => {
    // 上限只在动作发生那一刻判，从不回头纠正已有的东西，所以超限是一个
    // 要如实显示的状态，不是错误、不隐藏、不挡住页面。
    membershipMock.mockResolvedValue(
      answer({
        tier: 'base',
        limits: limits({ team_studios: 0, storage_bytes: 5 * GIB }),
        usage: { teamStudios: 0, storageBytes: 38 * GIB },
      }),
    );
    setup();

    const storage = await screen.findByTestId('quota-storage');
    expect(storage).toHaveTextContent('38 GiB / 5 GiB');
    expect(storage).toHaveTextContent('over');
    expect(screen.getByTestId('over-limit-storage')).toBeInTheDocument();
  });

  it('加载中显示骨架，不是 spinner', async () => {
    membershipMock.mockReturnValue(new Promise(() => {}));
    setup();

    await waitFor(() => {
      expect(screen.getByTestId('membership-skeleton')).toBeInTheDocument();
    });
  });

  it('加载失败显示一行错误文案', async () => {
    membershipMock.mockRejectedValue(new Error('network'));
    setup();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('We could not read your membership');
  });
});
