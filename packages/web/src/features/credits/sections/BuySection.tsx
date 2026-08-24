// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { CreditOverview } from '@breatic/shared';

import { Figure, Notice, Section } from '@web/features/credits/section-chrome';
import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

/** The overview to read a balance from. */
interface BuySectionProps {
  /** What the account holds, and where. */
  overview: CreditOverview;
}

/**
 * Where credits will be bought.
 *
 * It carries the balance and how credits are priced, and says that buying is
 * not open yet. The packs and their checkout button are the separate piece of
 * work that connects this to the payment provider; putting a price list here
 * before then would quote figures nobody can pay.
 * @param props - The overview.
 * @param props.overview - What the account holds, and where.
 * @returns The section.
 */
export function BuySection({ overview }: BuySectionProps): React.JSX.Element {
  const t = useTranslation();
  const total = overview.assignedCredits + overview.unassignedCredits;

  return (
    <Section title={t('credits.section.buy')}>
      {overview.billing ? (
        <>
          <Figure
            label={t('credits.total')}
            value={formatCreditAmount(total)}
            unit={t('credits.unit')}
            hint={t('credits.pricingHint')}
          />
          <Notice
            title={t('credits.buySoon.title')}
            body={t('credits.buySoon.body')}
            tone='info'
          />
        </>
      ) : (
        <Notice
          title={t('credits.billingOff.title')}
          body={t('credits.billingOff.body')}
          tone='info'
        />
      )}
    </Section>
  );
}
