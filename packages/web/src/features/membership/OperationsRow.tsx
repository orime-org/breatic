// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { formatCredits, getLocale, type OperationUsage } from '@breatic/shared';

import { QuotaRow } from '@web/features/membership/QuotaRow';
import { useTranslation } from '@web/i18n/use-translation';
import { formatLongLocalDay } from '@web/lib/format-day';

/**
 * A count, grouped the way the user's language writes numbers.
 * @param count - The count.
 * @returns It, grouped.
 */
function grouped(count: number): string {
  return count.toLocaleString(getLocale());
}

/**
 * The month's operations on the membership panel (inner#1968, design 3.7):
 * what the allowance has used, what is left and the day it resets; once it is
 * used up and the account is charged, what one more costs and how many went
 * over. The bar measures the allowance only, so it fills and never turns red:
 * going past it is charged, not refused.
 * @param props - The period's operations.
 * @param props.operations - What one account has used of its operations.
 * @returns The row.
 */
export const OperationsRow = React.memo(function OperationsRow({
  operations,
}: {
  operations: OperationUsage;
}): React.JSX.Element {
  const t = useTranslation();
  const { monthlyAllowance, allowanceUsed, allowanceRemaining, overageThisPeriod, nextResetAt, overageCredits } = operations;
  return (
    <div className='flex flex-col gap-1.5' data-testid='quota-operations'>
      <QuotaRow
        testId='quota-operations-bar'
        label={t('membership.operations.label')}
        value={t('membership.quotaValue', { used: grouped(allowanceUsed), limit: grouped(monthlyAllowance) })}
        used={allowanceUsed}
        limit={monthlyAllowance}
        overLabel={t('membership.overLimitTag')}
      />
      <div className='flex items-baseline justify-between gap-3 text-xs text-muted-foreground'>
        <span>{t('membership.operations.remaining', { count: grouped(allowanceRemaining) })}</span>
        <span>{t('membership.operations.resetsOn', { date: formatLongLocalDay(nextResetAt) })}</span>
      </div>
      {allowanceRemaining === 0 && overageCredits !== null ? (
        <p className='text-sm text-foreground-secondary'>
          {t('membership.operations.overagePrice', { credits: formatCredits(overageCredits, getLocale()) })}
        </p>
      ) : null}
      {overageThisPeriod > 0 && overageCredits !== null ? (
        <p className='text-sm text-foreground-secondary'>
          {t('membership.operations.overageCount', { count: grouped(overageThisPeriod) })}
        </p>
      ) : null}
      <p className='text-xs text-muted-foreground'>{t('membership.operations.shared')}</p>
    </div>
  );
});
