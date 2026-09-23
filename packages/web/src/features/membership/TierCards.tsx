// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { cardAction, getLocale } from '@breatic/shared';
import type {
  BillingPeriod,
  CardAction,
  ComparableMembershipTier,
  MembershipTier,
  MoveOffer,
  SubscriptionSituation,
  TierOffer,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { formatPrice } from '@web/features/membership/format';
import { SALES_EMAIL } from '@web/features/membership/pricing';
import { formatBytes } from '@web/lib/format-bytes';
import { useTranslation } from '@web/i18n/use-translation';

/** What the card grid needs to draw every card and decide every button. */
interface TierCardsProps {
  /** The priced tiers, cheapest first, as the server sends them. */
  offers: readonly TierOffer[];
  /** The tier in force on this account. */
  currentTier: MembershipTier;
  /** Which period the switcher is on, which picks the price and the action. */
  selectedPeriod: BillingPeriod;
  /** Which situation the account's subscription is in. */
  situation: SubscriptionSituation;
  /** The period of the stored subscription, null when there is none. */
  heldPeriod: BillingPeriod | null;
  /** Whether this deployment sells subscriptions at all. */
  sellsSubscriptions: boolean;
  /** Whether a move can be started right now. */
  move: MoveOffer;
  /** Whether one action is already running, so the buttons wait. */
  busy: boolean;
  /** Take the account to a tier over a period. */
  onChoose: (chosen: {
    tier: ComparableMembershipTier;
    period: BillingPeriod;
  }) => void;
}

/**
 * How many months of an annual price one month works out at.
 *
 * Rounded to the cent rather than truncated, because this figure is read
 * beside the annual price it comes from and a truncated one reads a cent
 * cheaper than the division actually gives.
 * @param annualCents - The annual price, in the smallest currency unit.
 * @returns The monthly equivalent, in the same unit.
 */
function monthlyEquivalent(annualCents: number): number {
  return Math.round(annualCents / 12);
}

/**
 * The purchase page's four cards: the three priced tiers and one to talk to us.
 *
 * The fourth is local to this component rather than a row of `catalog`,
 * because nothing about it comes from configuration: enterprise allowances are
 * agreed per customer, and `getMembershipLimits` narrows its argument to the
 * configured tiers on purpose so that every path from a tier to a ceiling has
 * to handle that tier explicitly. Inventing a `TierOffer` for it would defeat
 * exactly that.
 *
 * Which control each card carries is `cardAction`'s answer, not this file's:
 * the server reads the same function, so a button drawn here is one the
 * endpoint accepts and a blank card is a purchase nobody could have made.
 * @param props - The offers, the account's position and the selected period.
 * @returns The card grid.
 */
export const TierCards = React.memo(function TierCards({
  offers,
  currentTier,
  selectedPeriod,
  situation,
  heldPeriod,
  sellsSubscriptions,
  move,
  busy,
  onChoose,
}: TierCardsProps): React.JSX.Element {
  const t = useTranslation();
  // Read rather than subscribed to: `useTranslation` already re-renders this
  // component when the locale changes, so this is the current one by the time
  // it runs.
  const locale = getLocale();

  return (
    <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
      {offers.map((offer) => {
        const action = cardAction({
          card: offer.tier,
          selectedPeriod,
          accountTier: currentTier,
          sellsSubscriptions,
          situation,
          heldPeriod,
          move,
        });
        const price = offer.prices[selectedPeriod];
        return (
          <TierCard
            key={offer.tier}
            testId={`tier-card-${offer.tier}`}
            name={t(`membership.tier.${offer.tier}`)}
            current={action === 'current'}
            price={
              price
                ? t(`membership.priceSuffix.${selectedPeriod}`, {
                  amount: formatPrice(price.priceCents, price.currency, locale),
                })
                : t('membership.priceFree')
            }
            priceTestId={`tier-price-${offer.tier}`}
            // Only where there is an annual price to divide. The monthly view
            // shows the price itself, and the free tier has nothing to save.
            note={
              selectedPeriod === 'year' && price
                ? t('membership.perMonthEquivalent', {
                  amount: formatPrice(
                    monthlyEquivalent(price.priceCents),
                    price.currency,
                    locale,
                  ),
                })
                : null
            }
            noteTestId={`tier-note-${offer.tier}`}
            lines={[
              t('membership.card.storage', {
                value: formatBytes(offer.limits.storage_bytes),
              }),
              t('membership.card.teamStudios', {
                count: String(offer.limits.team_studios),
              }),
              t('membership.card.connections', {
                count: String(offer.limits.concurrent_editors),
              }),
            ]}
            action={
              <TierCardAction
                action={action}
                busy={busy}
                tier={offer.tier}
                label={t('membership.action.choose', {
                  tier: t(`membership.tier.${offer.tier}`),
                })}
                inProgressLabel={t('membership.action.inProgress')}
                currentLabel={t('membership.action.current')}
                onChoose={onChoose}
                period={selectedPeriod}
              />
            }
          />
        );
      })}
      {/* The fourth card. It never carries a price or a checkout, and it
          appears even where this deployment sells nothing — a self-hosted
          install has no shop, and this is the one card that was never a
          purchase in the first place. */}
      <TierCard
        testId='tier-card-enterprise'
        name={t('membership.tier.enterprise')}
        current={false}
        price={t('membership.priceOnRequest')}
        priceTestId='tier-price-enterprise'
        note={null}
        noteTestId='tier-note-enterprise'
        lines={[
          t('membership.card.enterpriseScale'),
          t('membership.card.enterpriseGovernance'),
        ]}
        action={
          <Button asChild type='button' variant='outline' size='sm'>
            <a href={`mailto:${SALES_EMAIL}`} data-testid='membership-contact-sales'>
              {t('membership.contactSales')}
            </a>
          </Button>
        }
      />
    </div>
  );
});

/** One card's contents, already turned into the words it shows. */
interface TierCardProps {
  /** Identifies the card for tests. */
  testId: string;
  /** The tier's name, which stays English in every locale. */
  name: string;
  /** Whether this is the card the account is on. */
  current: boolean;
  /** The price, or what stands in for one. */
  price: string;
  /** Identifies the price slot for tests. */
  priceTestId: string;
  /** The small line under the price, or null where there is none. */
  note: string | null;
  /** Identifies the small line for tests. */
  noteTestId: string;
  /** Two or three lines summarising what the tier gives. */
  lines: readonly string[];
  /** Whatever control this card carries. */
  action: React.ReactNode;
}

/**
 * One card, drawn the same way whether its figures came from configuration.
 *
 * The card the account is on is filled with `bg-accent` and outlined with
 * `border-active-border`: the fill moves away from the page in both themes,
 * and that border is the one colour this product uses to say "this one".
 * @param props - The card's words and its control.
 * @param props.testId - Identifies the card for tests.
 * @param props.name - The tier's name.
 * @param props.current - Whether this is the card the account is on.
 * @param props.price - The price, or what stands in for one.
 * @param props.priceTestId - Identifies the price slot for tests.
 * @param props.note - The small line under the price, or null.
 * @param props.noteTestId - Identifies the small line for tests.
 * @param props.lines - The lines summarising what the tier gives.
 * @param props.action - Whatever control this card carries.
 * @returns The card.
 */
function TierCard({
  testId,
  name,
  current,
  price,
  priceTestId,
  note,
  noteTestId,
  lines,
  action,
}: TierCardProps): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      aria-current={current ? 'true' : undefined}
      className={
        current
          ? 'flex flex-col gap-3 rounded-chrome border border-active-border bg-accent p-4'
          : 'flex flex-col gap-3 rounded-chrome border border-border p-4'
      }
    >
      <div className='flex flex-col gap-1'>
        <div className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
          {name}
        </div>
        <div className='text-xl font-bold tabular-nums' data-testid={priceTestId}>
          {price}
        </div>
        {/* Reserved whether or not there is a note, so the card bodies below
            start on the same line across the row. */}
        <div
          className='min-h-4 text-xs text-foreground-secondary'
          data-testid={noteTestId}
        >
          {note}
        </div>
      </div>
      <ul className='flex flex-col gap-1 text-sm text-foreground-secondary'>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {/* Pushed to the bottom so the controls line up however tall the
          bodies are. */}
      <div className='mt-auto pt-1'>{action}</div>
    </div>
  );
}

