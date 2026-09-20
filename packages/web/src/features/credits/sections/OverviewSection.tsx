// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import { accountTotal } from '@breatic/shared';
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
  // What the account holds, which is not the same as what it can spend. A
  // purchase under refund is still theirs until the money goes back, and
  // leaving it out makes the total drop the moment one is asked about, with
  // nothing on the screen saying where it went.
  const total = accountTotal(overview);
  const unit = t('credits.unit');
  const dash = '—';

  // The studios holding credits, which is what the card above them says it
  // is about. Unassigned credits and ones under refund are at no studio, and
  // both have a figure of their own above.
  const parts = React.useMemo(
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

  return (
    <Section title={t('credits.section.overview')}>
      {overview.billing ? null : (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      )}
      {/* The total on a line of its own, above the numbers that add up to
          it. Drawn the same size, the four read as four peers, and nothing
          on the screen says the first one is the sum of the rest. */}
      <div>
        <div className='border-b border-border pb-4'>
          <Figure
            label={t('credits.total')}
            value={overview.billing ? formatCreditAmount(total) : dash}
            {...(overview.billing ? { unit } : {})}
            {...(overview.billing ? { hint: t('credits.pricingHint') } : {})}
          />
        </div>
        <div className='mt-4 flex flex-wrap gap-x-9 gap-y-4'>
          <Figure
            size='part'
            label={t('credits.unassigned')}
            value={
              overview.billing
                ? formatCreditAmount(overview.unassignedCredits)
                : dash
            }
            {...(overview.billing ? { unit } : {})}
            {...(overview.billing && overview.unassignedCredits > 0
              ? { hint: t('credits.unassignedHint') }
              : {})}
          />
          <Figure
            size='part'
            label={t('credits.assigned')}
            value={
              overview.billing ? formatCreditAmount(overview.assignedCredits) : dash
            }
            {...(overview.billing ? { unit } : {})}
          />
          {!overview.billing || overview.underRefundCredits === 0 ? null : (
            <Figure
              size='part'
              label={t('credits.underRefund')}
              value={formatCreditAmount(overview.underRefundCredits)}
              unit={unit}
              hint={t('credits.underRefundHint')}
            />
          )}
        </div>
      </div>
      {!overview.billing ? null : total === 0 ? (
        <Notice
          title={t('credits.overviewEmpty.title')}
          body={t('credits.overviewEmpty.body')}
        />
      ) : parts.length === 0 ? null : (
        <Card title={t('credits.distributionTitle')}>
          {/* A bar rather than a list of percentages: which studio holds most
              of the money is the question, and relative width answers it
              without anybody doing arithmetic. The legend carries the names
              and figures, so the colours are never the only signal.

              Segments are parted by a hairline of the card behind them, which
              is what makes two of them two rather than one: a studio's colour
              is hashed from its id, so two studios can be handed the same
              one. Parting them is what the published guidance recommends
              over hunting for colours that clear 3:1 pairwise.

              The widths are grow factors rather than percentages so the gaps
              come out of the total before the split, leaving the segments
              proportional to each other. */}
          <div
            className='flex h-2 gap-px overflow-hidden rounded-full'
            aria-hidden='true'
          >
            {parts.map((part) => (
              <span
                key={part.key}
                style={{
                  flexGrow: part.value,
                  flexBasis: 0,
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
