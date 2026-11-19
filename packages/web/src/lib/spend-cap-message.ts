// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { t } from '@breatic/shared';

import { formatCreditAmount } from '@web/lib/format-credit-amount';
import { formatLongLocalDay } from '@web/lib/format-day';

/**
 * The sentence a spend-limit refusal is told in (inner#1968, design 3.10):
 * the person's own limit names its amount, the Studio's total does not, and
 * both say the day it resets in the user's own time. Neither offers a top-up,
 * since adding credits does not lift a limit.
 * @param scope - Whose limit was reached: the person's or the Studio's.
 * @param limit - The limit, as a credit decimal.
 * @param resetsAt - When the month resets, as an ISO instant.
 * @returns The sentence, in the user's language.
 */
export function spendCapMessage(scope: 'member' | 'studio', limit: string, resetsAt: string): string {
  const date = formatLongLocalDay(resetsAt);
  return scope === 'member'
    ? t('credits.spendCap.member', { limit: formatCreditAmount(limit), date })
    : t('credits.spendCap.studio', { date });
}

/**
 * The spend-limit sentence for whatever fields a refusal carried: the full
 * sentence when they name a scope, its reset day and, for a person's own
 * limit, its amount; otherwise the fallback.
 * @param fields - The refusal's fields, as received.
 * @param fields.scope - Whose limit was reached.
 * @param fields.limit - The limit, as a credit decimal.
 * @param fields.resetsAt - When the month resets, as an ISO instant.
 * @param fallback - What to say when they do not name all that.
 * @returns The sentence.
 */
export function spendCapSentence(fields: { scope?: unknown; limit?: unknown; resetsAt?: unknown }, fallback: string): string {
  const { scope, limit, resetsAt } = fields;
  if ((scope !== 'member' && scope !== 'studio') || typeof resetsAt !== 'string') return fallback;
  if (scope === 'member' && typeof limit !== 'string') return fallback;
  return spendCapMessage(scope, typeof limit === 'string' ? limit : '', resetsAt);
}
