// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent choice a browser made, shared by the product web app, the
 * website and the backend that reads it from the cookie.
 *
 * The cookie is written by `vanilla-cookieconsent` on the page and travels to
 * the API and the collab socket because both sit on the same site. Its name,
 * category names and revision are a contract with the website repo (inner#1442
 * design §4.4.3): changing any of them here changes it there too.
 */

/** Name of the cookie the consent banner writes. */
export const CONSENT_COOKIE_NAME = "breatic_consent";

/**
 * Bumped when the privacy policy or the categories change in substance. A
 * choice recorded under an older revision no longer counts and the banner
 * asks again.
 */
export const CONSENT_REVISION = 1;

/** Whether each optional category may run in this browser. */
export interface ConsentSnapshot {
  readonly analytics: boolean;
  readonly ads: boolean;
}

/** What an absent, unreadable or outdated choice means: nothing optional runs. */
export const NO_CONSENT: ConsentSnapshot = Object.freeze({ analytics: false, ads: false });

/**
 * Read the consent cookie's value.
 * @param raw - The cookie value as sent by the browser, URI-encoded or not.
 * @returns The categories the browser accepted; {@link NO_CONSENT} when the
 *   value is missing, malformed or from an older revision.
 */
export function parseConsentCookie(raw: string | undefined): ConsentSnapshot {
  if (!raw) return NO_CONSENT;
  const parsed = parseJson(raw) ?? parseJson(safeDecode(raw));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return NO_CONSENT;
  const { categories, revision } = parsed as { categories?: unknown; revision?: unknown };
  if (revision !== CONSENT_REVISION || !Array.isArray(categories)) return NO_CONSENT;
  return { analytics: categories.includes("analytics"), ads: categories.includes("ads") };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeDecode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

// EU 27, the rest of the EEA (IS, LI, NO), the UK, Switzerland and mainland
// China: visitors there are asked before anything optional loads.
const OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO", "GB", "CH", "CN",
]);

// Cloudflare's codes for "could not place" (XX) and Tor (T1): treated as unknown.
const UNKNOWN_COUNTRIES: ReadonlySet<string> = new Set(["XX", "T1"]);

/**
 * Whether a visitor from this country must accept before analytics or ads load.
 * @param country - ISO 3166-1 alpha-2 code from Cloudflare's `loc=`; null when
 *   the lookup failed.
 * @returns True for opt-in regions and whenever the country is unknown.
 */
export function requiresOptIn(country: string | null): boolean {
  if (!country) return true;
  const code = country.toUpperCase();
  return OPT_IN_COUNTRIES.has(code) || UNKNOWN_COUNTRIES.has(code);
}
