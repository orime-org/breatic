// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import { getLocale } from '@breatic/shared';
import type {
  ComparableMembershipTier,
  MembershipTier,
  TierOffer,
  UpgradeOffer,
} from '@breatic/shared';

import { Button } from '@web/components/ui/button';
import { formatBytes, formatPrice } from '@web/features/membership/format';
import { useTranslation } from '@web/i18n/use-translation';

/** The comparison table's inputs. */
interface TierComparisonProps {
  /** The tiers to compare, in ascending order. */
  offers: readonly TierOffer[];
  /** The account's own tier, so its column can be marked. */
  currentTier: MembershipTier;
  /**
   * Take the account to a tier above its own.
   *
   * Absent where this deployment sells nothing, which is what removes the
   * whole action row rather than leaving buttons that cannot work.
   */
  onChoose?: (tier: ComparableMembershipTier) => void;
  /** Whether a choice is already being carried out, so the row waits. */
  busy?: boolean;
  /**
   * Whether a higher tier can be chosen right now (design §13).
   *
   * `pending` while an upgrade is bought and waiting on its invoice: the
   * entrance says so instead of inviting a second one. `withheld` while a
   * card is failing, which is the one situation the server refuses an upgrade
   * in — drawing the button there produced nothing but a 409.
   */
  upgrade?: UpgradeOffer;
}

/**
 * The priced tiers side by side, with the account's own column marked.
 *
 * A real `<table>` rather than a grid of divs: the numbers are a table, and
 * one that says so can be read down a column by anything that reads tables.
 * The rows are the price plus the six ceilings.
 *
 * The current column is filled with `bg-accent`, which moves away from the
 * page in both themes — darker than it in light, lighter in dark (tokens.css
 * calls it "light darker / dark lighter"). `bg-card`, which this used before,
 * goes lighter in both, so in the light theme the marked column receded
 * exactly where it should stand out.
 *
 * Each cell is identified by its tier AND its row, so a test can assert what
 * one particular figure says. A column-wide id could only ever count cells,
 * which is how a row reading the wrong ceiling stayed invisible.
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
  onChoose,
  busy = false,
  upgrade = 'offered',
}: TierComparisonProps): React.JSX.Element {
  const t = useTranslation();
  // Read rather than subscribed to: `useTranslation` above already subscribes
  // to locale changes and re-renders this component, so by the time this runs
  // the locale is the current one. A second subscription would be redundant.
  const locale = getLocale();
  // Where the account's own tier sits, so the row below can tell "above me"
  // from "below me". A tier that is not on this table at all — self-hosted,
  // enterprise — gives -1, and then every column reads as above it, which is
  // right: neither of those has a table rendered for it anyway.
  const currentRank = offers.findIndex((offer) => offer.tier === currentTier);

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

  /**
   * Mark the account's own column so the comparison has a starting point.
   * @param tier - The column's tier.
   * @returns The class list for a cell in that column.
   */
  const columnClass = (tier: string): string =>
    tier === currentTier
      ? 'border-b border-border bg-accent px-2.5 py-2 text-right tabular-nums'
      : 'border-b border-border px-2.5 py-2 text-right tabular-nums';

  // `border-separate` rather than `border-collapse`: under the collapsed
  // border model browsers ignore a cell's border-radius outright, and the
  // highlighted column's first and last cells are meant to be rounded.
  // Spacing is zero, so each row still shows a single bottom border and the
  // table looks exactly as it did.
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
              aria-current={offer.tier === currentTier ? 'true' : undefined}
              className={
                offer.tier === currentTier
                  ? 'rounded-t-chrome border-b border-active-border bg-accent px-2.5 py-2 text-right text-xs font-semibold text-foreground'
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
          {offers.map((offer) => (
            <td
              key={offer.tier}
              data-testid={`compare-cell-${offer.tier}-monthlyFee`}
              className={columnClass(offer.tier)}
            >
              {/* Two different nulls. The free tier has no price because it
                  costs nothing, and says so. A priced tier has none when this
                  deployment sells nothing, and "Free" would be a claim that
                  PRO costs nothing — it costs $12 wherever it is sold. */}
              {offer.priceCents !== null && offer.currency !== null
                ? formatPrice(offer.priceCents, offer.currency, locale)
                : offer.tier === 'base'
                  ? t('membership.priceFree')
                  : '—'}
            </td>
          ))}
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
              <td
                key={offer.tier}
                data-testid={`compare-cell-${offer.tier}-${row.key}`}
                className={columnClass(offer.tier)}
              >
                {row.cell(offer)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {onChoose ? (
        <tfoot>
          <tr>
            {/* Empty on purpose. A note about tax belonged here while we
                expected to add tax at checkout; we do not — Stripe Tax needs
                a tax registration first and is deferred (#107) — so the line
                promised a calculation that never happens. It comes back when
                the calculation does. */}
            <td className='px-2.5 py-3' />
            {offers.map((offer, index) => (
              <td
                key={offer.tier}
                data-testid={`compare-action-${offer.tier}`}
                className={
                  offer.tier === currentTier
                    ? 'rounded-b-chrome bg-accent px-2.5 py-3 text-center'
                    : 'px-2.5 py-3 text-center'
                }
              >
                {/* Three cases, and the third is deliberately empty. A tier
                    below the account's own offers nothing at all: downgrading
                    is not on offer, so there is no control and therefore
                    nothing to explain. */}
                {offer.tier === currentTier ? (
                  <span className='text-xs font-semibold text-foreground'>
                    {t('membership.action.current')}
                  </span>
                ) : index > currentRank && upgrade !== 'withheld' ? (
                  <Button
                    type='button'
                    size='sm'
                    disabled={busy || upgrade === 'pending'}
                    data-testid={`membership-choose-${offer.tier}`}
                    onClick={() => onChoose(offer.tier)}
                  >
                    {upgrade === 'pending'
                      ? t('membership.action.inProgress')
                      : t('membership.action.choose', {
                        tier: t(`membership.tier.${offer.tier}`),
                      })}
                  </Button>
                ) : null}
              </td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
});
