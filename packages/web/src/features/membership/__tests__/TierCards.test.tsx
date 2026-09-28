// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What each card offers, driven through the component rather than the rule.
 *
 * `membership-card-action.test.ts` pins `cardAction` itself. This file asks
 * the separate question the rule cannot answer: that the grid feeds it the
 * right inputs and renders each of its answers as the right control. A rule
 * that is correct and a page that calls it with the wrong period produce the
 * same green run otherwise.
 *
 * The matrix is four cards over two periods over all seven situations, which
 * is the acceptance item as written (#253 A4). The account holds PRO monthly
 * wherever it holds anything, so one pass covers a tier below, the tier
 * itself and a tier above, and the yearly pass covers what lengthening the
 * period does to each of them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BILLING_PERIODS,
  SUBSCRIPTION_SITUATIONS,
  type BillingPeriod,
  type MembershipLimits,
  type MoveOffer,
  type ComparableMembershipTier,
  type SubscriptionSituation,
  type TierOffer,
} from '@breatic/shared';

import { TierCards } from '@web/features/membership/TierCards';

const GIB = 1024 ** 3;

/**
 * One tier's ceilings, overridable per case.
 * @param over - The ceilings to change.
 * @returns A full set of ceilings.
 */
function limits(over: Partial<MembershipLimits> = {}): MembershipLimits {
  return {
    team_studios: 1,
    projects_per_studio: 100,
    studio_members: 10,
    project_members: 12,
    concurrent_editors: 6,
    storage_bytes: 200 * GIB,
    ...over,
  };
}

/** The ratified price list: two prices per priced tier, free tier has none. */
const CATALOG: readonly TierOffer[] = [
  {
    tier: 'base',
    limits: limits({ team_studios: 0, concurrent_editors: 2, storage_bytes: 5 * GIB }),
    prices: { month: null, year: null },
  },
  {
    tier: 'pro',
    limits: limits(),
    prices: {
      month: { priceCents: 1999, currency: 'usd' },
      year: { priceCents: 19999, currency: 'usd' },
    },
  },
  {
    tier: 'team',
    limits: limits({ team_studios: 3, concurrent_editors: 20, storage_bytes: 500 * GIB }),
    prices: {
      month: { priceCents: 7999, currency: 'usd' },
      year: { priceCents: 79999, currency: 'usd' },
    },
  },
];

/**
 * The same tiers as a deployment that sells nothing reports them.
 *
 * `pricesOf` short-circuits on `selling` before it looks at the tier, so
 * every row comes back with both periods null — including the priced ones.
 */
const UNPRICED: readonly TierOffer[] = CATALOG.map((offer) => ({
  ...offer,
  prices: { month: null, year: null },
}));

/** The position an account is in while its subscription sits in one situation. */
interface Position {
  /** The tier in force, which is not always the tier that was paid for. */
  readonly accountTier: ComparableMembershipTier;
  /** The stored subscription's period, null where there is no subscription. */
  readonly heldPeriod: BillingPeriod | null;
  /** Whether a move can be started from here. */
  readonly move: MoveOffer;
}

/**
 * Where each situation leaves an account that bought PRO monthly.
 *
 * Straight out of the design's own table (#253 §3.2). The three that have
 * bought nothing report `base`, which is what `subscription-state.ts` returns
 * for them, and that is exactly what keeps the Starter card from reading as
 * "current" while a first invoice is outstanding.
 */
const POSITIONS: Record<SubscriptionSituation, Position> = {
  none: { accountTier: 'base', heldPeriod: null, move: 'offered' },
  firstPaymentUnsettled: { accountTier: 'base', heldPeriod: 'month', move: 'offered' },
  active: { accountTier: 'pro', heldPeriod: 'month', move: 'offered' },
  cancelling: { accountTier: 'pro', heldPeriod: 'month', move: 'offered' },
  upgradePending: { accountTier: 'pro', heldPeriod: 'month', move: 'pending' },
  retrying: { accountTier: 'pro', heldPeriod: 'month', move: 'withheld' },
  unexpected: { accountTier: 'base', heldPeriod: null, move: 'offered' },
};

