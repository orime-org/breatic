// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditOverview, StudioCreditSummary } from '@breatic/shared';

import { Badge } from '@web/components/ui/badge';
import {
  Card,
  Notice,
  Row,
  Rows,
  Section,
  Footnote,
  SectionEmpty,
} from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

/** The overview to draw a studio breakdown from. */
interface StudiosSectionProps {
  /** What the account holds, and where. */
  overview: CreditOverview;
}

/**
 * A line per studio this account has money in, has spent money in, or still
 * owes for.
 *
 * Deleted studios stay listed. The money was really spent there, and dropping
 * the row would make the spending column stop adding up — which is how the
 * large clouds report terminated resources. Their balance reads as a dash
 * instead of a number, because it can no longer be spent.
 *
 * Debt sits beside what the studio can spend rather than being taken off it:
 * a debt belongs to the studio and was run up by everyone generating in it,
 * so subtracting it from one funder's figure would charge every funder the
 * whole of it.
 * @param props - The overview.
 * @param props.overview - What the account holds, and where.
 * @returns The section.
 */
export function StudiosSection({
  overview,
}: StudiosSectionProps): React.JSX.Element {
  const t = useTranslation();

  return (
    <Section title={t('credits.section.studios')}>
      {overview.billing ? null : (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      )}
      {overview.studios.length === 0 ? (
        <SectionEmpty message={t('credits.studiosEmpty')} />
      ) : (
        <>
          <Card>
            <Rows>
              {overview.studios.map((studio) => (
                <StudioRow
                  key={studio.studioId}
                  studio={studio}
                  billing={overview.billing}
                />
              ))}
            </Rows>
          </Card>
          <Footnote>{t('credits.studiosNote')}</Footnote>
        </>
      )}
    </Section>
  );
}

/** One studio's line. */
interface StudioRowProps {
  /** The studio. */
  studio: StudioCreditSummary;
  /** Whether this deployment charges for generation at all. */
  billing: boolean;
}

/**
 * One studio: what it can spend, what it owes, and what it has spent.
 * @param props - The studio and whether billing is on.
 * @param props.studio - The studio.
 * @param props.billing - Whether this deployment charges at all.
 * @returns The row.
 */
const StudioRow = React.memo(function StudioRow({ studio, billing }: StudioRowProps): React.JSX.Element {
  const t = useTranslation();
  const spent = formatCreditAmount(studio.spent);

  return (
    <Row
      main={
        <>
          {/* The name, even once it is deleted. The row survives precisely so
              that the money can say where it went, and replacing the name
              with "a deleted Studio" takes that away a second time. The
              fallback is for a row whose name really did not come back. */}
          {studio.studioName === ''
            ? t('credits.deletedStudio')
            : studio.studioName}
          {studio.deleted ? (
            <Badge variant='secondary' className='ml-2 align-middle'>
              {t('credits.deletedBadge')}
            </Badge>
          ) : null}
        </>
      }
      sub={
        !billing
          ? t('credits.billingOff.title')
          : studio.deleted
            ? t('credits.deletedStudioHint')
            : studio.lotCount > 0
              ? t('credits.assignedLots', { count: studio.lotCount })
              : t('credits.noLotsHere')
      }
      right={
        <>
          <span className='block text-sm font-semibold'>
            {!billing || studio.deleted
              ? '—'
              : formatCreditAmount(studio.spendable)}
          </span>
          {/* A debt is the studio's, and null here says this reader no longer
              administers it. What they spent stays either way: that is their
              own history. */}
          <span className='block text-xs text-muted-foreground'>
            {studio.debt !== null && studio.debt > 0
              ? t('credits.debtAndSpent', {
                debt: formatCreditAmount(studio.debt),
                spent,
              })
              : t('credits.spentOnly', { spent })}
          </span>
        </>
      }
    />
  );
});
