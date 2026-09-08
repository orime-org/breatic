// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a model call costs, priced by the tokens it reported.
 *
 * Three paths charge this way — a chat turn, a memory consolidation and the
 * text mini-tool — and they are charging for the same thing: a call to a
 * language model, billed by size. Written once so the rounding and the
 * multiplier cannot drift apart between them, which would have two readers
 * paying different amounts for identical work.
 */

import { env } from "@breatic/core";

/**
 * Price one model call.
 * @param tokensUsed - Total tokens the call reported.
 * @returns Whole credits owed, rounded up.
 */
export function creditsForTokens(tokensUsed: number): number {
  return Math.ceil((tokensUsed / 1000) * env.CREDIT_MULTIPLIER);
}
