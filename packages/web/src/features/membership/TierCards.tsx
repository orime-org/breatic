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
  TierPrice,
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
 * How much less a year costs than twelve months bought one at a time.
 *
 * Worked out from the two prices rather than written down, so the sentence it
 * feeds stays true when either price changes. Rounded to a whole percent,
 * which is what the sentence says it is.
 *
 * A year that costs the same as twelve months, or more, answers null: the
 * sentence this feeds says a year saves something, and a function that can
 * hand it a zero or a negative is a function that can make it read "saves
 * about 0%". The caller draws nothing on null, so the claim holds by
 * construction rather than by the price list happening to agree with it.
 * @param prices - The tier's price over each period.
 * @returns The saving as a whole percent, or null where either price is
 *   missing or a year saves nothing.
 */
function yearSavingPercent(
  prices: Readonly<Record<BillingPeriod, TierPrice | null>>,
): number | null {
  const { month, year } = prices;
  if (!month || !year) return null;
  const twelveMonths = month.priceCents * 12;
  if (twelveMonths <= 0) return null;
  const saving = Math.round((1 - year.priceCents / twelveMonths) * 100);
  return saving > 0 ? saving : null;
}

/**
 * What stands in a priced card's price slot.
 *
 * A null price means two different things and they read differently. The free
 * tier has none because it costs nothing, and says so. A priced tier has none
 * where this deployment sells nothing, and "Free" there would be a claim that
 * PRO costs nothing — it costs what it costs wherever it is sold.
 * The figure itself carries the slot's own size; whatever the translator
 * wrote around it reads smaller and quieter, which is how the confirmed demo
 * sets the period apart from the number.
 * @param offer - The tier this card describes.
 * @param price - Its price over the selected period, or null.
 * @param period - Which period the switcher is on.
 * @param t - The translator.
 * @param locale - Which locale's conventions to write money in.
 * @returns What the price slot renders.
 */
