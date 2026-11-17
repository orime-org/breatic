// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The spend-limit refusal (inner#1968, design 3.10), said the same way at
 * every entry: with its limit and reset day, and no top-up, since adding
 * credits does not lift a limit.
 */

import { t } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { spendCapMessage } from '@web/lib/spend-cap-message';

/** The server's reason for a refusal past a spend limit. */
const SPEND_CAP_REACHED = 'spend_cap_reached';

/**
 * What a spend-limit refusal says, or null for any other failure.
 * @param err - What a request rejected with.
 * @returns The sentence, in the user's language, or null.
 */
export function refusalSentence(err: unknown): string | null {
  if (!(err instanceof ApiException) || err.reason !== SPEND_CAP_REACHED) return null;
  const { scope, limit, resetsAt } = err.details ?? {};
  if ((scope !== 'member' && scope !== 'studio') || typeof resetsAt !== 'string') {
    return err.fromServer && err.message ? err.message : t('credits.refusal.spendCap');
  }
  return spendCapMessage(SPEND_CAP_REACHED, scope, typeof limit === 'string' ? limit : String(limit ?? ''), resetsAt);
}
