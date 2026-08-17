// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

import { usageRatio } from '@web/features/membership/format';

/** One allowance, its spend, and how full that leaves it. */
interface QuotaRowProps {
  /** What this allowance is called. */
  label: string;
  /** The spend and the ceiling, already rendered (`38 GiB / 200 GiB`). */
  value: string;
  /** How much is spent, in the ceiling's own unit. */
  used: number;
  /** The ceiling. */
  limit: number;
  /** The word shown beside the figures once the spend is past the ceiling. */
  overLabel: string;
  /** Identifies the row for tests. */
  testId: string;
}

/**
 * One account-level allowance: what it is, how much of it is gone, and a bar.
 *
 * Being over the ceiling is a state to report rather than an error to raise —
 * ceilings are judged when an action happens and are never applied backwards,
 * so an account can legitimately sit above one. The figures then say so and
 * take the error colour, and the bar fills; nothing is hidden and nothing is
 * blocked.
 * @param props - The allowance to draw.
 * @param props.label - What this allowance is called.
 * @param props.value - The spend and the ceiling, already rendered.
 * @param props.used - How much is spent.
 * @param props.limit - The ceiling.
 * @param props.overLabel - The word shown when the spend is past the ceiling.
 * @param props.testId - Identifies the row for tests.
 * @returns The row.
 */
export const QuotaRow = React.memo(function QuotaRow({
  label,
  value,
  used,
  limit,
  overLabel,
  testId,
}: QuotaRowProps): React.JSX.Element {
  const over = used > limit;
  const ratio = usageRatio(used, limit);
  return (
    <div className='flex flex-col gap-1.5' data-testid={testId}>
      <div className='flex items-baseline justify-between gap-3'>
        <span className='text-sm'>{label}</span>
        <span
          className={
            over
              ? 'text-sm font-semibold tabular-nums text-status-error-foreground'
              : 'text-sm tabular-nums text-foreground-secondary'
          }
        >
          {value}
          {over ? ` (${overLabel})` : ''}
        </span>
      </div>
      <div className='h-1 overflow-hidden rounded-full bg-muted'>
        <div
          className={
            over ? 'h-full bg-status-error' : 'h-full bg-foreground'
          }
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
});
