// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  CreditLedgerView,
  CreditLotView,
  CreditOverview,
  PurchaseRow,
  StudioCreditSummary,
} from '@breatic/shared';

import { setLocale } from '@breatic/shared';

import { CreditsOverlay } from '@web/features/credits/CreditsOverlay';
import type { CreditsSectionId } from '@web/features/credits/credits-sections';
import { useCurrentUserStore } from '@web/stores/current-user';

const fetchCreditOverview = vi.fn();
const fetchCreditLots = vi.fn();
const fetchCreditLedger = vi.fn();
const designateCreditLot = vi.fn();
const requestCreditLotRefund = vi.fn();
vi.mock('@web/data/api/credits', () => ({
  fetchCreditOverview: () => fetchCreditOverview(),
  fetchCreditLots: (...args: unknown[]) => fetchCreditLots(...args),
  fetchCreditLedger: (...args: unknown[]) => fetchCreditLedger(...args),
  designateCreditLot: (...args: unknown[]) => designateCreditLot(...args),
  requestCreditLotRefund: (...args: unknown[]) =>
    requestCreditLotRefund(...args),
}));

const listUserStudios = vi.fn();
const paymentHistory = vi.fn();
const paymentTiers = vi.fn();
vi.mock('@web/data/api/payment', () => ({
  paymentApi: {
    tiers: () => paymentTiers(),
    checkout: vi.fn(),
    history: (...args: unknown[]) => paymentHistory(...args),
    resendConfirmation: vi.fn(),
  },
}));

/**
 * What `GET /payment/tiers` answers, in the shape the server sends.
 * @returns The packs and the refund rule.
 */
function tiers(): {
  packs: { name: string; credits: number; priceCents: number; currency: string }[];
  refundLines: string[];
  confirmTimeoutMs: number;
  } {
  return {
    packs: [
      { name: '830 Credits', credits: 830, priceCents: 1000, currency: 'usd' },
      { name: '1,700 Credits', credits: 1700, priceCents: 2000, currency: 'usd' },
    ],
    // The four sentences `refundLinesAt` reads out of `refund-credits-v1`,
    // copied from locales/en.json. A sentence of this file's own invention
    // would let a test pin wording the server never sends.
    refundLines: [
      'Bought within the last 30 days and haven\'t spent a single credit? Refunded in full, back to the original card.',
      'Spent any of them, even one? That pack can no longer be refunded.',
      'Past 30 days, packs are no longer refundable.',
      'Only a pack that is not assigned to a Studio can be refunded.',
    ],
    confirmTimeoutMs: 15000,
  };
}

vi.mock('@web/data/api/studios', () => ({
  studiosApi: { listUserStudios: () => listUserStudios() },
}));

