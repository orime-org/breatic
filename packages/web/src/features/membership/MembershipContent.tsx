// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import {
  isComparableMembershipTier,
  type AccountMembership,
  type ComparableMembershipTier,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { formatBytes } from '@web/features/membership/format';
import { QuotaRow } from '@web/features/membership/QuotaRow';
import { SALES_EMAIL } from '@web/features/membership/pricing';
import { SubscriptionLines } from '@web/features/membership/SubscriptionLines';
import { useSubscriptionActions } from '@web/features/membership/use-subscription-actions';
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
 *     below — which is why `self_hosted`, the one tier that gets no table,
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

  // The table offers every comparable tier, `base` included; only the ones
  // that can be subscribed to reach the action.
  const handleChoose = React.useCallback(
    (chosen: ComparableMembershipTier) => {
      if (chosen !== 'base') choose(chosen);
    },
    [choose],
  );

  return (
    <div className='flex flex-col gap-8'>
      <section className='flex flex-col gap-1.5'>
        <SectionHeading>{t('membership.currentTier')}</SectionHeading>
        <div className='flex flex-col gap-1'>
          <div className='text-2xl font-bold' data-testid='current-tier-name'>
            {t(`membership.tier.${tier}`)}
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
          {/* No heading element here: the table's own corner cell carries it,
              so the label lines up with the tier names instead of floating
              above a column that would otherwise have none. */}
          <ScrollArea scrollbars='horizontal'>
            <TierComparison
              offers={catalog}
              currentTier={tier}
              // No handler where this deployment sells nothing, which removes
              // the action row rather than showing buttons that cannot work.
              onChoose={subscription ? handleChoose : undefined}
              busy={busy}
            />
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
            {subscription && subscription.state !== 'none' ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={busy}
                data-testid={
                  subscription.cancelAtPeriodEnd
                    ? 'membership-resume'
                    : 'membership-cancel'
                }
                onClick={subscription.cancelAtPeriodEnd ? resume : cancel}
                className='shrink-0'
              >
                {subscription.cancelAtPeriodEnd
                  ? t('membership.resume')
                  : t('membership.cancel')}
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
