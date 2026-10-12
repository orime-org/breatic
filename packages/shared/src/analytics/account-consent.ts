// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { CONSENT_MAX_AGE_DAYS, CONSENT_REVISION } from "@shared/analytics/consent.js";

/** How a browser arrived at its choice (inner#1442 design §4.4.4). */
export const CONSENT_SOURCES = ["banner", "settings", "implicit", "gpc"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

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
  readonly source: ConsentSource;
  readonly revision: number;
}

/**
 * Fold a browser's report into the account's stored choice.
 * @param stored - What the account holds now; null when nothing was reported.
 * @param incoming - The choice a logged-in browser just reported.
 * @returns The record to keep: the later decision wins; on the same instant a
 *   category stays on only if both sides accepted it; a regional default the
 *   person never chose (`implicit`), a report from an older policy revision or
 *   one with an unreadable time leaves the record unchanged.
 */
export function mergeAccountConsent(
  stored: AccountConsent | null,
  incoming: AccountConsent,
): AccountConsent | null {
  const incomingAt = Date.parse(incoming.decidedAt);
  if (incoming.source === "implicit") return stored;
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

const MAX_AGE_MS = CONSENT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * The stored choice, while it still counts: made under the current policy and
 * no older than the consent cookie lasts.
 * @param stored - What the account holds.
 * @param now - The current time, epoch ms.
 * @returns The choice, or null; callers treat null as no consent.
 */
export function accountConsentCurrent(stored: AccountConsent | null, now: number): AccountConsent | null {
  if (stored === null || stored.revision !== CONSENT_REVISION) return null;
  const decidedAt = Date.parse(stored.decidedAt);
  return now - decidedAt <= MAX_AGE_MS ? stored : null;
}
