// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { CONSENT_REVISION } from "@shared/analytics/consent.js";

/**
 * The latest consent choice an account's browsers have reported.
 *
 * Events with no browser behind them (a renewal, an approved refund, a
 * collaboration conversion reported for the project owner) follow this
 * record; events a browser triggers follow that browser's own cookie
 * (inner#1442 design §4.4.5, §4.4.6).
 */
export interface AccountConsent {
  readonly analytics: boolean;
  readonly ads: boolean;
  /** When the person made the choice in the browser, as an ISO timestamp. */
  readonly decidedAt: string;
  /** How the browser arrived at the choice: banner, settings, implicit or gpc. */
  readonly source: string;
  readonly revision: number;
}

/**
 * Fold a browser's report into the account's stored choice.
 * @param stored - What the account holds now; null when nothing was reported.
 * @param incoming - The choice a logged-in browser just reported.
 * @returns The record to keep: the later decision wins; on the same instant a
 *   category stays on only if both sides accepted it; reports from an older
 *   policy revision or with an unreadable time leave the record unchanged.
 */
export function mergeAccountConsent(
  stored: AccountConsent | null,
  incoming: AccountConsent,
): AccountConsent | null {
  const incomingAt = Date.parse(incoming.decidedAt);
  if (incoming.revision !== CONSENT_REVISION || Number.isNaN(incomingAt)) return stored;
  if (stored === null) return incoming;
  const storedAt = Date.parse(stored.decidedAt);
  if (incomingAt > storedAt || Number.isNaN(storedAt)) return incoming;
  if (incomingAt < storedAt) return stored;
  return {
    ...incoming,
    analytics: stored.analytics && incoming.analytics,
    ads: stored.ads && incoming.ads,
  };
}
