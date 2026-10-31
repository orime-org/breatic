// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { COMPARABLE_MEMBERSHIP_TIERS, type ComparableMembershipTier, type TierOffer } from '@breatic/shared';

import { Skeleton } from '@web/components/ui/skeleton';
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
  const tiers = React.useMemo(() => offers.map((offer) => offer.tier), [offers]);
  const cell = React.useCallback(
    (row: ComparisonRow, tier: ComparableMembershipTier): React.ReactNode => {
      const offer = offers.find((candidate) => candidate.tier === tier);
      return offer ? row.cell(offer) : null;
    },
    [offers],
  );
  return <ComparisonTable tiers={tiers} cell={cell} />;
});

/**
 * The comparison table while its figures are on the way: the same corner,
 * tier names and row labels, which never depend on the answer, and a bar in
 * each figure's place, held to the line height so every row is as tall as it
 * will be.
 * @returns The table, waiting.
 */
export function TierComparisonSkeleton(): React.JSX.Element {
  return <ComparisonTable tiers={COMPARABLE_MEMBERSHIP_TIERS} cell={figureBar} />;
}

/**
 * A figure's placeholder, one line tall.
 * @returns The bar.
 */
function figureBar(): React.ReactNode {
  return (
    <span className='flex h-lh items-center justify-end'>
      <Skeleton className='h-3.5 w-10' data-testid='compare-cell-skeleton' />
    </span>
  );
}

/** One row of the table: its key, the label key and how an offer fills it. */
interface ComparisonRow {
  key: string;
  label: string;
  cell: (offer: TierOffer) => string;
}

/** The six ceilings, in the order the table lists them. */
const ROWS: readonly ComparisonRow[] = [
  { key: 'teamStudios', label: 'membership.quota.teamStudios', cell: (offer) => String(offer.limits.team_studios) },
  { key: 'projectsPerStudio', label: 'membership.quota.projectsPerStudio', cell: (offer) => String(offer.limits.projects_per_studio) },
  { key: 'studioMembers', label: 'membership.quota.studioMembers', cell: (offer) => String(offer.limits.studio_members) },
  { key: 'projectMembers', label: 'membership.quota.projectMembers', cell: (offer) => String(offer.limits.project_members) },
  { key: 'concurrentEditors', label: 'membership.quota.concurrentEditors', cell: (offer) => String(offer.limits.concurrent_editors) },
  { key: 'storage', label: 'membership.quota.storage', cell: (offer) => formatBytes(offer.limits.storage_bytes) },
];

/**
 * The table both states draw.
 * @param props - The columns and what goes in each figure's cell.
 * @param props.tiers - The tiers, one column each, in ascending order.
 * @param props.cell - What one row shows for one tier.
 * @returns The table.
 */
function ComparisonTable({
  tiers,
  cell,
}: {
  tiers: readonly ComparableMembershipTier[];
  cell: (row: ComparisonRow, tier: ComparableMembershipTier) => React.ReactNode;
}): React.JSX.Element {
  const t = useTranslation();
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
          {tiers.map((tier) => (
            <th
              key={tier}
              scope='col'
              data-testid={`compare-column-${tier}`}
              className='border-b border-border px-2.5 py-2 text-right text-xs font-semibold text-muted-foreground'
            >
              {t(`membership.tier.${tier}`)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key}>
            <th
              scope='row'
              className='border-b border-border px-2.5 py-2 text-left text-sm font-normal text-foreground-secondary'
            >
              {t(row.label)}
            </th>
            {tiers.map((tier) => (
              <td
                key={tier}
                data-testid={`compare-cell-${tier}-${row.key}`}
                className='border-b border-border px-2.5 py-2 text-right tabular-nums'
              >
                {cell(row, tier)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
