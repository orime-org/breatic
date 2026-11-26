// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the sign-in and sign-up pages read when the Google callback sends the
 * browser back to them (inner#2157 design 7.9): `google=created|signed_in`
 * after a session was set, `googleError=<reason>` otherwise. The referral
 * code the page held is saved in session storage before the full-page post,
 * because the return address never carries it.
 */

/** Where the page keeps its referral code across the Google round trip. */
const SAVED_REFERRAL_KEY = 'breatic.google-referral';

/** The referral state the page had when it left for Google. */
export interface SavedGoogleReferral {
  /** The code in the field or carried row. */
  code: string;
  /** Whether the sign-in page showed the typed field (true) or the carried row. */
  typed: boolean;
}

/** What the callback said, read from the return address. */
export type GoogleReturn =
  | { kind: 'session'; created: boolean; referralNotApplied: boolean }
  | { kind: 'error'; reason: string };

/** The catalog key shown for each reason the callback can give, besides `referral_invalid`. */
const ERROR_KEYS: Readonly<Record<string, string>> = {
  cancelled: 'auth.google.cancelled',
  expired: 'auth.google.expired',
  rate_limited: 'auth.google.rateLimited',
  unavailable: 'auth.google.unavailable',
  invalid_credential: 'server.auth.invalid_google_credential',
  email_unverified: 'server.auth.google_email_unverified',
  link_requires_email_login: 'server.auth.google_link_requires_email_login',
};

/** The query parameters the callback adds, removed once the page has read them. */
export const GOOGLE_RETURN_PARAMS = ['google', 'googleError', 'referral'] as const;

/**
 * Read the callback's answer from the page address.
 * @param params - The page's query.
 * @returns The answer, or null on a plain visit.
 */
export function readGoogleReturn(params: URLSearchParams): GoogleReturn | null {
  const signedIn = params.get('google');
  if (signedIn === 'created' || signedIn === 'signed_in') {
    return { kind: 'session', created: signedIn === 'created', referralNotApplied: params.get('referral') === 'not_applied' };
  }
  const reason = params.get('googleError');
  return reason === null ? null : { kind: 'error', reason };
}

/**
 * The catalog key to show for a failed sign-in.
 * @param reason - The callback's `googleError`.
 * @returns The key; an unknown reason reads as unavailable.
 */
export function googleErrorKey(reason: string): string {
  return ERROR_KEYS[reason] ?? 'auth.google.unavailable';
}

/**
 * Keep the referral state for the return trip; nothing is kept for an empty code.
 * @param saved - What to keep, or null to keep nothing.
 */
export function saveGoogleReferral(saved: SavedGoogleReferral | null): void {
  try {
    if (saved === null || saved.code === '') sessionStorage.removeItem(SAVED_REFERRAL_KEY);
    else sessionStorage.setItem(SAVED_REFERRAL_KEY, JSON.stringify(saved));
  } catch {
    // Storage blocked: the code is typed again after the round trip.
  }
}

/**
 * The referral state saved before the post.
 * @returns It, or null when nothing was saved or it cannot be read.
 */
export function readGoogleReferral(): SavedGoogleReferral | null {
  try {
    const raw = sessionStorage.getItem(SAVED_REFERRAL_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<SavedGoogleReferral>;
    return typeof parsed.code === 'string' && typeof parsed.typed === 'boolean' ? { code: parsed.code, typed: parsed.typed } : null;
  } catch {
    return null;
  }
}

/** Drop the saved referral state once the page has taken it back. */
export function clearGoogleReferral(): void {
  try {
    sessionStorage.removeItem(SAVED_REFERRAL_KEY);
  } catch {
    // Storage blocked: nothing was saved.
  }
}
