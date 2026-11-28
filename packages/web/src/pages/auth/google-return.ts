// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What the sign-in and sign-up pages read when the Google callback sends the
 * browser back to them (inner#2157 design 7.9): `google=created|signed_in`
 * after a session was set, `googleError=<reason>` otherwise. The referral
 * code the page held and the page's own query (`next`, `invite`) are saved in
 * session storage before the full-page post: the return address never carries
 * the code or `invite`, and an expired sign-in comes back without `next` too.
 */

/** Where the page keeps what it had across the Google round trip. */
const SAVED_START_KEY = 'breatic.google-start';

/** The query parameters of the sign-in and sign-up pages that a return restores. */
export const GOOGLE_KEPT_PARAMS = ['next', 'invite'] as const;

/** The referral state the page had when it left for Google. */
export interface SavedGoogleReferral {
  /** The code in the field or carried row; empty when the user cleared it, so the carried code does not come back. */
  code: string;
  /** Whether the sign-in page showed the typed field (true) or the carried row. */
  typed: boolean;
}

/** What the page had when it left for Google. */
export interface SavedGoogleStart {
  /** The referral field to restore, or null when the page showed none. */
  referral: SavedGoogleReferral | null;
  /** The page's own query parameters among {@link GOOGLE_KEPT_PARAMS}. */
  query: Record<string, string>;
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
 * Keep what the page had for the return trip.
 * @param start - The referral state and the page's query.
 */
export function saveGoogleStart(start: SavedGoogleStart): void {
  try {
    sessionStorage.setItem(SAVED_START_KEY, JSON.stringify(start));
  } catch {
    // Storage blocked: the code is typed again and the page opens plain.
  }
}

/**
 * The page's kept parameters, read from its query.
 * @param params - The page's query.
 * @returns The parameters among {@link GOOGLE_KEPT_PARAMS} it carries.
 */
export function keptQuery(params: URLSearchParams): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of GOOGLE_KEPT_PARAMS) {
    const value = params.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

/**
 * What the page saved before the post.
 * @returns It, or null when nothing was saved or it cannot be read.
 */
export function readGoogleStart(): SavedGoogleStart | null {
  try {
    const raw = sessionStorage.getItem(SAVED_START_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { referral?: Partial<SavedGoogleReferral> | null; query?: Record<string, unknown> };
    const r = parsed.referral;
    const referral = r && typeof r.code === 'string' && typeof r.typed === 'boolean' ? { code: r.code, typed: r.typed } : null;
    const query: Record<string, string> = {};
    for (const name of GOOGLE_KEPT_PARAMS) {
      const value = parsed.query?.[name];
      if (typeof value === 'string') query[name] = value;
    }
    return { referral, query };
  } catch {
    return null;
  }
}

/** Drop what the page saved once it has taken it back. */
export function clearGoogleStart(): void {
  try {
    sessionStorage.removeItem(SAVED_START_KEY);
  } catch {
    // Storage blocked: nothing was saved.
  }
}