/** What one card shows: a button's words, the current badge, or nothing. */
type Shown = 'choose' | 'inProgress' | 'current' | 'nothing' | 'contactSales';

/**
 * The whole matrix, one entry per period per situation.
 *
 * Read against §3.2: the monthly pass is the account looking at what it
 * already pays for, the yearly pass is the same account looking at a longer
 * period — where the tier it holds stops being "current" and becomes
 * something it can move to.
 */
const MATRIX: Record<
  BillingPeriod,
  Record<SubscriptionSituation, Record<'base' | 'pro' | 'team', Shown>>
> = {
  month: {
    none: { base: 'nothing', pro: 'choose', team: 'choose' },
    firstPaymentUnsettled: { base: 'nothing', pro: 'choose', team: 'choose' },
    active: { base: 'nothing', pro: 'current', team: 'choose' },
    cancelling: { base: 'nothing', pro: 'current', team: 'choose' },
    upgradePending: { base: 'nothing', pro: 'current', team: 'inProgress' },
    retrying: { base: 'nothing', pro: 'current', team: 'nothing' },
    unexpected: { base: 'nothing', pro: 'choose', team: 'choose' },
  },
  year: {
    none: { base: 'nothing', pro: 'choose', team: 'choose' },
    firstPaymentUnsettled: { base: 'nothing', pro: 'choose', team: 'choose' },
    // Holding PRO monthly, the yearly view offers the same tier over the
    // longer period — a move, not the card in force.
    active: { base: 'nothing', pro: 'choose', team: 'choose' },
    cancelling: { base: 'nothing', pro: 'choose', team: 'choose' },
    upgradePending: { base: 'nothing', pro: 'inProgress', team: 'inProgress' },
    retrying: { base: 'nothing', pro: 'nothing', team: 'nothing' },
    unexpected: { base: 'nothing', pro: 'choose', team: 'choose' },
  },
};

/**
 * Reads what a card is showing, without caring how it is marked up.
 * @param tier - Which card to read.
 * @returns What that card offers.
 */
function shown(tier: 'base' | 'pro' | 'team'): Shown {
  if (screen.queryByTestId(`tier-current-${tier}`)) return 'current';
  const button = screen.queryByTestId(`membership-choose-${tier}`);
  if (!button) return 'nothing';
  return button.hasAttribute('disabled') ? 'inProgress' : 'choose';
}

/**
 * Renders the grid for one cell of the matrix.
 * @param period - Which period the switcher is on.
 * @param situation - Which situation the subscription is in.
 * @param onChoose - What a press should call.
 */
function renderGrid(
  period: BillingPeriod,
  situation: SubscriptionSituation,
  onChoose: (chosen: {
    tier: 'pro' | 'team' | 'base';
    period: BillingPeriod;
  }) => void = vi.fn(),
): void {
  const position = POSITIONS[situation];
  render(
    <TierCards
      offers={CATALOG}
      currentTier={position.accountTier}
      selectedPeriod={period}
      situation={situation}
      heldPeriod={position.heldPeriod}
      sellsSubscriptions
      move={position.move}
      busy={false}
      choosing={null}
      onChoose={onChoose}
    />,
  );
}

