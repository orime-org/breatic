// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent choice a browser made, shared by the product web app, the
 * website and the backend that reads it from the cookie.
 *
 * The cookie is written by `vanilla-cookieconsent` on the page and travels to
 * the API and the collab socket on the page's host, or on any host under the
 * parent domain `VITE_CONSENT_COOKIE_DOMAIN` names. Its name,
 * category names and revision are a contract with the website repo (inner#1442
 * design §4.4.3): changing any of them here changes it there too.
 */

/** Name of the cookie the consent banner writes. */
import { z } from "zod";

export const CONSENT_COOKIE_NAME = "breatic_consent";

/**
 * Bumped when the privacy policy or the categories change in substance. A
 * choice recorded under an older revision no longer counts and the banner
 * asks again.
 */
export const CONSENT_REVISION = 1;

/**
 * Whether a choice recorded under a revision still counts: the current one, or
 * a newer one written by code deployed ahead of this copy (the website and the
 * product deploy separately). Only an older revision no longer counts.
 * @param revision - The recorded revision.
 * @returns True when the choice stands.
 */
export function revisionInForce(revision: unknown): boolean {
  return typeof revision === "number" && Number.isInteger(revision) && revision >= CONSENT_REVISION;
}

/** How long a choice lasts before the banner asks again: 13 months, as Google keeps a visitor's cookie choice (its SOCS cookie). */
export const CONSENT_MAX_AGE_DAYS = 395;

/** Whether each optional category may run in this browser. */
export interface ConsentSnapshot {
  readonly analytics: boolean;
  readonly ads: boolean;
}

/** What an absent, unreadable or outdated choice means: nothing optional runs. */
export const NO_CONSENT: ConsentSnapshot = Object.freeze({ analytics: false, ads: false });

/** A consent snapshot as a client sends it, e.g. on a collab request (design §4.4.5). */
export const ConsentSnapshotSchema = z.object({ analytics: z.boolean(), ads: z.boolean() }).strict();

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
