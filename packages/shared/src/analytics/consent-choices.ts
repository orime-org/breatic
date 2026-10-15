// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Each category's latest choice as the consent cookie holds it, and what a
 * signed-in request records of it (inner#1442 design §4.4.3, §4.4.6). The
 * cookie parse is one of the functions the website copies verbatim; the
 * contract test compares them.
 */

import { CONSENT_MAX_AGE_DAYS, revisionInForce, type ConsentSnapshot } from "@shared/analytics/consent.js";
import type { SeenChoice } from "@shared/analytics/ads-sharing.js";

/** How a browser arrived at a choice it holds in its cookie. */
export const CONSENT_SOURCES = ["banner", "settings", "implicit", "gpc"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The fields each category's entry in the cookie data holds; both repos export the same table. */
export const CONSENT_DATA_FIELDS = {
  analytics: ["decidedAt", "source"],
  ads: ["decidedAt", "source"],
} as const;

/** One category's choice in this browser's consent cookie. */
export interface BrowserChoice {
  readonly value: boolean;
  readonly source: ConsentSource;
  readonly decidedAt: string;
  readonly revision: number;
}

/** Each category's choice in force in this browser; null where it has none. */
export interface BrowserChoices {
  readonly analytics: BrowserChoice | null;
  readonly ads: BrowserChoice | null;
}

const NONE: BrowserChoices = Object.freeze({ analytics: null, ads: null });
const MAX_AGE_MS = CONSENT_MAX_AGE_DAYS * 86_400_000;

/**
 * Whether a choice is still in force: a consent lapses 395 days after its own
 * `decidedAt` or when its revision is no longer in force; a refusal does not.
 * @param choice - The choice.
 * @param now - The current time, epoch ms.
 * @returns Whether it counts.
 */
export function choiceInForce(choice: Pick<BrowserChoice, "value" | "decidedAt" | "revision">, now: number): boolean {
  if (!choice.value) return true;
  return revisionInForce(choice.revision) && now - Date.parse(choice.decidedAt) <= MAX_AGE_MS;
}

/**
 * Read each category's latest choice from the consent cookie. Either
 * category's consent lapses on its own `decidedAt` and revision; an analytics
 * refusal lapses the same way, an ads refusal never does. A category whose
 * entry is missing or unreadable counts as unset.
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
  const ads = readEntry(data.ads, categories.includes("ads"), revision);
  return {
    analytics: analytics !== null && choiceInForce({ ...analytics, value: true }, now) ? analytics : null,
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
function readEntry(entry: unknown, value: boolean, revision: number): BrowserChoice | null {
  if (!isRecord(entry) || typeof entry.decidedAt !== "string" || Number.isNaN(Date.parse(entry.decidedAt))) return null;
  const source = CONSENT_SOURCES.find((s) => s === entry.source);
  if (source === undefined) return null;
  // A GPC entry is only ever written as a refusal.
  return { value: value && source !== "gpc", source, decidedAt: entry.decidedAt, revision };
}

/**
 * Each category's value in these choices, unset meaning off.
 * @param choices - The choices in force.
 * @returns The snapshot.
 */
export function snapshotOf(choices: BrowserChoices): ConsentSnapshot {
  return { analytics: choices.analytics?.value ?? false, ads: choices.ads?.value ?? false };
}

/**
 * This browser's own value per category, unset meaning off.
 * @param raw - The cookie value.
 * @param now - The current time, epoch ms.
 * @returns The snapshot.
 */
export function parseConsentCookie(raw: string | undefined, now: number): ConsentSnapshot {
  return snapshotOf(parseConsentChoices(raw, now));
}

/** The choices a signed-in request records on the account (`users.consent_seen`). */
export interface ConsentSeen {
  readonly analytics?: SeenChoice;
  readonly ads?: SeenChoice;
}

/**
 * What a signed-in request records of this browser's choices: each category
 * the visitor chose, leaving out a regional default.
 * @param choices - This browser's choices in force.
 * @returns The record, or null when there is nothing to record.
 */
export function consentSeenFrom(choices: BrowserChoices): ConsentSeen | null {
  /**
   * One category's choice as the account records it.
   * @param c - The choice in force, or null.
   * @returns The record, or undefined for none or a regional default.
   */
  const pick = (c: BrowserChoice | null): SeenChoice | undefined =>
    c === null || c.source === "implicit" ? undefined : { value: c.value, revision: c.revision };
  const analytics = pick(choices.analytics);
  const ads = pick(choices.ads);
  if (analytics === undefined && ads === undefined) return null;
  return { ...(analytics && { analytics }), ...(ads && { ads }) };
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
