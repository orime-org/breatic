// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { TierOffer } from '@breatic/shared';

import { formatBytes } from '@web/lib/format-bytes';
import { useTranslation } from '@web/i18n/use-translation';

/** The comparison table's inputs. */
interface TierComparisonProps {
  /** The tiers to compare, in ascending order. */
  offers: readonly TierOffer[];
}

/**
 * The priced tiers' six ceilings side by side.
 *
 * A real `<table>` rather than a grid of divs: the numbers are a table, and
 * one that says so can be read down a column by anything that reads tables.
 *
 * It does not mark which tier the account is on. Two things above it already
 * say so — the tier name in the first section, and "Current" on one of the
 * cards — and a third would only lay an unread tint over one column. Here the
 * table answers one question: what each tier's figures are.
 *
 * Each cell is identified by its tier AND its row, so a test can assert what
 * one particular figure says. A column-wide id could only ever count cells,
 * which is how a row reading the wrong ceiling stayed invisible.
 *
 * Only the tiers on the price list appear. `self_hosted` is a deployment shape
 * and `enterprise` is negotiated per customer, so neither is something to
 * compare against — the server leaves them out of `catalog`, and this renders
 * what it is given.
 * @param props - The offers to compare.
 * @param props.offers - The tiers to compare, in ascending order.
 * @returns The comparison table.
 */
export const TierComparison = React.memo(function TierComparison({
  offers,
}: TierComparisonProps): React.JSX.Element {
  const t = useTranslation();

  // Not memoised on `[t]`: `useTranslation` hands back the module-level
  // function, whose identity never changes, so such a memo would compute these
  // six strings once and hold the first locale's words forever. Building six
  // strings per render costs nothing worth protecting.
  const rows = [
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
  ];

  // `border-separate` rather than `border-collapse`: under the collapsed
  // border model browsers ignore a cell's border-radius outright. Spacing is
  // zero, so each row still shows a single bottom border.
  return (
    <table className='w-full border-separate border-spacing-0 text-sm'>
      <thead>
        <tr>
          {/* The corner is the section heading. It sits on the same line as
              the tier names because that line IS the table's header row —
              a separate heading above it left this column unlabelled. */}
          <th
            scope='col'
            className='border-b border-border px-2.5 py-2 text-left text-xs font-bold uppercase tracking-[0.04em] text-muted-foreground'
          >
            {t('membership.compare')}
          </th>
          {offers.map((offer) => (
            <th
              key={offer.tier}
              scope='col'
              data-testid={`compare-column-${offer.tier}`}
              className='border-b border-border px-2.5 py-2 text-right text-xs font-semibold text-muted-foreground'
            >
              {t(`membership.tier.${offer.tier}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <th
              scope='row'
              className='border-b border-border px-2.5 py-2 text-left text-sm font-normal text-foreground-secondary'
            >
              {row.label}
            </th>
            {offers.map((offer) => (
              <td
                key={offer.tier}
                data-testid={`compare-cell-${offer.tier}-${row.key}`}
                className='border-b border-border px-2.5 py-2 text-right tabular-nums'
              >
                {row.cell(offer)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});
