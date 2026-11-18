// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { ApiException } from '@web/data/api/types';
import { StreamRefusedError } from '@web/data/stream/sse';

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
