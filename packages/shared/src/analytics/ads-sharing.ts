// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether ads may run, from this browser's choice, its GPC signal and the
 * account's ad switch (inner#1442 design §4.4.6). Server, worker, app and
 * website all decide through these functions; the website keeps a verbatim
 * copy that its contract test compares.
 */

import { z } from "zod";
import { revisionInForce } from "@shared/analytics/consent.js";

/** Who switched an account's ads off. */
export const AdsOptOutSourceSchema = z.enum(["settings", "gpc", "request"]);
export type AdsOptOutSource = z.infer<typeof AdsOptOutSourceSchema>;

/** The answer of `GET`/`PUT /me/ads-sharing`. */
export const AdsSharingSchema = z
  .object({
    optedOut: z.boolean(),
    source: AdsOptOutSourceSchema.nullable(),
  })
  .strict();

/** The account's ad switch. */
export type AdsSharing = z.infer<typeof AdsSharingSchema>;

/** The answer's field names, compared by the website's contract test. */
export const ADS_SHARING_FIELDS = ["optedOut", "source"] as const;

/**
 * The account as a decision sees it: nobody signed in, signed in but the
 * switch not known yet, a deleted account, or the switch itself.
 */
export type AccountAdsView = "signedOut" | "unknown" | "deleted" | AdsSharing;

/** This browser's ads consent and whether it sent GPC, as stored on orders, tasks and upload jobs. */
export const BrowserAdsSnapshotSchema = z.object({ consent: z.boolean(), gpc: z.boolean() }).strict();

/** This browser's ads consent and whether it sent GPC. */
export type BrowserAdsSnapshot = z.infer<typeof BrowserAdsSnapshotSchema>;

/** A browser with no ads choice, which never allows ads. */
export const NO_ADS_BROWSER: BrowserAdsSnapshot = Object.freeze({ consent: false, gpc: false });

/** A category's choice last seen on a signed-in request (`users.consent_seen`). */
export interface SeenChoice {
  readonly value: boolean;
  readonly revision: number;
}

/**
 * Whether the account's switch is known and on.
 * @param account - The account.
 * @returns True only for a known switch that is not opted out.
 */
function accountAllows(account: AccountAdsView): boolean {
  return typeof account === "object" && !account.optedOut;
}

/**
 * Whether ads may run.
 * @param input - What decides it.
 * @param input.browser - This browser's ads consent and GPC, or null for an event no browser caused.
 * @param input.account - The account's view.
 * @param input.seen - The ads choice last seen while signed in, for events no browser caused.
 * @returns Whether ads may run.
 */
export function adsAllowed(input: {
  browser: BrowserAdsSnapshot | null;
  account: AccountAdsView;
  seen?: SeenChoice | null;
}): boolean {
  const { browser, account, seen } = input;
  if (browser === null) {
    return seen?.value === true && revisionInForce(seen.revision) && accountAllows(account);
  }
  if (!browser.consent || browser.gpc) return false;
  return account === "signedOut" || accountAllows(account);
}

/**
 * Whether ads are opted out here: the banner then offers no ads and turning
 * them on takes a confirmation (design §4.4.4).
 * @param input - What decides it.
 * @param input.browserAds - This browser's ads choice in force, or null without one.
 * @param input.gpc - Whether this browser sends GPC.
 * @param input.account - The account's view; an unknown switch counts as not opted out.
 * @returns Whether ads are opted out.
 */
export function adsOptedOut(input: { browserAds: boolean | null; gpc: boolean; account: AccountAdsView }): boolean {
  const { browserAds, gpc, account } = input;
  return gpc || browserAds === false || (typeof account === "object" && account.optedOut);
}

/** The status line under the ads switch in the settings window. */
export type AdsStatus = "gpc" | "account" | "browser" | null;

/**
 * The settings window's status line (design §4.4.6).
 * @param input - What decides it.
 * @param input.gpc - Whether this browser sends GPC.
 * @param input.account - The account's view.
 * @returns Which line to show, or null for none.
 */
export function adsStatus(input: { gpc: boolean; account: AccountAdsView }): AdsStatus {
  if (input.gpc) return "gpc";
  if (input.account === "signedOut") return "browser";
  return typeof input.account === "object" && input.account.optedOut ? "account" : null;
}