describe('TierCards — four cards, two periods, seven situations', () => {
  beforeEach(() => {
    cleanup();
  });

  for (const period of BILLING_PERIODS) {
    for (const situation of SUBSCRIPTION_SITUATIONS) {
      it(`${period} · ${situation}: each card shows what the rule says`, () => {
        renderGrid(period, situation);
        for (const card of ['base', 'pro', 'team'] as const) {
          expect(shown(card), `${card} card`).toBe(MATRIX[period][situation][card]);
        }
        // The fourth card never sells anything, so no situation changes it.
        expect(screen.getByTestId('membership-contact-sales')).toHaveAttribute(
          'href',
          'mailto:breatic@orime.ai',
        );
      });
    }
  }

  it('leaves every priced card blank where this deployment sells nothing', () => {
    render(
      <TierCards
        offers={CATALOG}
        currentTier='base'
        selectedPeriod='year'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions={false}
        move='offered'
        busy={false}
        choosing={null}
        onChoose={vi.fn()}
      />,
    );

    for (const card of ['base', 'pro', 'team'] as const) {
      expect(shown(card)).toBe('nothing');
    }
    // The conversation is still on offer: it was never a purchase.
    expect(screen.getByTestId('membership-contact-sales')).toBeInTheDocument();
  });

  it('quotes no price where nothing is sold, rather than calling PRO free', () => {
    // Two different nulls reach this slot. The free tier has none because it
    // costs nothing. A priced tier has none where this deployment sells
    // nothing — and "Free" there is a claim that PRO costs nothing.
    render(
      <TierCards
        offers={UNPRICED}
        currentTier='base'
        selectedPeriod='year'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions={false}
        move='offered'
        busy={false}
        choosing={null}
        onChoose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('tier-price-base')).toHaveTextContent('Free');
    for (const card of ['pro', 'team'] as const) {
      const price = screen.getByTestId(`tier-price-${card}`);
      expect(price).not.toHaveTextContent('Free');
      expect(price.textContent?.trim()).toBe('—');
    }
  });

  it('presses with the card it is on and the period the switcher is on', async () => {
    const onChoose = vi.fn();
    const user = userEvent.setup();
    renderGrid('year', 'none', onChoose);

    await user.click(screen.getByTestId('membership-choose-team'));
    expect(onChoose).toHaveBeenCalledWith({ tier: 'team', period: 'year' });
  });

  it('waits while another action is running', () => {
    render(
      <TierCards
        offers={CATALOG}
        currentTier='base'
        selectedPeriod='month'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions
        move='offered'
        busy
        choosing={null}
        onChoose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('membership-choose-pro')).toBeDisabled();
  });

  it('spins only the card whose tier and period are the ones being moved to', () => {
    const { rerender } = render(
      <TierCards
        offers={CATALOG}
        currentTier='base'
        selectedPeriod='month'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions
        move='offered'
        busy
        choosing={{ tier: 'pro', period: 'month' }}
        onChoose={vi.fn()}
      />,
    );
    const pro = screen.getByTestId('membership-choose-pro');
    expect(within(pro).getByTestId('membership-choose-pending')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('membership-choose-team')).queryByTestId(
        'membership-choose-pending',
      ),
    ).toBeNull();

    // The same tier on the other period is a different offer.
    rerender(
      <TierCards
        offers={CATALOG}
        currentTier='base'
        selectedPeriod='year'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions
        move='offered'
        busy
        choosing={{ tier: 'pro', period: 'month' }}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('membership-choose-pending')).toBeNull();
  });
});

