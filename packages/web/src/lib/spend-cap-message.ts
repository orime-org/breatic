// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { t } from '@breatic/shared';

import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLongLocalDay } from '@web/lib/format-day';

/**
 * The sentence a spend-limit refusal is told in (inner#1968, design 3.10):
 * the person's own limit names its amount, the Studio's total does not, and
 * both say the day it resets in the user's own time. Neither offers a top-up,
 * since adding credits does not lift a limit.
 * @param _reason - The refusal's reason, `spend_cap_reached`.
 * @param scope - Whose limit was reached: the person's or the Studio's.
 * @param limit - The limit, as a credit decimal.
 * @param resetsAt - When the month resets, as an ISO instant.
 * @returns The sentence, in the user's language.
 */
export function spendCapMessage(
  _reason: 'spend_cap_reached',
  scope: 'member' | 'studio',
  limit: string,
  resetsAt: string,
): string {
  const date = formatLongLocalDay(resetsAt);
  return scope === 'member'
    ? t('credits.spendCap.member', { limit: formatCreditAmount(limit), date })
    : t('credits.spendCap.studio', { date });
}
