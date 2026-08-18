// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * 会员面板（任务 #90）。
 *
 * 面板背后只有一个请求，所以它能渲染的每一种样子都由那一个答案决定。这个
 * 文件钉的是那些样子里、能在 jsdom 里判定的部分：
 *
 *   1. 正常档位：档位名、价格、账号级两项额度、各档对比表逐格的数字。
 *   2. 只列账号级那两项额度，其余四项在对比表里看，不在额度区重复。
 *   3. 自托管：六项数值全列（因为它没有对比表可看），不显示价格、对比表、
 *      升级按钮，但保留联系邮箱。
 *   4. 企业版：不显示上限数字、不显示对比表，说明额度由单独协议约定。
 *   5. 某项超限：数字照实显示并标已超出，跟一句说明。
 *   6. 加载中：骨架，不是整页 spinner。
 *   7. 加载失败：一行错误文案。
 *   8. 换账号之后不复用上一个账号的答案。
 *
 * 进度条画多满、当前列的底色深浅这类只有像素能判定的，靠真浏览器 smoke，
 * 不在这里断言 —— jsdom 没有布局。
 *
 * 升级按钮这一版点了没去处（块八未做），所以它压暗、带「尚未开放」，并且
 * 用 aria-disabled 而不是 disabled —— 后者会把它踢出键盘顺序。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AccountMembership,
  MembershipLimits,
  SubscriptionSummary,
} from '@breatic/shared';

import { MembershipPanel } from '@web/features/membership/MembershipPanel';
import { useCurrentUserStore } from '@web/stores/current-user';

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
 * 一份订阅，按需覆盖。
 * @param over - 要覆盖的字段。
 * @returns 完整的订阅。
 */
function subscription(
  over: Partial<SubscriptionSummary> = {},
): SubscriptionSummary {
  return {
    state: 'active',
    tier: 'pro',
    currentPeriodEnd: '2026-09-18T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    payableInvoiceUrl: null,
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
    // 三档每一项都取不同的值：这样每个格子的期望值在整张表里唯一，某一行
    // 读错字段、或者整列取错档，逐格断言才分得出来。
    catalog: [
      {
        tier: 'base',
        limits: {
          team_studios: 0,
          projects_per_studio: 10,
          concurrent_editors: 2,
          studio_members: 1,
          project_members: 4,
          storage_bytes: 5 * GIB,
        },
        priceCents: null,
        currency: null,
      },
      { tier: 'pro', limits: limits(), priceCents: 1200, currency: 'usd' },
      {
        tier: 'team',
        limits: {
          team_studios: 3,
          projects_per_studio: 300,
          concurrent_editors: 20,
          studio_members: 100,
          project_members: 40,
          storage_bytes: 500 * GIB,
        },
        priceCents: 3900,
        currency: 'usd',
      },
    ],
    subscription: null,
    ...over,
  };
}

/**
 * 让某个账号处于登录态。面板问的是「这个账号在哪一档」，所以它认账号。
 * @param id - 账号 id。
 */
function signIn(id: string): void {
  useCurrentUserStore.getState().setUser({
    id,
    name: id,
    email: `${id}@x.test`,
    personalStudio: null,
    membershipTier: 'base',
  });
}

/**
 * 渲染打开着的面板。
 * @param client - 想跨多次渲染共用同一份缓存时传进来。
 * @returns testing-library 的渲染结果。
 */