describe('TierCards — the figures on the cards', () => {
  beforeEach(() => {
    cleanup();
  });

  it('quotes the monthly price on the monthly view', () => {
    renderGrid('month', 'none');
    expect(screen.getByTestId('tier-price-pro')).toHaveTextContent('$19.99');
    expect(screen.getByTestId('tier-price-team')).toHaveTextContent('$79.99');
  });

  it('quotes the yearly price on the yearly view', () => {
    renderGrid('year', 'none');
    expect(screen.getByTestId('tier-price-pro')).toHaveTextContent('$199.99');
    expect(screen.getByTestId('tier-price-team')).toHaveTextContent('$799.99');
  });

  it('says how much a year saves, as a percentage off the monthly price', () => {
    // 19999 against 1999 x 12 is 16.63% off, and 79999 against 7999 x 12 is
    // 16.66% — both round to 17. The figure is worked out from the two
    // prices, so a change to either one keeps the sentence true.
    renderGrid('year', 'none');
    expect(screen.getByTestId('tier-note-pro')).toHaveTextContent('17%');
    expect(screen.getByTestId('tier-note-team')).toHaveTextContent('17%');
  });

  it('keeps that line off the monthly view and off the free card', () => {
    renderGrid('month', 'none');
    expect(screen.getByTestId('tier-note-pro')).toBeEmptyDOMElement();

    cleanup();
    renderGrid('year', 'none');
    expect(screen.getByTestId('tier-note-base')).toBeEmptyDOMElement();
  });

  it('offers the free tier as free rather than as a price of zero', () => {
    renderGrid('year', 'none');
    expect(screen.getByTestId('tier-price-base')).toHaveTextContent('Free');
    expect(screen.getByTestId('tier-price-base')).not.toHaveTextContent('0.00');
  });

  it('quotes nothing on the card whose terms are agreed one at a time', () => {
    renderGrid('year', 'none');
    expect(screen.getByTestId('tier-price-enterprise')).toHaveTextContent(
      'On request',
    );
  });

  it('counts one team studio in the singular', () => {
    // PRO grants exactly one, and "1 Team Studios" is not English. Every
    // other counted sentence in this product uses an ICU plural.
    renderGrid('month', 'none');
    expect(screen.getByTestId('tier-card-pro')).toHaveTextContent(
      '1 Team Studio',
    );
    expect(screen.getByTestId('tier-card-pro')).not.toHaveTextContent(
      '1 Team Studios',
    );
    expect(screen.getByTestId('tier-card-team')).toHaveTextContent(
      '3 Team Studios',
    );
    // Zero reads as a sentence of its own, the way the rest of the product
    // writes a zero ceiling.
    expect(screen.getByTestId('tier-card-base')).not.toHaveTextContent(
      '0 Team Studios',
    );
  });

  it('reads each card body off that tier\'s own ceilings', () => {
    renderGrid('month', 'none');
    const team = screen.getByTestId('tier-card-team');
    expect(team).toHaveTextContent('500 GiB');
    expect(team).toHaveTextContent('3 Team Studios');
    expect(team).toHaveTextContent('20 connections');
    // A body copied from one tier onto all three is what this catches.
    expect(screen.getByTestId('tier-card-base')).toHaveTextContent('5 GiB');
  });

  it('states the saving once, on the yearly view, and never on the monthly one', () => {
    // Ratified 2026-09-23: the card says a percentage. The monthly view is
    // the price being compared against, so there is nothing to state there.
    renderGrid('year', 'none');
    expect(document.body.textContent ?? '').toContain('%');

    cleanup();
    renderGrid('month', 'none');
    expect(document.body.textContent ?? '').not.toContain('%');
  });
});

describe('TierCards — an yearly price that saves nothing', () => {
  beforeEach(() => {
    cleanup();
  });

  /** The same three tiers, with an yearly price that is not a discount. */
  const noSaving = (yearCents: number): readonly TierOffer[] =>
    CATALOG.map((offer) =>
      offer.tier === 'pro'
        ? { ...offer, prices: { ...offer.prices, year: { priceCents: yearCents, currency: 'usd' } } }
        : offer,
    );

  it.each([
    ['the same as twelve months', 1999 * 12],
    ['more than twelve months', 1999 * 12 + 1],
  ])('keeps the saving line off a year that costs %s', (_case, yearCents) => {
    render(
      <TierCards
        offers={noSaving(yearCents)}
        currentTier='base'
        selectedPeriod='year'
        situation='none'
        heldPeriod={null}
        sellsSubscriptions
        move='offered'
        busy={false}
        choosing={null}
        onChoose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('tier-note-pro')).toBeEmptyDOMElement();
  });
});
