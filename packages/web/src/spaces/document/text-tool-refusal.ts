// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** What a text-tool run that was refused before its stream opened tells the user. */

import { StreamRefusedError } from '@web/data/stream/sse';
import { refusalSentence } from '@web/stores/credit-refusals';

/**
 * The sentence for a refused text-tool run: a spend limit says its limit and
 * local reset day (inner#1968, design 3.10); any other refusal our server
 * wrote says the server's sentence.
 * @param err - What the stream rejected with.
 * @returns The sentence, or null when nothing of ours says why.
 */
export function textToolRefusal(err: unknown): string | null {
  return refusalSentence(err) ?? (err instanceof StreamRefusedError && err.fromServer ? err.message : null);
}
