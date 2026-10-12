// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { pathOf } from "@shared/analytics/events.js";

/**
 * Where a visitor came from, recorded by the landing page once a consent
 * category is accepted (inner#1442 design §4.5).
 */
export interface AttributionTouch {
  readonly utm_source?: string;
  readonly utm_medium?: string;
  readonly utm_campaign?: string;
  readonly utm_term?: string;
  readonly utm_content?: string;
  readonly gclid?: string;
  readonly gbraid?: string;
  readonly wbraid?: string;
  /** The referring page, origin and path only. */
  readonly referrer?: string;
  /** The landing page, path only. */
  readonly landing_page?: string;
  /** When the touch was recorded, as an ISO timestamp. */
  readonly at: string;
}

/** The first touch is never overwritten; the last one follows each new campaign. */
export interface Attribution {
  readonly first: AttributionTouch;
  readonly last: AttributionTouch;
}

const CAMPAIGN_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "gbraid",
  "wbraid",
] as const;
const MAX_LENGTH = 200;

/**
 * Read the attribution a browser sent with a sign-up.
 * @param raw - The request's `attribution` field, untrusted.
 * @returns The known fields, cut to length with addresses stripped of query
 *   strings; null when it is missing or malformed. Never throws: a bad
 *   attribution must not fail the sign-up it rides on.
 */
export function parseAttribution(raw: unknown): Attribution | null {
  if (!isRecord(raw)) return null;
  const first = parseTouch(raw.first);
  const last = parseTouch(raw.last);
  return first && last ? { first, last } : null;
}

/** One Google Ads click identifier and when it was recorded. */
export interface AdClick {
  readonly gclid?: string;
  readonly gbraid?: string;
  readonly wbraid?: string;
  readonly at: string;
}

/** Google Ads accepts click conversions up to 90 days after the click. */
export const CLICK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const CLICK_FIELDS = ["gclid", "gbraid", "wbraid"] as const;

/**
 * The click a conversion is credited to (inner#1442 design §4.9).
 * @param attribution - What the account or order recorded, if anything.
 * @param now - The current time in milliseconds.
 * @returns The latest touch's click within 90 days, one identifier only with
 *   gclid preferred; null when no touch carries a recent click.
 */
export function adClickFrom(attribution: Attribution | null | undefined, now: number): AdClick | null {
  for (const touch of attribution ? [attribution.last, attribution.first] : []) {
    if (now - Date.parse(touch.at) > CLICK_WINDOW_MS) continue;
    const field = CLICK_FIELDS.find((key) => touch[key]);
    if (field) return { [field]: touch[field], at: touch.at };
  }
  return null;
}

/**
 * Read one touch.
 * @param raw - Untrusted input.
 * @returns The touch, or null without a readable time.
 */
function parseTouch(raw: unknown): AttributionTouch | null {
  if (!isRecord(raw) || typeof raw.at !== "string" || Number.isNaN(Date.parse(raw.at))) return null;
  const out: Record<string, string> = {};
  for (const key of CAMPAIGN_FIELDS) {
    const value = raw[key];
    if (typeof value === "string" && value !== "") out[key] = value.slice(0, MAX_LENGTH);
  }
  const referrer = typeof raw.referrer === "string" ? originAndPath(raw.referrer) : "";
  if (referrer !== "") out.referrer = referrer.slice(0, MAX_LENGTH);
  const landing = typeof raw.landing_page === "string" && raw.landing_page !== "" ? pathOf(raw.landing_page) : "";
  if (landing !== "") out.landing_page = landing.slice(0, MAX_LENGTH);
  return { ...out, at: raw.at.slice(0, MAX_LENGTH) };
}

/**
 * The origin and path of an absolute address.
 * @param address - A URL.
 * @returns Origin plus path, or empty when it is not an absolute URL.
 */
function originAndPath(address: string): string {
  try {
    const url = new URL(address);
    return url.origin === "null" ? "" : url.origin + url.pathname;
  } catch {
    return "";
  }
}

/**
 * Narrow to a plain object.
 * @param value - Anything.
 * @returns Whether it is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
