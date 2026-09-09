// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The whole of one media understanding call: get the media, then ask about it.
 *
 * The two steps have an order and a set of limits between them, and that
 * belongs here rather than in each caller. A second caller assembling it again
 * would decide for itself which failures mean what, and the two would answer
 * differently for the same address.
 */

import { fetchMedia } from "@domain/understand/fetch-media.js";
import { understandMedia } from "@domain/understand/understand.js";
import type { MediaKind, UnderstandAnswer, UnderstandAt } from "@domain/understand/types.js";

/** What one call answered with, and which kind it turned out to be. */
export interface UnderstandAtAnswer extends UnderstandAnswer {
  /** Which of the three kinds the address held. */
  kind: MediaKind;
}

/**
 * Get the media at an address and ask a model about it.
 * @param request - The address, the question, the limits, and who to ask.
 * @returns What the model wrote, and which kind the address held.
 * @throws {MediaUnavailable} when the address yields no usable media.
 * @throws {UnderstandRefused} when the service would not answer.
 */
export async function understandMediaAt(request: UnderstandAt): Promise<UnderstandAtAnswer> {
  const media = await fetchMedia({
    url: request.url,
    maxBytes: request.maxBytes,
    fetchTimeoutMs: request.fetchTimeoutMs,
    minBytesPerSec: request.minBytesPerSec,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  const answer = await understandMedia({
    media,
    question: request.question,
    model: request.model,
    ...(request.backend ? { backend: request.backend } : {}),
    apiKey: request.apiKey,
    baseUrl: request.baseUrl,
    maxOutputTokens: request.maxOutputTokens,
    timeoutMs: request.callTimeoutMs,
    ...(request.signal ? { signal: request.signal } : {}),
  });

  return { ...answer, kind: media.kind };
}
