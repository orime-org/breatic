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
  // Handed on whole rather than copied field by field. Each half reads the
  // fields it declared and ignores the rest, so a field added to either one
  // arrives here without a third place to update — and a figure cannot be
  // routed to the wrong parameter, because nothing is routing them.
  const media = await fetchMedia(request);
  const answer = await understandMedia({ ...request, media });

  return { ...answer, kind: media.kind };
}
