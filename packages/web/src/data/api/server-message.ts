// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { t } from '@breatic/shared';

import { ApiException } from '@web/data/api/types';
import { StreamRefusedError } from '@web/data/stream/sse';
import { spendCapSentence } from '@web/lib/spend-cap-message';

/**
 * The sentence our server wrote for this user about a refused request, or a
 * stream refused before it opened, if it wrote one.
 * @param err - Whatever the call threw.
 * @returns The sentence, or null when it is not ours.
 */
export function serverWords(err: unknown): string | null {
  return (err instanceof ApiException || err instanceof StreamRefusedError) && err.fromServer && err.message ? err.message : null;
}

/**
 * What to tell the user about a request the server turned down.
 *
 * The server writes a sentence for each refusal it has — already subscribed,
 * being refunded, spent from, past the window — and that sentence is the only
 * true thing there is to say. A generic line is the honest answer in exactly
 * one case: the request never reached us.
 *
 * `fromServer` is what separates the two, rather than "is the message
 * non-empty". A request that never arrived — network down, a gateway
 * answering HTML, a timeout — still leaves axios a message, and it is English
 * written for a developer ("Network Error", "Request failed with status code
 * 502"). Handing that to a user in any of our five languages is the thing
 * this field exists to prevent.
 * @param err - Whatever the call threw.
 * @param fallback - The line for a request that never reached us, translated.
 * @returns The line to show.
 */
export function serverMessage(err: unknown, fallback: string): string {
  return serverWords(err) ?? fallback;
}

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
