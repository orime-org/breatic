// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditOverview } from '@breatic/shared';

import {
  Card,
  Figure,
  Notice,
  Section,
} from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { userPaletteHue } from '@web/lib/user-color';

/** The overview to draw. */
interface OverviewSectionProps {
  /** What the account holds, and where. */
  overview: CreditOverview;
}

/**
 * What the account holds: three headline figures and where the money sits.
 *
 * The three are reported separately rather than as one balance because they
 * are not interchangeable — unassigned credits cannot be spent anywhere until
 * somebody points them at a studio.
 * @param props - The overview.
 * @param props.overview - What the account holds, and where.
 * @returns The section.
 */
export function OverviewSection({
  overview,
}: OverviewSectionProps): React.JSX.Element {
  const t = useTranslation();
  const total = overview.assignedCredits + overview.unassignedCredits;
  const unit = t('credits.unit');
  const dash = '—';

  const slices = React.useMemo(
    () =>
      overview.studios
        .filter((studio) => studio.spendable > 0)
        .map((studio) => ({
          key: studio.studioId,
          name: studio.studioName,
          value: studio.spendable,
          color: `var(--color-palette-${userPaletteHue(studio.studioId)})`,
        })),
    [overview.studios],
  );
  const unassignedSlice =
    overview.unassignedCredits > 0
      ? {
        key: 'unassigned',
        name: t('credits.unassigned'),
        value: overview.unassignedCredits,
        color: 'var(--color-muted-foreground)',
      }
      : null;
  const parts =
    unassignedSlice === null ? slices : [...slices, unassignedSlice];

  return (
    <Section title={t('credits.section.overview')}>
      {overview.billing ? null : (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      )}
      <div className='flex flex-wrap gap-9'>
        <Figure
          label={t('credits.total')}
          value={overview.billing ? formatCreditAmount(total) : dash}
          {...(overview.billing ? { unit } : {})}
          {...(overview.billing ? { hint: t('credits.pricingHint') } : {})}
        />
        <Figure
          label={t('credits.unassigned')}
          value={
            overview.billing ? formatCreditAmount(overview.unassignedCredits) : dash
          }
          {...(overview.billing ? { unit } : {})}
          {...(overview.billing && overview.unassignedCredits > 0
            ? { hint: t('credits.unassignedHint') }
            : {})}
        />
        <Figure
          label={t('credits.assigned')}
          value={
            overview.billing ? formatCreditAmount(overview.assignedCredits) : dash
          }
          {...(overview.billing ? { unit } : {})}
        />
      </div>
      {!overview.billing ? null : total === 0 ? (
        <Notice
          title={t('credits.overviewEmpty.title')}
          body={t('credits.overviewEmpty.body')}
        />
      ) : (
        <Card title={t('credits.distributionTitle')}>
          {/* A bar rather than a list of percentages: which studio holds most
              of the money is the question, and relative width answers it
              without anybody doing arithmetic. The legend carries the names
              and figures, so the colours are never the only signal. */}
          <div
            className='flex h-2 overflow-hidden rounded-full'
            aria-hidden='true'
          >
            {parts.map((part) => (
              <span
                key={part.key}
                style={{
                  width: `${((part.value / total) * 100).toFixed(2)}%`,
                  background: part.color,
                }}
              />
            ))}
          </div>
          <ul className='mt-3 flex list-none flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground'>
            {parts.map((part) => (
              <li key={part.key} className='flex items-center gap-1.5'>
                <span
                  className='h-2 w-2 shrink-0 rounded-full'
                  style={{ background: part.color }}
                />
                {part.name} {formatCreditAmount(part.value)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Section>
  );
}
