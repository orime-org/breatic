// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { MembershipTier, TierOffer } from '@breatic/shared';

import { formatBytes } from '@web/features/membership/format';
import { TIER_MONTHLY_PRICE_USD } from '@web/features/membership/pricing';
import { useTranslation } from '@web/i18n/use-translation';

/** The comparison table's inputs. */
interface TierComparisonProps {
  /** The tiers to compare, in ascending order. */
  offers: readonly TierOffer[];
  /** The account's own tier, so its column can be marked. */
  currentTier: MembershipTier;
}

/**
 * The priced tiers side by side, with the account's own column marked.
 *
 * A real `<table>` rather than a grid of divs: the numbers are a table, and
 * one that says so can be read down a column by anything that reads tables.
 * The rows are the six ceilings plus the price, in the order the panel above
 * introduces them.
 *
 * Only the tiers on the price list appear. `self_hosted` is a deployment shape
 * and `enterprise` is negotiated per customer, so neither is something to
 * compare against or move to — the server leaves them out of `catalog`, and
 * this renders what it is given.
 * @param props - The offers and which tier is the account's own.
 * @param props.offers - The tiers to compare, in ascending order.
 * @param props.currentTier - The account's own tier.
 * @returns The comparison table.
 */
export const TierComparison = React.memo(function TierComparison({
  offers,
  currentTier,
}: TierComparisonProps): React.JSX.Element {
  const t = useTranslation();

  const rows = React.useMemo(
    () => [
      {
        key: 'teamStudios',
        label: t('membership.quota.teamStudios'),
        cell: (offer: TierOffer) => String(offer.limits.team_studios),
      },
      {
        key: 'projectsPerStudio',
        label: t('membership.quota.projectsPerStudio'),
        cell: (offer: TierOffer) => String(offer.limits.projects_per_studio),
      },
      {
        key: 'studioMembers',
        label: t('membership.quota.studioMembers'),
        cell: (offer: TierOffer) => String(offer.limits.studio_members),
      },
      {
        key: 'projectMembers',
        label: t('membership.quota.projectMembers'),
        cell: (offer: TierOffer) => String(offer.limits.project_members),
      },
      {
        key: 'concurrentEditors',
        label: t('membership.quota.concurrentEditors'),
        cell: (offer: TierOffer) => String(offer.limits.concurrent_editors),
      },
      {
        key: 'storage',
        label: t('membership.quota.storage'),
        cell: (offer: TierOffer) => formatBytes(offer.limits.storage_bytes),
      },
    ],
    [t],
  );

  /**
   * Mark the account's own column so the comparison has a starting point.
   * @param tier - The column's tier.
   * @returns The class list for a cell in that column.
   */
  const columnClass = (tier: string): string =>
    tier === currentTier
      ? 'border-b border-border px-2.5 py-2 text-right tabular-nums bg-card text-foreground'
      : 'border-b border-border px-2.5 py-2 text-right tabular-nums';

  return (
    <table className='w-full border-collapse text-sm'>
      <thead>
        <tr>
          <th className='border-b border-border px-2.5 py-2 text-left text-xs font-semibold text-muted-foreground' />
          {offers.map((offer) => (
            <th
              key={offer.tier}
              scope='col'
              data-testid={`compare-column-${offer.tier}`}
              aria-current={offer.tier === currentTier ? 'true' : undefined}
              className={
                offer.tier === currentTier
                  ? 'border-b border-active-border bg-card px-2.5 py-2 text-right text-xs font-semibold text-foreground'
                  : 'border-b border-border px-2.5 py-2 text-right text-xs font-semibold text-muted-foreground'
              }
            >
              {t(`membership.tier.${offer.tier}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th
            scope='row'
            className='border-b border-border px-2.5 py-2 text-left text-sm font-normal text-foreground-secondary'
          >
            {t('membership.monthlyFee')}
          </th>
          {offers.map((offer) => {
            const price = TIER_MONTHLY_PRICE_USD[offer.tier];
            return (
              <td key={offer.tier} className={columnClass(offer.tier)}>
                {price === 0
                  ? t('membership.priceFree')
                  : `$${String(price)}`}
              </td>
            );
          })}
        </tr>
        {rows.map((row) => (
          <tr key={row.key}>
            <th
              scope='row'
              className='border-b border-border px-2.5 py-2 text-left text-sm font-normal text-foreground-secondary'
            >
              {row.label}
            </th>
            {offers.map((offer) => (
              <td key={offer.tier} className={columnClass(offer.tier)}>
                {row.cell(offer)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});