function priceSlot(
  offer: TierOffer,
  price: TierPrice | null,
  period: BillingPeriod,
  t: ReturnType<typeof useTranslation>,
  locale: string,
): React.ReactNode {
  if (price) {
    const amount = formatPrice(price.priceCents, price.currency, locale);
    const line = t(`membership.priceSuffix.${period}`, { amount });
    // Split on the amount the translator placed rather than on a fixed
    // order, so a language that writes "monthly $19.99" keeps its own
    // arrangement while the figure still reads louder than the period.
    const at = line.indexOf(amount);
    const before = at < 0 ? '' : line.slice(0, at);
    const after = at < 0 ? line : line.slice(at + amount.length);
    return (
      <>
        <span className='text-xs font-normal text-foreground-secondary'>
          {before}
        </span>
        {at < 0 ? null : amount}
        <span className='text-xs font-normal text-foreground-secondary'>
          {after}
        </span>
      </>
    );
  }
  if (offer.tier === 'base') return t('membership.priceFree');
  // An em dash, not a sentence: there is no price to quote here and nothing
  // to explain about it.
  return '—';
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
 * Which control each card carries is `cardAction`'s answer, not this file's.
 * That rule is built on `canMoveTo`, which the server reads too when it
 * decides whether to accept a change, so a button drawn here is one the
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
    // Three rows — head, body, control — declared here and borrowed by every
    // card, so a head that runs to one more line makes that row taller for
    // all four at once and the lists below still start on one line. Reserving
    // a fixed height inside each card cannot do this: the height that fits
    // has to be the tallest of five languages, which leaves the other four
    // padded out, and the first string that outgrows it puts one card's body
    // out of line with its neighbours again.
    <div className='grid grid-rows-[auto_auto_auto] gap-3 sm:grid-cols-2 lg:grid-cols-4'>
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
        const saving = yearSavingPercent(offer.prices);
        return (
          <TierCard
            key={offer.tier}
            testId={`tier-card-${offer.tier}`}
            name={t(`membership.tier.${offer.tier}`)}
            current={action === 'current'}
            price={priceSlot(offer, price, selectedPeriod, t, locale)}
            priceTestId={`tier-price-${offer.tier}`}
            // Only on the yearly view, and only where both prices exist to
            // compare. The monthly view is the price it is comparing against,
            // and the free tier has nothing to save.
            note={
              selectedPeriod === 'year' && saving !== null
                ? t('membership.yearSaving', { percent: saving })
                : null
            }
            noteTestId={`tier-note-${offer.tier}`}
            lines={[
              t('membership.card.storage', {
                value: formatBytes(offer.limits.storage_bytes),
              }),
              t('membership.card.teamStudios', {
                count: offer.limits.team_studios,
              }),
              t('membership.card.connections', {
                count: offer.limits.concurrent_editors,
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
                contactLabel={t('membership.contactSales')}
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
          <TierCardAction
            action={cardAction({
              card: 'enterprise',
              selectedPeriod,
              accountTier: currentTier,
              sellsSubscriptions,
              situation,
              heldPeriod,
              move,
            })}
            busy={busy}
            tier={null}
            label=''
            inProgressLabel=''
            currentLabel=''
            contactLabel={t('membership.contactSales')}
            onChoose={onChoose}
            period={selectedPeriod}
          />
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
  price: React.ReactNode;
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
          ? 'row-span-3 grid grid-rows-subgrid rounded-chrome border border-active-border bg-accent p-4'
          : 'row-span-3 grid grid-rows-subgrid rounded-chrome border border-border p-4'
      }
    >
      <div className='flex flex-col gap-1'>
        <div className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
          {name}
        </div>
        <div className='text-xl font-bold tabular-nums' data-testid={priceTestId}>
          {price}
        </div>
        <div className='text-xs text-foreground-secondary' data-testid={noteTestId}>
          {note}
        </div>
      </div>
      <ul className='list-disc space-y-1 pl-4 text-sm text-foreground-secondary'>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      {/* Its own row of the shared grid, so the controls line up however tall
          the bodies are. */}
      <div>{action}</div>
    </div>
  );
}

/** What one card's control needs. */
interface TierCardActionProps {
  /** What this card offers, decided by the shared rule. */
  action: CardAction;
  /** Whether an action is already running. */
  busy: boolean;
  /** Which tier this card sells, null on the card that sells none. */
  tier: ComparableMembershipTier | null;
  /** Which period the switcher is on. */
  period: BillingPeriod;
  /** The button's words. */
  label: string;
  /** What it says while a bought move waits on its invoice. */
  inProgressLabel: string;
  /** What stands where a button would be on the card in force. */
  currentLabel: string;
  /** What the card that sells nothing offers instead. */
  contactLabel: string;
  /** Take the account to this card's offer. */
  onChoose: (chosen: {
    tier: ComparableMembershipTier;
    period: BillingPeriod;
  }) => void;
}

/**
 * The control on one card, or a slot of the same height.
 *
 * A card that cannot be moved to stays empty rather than showing a disabled
 * button or a sentence explaining the refusal: the reader is looking at what
 * they can buy, not at a list of what they cannot. The empty slot keeps the
 * height of a button so the row of cards stays lined up.
 * @param props - What this card offers and how to take it.
 * @param props.action - What this card offers, decided by the shared rule.
 * @param props.busy - Whether an action is already running.
 * @param props.tier - Which tier this card sells.
 * @param props.period - Which period the switcher is on.
 * @param props.label - The button's words.
 * @param props.inProgressLabel - What it says while a move waits on payment.
 * @param props.currentLabel - What stands on the card in force.
 * @param props.contactLabel - What the card that sells nothing offers.
 * @param props.onChoose - Take the account to this card's offer.
 * @returns The control, or a slot the height of one.
 */
function TierCardAction({
  action,
  busy,
  tier,
  period,
  label,
  inProgressLabel,
  currentLabel,
  contactLabel,
  onChoose,
}: TierCardActionProps): React.JSX.Element {
  const handleClick = React.useCallback(() => {
    if (tier) onChoose({ tier, period });
  }, [onChoose, tier, period]);

  if (action === 'contactSales') {
    return (
      <Button asChild type='button' variant='outline' size='sm' className='w-full'>
        <a href={`mailto:${SALES_EMAIL}`} data-testid='membership-contact-sales'>
          {contactLabel}
        </a>
      </Button>
    );
  }
  if (action === 'current') {
    return (
      <span
        className='flex h-[var(--btn-inline)] items-center justify-center text-xs font-semibold text-foreground'
        data-testid={`tier-current-${tier}`}
      >
        {currentLabel}
      </span>
    );
  }
  // Blank, and still the height of a button: the four cards line their
  // bodies up against each other, and a slot that collapses moves the three
  // lines above it out of line with its neighbours.
  if (action === 'blank') {
    return <span className='block h-[var(--btn-inline)]' />;
  }
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