// jsdom does not scroll, so the callback the hook is given is captured here
// and called directly. The element handed to `scrollerRef` is kept too: it is
// what the hook would watch, and nothing else in this file can see which box
// the overlay ended up passing down.
let reachEnd: (() => void) | null = null;
let watcherStopped: boolean | null = null;
let watched: HTMLElement | null = null;
vi.mock('@web/lib/use-scrolled-to-end', () => ({
  useScrolledToEnd: (opts: {
    enabled: boolean;
    onReachEnd: () => void;
    failed: boolean;
  }) => {
    reachEnd = opts.enabled ? opts.onReachEnd : null;
    watcherStopped = opts.failed;
    return {
      scrollerRef: (node: HTMLElement | null) => {
        if (node !== null) watched = node;
      },
      sentinelRef: () => {},
    };
  },
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
    underRefundCredits: 0,
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
  const base = {
    id: 'l1',
    purchasedCredits: 4550,
    remainingCredits: 2400,
    designatedStudioId: 's1' as string | null,
    designatedStudioName: 'Orime Studio' as string | null,
    paidCents: 5000,
    currency: 'usd',
    lifecycle: 'active' as CreditLotView['lifecycle'],
    refundAttempts: 0,
    everSpent: false,
    createdAt: '2026-08-21T10:00:00.000Z',
    ...over,
  };
  // The two say the same thing on every purchase a test writes, so the
  // fixture derives one from the other rather than asking each test to keep
  // them in step. A test that means to split them passes `designated`.
  return { designated: base.designatedStudioId !== null, ...base, ...over };
}

/**
 * One purchase, as the history reports it.
 * @param over - Fields to override.
 * @returns The row.
 */
function purchase(over: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    paymentId: 'p1',
    amountCents: 5000,
    totalCents: 5000,
    taxCents: 0,
    currency: 'usd',
    creditsGranted: 4550,
    remainingCredits: 2400,
    lifecycle: 'active',
    designatedStudioId: 's1',
    designatedStudioName: 'Orime Studio',
    status: 'completed',
    createdAt: '2026-08-21T10:00:00.000Z',
    canResend: false,
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
    kind: 'generation' as const,
    amount: -120,
    createdAt: '2026-08-22T10:00:00.000Z',
    ...over,
  };
}

/**
 * Open the overlay on one section.
 * @param section - Which section to show.
 * @param likeTheApp - Use the app's own caching (`QueryClientProvider.tsx`)
 *   instead of throwing every answer away. Only the cases about what makes a
 *   screen read again need it; the rest start clean.
 * @returns The userEvent session, for the tests that go on interacting.
 */
async function openOn(
  section: CreditsSectionId,
  likeTheApp = false,
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const qc = new QueryClient({
    defaultOptions: {
      queries: likeTheApp
        ? { retry: false, gcTime: 5 * 60 * 1000, staleTime: 30_000 }
        : { retry: false, gcTime: 0 },
    },
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

describe('the credits overlay, section by section', () => {
  beforeEach(() => {
    // The fixtures carry fixed dates, so the clock they are read against has
    // to be fixed too. The refunds screen drops a purchase once its thirty
    // days are up, which without this would turn every fixture into a test
    // that passes until a date and then stops. Only `Date` is taken over —
    // what has to hold still is which day it is, and leaving the timers alone
    // keeps this file at a fifth of the wall time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'));
    useCurrentUserStore.getState().clear();
    useCurrentUserStore.getState().setUser(ALEX);
    fetchCreditOverview.mockReset().mockResolvedValue(overview());
    fetchCreditLots
      .mockReset()
      .mockResolvedValue({ items: [lot()], nextCursor: null });
    paymentHistory
      .mockReset()
      .mockResolvedValue({ items: [purchase()], nextCursor: null });
    fetchCreditLedger
      .mockReset()
      .mockResolvedValue({ items: [entry()], nextCursor: null });
    designateCreditLot.mockReset().mockResolvedValue(lot());
    requestCreditLotRefund.mockReset().mockResolvedValue(undefined);
    listUserStudios.mockReset().mockResolvedValue([
      { id: 's1', name: 'Orime Studio', myStudioRole: 'admin' },
      { id: 's2', name: 'Design squad', myStudioRole: 'guest' },
    ]);
    toastWarning.mockReset();
    reachEnd = null;
    watcherStopped = null;
    watched = null;
    paymentTiers.mockReset().mockResolvedValue(tiers());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('overview', () => {
    it('reports three figures, the total being the other two added up', async () => {
      await openOn('overview');
      const body = await panel();

      // The three are not one figure: unassigned credits cannot be spent,
      // and a single total hides that.
      expect(body).toHaveTextContent('5,430');
      expect(body).toHaveTextContent('1,790');
      expect(body).toHaveTextContent('3,640');
    });

    it('gives the split a line per studio and one for the unassigned', async () => {
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent('Orime Studio 2,400');
      expect(body).toHaveTextContent(/Unassigned 1,790/);
    });

    it('drops the split when there is nothing, and says what to do instead', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({ assignedCredits: 0, unassignedCredits: 0, studios: [] }),
      );
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent(/assigned to a Studio/i);
      expect(body.querySelector('ul')).toBeNull();
    });

    it('dashes all three where the deployment charges nobody', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent(/does not charge credits/i);
      expect(body).not.toHaveTextContent('5,430');
    });
  });

  describe('purchases', () => {
    it('reports what was paid, when, what is left, of how much, and where it points', async () => {
      await openOn('lots');
      const body = await panel();

      // What was paid leads: it is the figure a reader checks against a
      // statement.
      expect(body).toHaveTextContent('$50.00');
      expect(body).toHaveTextContent('2026-08-21');
      expect(body).toHaveTextContent('2,400');
      expect(body).toHaveTextContent('of 4,550');
      expect(body).toHaveTextContent('Assigned to Orime Studio');
    });

    it('prompts when some point nowhere, and counts them right', async () => {
      paymentHistory.mockResolvedValue({
        items: [
          purchase(),
          purchase({ paymentId: 'p2', designatedStudioId: null, designatedStudioName: null }),
          purchase({ paymentId: 'p3', designatedStudioId: null, designatedStudioName: null }),
        ],
        nextCursor: null,
      });
      await openOn('lots');
      const body = await panel();

      expect(body).toHaveTextContent('2 purchases are unassigned');
    });

    it('leaves a purchase under refund out of that count', async () => {
      // Asking for a refund detaches it from every studio and bars it from
      // being pointed anywhere. Counting it asks the reader to do something
      // the server refuses.
      paymentHistory.mockResolvedValue({
        items: [
          purchase(),
          purchase({
            paymentId: 'p4',
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

    // "Unassigned" is what this panel teaches the reader to act on — assign
    // it to a Studio and it becomes spendable. On a purchase under refund
    // that reading is wrong twice over: the detachment is the refund's doing,
    // and the assign screen will not offer it.
    it('names where a purchase under refund stands, rather than calling it unassigned', async () => {
      paymentHistory.mockResolvedValue({
        items: [
          purchase({
            paymentId: 'p4',
            lifecycle: 'refund_pending',
            designatedStudioId: null,
            designatedStudioName: null,
          }),
        ],
        nextCursor: null,
      });
      await openOn('lots');
      const body = await panel();

      expect(body).toHaveTextContent('Under review');
      expect(body).not.toHaveTextContent(/^Unassigned$/m);
    });

    it('says nothing when every purchase points somewhere', async () => {
      await openOn('lots');
      const body = await panel();

      expect(body).not.toHaveTextContent(/are unassigned/);
    });

    it('does not reach the endpoint at all where nothing is charged', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('lots');
      const body = await panel();

      expect(body).toHaveTextContent(/does not charge credits/i);
      expect(paymentHistory).not.toHaveBeenCalled();
    });

    it('says so when the read fails, rather than showing nothing', async () => {
      paymentHistory.mockRejectedValue(new Error('nope'));
      await openOn('lots');

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });
  });

  describe('spending', () => {
    it('gives one generation one row, with all six columns', async () => {
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

    it('names a repayment for what it is instead of passing it off as a run', async () => {
      // It carries no project and no model. Two dashes there read as a run
      // that came from nowhere; the debt itself is the studio's and sits in
      // nobody's ledger.
      fetchCreditLedger.mockResolvedValue({
        items: [
          entry({
            kind: 'debt_repayment',
            amount: -70,
            projectName: null,
            model: null,
          }),
        ],
        nextCursor: null,
      });
      await openOn('ledger');
      const body = await panel();

      expect(body).toHaveTextContent('paying off debt');
      expect(body).toHaveTextContent('-70');
    });

    it('changes the column headings with the language', async () => {
      // `useTranslation` hands back a module-level constant. Its identity
      // survives a locale change, so a memo keyed on it alone keeps the
      // previous language on screen.
      await openOn('ledger');
      const body = await panel();
      expect(body).toHaveTextContent('Model');

      setLocale('zh-CN');
      await waitFor(() => {
        expect(screen.getByRole('tabpanel')).toHaveTextContent('模型');
      });
      setLocale('en');
    });

    it('passes the studio id to the endpoint when narrowing', async () => {
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

    it('lists usage even where nothing is charged', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('ledger');
      const body = await panel();

      // Being charged and having used something are two different facts, and
      // the second is recorded either way.
      expect(fetchCreditLedger).toHaveBeenCalled();
      expect(body).toHaveTextContent('seedream-4.0');
    });
  });

  describe('list mechanics', () => {
    it('keeps a repayment row six columns wide after merging two of them', async () => {
      fetchCreditLedger.mockResolvedValue({
        items: [
          entry({ kind: 'debt_repayment', projectName: null, model: null }),
          entry({ id: 'e2' }),
        ],
        nextCursor: null,
      });
      await openOn('ledger');
      const body = await panel();

      const head = body.querySelectorAll('thead th').length;
      for (const row of body.querySelectorAll('tbody tr')) {
        const span = [...row.querySelectorAll('td')].reduce(
          (n, td) => n + (Number(td.getAttribute('colspan')) || 1),
          0,
        );
        expect(span).toBe(head);
      }
    });

    it('pins a long list\'s heading to the top of the scroll container', async () => {
      await openOn('ledger');
      const body = await panel();

      const th = body.querySelector('thead');
      expect(th).not.toBeNull();
      expect(th!.className).toContain('sticky');
      expect(th!.className).toContain('top-0');
    });

    it('withholds the unassigned count while a further page is coming', async () => {
      // The count covers only the pages read so far, so stating it makes it
      // climb as the reader scrolls.
      paymentHistory.mockResolvedValue({
        items: [purchase({ designatedStudioId: null, designatedStudioName: null })],
        nextCursor: 'more',
      });
      await openOn('lots');
      const body = await panel();

      expect(body).not.toHaveTextContent(/are unassigned/);
    });

    it('keeps the sentinel on an empty refunds page with more to come', async () => {
      // An empty page that says there is more has to keep watching, or it
      // stops here for good.
      fetchCreditLots.mockResolvedValue({ items: [], nextCursor: 'more' });
      await openOn('refunds');
      const body = await panel();

      expect(body).toHaveTextContent(/No credit packs bought yet/i);
      // The sentinel has to be rendered on this branch. The hook watching it
      // is stubbed here, so asking whether the hook received a callback
      // cannot answer whether the element exists.
      expect(body.querySelector('[aria-hidden="true"]')).not.toBeNull();
    });

    it('scrolls the rows and leaves the heading where it is', async () => {
      // The heading names the section and the terms explain it, so both hold
      // whatever the rows are doing. Scrolling the whole column carries the
      // heading off on the first turn of the wheel.
      await openOn('ledger');
      const body = await panel();

      const viewport = body.querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement | null;
      expect(viewport).not.toBeNull();
      const heading = body.querySelector('h2');
      expect(heading).not.toBeNull();
      expect(viewport!.contains(heading!)).toBe(false);
    });

    it('starts a section at the top of its own list', async () => {
      // Each section brings its own scroller, so an offset left in one cannot
      // drop the reader into the middle of the next — where the sentinel may
      // already be in view, asking for a page nobody scrolled to.
      const user = await openOn('ledger');
      const first = (await panel()).querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      first.scrollTop = 400;

      await user.click(document.getElementById('credits-tab-studios')!);
      await waitFor(() => {
        expect(document.getElementById('credits-tab-studios')).toHaveAttribute(
          'aria-selected',
          'true',
        );
      });

      const next = (await panel()).querySelector(
        '[data-radix-scroll-area-viewport]',
      ) as HTMLElement;
      expect(next.scrollTop).toBe(0);
    });

    it('marks a run that drew on no purchase, and leaves the rest unmarked', async () => {
      fetchCreditLedger.mockResolvedValue({
        items: [
          entry({ id: 'u1', kind: 'unbilled', amount: -42 }),
          entry({ id: 'g1', kind: 'generation', amount: -12 }),
        ],
        nextCursor: null,
      });
      await openOn('ledger');
      const body = await panel();

      const rows = [...body.querySelectorAll('tbody tr')];
      expect(rows[0]!.querySelector('td:last-child')).toHaveTextContent(
        /Not charged/i,
      );
      // 真扣到包的那一行不带这个词，否则这个词什么也没说。
      expect(rows[1]!.querySelector('td:last-child')).not.toHaveTextContent(
        /Not charged/i,
      );
    });

    it('names what was paid, never what the credits would be worth', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [
          lot({
            remainingCredits: 880,
            paidCents: 1120,
            currency: 'usd',
            designatedStudioId: null,
          }),
        ],
        nextCursor: null,
      });
      await openOn('refunds');
      const body = await panel();

      // A refund is for the whole purchase, so one figure belongs on this
      // row: what was paid for it. The $8.80 the remaining credits work out
      // to is a partial refund, and there is no such thing.
      expect(body).toHaveTextContent('$11.20');
      expect(body).not.toHaveTextContent('$8.80');
    });

    it('waits for both reads before drawing a picker', async () => {
      // Waiting only for the purchases draws every row from an empty list of
      // studios: the assigned ones read as "you no longer administer this",
      // and the rest are left with nowhere to point.
      const held: { release: (v: unknown) => void } = { release: () => {} };
      listUserStudios.mockReturnValue(
        new Promise((resolve) => {
          held.release = resolve;
        }),
      );
      await openOn('assign');

      // The purchases have arrived and the studios have not. This moment is
      // a skeleton, not a picker.
      const body = await screen.findByRole('tabpanel');
      await waitFor(() => {
        expect(fetchCreditLots).toHaveBeenCalled();
      });
      expect(body.querySelector('[data-testid="credits-skeleton"]')).not.toBeNull();
      expect(body.querySelector('[role="combobox"]')).toBeNull();

      held.release([{ id: 's1', name: 'Alpha', myStudioRole: 'admin' }]);
      await waitFor(() => {
        expect(
          screen
            .getByRole('tabpanel')
            .querySelector('[data-testid="credits-skeleton"]'),
        ).toBeNull();
      });
    });

    it('says a page failed, and leaves the rows already in hand', async () => {
      paymentHistory
        .mockResolvedValueOnce({ items: [purchase()], nextCursor: 'c2' })
        .mockRejectedValueOnce(new Error('nope'));
      await openOn('lots');
      await panel();

      reachEnd!();
      await waitFor(() => {
        expect(paymentHistory).toHaveBeenCalledTimes(2);
      });

      // The first page is still there, and the foot is no longer blank.
      const body = await screen.findByRole('tabpanel');
      expect(body).toHaveTextContent('$50.00');
      expect(body).toHaveTextContent(/Could not load this page/i);
    });

    it('stops the watcher after a failed page until the reader scrolls again', async () => {
      paymentHistory
        .mockResolvedValueOnce({ items: [purchase()], nextCursor: 'c2' })
        .mockRejectedValueOnce(new Error('nope'));
      await openOn('lots');
      await panel();

      reachEnd!();
      await waitFor(() => {
        expect(paymentHistory).toHaveBeenCalledTimes(2);
      });
      // No retry of its own accord, and the first page stays: replacing what
      // the reader has already seen with a failure loses more than the
      // failure did.
      await new Promise((r) => setTimeout(r, 60));
      expect(paymentHistory).toHaveBeenCalledTimes(2);
      // 观察器收到的就是这个信号。断言它，而不是断言「没有再请求」——
      // 后者靠 react-query 的 retry:false 就成立，把接线删掉照样绿。
      expect(watcherStopped).toBe(true);
      expect(await screen.findByRole('tabpanel')).toHaveTextContent('$50.00');
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('per studio', () => {
    it('reports four things a row: spendable, debt, spent, purchases pointed there', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({ studios: [studio({ debt: 120 })] }),
      );
      await openOn('studios');
      const body = await panel();

      expect(body).toHaveTextContent('2,400');
      expect(body).toHaveTextContent('owes 120');
      expect(body).toHaveTextContent('spent 1,280');
      expect(body).toHaveTextContent('1 purchase assigned to it');
    });

    it('withholds the debt from a reader who no longer administers it', async () => {
      // 欠账是 studio 自己的数，只有 admin 能拿它做决定。服务端在这种情形
      // 下发的是 null，这一行要说得出「不是零、是没有」。
      fetchCreditOverview.mockResolvedValue(
        overview({ studios: [studio({ debt: null, spent: 640 })] }),
      );
      await openOn('studios');
      const body = await panel();

      expect(body).toHaveTextContent('640');
      expect(body).not.toHaveTextContent(/owes/i);
    });

    it('keeps a deleted studio\'s name and adds a badge', async () => {
      // The row is kept so the spending can say where it went. Replacing the
      // name with "deleted studio" erases it a second time — the reader can
      // no longer tell which one it was.
      fetchCreditOverview.mockResolvedValue(
        overview({
          studios: [
            studio({
              studioId: 's3',
              studioName: 'Design squad',
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

      expect(body).toHaveTextContent('Design squad');
      expect(body).toHaveTextContent('Deleted');
    });

    it('keeps a deleted studio, reports its spending, and dashes the balance', async () => {
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

      // The money really was spent; dropping the row leaves the spending
      // column not adding up.
      expect(body).toHaveTextContent('spent 880');
      expect(body).toHaveTextContent('Deleted');
      expect(body).toHaveTextContent('—');
    });
  });

  describe('loading, empty, failed, and paging', () => {
    it.each([
      ['lots' as const, () => paymentHistory],
      ['ledger' as const, () => fetchCreditLedger],
      ['assign' as const, () => fetchCreditLots],
      ['refunds' as const, () => fetchCreditLots],
    ])('%s says so when its read fails', async (section, mock) => {
      mock().mockRejectedValue(new Error('nope'));
      await openOn(section);

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });

    it.each([
      ['lots' as const, /No purchases yet/i],
      ['ledger' as const, /Nothing spent yet/i],
      ['assign' as const, /Nothing to assign/i],
      ['refunds' as const, /No credit packs bought yet/i],
    ])('%s says what is missing when it is empty', async (section, message) => {
      fetchCreditLots.mockResolvedValue({ items: [], nextCursor: null });
      fetchCreditLedger.mockResolvedValue({ items: [], nextCursor: null });
      paymentHistory.mockResolvedValue({ items: [], nextCursor: null });
      await openOn(section);
      const body = await panel();

      expect(body).toHaveTextContent(message);
    });

    it('shows a skeleton while the first read is in flight', async () => {
      // Held unresolved: this is the moment the reader sees.
      paymentHistory.mockReturnValue(new Promise(() => {}));
      await openOn('lots');

      expect(
        await screen.findByTestId('credits-skeleton'),
      ).toBeInTheDocument();
    });

    it('asks again with the cursor once the reader reaches the end', async () => {
      paymentHistory
        .mockResolvedValueOnce({ items: [purchase()], nextCursor: 'cursor-2' })
        .mockResolvedValueOnce({
          items: [purchase({ paymentId: 'p2', totalCents: 777 })],
          nextCursor: null,
        });
      await openOn('lots');
      await panel();

      // jsdom does not scroll, so the callback the hook was given is called
      // directly. What is under test is whether the cursor comes back on the
      // next request, not the IntersectionObserver.
      expect(reachEnd).not.toBeNull();
      reachEnd!();

      await waitFor(() => {
        expect(paymentHistory).toHaveBeenLastCalledWith('cursor-2');
      });
      // The second page's rows follow the first rather than replacing it.
      const body = await screen.findByRole('tabpanel');
      expect(body).toHaveTextContent('$50.00');
      expect(body).toHaveTextContent('$7.77');
    });
  });

  describe('buying credits', () => {
    it('gives the balance, how credits are priced, and the packs on offer', async () => {
      await openOn('buy');
      const body = await panel();

      expect(body).toHaveTextContent('5,430');
      expect(body).toHaveTextContent('1 credit = 1 US cent');
      await waitFor(() => {
        expect(body.querySelectorAll('[data-testid="credit-pack"]')).toHaveLength(2);
      });
    });

    it('names the figure what the overview names it', async () => {
      // The figure is assigned plus unassigned, and the overview calls that
      // the account total. Calling the same sum available here contradicts
      // the line beside it there, which says the unassigned part is not.
      await openOn('buy');
      const body = await panel();

      expect(body).toHaveTextContent(/Account total/i);
      expect(body).not.toHaveTextContent(/Available now/i);
    });

    it('offers no top-up where the deployment charges nobody', async () => {
      fetchCreditOverview.mockResolvedValue(overview({ billing: false }));
      await openOn('buy');
      const body = await panel();

      expect(body).not.toHaveTextContent(/opens soon/i);
      expect(body).toHaveTextContent(/does not charge credits/i);
    });
  });

  describe('assigning', () => {
    it('asks only for the active purchases', async () => {
      await openOn('assign');
      await panel();

      expect(fetchCreditLots).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: 'active' }),
      );
    });

    it('fails visibly when the studios cannot be read', async () => {
      // Either read failing leaves this section unable to do its one job.
      // Reporting only one of them leaves the picker silently down to a
      // single option when the other fails.
      listUserStudios.mockRejectedValue(new Error('nope'));
      await openOn('assign');

      expect(await screen.findByRole('alert')).toBeInTheDocument();
    });

    it('offers only the studios this account administers', async () => {
      const user = await openOn('assign');
      await panel();

      await user.click(screen.getByRole('combobox'));

      expect(await screen.findByRole('option', { name: 'Orime Studio' })).toBeInTheDocument();
      // A studio held as a guest cannot be pointed at, so offering it offers
      // a rejection.
      expect(screen.queryByRole('option', { name: 'Design squad' })).toBeNull();
    });

    it('still names where a purchase points when that studio is beyond reach', async () => {
      // A purchase pointed at a team, and the account demoted there since.
      // The options answer "where may it go"; the picker shows "where is it
      // now". With the second outside the first, Radix matches nothing and
      // the cell reads empty, leaving the reader unable to find the money.
      fetchCreditLots.mockResolvedValue({
        items: [
          lot({ designatedStudioId: 's9', designatedStudioName: 'Ex team' }),
        ],
        nextCursor: null,
      });
      await openOn('assign');
      const body = await panel();

      expect(within(body).getByRole('combobox')).toHaveTextContent('Ex team');
    });

    it('sends the purchase to the endpoint when it is repointed', async () => {
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

    it('makes the purchase history read again once a purchase is repointed', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [lot({ designatedStudioId: null, designatedStudioName: null })],
        nextCursor: null,
      });
      // Open the history once so its query is in the cache, then repoint from
      // the assign screen. Where a purchase points is on every row of that
      // list, so it has to be read again — the two screens are backed by
      // different keys and nothing else connects them.
      const user = await openOn('lots', true);
      await panel();
      await waitFor(() => {
        expect(paymentHistory).toHaveBeenCalledTimes(1);
      });

      await user.click(document.getElementById('credits-tab-assign')!);
      await panel();
      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Orime Studio' }));
      await waitFor(() => {
        expect(designateCreditLot).toHaveBeenCalled();
      });

      // Back to the list the buyer would go and check. Its answer is thirty
      // seconds fresh, so it reads again only because repointing marked it
      // stale — without that it would still be saying "unassigned".
      await user.click(document.getElementById('credits-tab-lots')!);
      await panel();
      await waitFor(() => {
        expect(paymentHistory.mock.calls.length).toBeGreaterThan(1);
      });
    });

    it('takes a purchase back with null rather than an empty string', async () => {
      const user = await openOn('assign');
      await panel();

      await user.click(screen.getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Unassigned' }));

      await waitFor(() => {
        expect(designateCreditLot).toHaveBeenCalledWith('l1', null);
      });
    });
  });

  describe('the overview while a purchase is under refund', () => {
    it('names the third figure and counts it in the total', async () => {
      // The other two only count what is spendable, so without this one the
      // total drops by the purchase the moment it is asked about and nothing
      // on the screen says where it went.
      fetchCreditOverview.mockResolvedValue(
        overview({
          assignedCredits: 100,
          unassignedCredits: 40,
          underRefundCredits: 25,
        }),
      );
      await openOn('overview');
      const body = await panel();

      expect(body).toHaveTextContent(/Under refund/i);
      expect(body).toHaveTextContent('165');
    });

    it('leaves the figure out when nothing is under refund', async () => {
      fetchCreditOverview.mockResolvedValue(
        overview({ underRefundCredits: 0 }),
      );
      await openOn('overview');
      const body = await panel();

      expect(body).not.toHaveTextContent(/Under refund/i);
    });
  });

  describe('refunds', () => {
    it('asks for a refund on the purchase whose button was confirmed', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [lot({ id: 'l1', designatedStudioId: null })],
        nextCursor: null,
      });
      const user = await openOn('refunds');
      const body = await panel();

      const button = within(body).getByRole('button', { name: /refund/i });
      expect(button).not.toHaveAttribute('aria-disabled');
      await user.click(button);

      const dialog = await screen.findByRole('alertdialog');
      await user.click(
        within(dialog).getByRole('button', { name: /^ask for a refund$/i }),
      );

      expect(requestCreditLotRefund).toHaveBeenCalledWith('l1');
    });

    it('sends nothing when the buyer backs out of the confirmation', async () => {
      // The ask is what the confirmation is for: once sent, the purchase
      // waits on a decision this screen cannot take back.
      fetchCreditLots.mockResolvedValue({
        items: [lot({ id: 'l1', designatedStudioId: null })],
        nextCursor: null,
      });
      const user = await openOn('refunds');
      const body = await panel();

      await user.click(within(body).getByRole('button', { name: /refund/i }));
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(requestCreditLotRefund).not.toHaveBeenCalled();
    });

    // Three screens read purchases and each wants a different subset, so each
    // holds its own react-query key. Sharing one would let the purchases
    // screen — which lists payments that never became a lot — fill the cache
    // this screen then reads, and rows with no lot would land under a heading
    // offering to refund them.
    it('reads its own list rather than the one the purchases screen filled', async () => {
      const user = await openOn('lots', true);
      await panel();
      fetchCreditLots.mockClear();

      await user.click(document.getElementById('credits-tab-refunds')!);
      await panel();

      // A shared key would have served this screen from that cache instead.
      expect(fetchCreditLots).toHaveBeenCalled();
    });

    it('says so when the account never bought anything', async () => {
      fetchCreditLots.mockResolvedValue({ items: [], nextCursor: null });
      await openOn('refunds');
      const body = await panel();

      expect(body).toHaveTextContent(/No credit packs bought yet/i);
    });

    // The terms are read back from the version the purchase was made under,
    // rather than summarised beside the list. A summary said two of the four
    // rules, and the two it left out are the ones a buyer acts on.
    it('prints the refund terms in full under the list', async () => {
      await openOn('refunds');
      await panel();

      const terms = await screen.findByTestId('refunds-terms');
      expect(within(terms).getAllByRole('listitem')).toHaveLength(4);
      expect(terms).toHaveTextContent('not assigned to a Studio');
    });

    // The terms are the only place this screen states the rule, so a screen
    // that could not read them says so. Silence there reads as "this screen
    // has no terms", and the reader is left to work out from the rows alone
    // why one carries a button and the next does not.
    it('says so when the refund terms could not be read', async () => {
      paymentTiers.mockRejectedValue(new Error('nope'));
      await openOn('refunds');

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /Could not load/i,
      );
      expect(screen.queryByTestId('refunds-terms')).toBeNull();
    });

    // A list terminator under a list that was never drawn reads as a second,
    // contradictory answer to the same question.
    it('leaves the list terminator off when there is no list', async () => {
      fetchCreditLots.mockResolvedValue({ items: [], nextCursor: null });
      await openOn('refunds');
      const body = await panel();

      expect(body).toHaveTextContent(/No credit packs bought yet/i);
      expect(body).not.toHaveTextContent(/No more/i);
    });

    // The ask is sent and the row has not caught up yet. Leaving the button
    // live in that gap reads as a press that did not register, and pressing
    // again earns a red toast for an action that in fact succeeded.
    it('keeps the button down until the row it changed comes back', async () => {
      fetchCreditLots.mockResolvedValue({
        items: [lot({ id: 'l1', designatedStudioId: null })],
        nextCursor: null,
      });
      requestCreditLotRefund.mockResolvedValue(undefined);
      const user = await openOn('refunds');
      const body = await panel();

      await user.click(within(body).getByRole('button', { name: /refund/i }));
      const dialog = await screen.findByRole('alertdialog');
      // The read that follows the ask never answers, so the row stays as the
      // browser already has it.
      fetchCreditLots.mockReturnValue(new Promise(() => {}));
      await user.click(
        within(dialog).getByRole('button', { name: /^ask for a refund$/i }),
      );
      await waitFor(() => {
        expect(requestCreditLotRefund).toHaveBeenCalledTimes(1);
      });

      expect(screen.getByRole('button', { name: /refund/i })).toBeDisabled();
    });

    // What scrolls is the box around the rows, not the panel: the heading and
    // the terms stay on screen while the rows move under them. Nothing else
    // in this file can see which element the overlay passed down, so the
    // element the paging hook was handed is what gets asserted.
    it('watches the box around the rows, not the whole panel', async () => {
      await openOn('refunds');
      const body = await panel();

      expect(watched).not.toBeNull();
      expect(watched!.contains(within(body).getByText(/\$50\.00/))).toBe(true);
      expect(
        watched!.contains(within(body).getByRole('heading', { level: 2 })),
      ).toBe(false);
      expect(watched!.contains(screen.getByTestId('refunds-terms'))).toBe(
        false,
      );
    });

    // A pack the buyer cannot find here is a pack he has to guess about, so
    // every pack appears and each says where it stands. The right column of a
    // row answers one question — can this be refunded — with the ask button
    // when it can and the state when it cannot.
    describe('every pack appears, carrying where it stands', () => {
      it('offers the ask on one the rule allows', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [lot({ id: 'ok', designatedStudioId: null })],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(
          within(body).getByRole('button', { name: /refund/i }),
        ).toBeInTheDocument();
      });

      it('names the studio a pack is assigned to', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [lot({ id: 'assigned', designatedStudioId: 's1' })],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Assigned to Orime Studio/i);
        expect(body).toHaveTextContent(/unassign it to ask for a refund/i);
        expect(
          within(body).queryByRole('button', { name: /refund/i }),
        ).toBeNull();
      });

      it('marks one that has been spent from', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'spent',
              remainingCredits: 818,
              everSpent: true,
              designatedStudioId: null,
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Already used/i);
        expect(
          within(body).queryByRole('button', { name: /refund/i }),
        ).toBeNull();
      });

      it('marks one spent to nothing, counting what it held', async () => {
        // The balance is gone, so a count of what is left would read as a
        // mistake; what it was bought with is what identifies the purchase.
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'empty',
              purchasedCredits: 4550,
              remainingCredits: 0,
              everSpent: true,
              lifecycle: 'depleted',
              designatedStudioId: null,
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/4,?550 credits in all/i);
        expect(
          within(body).queryByRole('button', { name: /refund/i }),
        ).toBeNull();
      });

      it('marks one bought more than thirty days ago', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'stale',
              createdAt: '2026-07-01T00:00:00.000Z',
              designatedStudioId: null,
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Over 30 days/i);
        expect(
          within(body).queryByRole('button', { name: /refund/i }),
        ).toBeNull();
      });

      it('offers the ask past thirty days when the first ask was refused', async () => {
        // Same purchase date as the one above; the one difference is that
        // this buyer already asked while the window was open. The window runs
        // from that ask, so however long the decision took, they keep the
        // right — and the server answers the same way.
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'refused',
              createdAt: '2026-07-01T00:00:00.000Z',
              designatedStudioId: null,
              refundAttempts: 1,
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(
          within(body).getByRole('button', { name: /refund/i }),
        ).toBeInTheDocument();
      });

      it('keeps the ask on the thirtieth day, which counts in full', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'lastday',
              createdAt: '2026-07-26T23:00:00.000Z',
              designatedStudioId: null,
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(
          within(body).getByRole('button', { name: /refund/i }),
        ).toBeInTheDocument();
      });

      it('names the step a pack under review is at', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [lot({ id: 'pending', lifecycle: 'refund_pending' })],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Under review/i);
        expect(body).toHaveTextContent(/while it is under review/i);
      });

      it('names the step a pack being refunded is at', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [lot({ id: 'refunding', lifecycle: 'refunding' })],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/while the money goes back/i);
      });

      it('keeps a refunded pack on the list, saying where the money went', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [lot({ id: 'gone', lifecycle: 'refunded' })],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Back to the original payment method/i);
        expect(
          within(body).queryByRole('button', { name: /refund/i }),
        ).toBeNull();
      });
    });

    // Unassigning is the one thing a buyer can do about a refusal, so the row
    // names it only when it would work. Naming it on a purchase refused on
    // another count sends them to undo a designation for nothing.
    describe('when a pack fails more than one condition', () => {
      it('names the spending rather than the designation', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({ id: 'both', everSpent: true, designatedStudioId: 's1' }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Already used/i);
        expect(body).not.toHaveTextContent(/unassign it/i);
      });

      it('names the closed window rather than the designation', async () => {
        fetchCreditLots.mockResolvedValue({
          items: [
            lot({
              id: 'stale-assigned',
              createdAt: '2026-07-01T00:00:00.000Z',
              designatedStudioId: 's1',
            }),
          ],
          nextCursor: null,
        });
        await openOn('refunds');
        const body = await panel();

        expect(body).toHaveTextContent(/Over 30 days/i);
        expect(body).not.toHaveTextContent(/unassign it/i);
      });
    });
  });
});