/** What one priced card's control needs. */
interface TierCardActionProps {
  /** What this card offers, decided by the shared rule. */
  action: CardAction;
  /** Whether an action is already running. */
  busy: boolean;
  /** Which tier this card sells. */
  tier: ComparableMembershipTier;
  /** Which period the switcher is on. */
  period: BillingPeriod;
  /** The button's words. */
  label: string;
  /** What it says while a bought move waits on its invoice. */
  inProgressLabel: string;
  /** What stands where a button would be on the card in force. */
  currentLabel: string;
  /** Take the account to this card's offer. */
  onChoose: (chosen: {
    tier: ComparableMembershipTier;
    period: BillingPeriod;
  }) => void;
}

/**
 * The control on a priced card, or nothing.
 *
 * A card that cannot be moved to stays empty rather than showing a disabled
 * button or a sentence explaining the refusal: the reader is looking at what
 * they can buy, not at a list of what they cannot.
 * @param props - What this card offers and how to take it.
 * @param props.action - What this card offers, decided by the shared rule.
 * @param props.busy - Whether an action is already running.
 * @param props.tier - Which tier this card sells.
 * @param props.period - Which period the switcher is on.
 * @param props.label - The button's words.
 * @param props.inProgressLabel - What it says while a move waits on payment.
 * @param props.currentLabel - What stands on the card in force.
 * @param props.onChoose - Take the account to this card's offer.
 * @returns The control, or null.
 */
function TierCardAction({
  action,
  busy,
  tier,
  period,
  label,
  inProgressLabel,
  currentLabel,
  onChoose,
}: TierCardActionProps): React.JSX.Element | null {
  const handleClick = React.useCallback(() => {
    onChoose({ tier, period });
  }, [onChoose, tier, period]);

  if (action === 'current') {
    return (
      <span
        className='text-xs font-semibold text-foreground'
        data-testid={`tier-current-${tier}`}
      >
        {currentLabel}
      </span>
    );
  }
  // `contactSales` never reaches a priced card — the enterprise card carries
  // its own control — and `blank` is the whole of "there is nothing here".
  if (action === 'blank' || action === 'contactSales') return null;
  return (
    <Button
      type='button'
      size='sm'
      className='w-full'
      disabled={busy || action === 'inProgress'}
      data-testid={`membership-choose-${tier}`}
      onClick={handleClick}
    >
      {action === 'inProgress' ? inProgressLabel : label}
    </Button>
  );
}
