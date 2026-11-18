// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The spend-limit refusal (inner#1968, design 3.10), said the same way at
 * every entry: with its limit and reset day, and no top-up, since adding
 * credits does not lift a limit.
 */

import { t } from '@breatic/shared';

import { serverWords } from '@web/data/api/server-message';
import { ApiException } from '@web/data/api/types';
import { StreamRefusedError } from '@web/data/stream/sse';
import { spendCapSentence } from '@web/lib/spend-cap-message';

/** The server's reason for a refusal past a spend limit. */
const SPEND_CAP_REACHED = 'spend_cap_reached';

/**
 * What a spend-limit refusal says, or null for any other failure.
 * @param err - What a request, or a stream before it opened, rejected with.
 * @returns The sentence, in the user's language, or null.
 */
export function refusalSentence(err: unknown): string | null {
  if (!(err instanceof ApiException || err instanceof StreamRefusedError) || err.reason !== SPEND_CAP_REACHED) return null;
  return spendCapSentence(err.details ?? {}, serverWords(err) ?? t('credits.refusal.spendCap'));
}

/**
 * What a refusal says at every entry that starts work: the spend limit when
 * that is why, otherwise the sentence our server wrote (design 3.3a).
 * @param err - What a request, or a stream before it opened, rejected with.
 * @returns The sentence, or null when nothing of ours says why.
 */
export function ourSentence(err: unknown): string | null {
  return refusalSentence(err) ?? serverWords(err);
}
