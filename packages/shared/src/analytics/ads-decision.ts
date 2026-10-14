// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Whether ads may run, decided from one time-ordered list of events
 * (inner#1442 design §4.4.6). Every caller — server request, enqueue, worker,
 * app and website — goes through these functions, and the website keeps a
 * verbatim copy that the contract test compares.
 */

import { z } from "zod";
import { CONSENT_MAX_AGE_DAYS, revisionInForce } from "@shared/analytics/consent.js";

/** Which opt-out notice the settings window showed when the choice was saved. */
export type NoticeShown = "gpc" | "account" | false;

/** Where an ads choice came from. */
export type AdsSource = "banner" | "settings" | "implicit" | "gpc" | "request";

/** The ads part of this browser's consent cookie. */
export interface BrowserAds {
  readonly decisionId?: string;
  readonly value: boolean;
  readonly source: AdsSource;
  readonly noticeShown: NoticeShown;
  /** Whether this browser sent GPC when the choice was saved. */
  readonly gpcAtDecision: boolean;
  readonly decidedAt: string;
  readonly revision: number;
}

/** An ads receipt on the account. */
export interface AccountAdsReceipt {
  readonly decisionId: string;
  readonly value: boolean;
  readonly source: AdsSource;
  readonly noticeShown: NoticeShown;
  readonly decidedAt: string;
  readonly revision: number;
}

/** Whose receipt the cookie's decision is: this account's, another's, or none yet. */
export type Ownership = "self" | "other" | "none";

/** One event in the ads sequence, at a time in epoch milliseconds. */
export type AdsEvent =
  | { readonly kind: "consent" | "refusal" | "gpc"; readonly at: number }
  | { readonly kind: "override"; readonly notice: "account" | "gpc"; readonly at: number };

/** The outcome, and which opt-out notice to show when ads are off for an opt-out. */
export interface AdsOutcome {
  readonly allowed: boolean;
  readonly notice: "account" | "gpc" | null;
}

const MAX_AGE_MS = CONSENT_MAX_AGE_DAYS * 86_400_000;

/**
 * A consent the person gave in settings while an opt-out notice was showing.
 * @param ads - The choice.
 * @returns Whether it lifts earlier opt-outs.
 */
export function adsConsentOverridesOptOut(ads: Pick<BrowserAds, "value" | "source" | "noticeShown">): boolean {
  return ads.value && ads.source === "settings" && ads.noticeShown !== false;
}

/**
 * Whether this browser's own GPC is left out: only for an override saved while
 * the browser already sent GPC, and never for one another account left behind.
 * @param ads - This browser's ads choice, or null without one.
 * @param ownership - Whose receipt that choice is.
 * @returns Whether this browser's GPC does not count.
 */
export function browserSuppressesOwnGpc(ads: BrowserAds | null, ownership: Ownership): boolean {
  return ads !== null && ownership !== "other" && ads.gpcAtDecision && adsConsentOverridesOptOut(ads);
}

/**
 * Whether an ads choice is still in force: a consent lapses after 395 days or
 * when its revision is no longer in force; a refusal never lapses.
 * @param choice - The choice.
 * @param now - The current time.
 * @returns Whether it counts.
 */
export function choiceInForce(choice: Pick<BrowserAds, "value" | "decidedAt" | "revision">, now: number): boolean {
  if (!choice.value) return true;
  return revisionInForce(choice.revision) && now - Date.parse(choice.decidedAt) <= MAX_AGE_MS;
}

/**
 * This browser's ads choice as an event in the account's sequence.
 * @param ads - The cookie's ads part, or null without one.
 * @param ownership - Whose receipt that decision is.
 * @param now - The current time.
 * @returns The event (null when the account's receipt stands for it), and whether
 *   this browser has no ads choice in force, in which case ads stay off here.
 */
export function normalizeBrowserAds(
  ads: BrowserAds | null,
  ownership: Ownership,
  now: number,
): { event: AdsEvent | null; unset: boolean } {
  if (ads === null || !choiceInForce(ads, now)) return { event: null, unset: true };
  if (ownership === "self") return { event: null, unset: false };
  if (!ads.value) return { event: { kind: "refusal", at: now }, unset: false };
  return { event: { kind: "consent", at: Math.min(Date.parse(ads.decidedAt), now) }, unset: false };
}

/**
 * The account's ads receipts and GPC signal as events.
 * @param receipts - The account's ads receipts.
 * @param gpcSeenAt - When a signed-in request last carried GPC, if ever.
 * @param now - The current time.
 * @returns The events still in force.
 */
export function accountAdsEvents(
  receipts: readonly AccountAdsReceipt[],
  gpcSeenAt: string | null,
  now: number,
): AdsEvent[] {
  const events: AdsEvent[] = receipts
    .filter((r) => choiceInForce(r, now))
    .map((r): AdsEvent => {
      const at = Date.parse(r.decidedAt);
      if (!r.value) return { kind: "refusal", at };
      return r.noticeShown === "account" && adsConsentOverridesOptOut(r)
        ? { kind: "override", notice: "account", at }
        : { kind: "consent", at };
    });
  if (gpcSeenAt !== null) events.push({ kind: "gpc", at: Date.parse(gpcSeenAt) });
  return events;
}

// On a tie the stricter event goes last, so it wins.
const TIE_ORDER: Record<AdsEvent["kind"], number> = { consent: 0, override: 1, gpc: 2, refusal: 3 };

/**
 * Walk the events in time order (design §4.4.6 state table).
 * @param events - Account events plus, where there is a browser, its normalized event and GPC.
 * @returns Whether ads may run, and the notice to show when an opt-out stops them.
 */
export function adsDecision(events: readonly AdsEvent[]): AdsOutcome {
  const ordered = [...events].sort((a, b) => a.at - b.at || TIE_ORDER[a.kind] - TIE_ORDER[b.kind]);
  let consented = false;
  let byAccount = false;
  let byGpc = false;
  for (const event of ordered) {
    if (event.kind === "refusal") byAccount = true;
    else if (event.kind === "gpc") byGpc = true;
    else if (event.kind === "override" && event.notice === "account") byAccount = byGpc = false;
    else if (event.kind === "override") byGpc = false;
    if (event.kind !== "gpc" && event.kind !== "refusal" && !byAccount && !byGpc) consented = true;
    if (byAccount || byGpc) consented = false;
  }
  if (byAccount) return { allowed: false, notice: "account" };
  if (byGpc) return { allowed: false, notice: "gpc" };
  return { allowed: consented, notice: null };
}

/** The account's ads receipts still in force and its GPC signal. */
export interface AccountAdsHistory {
  readonly receipts: readonly AccountAdsReceipt[];
  readonly gpcSeenAt: string | null;
}

/** The ads side of a browser's consent at one moment, as requests, orders and upload jobs keep it. */
export interface BrowserAdsSnapshot {
  /** The cookie's ads choice; null when the browser has none. */
  readonly choice: BrowserAds | null;
  /** When the browser was seen sending GPC, if it was. */
  readonly gpcAt: string | null;
  /** When the snapshot was taken. */
  readonly at: string;
}

const isoTime = z.string().datetime({ offset: true });

/** A stored {@link BrowserAdsSnapshot}, checked before it is used. */
export const BrowserAdsSnapshotSchema = z
  .object({
    choice: z
      .object({
        decisionId: z.string().uuid().optional(),
        value: z.boolean(),
        source: z.enum(["banner", "settings", "implicit", "gpc", "request"]),
        noticeShown: z.union([z.literal("gpc"), z.literal("account"), z.literal(false)]),
        gpcAtDecision: z.boolean(),
        decidedAt: isoTime,
        revision: z.number().int(),
      })
      .strict()
      .nullable(),
    gpcAt: isoTime.nullable(),
    at: isoTime,
  })
  .strict();

/**
 * Whether ads may run for an event: the account's events plus, where a
 * browser is behind it, that browser's choice and GPC as the snapshot holds
 * them. A missing or deleted account, or a browser with no choice in force,
 * never allows ads.
 * @param history - The account's ads record; null when the account is gone.
 * @param browser - The browser behind the event; null for an event with none.
 * @param ownership - Whose receipt the browser's decision is.
 * @param now - The current time, epoch ms.
 * @returns The outcome.
 */
export function adsAllowed(
  history: AccountAdsHistory | null,
  browser: BrowserAdsSnapshot | null,
  ownership: Ownership,
  now: number,
): AdsOutcome {
  if (history === null) return { allowed: false, notice: null };
  const events = accountAdsEvents(history.receipts, history.gpcSeenAt, now);
  if (browser !== null) {
    const { event, unset } = normalizeBrowserAds(browser.choice, ownership, Date.parse(browser.at));
    if (unset) return { allowed: false, notice: adsDecision(events).notice };
    if (event !== null) events.push(event);
    if (browser.gpcAt !== null && !browserSuppressesOwnGpc(browser.choice, ownership)) {
      events.push({ kind: "gpc", at: Date.parse(browser.gpcAt) });
    }
  }
  return adsDecision(events);
}
