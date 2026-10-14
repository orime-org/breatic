// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each category's latest choice as the consent cookie holds it, and the
 * account's analytics value from its receipts (inner#1442 design §4.4.3,
 * §4.4.6). The cookie parse is one of the functions the website copies
 * verbatim; the contract test compares them.
 */

import type { BrowserAds } from "@shared/analytics/ads-decision.js";
import { choiceInForce } from "@shared/analytics/ads-decision.js";
import type { ConsentSnapshot } from "@shared/analytics/consent.js";

/** How a browser arrived at a choice it holds in its cookie. */
export const CONSENT_SOURCES = ["banner", "settings", "implicit", "gpc"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The fields each category's entry in the cookie data holds; both repos export the same table. */
export const CONSENT_DATA_FIELDS = {
  analytics: ["decisionId", "decidedAt", "source"],
  ads: ["decisionId", "decidedAt", "source", "noticeShown", "gpcAtDecision"],
} as const;

/** The analytics part of this browser's consent cookie. */
export interface BrowserAnalytics {
  readonly decisionId?: string;
  readonly value: boolean;
  readonly source: ConsentSource;
  readonly decidedAt: string;
  readonly revision: number;
}

/** Each category's choice in force in this browser; null where it has none. */
export interface BrowserChoices {
  readonly analytics: BrowserAnalytics | null;
  readonly ads: BrowserAds | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE: BrowserChoices = Object.freeze({ analytics: null, ads: null });

/**
 * Read each category's latest choice from the consent cookie. A consent lapses
 * 395 days after its own `decidedAt` or when its revision is no longer in
 * force; an ads refusal never lapses. A category whose entry is missing or
 * unreadable counts as unset.
 * @param raw - The cookie value as sent by the browser, URI-encoded or not.
 * @param now - The current time, epoch ms.
 * @returns The choices in force.
 */
export function parseConsentChoices(raw: string | undefined, now: number): BrowserChoices {
  if (!raw) return NONE;
  const parsed = parseJson(raw) ?? parseJson(safeDecode(raw));
  if (!isRecord(parsed)) return NONE;
  const { categories, revision, data } = parsed;
  if (!Array.isArray(categories) || typeof revision !== "number" || !isRecord(data)) return NONE;
  const analytics = readEntry(data.analytics, categories.includes("analytics"), revision);
  const adsBase = readEntry(data.ads, categories.includes("ads"), revision);
  const notice = isRecord(data.ads) ? data.ads.noticeShown : undefined;
  const ads: BrowserAds | null =
    adsBase === null || (notice !== false && notice !== "gpc" && notice !== "account")
      ? null
      : { ...adsBase, noticeShown: notice, gpcAtDecision: isRecord(data.ads) && data.ads.gpcAtDecision === true };
  return {
    analytics: analytics !== null && analyticsInForce(analytics, now) ? analytics : null,
    ads: ads !== null && choiceInForce(ads, now) ? ads : null,
  };
}

/**
 * One category's entry in the cookie data.
 * @param entry - The entry as stored.
 * @param value - Whether the category is in the accepted list.
 * @param revision - The cookie's revision.
 * @returns The choice, or null when the entry is missing or unreadable.
 */
function readEntry(entry: unknown, value: boolean, revision: number): BrowserAnalytics | null {
  if (!isRecord(entry) || typeof entry.decidedAt !== "string" || Number.isNaN(Date.parse(entry.decidedAt))) return null;
  const source = CONSENT_SOURCES.find((s) => s === entry.source);
  if (source === undefined) return null;
  const id = typeof entry.decisionId === "string" && UUID.test(entry.decisionId) ? { decisionId: entry.decisionId } : {};
  return { ...id, value, source, decidedAt: entry.decidedAt, revision };
}

/**
 * Whether an analytics choice counts: either value lapses with age and revision.
 * @param choice - The choice.
 * @param now - The current time.
 * @returns Whether it counts.
 */
function analyticsInForce(choice: Pick<BrowserAnalytics, "decidedAt" | "revision">, now: number): boolean {
  return choiceInForce({ ...choice, value: true }, now);
}

/**
 * This browser's own value per category, unset meaning off.
 * @param raw - The cookie value.
 * @param now - The current time, epoch ms.
 * @returns The snapshot.
 */
export function parseConsentCookie(raw: string | undefined, now: number): ConsentSnapshot {
  const { analytics, ads } = parseConsentChoices(raw, now);
  return { analytics: analytics?.value ?? false, ads: ads?.value ?? false };
}

/**
 * The account's analytics value, for events no browser is behind: the latest
 * receipt still in force, the stricter one on a tie.
 * @param receipts - The account's analytics receipts.
 * @param now - The current time, epoch ms.
 * @returns The value, or null when none is in force.
 */
export function accountAnalyticsValue(
  receipts: readonly { value: boolean; decidedAt: string; revision: number }[],
  now: number,
): boolean | null {
  let latest: { at: number; value: boolean } | null = null;
  for (const r of receipts) {
    if (!analyticsInForce(r, now)) continue;
    const at = Date.parse(r.decidedAt);
    if (latest === null || at > latest.at) latest = { at, value: r.value };
    else if (at === latest.at) latest = { at, value: latest.value && r.value };
  }
  return latest?.value ?? null;
}

/**
 * Narrow to a plain object.
 * @param value - Anything.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse JSON without throwing.
 * @param text - The text to parse; null passes through.
 * @returns The parsed value, or null when the text is null or not JSON.
 */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * URI-decode without throwing.
 * @param text - The encoded text.
 * @returns The decoded text, or null when the encoding is malformed.
 */
function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}
