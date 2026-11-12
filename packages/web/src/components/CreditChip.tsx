// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as React from 'react';
import { Star } from 'lucide-react';

import { useTranslation } from '@web/i18n/use-translation';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

interface CreditChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** What the run was charged, or, while it is still being billed, what is known so far. */
  credits: number;
  /** Whether the run's upstream has not billed it yet (inner#1743). */
  billingPending: boolean;
}

/**
 * What a generation cost, beside a star: the node's history row and the project feed show it the same way. A run
 * still being billed shows the known part as a lower bound, the way the panel shows an estimate that can only grow,
 * with a word saying it is still being billed.
 * @param root0 - Chip props, plus any extra span attributes.
 * @param root0.credits - The amount.
 * @param root0.billingPending - Whether it is still being billed.
 * @returns The chip.
 */
export function CreditChip({ credits, billingPending, ...rest }: CreditChipProps): React.JSX.Element {
  const t = useTranslation();
  const amount = formatCreditAmount(credits);
  return (
    <span
      className={(billingPending ? 'gap-1' : 'gap-0.5') + ' inline-flex shrink-0 items-center text-xs tabular-nums text-foreground'}
      {...rest}
    >
      <Star className='h-3 w-3 text-muted-foreground' aria-hidden='true' />
      {billingPending ? (
        <>
          <span>{`≥ ${amount}`}</span>
          <span className='text-2xs text-muted-foreground'>{t('credits.billingPending')}</span>
        </>
      ) : (
        amount
      )}
    </span>
  );
}
