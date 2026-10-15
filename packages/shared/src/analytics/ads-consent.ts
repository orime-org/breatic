// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether ads may run, and what a signed-in browser reports to its account
 * (inner#1442 design §4.4.5, §4.4.6). A browser's own choice decides events
 * it causes; GPC only refuses ads the visitor never chose; events with no
 * browser use the account's latest report. Server, worker, app and website
 * all decide through these functions; the website keeps a verbatim copy that
 * its contract test compares.
 */

import { z } from "zod";
import { revisionInForce } from "@shared/analytics/consent.js";
import type { BrowserChoice } from "@shared/analytics/consent-choices.js";

/** This browser's ads consent with GPC applied, as stored on orders, tasks and upload jobs. */
export const BrowserAdsSnapshotSchema = z.object({ consent: z.boolean() }).strict();

/** This browser's ads consent with GPC applied. */
export type BrowserAdsSnapshot = z.infer<typeof BrowserAdsSnapshotSchema>;

/** A browser with no ads consent. */
export const NO_ADS_BROWSER: BrowserAdsSnapshot = Object.freeze({ consent: false });

/** What a signed-in browser reports to its account (`PUT /users/me/consent`): its consent snapshot. */
export const ReportedConsentSchema = z.object({ analytics: z.boolean(), ads: z.boolean() }).strict();

/** What a signed-in browser reports to its account. */
export type ReportedConsent = z.infer<typeof ReportedConsentSchema>;

/** One category of the account's latest report (`users.consent_seen`). */
export interface SeenChoice {
  readonly value: boolean;
  readonly revision: number;
}

/** The account's latest report, as `users.consent_seen` holds it. */
export interface ConsentRecord {
  readonly analytics: SeenChoice;
  readonly ads: SeenChoice;
  readonly reportedAt: string;
}

/**
 * Whether this browser's ads choice is a consent: GPC refuses a regional
 * default or a missing choice, and leaves the visitor's own choice as it is.
 * @param ads - The ads choice in force, or null without one.
 * @param gpc - Whether this browser sends GPC.
 * @returns Whether ads are consented.
 */
export function browserAdsConsent(ads: Pick<BrowserChoice, "value" | "source"> | null, gpc: boolean): boolean {
  if (ads === null || !ads.value) return false;
  return !(gpc && ads.source === "implicit");
}

/**
 * Whether ads may run.
 * @param input - What decides it.
 * @param input.browser - The ads consent of the browser behind the event, or null when none caused it.
 * @param input.seen - The ads choice in the account's latest report, for events no browser caused.
 * @param input.deleted - Whether the account is deleted.
 * @returns Whether ads may run.
 */
export function adsAllowed(input: {
  browser: BrowserAdsSnapshot | null;
  seen?: SeenChoice | null;
  deleted?: boolean;
}): boolean {
  const { browser, seen, deleted } = input;
  if (deleted) return false;
  if (browser !== null) return browser.consent;
  return seen?.value === true && revisionInForce(seen.revision);
}
