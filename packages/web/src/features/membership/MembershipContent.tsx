// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { AccountMembership } from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { ScrollArea } from '@web/components/ui/scroll-area';
import { formatBytes } from '@web/features/membership/format';
import { QuotaRow } from '@web/features/membership/QuotaRow';
import {
  SALES_EMAIL,
  TIER_MONTHLY_PRICE_USD,
} from '@web/features/membership/pricing';
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
 * A line offering to talk about terms that are not on the price list.
 * @param props - Which wording to use.
 * @param props.text - The sentence that precedes the address.
 * @returns The line, with the address as a mail link.
 */
function ContactLine({ text }: { text: string }): React.JSX.Element {
  return (
    <p className='text-sm text-foreground-secondary'>
      {text}{' '}
      <a
        href={`mailto:${SALES_EMAIL}`}
        data-testid='membership-contact'
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
 *   - Its allowances. Only the two counted account-wide are listed, because
 *     the other four are per-studio and are read on that studio's own page —
 *     except on `self_hosted`, which has no comparison table to read them off
 *     and would otherwise never see its own ceilings at all.
 *   - The comparison table, for accounts that could move between the tiers on
 *     it. `self_hosted` is a deployment shape and `enterprise` is negotiated,
 *     so for those two there is nothing to compare against; they get the
 *     contact line instead.
 * @param props - The membership to render.
 * @param props.membership - The whole answer behind the panel.
 * @returns The panel's body.
 */
export function MembershipContent({
  membership,
}: MembershipContentProps): React.JSX.Element {
  const t = useTranslation();
  const { tier, limits, usage, catalog } = membership;
  const onPriceList = tier === 'base' || tier === 'pro' || tier === 'team';
  const price = onPriceList ? TIER_MONTHLY_PRICE_USD[tier] : null;

  return (
    <div className='flex flex-col gap-8'>
      <section className='flex flex-col gap-1.5'>
        <SectionHeading>{t('membership.currentTier')}</SectionHeading>
        <div className='flex items-start justify-between gap-4'>
          <div>
            <div className='text-2xl font-bold' data-testid='current-tier-name'>
              {t(`membership.tier.${tier}`)}
            </div>
            {price === null ? null : (
              <div className='text-sm text-muted-foreground'>
                {price === 0
                  ? t('membership.priceFree')
                  : t('membership.pricePerMonth', { amount: `$${String(price)}` })}
              </div>
            )}
          </div>
          {onPriceList ? (
            // Upgrading has nowhere to go until the checkout work lands, and
            // the entry says so rather than pretending. `aria-disabled` and
            // not `disabled`: the latter takes it out of the tab order, and
            // the reader most likely to want the notice is the one moving by
            // focus. Same treatment as the account menu's coming entries.
            <Button
              type='button'
              aria-disabled='true'
              data-testid='membership-upgrade'
              onClick={(event) => event.preventDefault()}
              className='shrink-0 cursor-not-allowed gap-2 opacity-50'
            >
              {t('membership.upgrade')}
              <span className='rounded-chrome bg-muted px-1 py-0.5 text-2xs font-medium text-muted-foreground'>
                {t('studio.topBar.notOpenYet')}
              </span>
            </Button>
          ) : null}
        </div>
        <p className='text-sm text-foreground-secondary'>
          {t('membership.tierNote')}
        </p>
      </section>

      <section className='flex flex-col gap-4'>
        <SectionHeading>{t('membership.myQuota')}</SectionHeading>
        {limits === null ? (
          <p
            className='text-sm text-foreground-secondary'
            data-testid='enterprise-quota-note'
          >
            {t('membership.enterpriseQuota')}
          </p>
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
                <ContactLine text={t('membership.contactSelfHosted')} />
              </div>
            ) : null}
          </>
        )}
      </section>

      {onPriceList ? (
        <section className='flex flex-col gap-4'>
          <SectionHeading>{t('membership.compare')}</SectionHeading>
          <ScrollArea scrollbars='horizontal'>
            <TierComparison offers={catalog} currentTier={tier} />
          </ScrollArea>
          <ContactLine text={t('membership.contactEnterprise')} />
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
