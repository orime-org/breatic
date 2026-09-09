// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Asking a model about one piece of media.
 */

import type { UnderstandAnswer, UnderstandRequest } from "@domain/understand/types.js";

/**
 * Ask the model about this media and hand back what it wrote.
 * @param request - The media, the question, and who to ask.
 * @returns What the model wrote and why it stopped.
 * @throws {UnderstandRefused} when the service would not answer.
 */
export async function understandMedia(request: UnderstandRequest): Promise<UnderstandAnswer> {
  void request;
  return Promise.reject(new Error("not implemented"));
}