function setup(client?: QueryClient): ReturnType<typeof render> {
  const qc =
    client ??
    new QueryClient({
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
  useCurrentUserStore.getState().clear();
  signIn('u-default');
});

describe('MembershipPanel', () => {
  it('显示档位和账号级的两项额度', async () => {
    // 档位名下面那行现在讲订阅（下次扣费 / 期末结束 / 有款项没付成），
    // 不再是一个静态价格 —— 价格在对比表里，那行要说的是这个人的钱现在
    // 是什么情况。没有订阅的账号那行整个不出现。
    membershipMock.mockResolvedValue(answer());
    setup();

    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'PRO',
    );
    expect(screen.queryByTestId('subscription-billing-line')).toBeNull();
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

  it('只给高于当前档的那几格入口，低的什么都不标', async () => {
    // 拍定 2026-08-18：降级这个动作在界面上不存在。低档那几格留空 ——
    // 不是压暗的按钮，也不是「不能降」的提示，因为没有可点的东西就没有
    // 需要解释的事。
    membershipMock.mockResolvedValue(answer({ subscription: subscription() }));
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.getByTestId('membership-choose-team')).toBeInTheDocument();
    expect(screen.queryByTestId('membership-choose-base')).toBeNull();
    expect(screen.getByTestId('compare-action-base')).toBeEmptyDOMElement();
    expect(screen.getByTestId('compare-action-pro')).toHaveTextContent(
      'Current',
    );
  });

  it('从没订过的 Base 账号照样看得到升级入口', async () => {
    // 真机上抓到的：后端把「这个部署不卖订阅」和「这个账号还没订」都答成
    // null，前端据此把整行藏了 —— 结果是最需要那几个按钮的人反而看不到。
    membershipMock.mockResolvedValue(
      answer({
        tier: 'base',
        subscription: subscription({ state: 'none', tier: 'base', currentPeriodEnd: null }),
      }),
    );
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.getByTestId('membership-choose-pro')).toBeInTheDocument();
    expect(screen.getByTestId('membership-choose-team')).toBeInTheDocument();
    // 没有活订阅就没有可取消的东西。
    expect(screen.queryByTestId('membership-cancel')).toBeNull();
  });

  it('这个部署不卖订阅时，整行操作都不出现', async () => {
    // 自托管没有价目表这回事，摆一排点不动的按钮比什么都不摆更糟。
    membershipMock.mockResolvedValue(answer({ subscription: null }));
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.queryByTestId('compare-action-team')).toBeNull();
    expect(screen.queryByTestId('membership-cancel')).toBeNull();
  });

  it('正常订阅显示下次扣费日期和取消入口', async () => {
    membershipMock.mockResolvedValue(answer({ subscription: subscription() }));
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.getByTestId('subscription-billing-line')).toHaveTextContent(
      'Next charge',
    );
    expect(screen.getByTestId('membership-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('subscription-notice')).toBeNull();
  });

  it('已预约取消时说的是结束、给的是恢复', async () => {
    // 那天不会再扣钱，写「下次扣费」就是在说一笔不会发生的付款。
    membershipMock.mockResolvedValue(
      answer({
        subscription: subscription({ state: 'cancelling', cancelAtPeriodEnd: true }),
      }),
    );
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.getByTestId('subscription-billing-line')).toHaveTextContent(
      'Membership ends',
    );
    expect(screen.getByTestId('membership-resume')).toBeInTheDocument();
    expect(screen.queryByTestId('membership-cancel')).toBeNull();
  });

  it('扣款失败重试期间给说明和一个能自己付掉的入口', async () => {
    // 保住档位的另一半：那两周里他必须知道发生了什么，并且有一个自己把钱
    // 付掉的动作。这一格没有「下次扣费」，因为这个月的还没收上来。
    membershipMock.mockResolvedValue(
      answer({
        subscription: subscription({
          state: 'retrying',
          payableInvoiceUrl: 'https://invoice.example/pay',
        }),
      }),
    );
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.queryByTestId('subscription-billing-line')).toBeNull();
    expect(screen.getByTestId('subscription-notice')).toHaveTextContent(
      'did not go through',
    );
    expect(screen.getByTestId('subscription-pay-now')).toHaveAttribute(
      'href',
      'https://invoice.example/pay',
    );
  });

  it('升级待付款时档位不动，另给一条把差价付掉的路', async () => {
    membershipMock.mockResolvedValue(
      answer({
        subscription: subscription({
          state: 'upgradePending',
          payableInvoiceUrl: 'https://invoice.example/diff',
        }),
      }),
    );
    setup();

    await screen.findByTestId('current-tier-name');
    expect(screen.getByTestId('current-tier-name')).toHaveTextContent('PRO');
    expect(screen.getByTestId('subscription-notice')).toHaveTextContent(
      'Upgrade payment not completed',
    );
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
    // 自部署不向我们付费，所以价格一个字都不出现。
    expect(screen.queryByText(/\$\d/)).toBeNull();
    expect(screen.queryByText('Free')).toBeNull();
    // 联系邮箱保留，措辞换成商用授权与支持条款。
    const contact = screen.getByTestId('membership-contact-self-hosted');
    expect(contact).toHaveAttribute('href', 'mailto:breatic@orime.ai');
    expect(contact.parentElement).toHaveTextContent('commercial licence');
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
    // 这一档的额度只存在于协议里，用户读完「由单独协议约定」之后想问的
    // 正是「那是多少」——没有邮箱他就没有任何去处。
    const contact = screen.getByTestId('membership-contact-enterprise');
    expect(contact).toHaveAttribute('href', 'mailto:breatic@orime.ai');
    expect(contact.parentElement).toHaveTextContent('allowances');
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

  it('价目表档位在对比表下面有联系邮箱', async () => {
    // 用户看完三档发现都不够，视线往下正好碰到它。
    membershipMock.mockResolvedValue(answer());
    setup();

    const contact = await screen.findByTestId('membership-contact-priced');
    expect(contact).toHaveAttribute('href', 'mailto:breatic@orime.ai');
    expect(contact.parentElement).toHaveTextContent('bigger scale');
  });

  it('每一档都够得着一个联系邮箱，一个都不落', async () => {
    // 三处措辞不同，但没有哪一档是死路。
    const cases = [
      { tier: 'base' as const, limits: limits(), testId: 'membership-contact-priced' },
      { tier: 'self_hosted' as const, limits: limits(), testId: 'membership-contact-self-hosted' },
      { tier: 'enterprise' as const, limits: null, testId: 'membership-contact-enterprise' },
    ];
    for (const c of cases) {
      membershipMock.mockResolvedValue(answer({ tier: c.tier, limits: c.limits }));
      const view = setup();
      expect(await screen.findByTestId(c.testId)).toHaveAttribute(
        'href',
        'mailto:breatic@orime.ai',
      );
      view.unmount();
    }
  });

  it('对比表当前那一列整列有底色，别的列没有', async () => {
    // 当前档位那一列靠底色标出来（user 2026-08-16 拍的：整列换底色，不画
    // 竖线）。用的是 accent —— 亮色下比页面暗、暗色下比页面亮，两个主题
    // 下都看得出来；card 两个主题都往亮走，亮色下等于把该突出的那一列往
    // 背景里推。
    membershipMock.mockResolvedValue(answer());
    setup();

    const header = await screen.findByTestId('compare-column-pro');
    expect(header.className).toContain('bg-accent');
    const cells = document.querySelectorAll('[data-testid^="compare-cell-pro-"]');
    // 月费 + 六项上限。
    expect(cells).toHaveLength(7);
    for (const cell of cells) {
      expect(cell.className).toContain('bg-accent');
    }
    // 别的列没有。
    for (const cell of document.querySelectorAll('[data-testid^="compare-cell-base-"]')) {
      expect(cell.className).not.toContain('bg-accent');
    }
  });

  it('换账号之后不把上一个账号的答案端给下一个人', async () => {
    // 同一个标签页登出再登录，React Query 的 client 是模块单例、活得过这次
    // 跳转，而登出只清 zustand。缓存键里没有账号身份的话，第二个人打开面板
    // 命中的就是第一个人的档位和存储用量。
    // 缓存必须跨两次渲染共用，否则这条测试什么都证明不了。
    const shared = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    signIn('u-alpha');
    membershipMock.mockResolvedValue(answer());
    const first = setup(shared);
    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'PRO',
    );
    first.unmount();

    signIn('u-beta');
    membershipMock.mockResolvedValue(
      answer({ tier: 'base', limits: limits({ team_studios: 0 }) }),
    );
    setup(shared);

    expect(await screen.findByTestId('current-tier-name')).toHaveTextContent(
      'Base',
    );
    // 两个账号各问了一次；共用一个 key 的话第二次会被 staleTime 挡掉。
    expect(membershipMock).toHaveBeenCalledTimes(2);
  });

  it('对比表每一格都是那一档那一项的真实数字', async () => {
    // 这张表就是验收里「各档差别」的全部内容，而它的正确性此前只靠写的人
    // 当时没手滑：把某一行读成另一个字段、或者整列错位，都没有任何断言接得住。
    membershipMock.mockResolvedValue(answer());
    await screen.findByTestId('compare-column-pro').catch(() => undefined);
    setup();
    await screen.findByTestId('compare-column-pro');

    const expected: Record<string, [string, string, string]> = {
      // 行 key: [base, pro, team]
      monthlyFee: ['Free', '$12', '$39'],
      teamStudios: ['0', '1', '3'],
      projectsPerStudio: ['10', '100', '300'],
      studioMembers: ['1', '10', '100'],
      projectMembers: ['4', '12', '40'],
      concurrentEditors: ['2', '6', '20'],
      storage: ['5 GiB', '200 GiB', '500 GiB'],
    };
    for (const [row, [base, pro, team]] of Object.entries(expected)) {
      expect(screen.getByTestId(`compare-cell-base-${row}`)).toHaveTextContent(
        base,
      );
      expect(screen.getByTestId(`compare-cell-pro-${row}`)).toHaveTextContent(
        pro,
      );
      expect(screen.getByTestId(`compare-cell-team-${row}`)).toHaveTextContent(
        team,
      );
    }
  });

  it('自托管那四行各自读的是自己那一项', async () => {
    // 同理：四项全填同一个数的话，标签和数值接错看不出来。
    membershipMock.mockResolvedValue(
      answer({
        tier: 'self_hosted',
        limits: {
          team_studios: 7,
          projects_per_studio: 111,
          concurrent_editors: 22,
          studio_members: 33,
          project_members: 44,
          storage_bytes: 100 * 1024 ** 4,
        },
      }),
    );
    setup();

    expect(
      await screen.findByTestId('quota-projects-per-studio'),
    ).toHaveTextContent('111');
    expect(screen.getByTestId('quota-studio-members')).toHaveTextContent('33');
    expect(screen.getByTestId('quota-project-members')).toHaveTextContent('44');
    expect(screen.getByTestId('quota-concurrent-editors')).toHaveTextContent(
      '22',
    );
    // 账号级那两项照旧带用量。
    expect(screen.getByTestId('quota-team-studios')).toHaveTextContent('1 / 7');
    expect(screen.getByTestId('quota-storage')).toHaveTextContent(
      '38 GiB / 100 TiB',
    );
  });

  it('「各档对比」是表格第一列的表头，跟三个档位名同一行', async () => {
    // 它原本是表格上方一个单独的标题，于是第一列没有任何标签。
    membershipMock.mockResolvedValue(answer());
    setup();

    const table = await screen.findByRole('table');
    const headerRow = table.querySelectorAll('thead tr th');
    expect(headerRow).toHaveLength(4);
    expect(headerRow[0]).toHaveTextContent('Compare tiers');
    expect(headerRow[1]).toHaveTextContent('Base');
    expect(headerRow[3]).toHaveTextContent('Team');
    // 表格外面不再有第二个「各档对比」。
    expect(screen.getAllByText('Compare tiers')).toHaveLength(1);
  });
});
