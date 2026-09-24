// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import {
  BILLING_PERIODS,
  holdsActionableSubscription,
  isComparableMembershipTier,
  subscriptionActions,
  type AccountMembership,
  type BillingPeriod,
  type ComparableMembershipTier,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { formatBytes } from '@web/lib/format-bytes';
import { QuotaRow } from '@web/features/membership/QuotaRow';
import { SALES_EMAIL } from '@web/features/membership/pricing';
import { SubscriptionLines } from '@web/features/membership/SubscriptionLines';
import { useSubscriptionActions } from '@web/features/membership/use-subscription-actions';
import { TierCards } from '@web/features/membership/TierCards';
import { TierComparison } from '@web/features/membership/TierComparison';
import { useTranslation } from '@web/i18n/use-translation';

/** The loaded panel's input. */
interface MembershipContentProps {
  /** The whole answer behind the panel. */
  membership: AccountMembership;
}

/**
 * A muted section heading, matching the settings tab's own.
 * @param props - The heading's text.
 * @param props.children - The heading's text.
 * @returns The heading.
 */
function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h3 className='text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'>
      {children}
    </h3>
  );
}

/**
 * A line offering to talk about something the price list does not cover.
 *
 * Every tier gets one, because every tier can run out of what the panel can
 * answer: the priced ones outgrow the table, self-hosted needs a licence, and
 * enterprise can only ask about the agreement its allowances live in. Only the
 * wording differs, and each placement carries its own test id so that no
 * placement can quietly go missing behind another one's assertion.
 * @param props - Which wording to use and which placement this is.
 * @param props.text - The sentence that precedes the address.
 * @param props.testId - Identifies this placement for tests.
 * @returns The line, with the address as a mail link.
 */
function ContactLine({
  text,
  testId,
}: {
  text: string;
  testId: string;
}): React.JSX.Element {
  return (
    <p className='text-sm text-foreground-secondary'>
      {text}{' '}
      <a
        href={`mailto:${SALES_EMAIL}`}
        data-testid={testId}
        className='underline underline-offset-2'
      >
        {SALES_EMAIL}
      </a>
    </p>
  );
}

/**
 * The panel once its one request has answered.
 *
 * Three sections, and which of them appear depends on what the tier can be
 * told about itself:
 *
 *   - The tier it is on. Priced tiers also get a price and an upgrade button.
 *   - Its allowances. Only the two counted account-wide are listed; the other
 *     four are per-studio, and their values are read off the comparison table
 *     below — which is why `self_hosted`, which has ceilings but no table,
 *     lists them here instead.
 *   - The comparison table, for accounts that could move between the tiers on
 *     it. `self_hosted` is a deployment shape and `enterprise` is negotiated,
 *     so for those two there is nothing to compare against.
 *
 * A contact line appears on every tier, worded for what that tier has run out
 * of: scale for the priced ones, a licence for self-hosted, the agreement
 * itself for enterprise.
 * @param props - The membership to render.
 * @param props.membership - The whole answer behind the panel.
 * @returns The panel's body.
 */
export function MembershipContent({
  membership,
}: MembershipContentProps): React.JSX.Element {
  const t = useTranslation();
  const { tier, limits, usage, catalog, subscription } = membership;
  const onPriceList = isComparableMembershipTier(tier);
  const { choose, cancel, resume, busy } = useSubscriptionActions(subscription);
  // What this account may do, decided on the same rule the server enforces.
  // Both ends asking their own version is what drew a resume button the
  // server always refused, and an upgrade entrance during the retry window
  // that design §13 says not to draw.
  const actions = React.useMemo(
    () =>
      subscriptionActions(
        subscription?.state ?? 'none',
        subscription?.cancelAtPeriodEnd ?? false,
      ),
    [subscription?.state, subscription?.cancelAtPeriodEnd],
  );

  // Two questions about the same column, and they have different answers.
  //
  // `boughtPeriod` is which period this account is being charged over. A
  // stored row carries one from the moment it exists, so this is the answer
  // even while the first invoice is still unsettled — that account is in the
  // middle of buying a month, and the page opening on yearly would quote
  // prices other than the ones its own "finish paying" link is for.
  //
  // `heldPeriod` is what the cards may be compared against, which needs the
  // subscription to be one that can still be acted on. Until the first
  // invoice settles the tier in force is Starter and there is nothing to move
  // from, so the cards read null and the Starter card does not flicker
  // between "current" and not as the switcher moves.
  const boughtPeriod = subscription?.period ?? null;
  const heldPeriod =
    subscription && holdsActionableSubscription(subscription.state)
      ? subscription.period
      : null;

  // Which period the reader is looking at. It starts on the one this account
  // is being charged over, because opening on the other one would answer
  // "what do I have" with a price they do not pay. An account with no
  // subscription starts on yearly, which is what the page is recommending.
  const [selectedPeriod, setSelectedPeriod] = React.useState<BillingPeriod>(
    boughtPeriod ?? 'year',
  );

  // The table offers every comparable tier, `base` included; only the ones
  // that can be subscribed to reach the action.
  const handleChoose = React.useCallback(
    (chosen: { tier: ComparableMembershipTier; period: BillingPeriod }) => {
      // `base` has a column in the table and never a button; the narrowing
      // here is what lets the offer that travels be a subscribable one.
      if (chosen.tier !== 'base') {
        choose({ tier: chosen.tier, period: chosen.period });
      }
    },
    [choose],
  );

  return (
    <div className='flex flex-col gap-8'>
      <section className='flex flex-col gap-1.5'>
        <SectionHeading>{t('membership.currentTier')}</SectionHeading>
        <div className='flex flex-col gap-1'>
          <div className='text-2xl font-bold' data-testid='current-tier-name'>
            {/* The period joins the tier name only where the account holds
                something it is billed over — the same condition the cards
                ask. A first invoice that has not settled leaves a row with a
                period while the tier in force is still Starter, and naming a
                period there bills a tier nobody pays for. */}
            {heldPeriod
              ? t('membership.tierWithPeriod', {
                tier: t(`membership.tier.${tier}`),
                period: t(`membership.period.${heldPeriod}`),
              })
              : t(`membership.tier.${tier}`)}
          </div>
          {/* Under the tier name: when the next charge is, or that the
              membership is ending, or that a payment is outstanding. Which of
              those follows from the subscription's situation, and a static
              price would be wrong in three of them. */}
          <SubscriptionLines subscription={subscription} />
        </div>
        <p className='text-sm text-foreground-secondary'>
          {t('membership.tierNote')}
        </p>
      </section>

      <section className='flex flex-col gap-4'>
        <SectionHeading>{t('membership.myQuota')}</SectionHeading>
        {limits === null ? (
          // Enterprise. Its ceilings are agreed per customer and live only in
          // that agreement, so the panel cannot print them — which makes the
          // address the one thing it can usefully offer.
          <>
            <p
              className='text-sm text-foreground-secondary'
              data-testid='enterprise-quota-note'
            >
              {t('membership.enterpriseQuota')}
            </p>
            <ContactLine
              text={t('membership.contactEnterpriseAccount')}
              testId='membership-contact-enterprise'
            />
          </>
        ) : (
          <>
            <QuotaRow
              testId='quota-team-studios'
              label={t('membership.quota.teamStudios')}
              value={t('membership.quotaValue', {
                used: String(usage.teamStudios),
                limit: String(limits.team_studios),
              })}
              used={usage.teamStudios}
              limit={limits.team_studios}
              overLabel={t('membership.overLimitTag')}
            />
            {usage.teamStudios > limits.team_studios ? (
              <p
                className='text-sm text-foreground-secondary'
                data-testid='over-limit-team-studios'
              >
                {t('membership.overLimit.teamStudios')}
              </p>
            ) : null}
            <QuotaRow
              testId='quota-storage'
              label={t('membership.quota.storage')}
              value={t('membership.quotaValue', {
                used: formatBytes(usage.storageBytes),
                limit: formatBytes(limits.storage_bytes),
              })}
              used={usage.storageBytes}
              limit={limits.storage_bytes}
              overLabel={t('membership.overLimitTag')}
            />
            {usage.storageBytes > limits.storage_bytes ? (
              <p
                className='text-sm text-foreground-secondary'
                data-testid='over-limit-storage'
              >
                {t('membership.overLimit.storage')}
              </p>
            ) : null}
            {tier === 'self_hosted' ? (
              // The four per-studio ceilings, listed here only for this tier:
              // it is not on the price list, so the comparison table below —
              // where every other tier reads them — is not shown to it.
              <div className='flex flex-col gap-3 pt-2'>
                <SelfHostedRow
                  testId='quota-projects-per-studio'
                  label={t('membership.quota.projectsPerStudio')}
                  value={t('membership.countItems', {
                    count: String(limits.projects_per_studio),
                  })}
                />
                <SelfHostedRow
                  testId='quota-studio-members'
                  label={t('membership.quota.studioMembers')}
                  value={t('membership.countPeople', {
                    count: String(limits.studio_members),
                  })}
                />
                <SelfHostedRow
                  testId='quota-project-members'
                  label={t('membership.quota.projectMembers')}
                  value={t('membership.countPeople', {
                    count: String(limits.project_members),
                  })}
                />
                <SelfHostedRow
                  testId='quota-concurrent-editors'
                  label={t('membership.quota.concurrentEditors')}
                  value={t('membership.countConnections', {
                    count: String(limits.concurrent_editors),
                  })}
                />
                <ContactLine
                  text={t('membership.contactSelfHosted')}
                  testId='membership-contact-self-hosted'
                />
              </div>
            ) : null}
          </>
        )}
      </section>

      {onPriceList ? (
        <section className='flex flex-col gap-4'>
          {/* The heading and the switcher share one line, the two ends of
              it, which is where the confirmed demo puts them. */}
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <SectionHeading>{t('membership.chooseTier')}</SectionHeading>
            {/* No switcher where nothing is sold: the periods it offers are
                two prices, and this deployment quotes neither. */}
            {subscription ? (
              <div className='flex items-center gap-3'>
                {/* What the yearly price saves, so it belongs to the yearly
                    view. Beside monthly prices it describes something other
                    than what the reader is looking at. */}
                {selectedPeriod === 'year' ? (
                  <span
                    className='text-xs text-foreground-secondary'
                    data-testid='membership-save-line'
                  >
                    {t('membership.saveTwoMonths')}
                  </span>
                ) : null}
                {/* One frame around both segments with a single rule between
                    them, so the pair reads as one control with two positions
                    rather than as two buttons that happen to sit together. */}
                <div
                  role='group'
                  className='flex items-center overflow-hidden rounded-chrome border border-border'
                  data-testid='membership-period-switch'
                >
                  {BILLING_PERIODS.map((period) => (
                    <Button
                      key={period}
                      type='button'
                      size='sm'
                      variant='ghost'
                      aria-pressed={period === selectedPeriod}
                      // The chosen segment is marked the way the credits
                      // overlay marks its chosen row: one step above hover, so
                      // hovering the other segment cannot make it look chosen
                      // too. The page's primary fill would read as the thing
                      // to press, and pressing it is what the reader has
                      // already done.
                      //
                      // `ring-inset` is load-bearing: the frame around both
                      // segments clips overflow to round its corners, and the
                      // segments fill it exactly, so a ring drawn outside
                      // their edges has nowhere to land. Drawn inside, the
                      // keyboard reader sees where they are.
                      className='rounded-none border-0 border-l border-border first:border-l-0 focus-visible:ring-inset aria-pressed:bg-accent-strong aria-pressed:font-semibold aria-pressed:text-foreground aria-pressed:hover:bg-accent-strong'
                      data-testid={`membership-period-${period}`}
                      onClick={() => setSelectedPeriod(period)}
                    >
                      {t(`membership.period.${period}`)}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <TierCards
            offers={catalog}
            currentTier={tier}
            selectedPeriod={selectedPeriod}
            situation={subscription?.state ?? 'none'}
            heldPeriod={heldPeriod}
            // Null means this deployment sells no subscriptions at all, which
            // empties every priced card rather than drawing buttons that
            // cannot work.
            sellsSubscriptions={subscription !== null}
            move={actions.move}
            busy={busy}
            onChoose={handleChoose}
          />
          {/* Two sentences the page has to carry, together because both are
              about what a price does and does not cover. Membership and
              credits are separate legs, and a reader who assumes a tier comes
              with generation credits finds out mid-generation; the tax line
              stops at "excluded" because nothing anywhere calculates tax
              (#170), and #106 deleted the half-sentence that said otherwise. */}
          <ul className='flex flex-col gap-1 text-sm text-foreground-secondary'>
            <li data-testid='membership-no-credits'>
              {t('membership.noCreditsIncluded')}
            </li>
            <li data-testid='membership-tax-note'>{t('membership.taxNote')}</li>
          </ul>
        </section>
      ) : null}

      {onPriceList ? (
        <section className='flex flex-col gap-4'>
          {/* No heading element here: the table's own corner cell carries it,
              so the label lines up with the tier names instead of floating
              above a column that would otherwise have none. */}
          <ScrollArea scrollbars='horizontal'>
            <TierComparison offers={catalog} />
          </ScrollArea>
          {/* One line, contact on the left and the subscription control on
              the right — the ratified layout (design §13, and the demo it
              points at). The control sat beside the tier name before, which
              put an action in the panel's quietest corner and crowded the
              close button. */}
          <div className='flex items-center justify-between gap-4'>
            <ContactLine
              text={t('membership.contactEnterprise')}
              testId='membership-contact-priced'
            />
            {/* The same list the server reads, so an action this panel draws
                is one the server will accept. */}
            {actions.cancel || actions.resume ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={busy}
                data-testid={
                  actions.resume ? 'membership-resume' : 'membership-cancel'
                }
                onClick={actions.resume ? resume : cancel}
                className='shrink-0'
              >
                {actions.resume ? t('membership.resume') : t('membership.cancel')}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/** One of the four ceilings only the self-hosted tier lists here. */
interface SelfHostedRowProps {
  /** What the ceiling is called. */
  label: string;
  /** The ceiling, with its unit. */
  value: string;
  /** Identifies the row for tests. */
  testId: string;
}

/**
 * A ceiling with no usage beside it: a number, not a bar.
 *
 * These four are per-studio, and this panel answers account-level questions —
 * how much of one is spent is a question for the studio it belongs to.
 * @param props - The ceiling to draw.
 * @param props.label - What the ceiling is called.
 * @param props.value - The ceiling, with its unit.
 * @param props.testId - Identifies the row for tests.
 * @returns The row.
 */
function SelfHostedRow({
  label,
  value,
  testId,
}: SelfHostedRowProps): React.JSX.Element {
  return (
    <div className='flex justify-between text-sm' data-testid={testId}>
      <span>{label}</span>
      <span className='tabular-nums text-foreground-secondary'>{value}</span>
    </div>
  );
}
