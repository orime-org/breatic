// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a page does with consent (inner#1442 design §4.4.2, §4.4.4, §4.4.6):
 * on load, on a press in the banner or the settings window, and what it
 * reads of the account's ad switch; kept apart from the banner library so the
 * rules can be tested. The website keeps verbatim copies, which its contract
 * test compares.
 */

import {
  adsAllowed,
  adsOptedOut,
  adsStatus,
  httpRequest,
  type AccountAdsView,
  type AdsSharing,
  type AdsStatus,
  type BrowserChoices,
  type ConsentSource,
} from '@breatic/shared';

/** What to write for one category; the writer adds the time. */
export interface CategoryWrite {
  readonly value: boolean;
  readonly source: ConsentSource;
}

/** The categories to write; a category left out keeps what the cookie holds. */
export interface ConsentWrites {
  readonly analytics?: CategoryWrite;
  readonly ads?: CategoryWrite;
}

/** What to do on load. */
export interface LoadDecision {
  readonly analytics: CategoryWrite | null;
  readonly ads: CategoryWrite | null;
  readonly showBanner: boolean;
}

/**
 * Decide on load, category by category (design §4.4.4, events that are not presses).
 * @param input - What the page knows.
 * @param input.stored - Each category's choice in force.
 * @param input.optIn - Whether the visitor's region asks before anything loads.
 * @param input.gpc - Whether the browser sends Global Privacy Control.
 * @returns What to write now, and whether to ask.
 */
export function decideOnLoad(input: { stored: BrowserChoices; optIn: boolean; gpc: boolean }): LoadDecision {
  const { stored, optIn, gpc } = input;
  const gpcRefusal: CategoryWrite = { value: false, source: 'gpc' };
  let ads: CategoryWrite | null = null;
  // GPC withdraws an ads consent; a refusal stays as it is.
  if (stored.ads !== null) ads = gpc && stored.ads.value ? gpcRefusal : null;
  else if (!optIn) ads = gpc ? gpcRefusal : { value: true, source: 'implicit' };
  const analytics: CategoryWrite | null = stored.analytics === null && !optIn ? { value: true, source: 'implicit' } : null;
  return { analytics, ads, showBanner: optIn && (stored.analytics === null || stored.ads === null) };
}

/** Where ads stand when a button is pressed: a row of the click table (design §4.4.4). */
export type AdsSituation = 'open' | 'gpc' | 'browserRefused' | 'accountOptedOut' | 'accountUnknown';

/**
 * The click table's row for this browser.
 * @param input - What the page knows.
 * @param input.browserAds - This browser's ads choice in force, or null without one.
 * @param input.gpc - Whether the browser sends GPC.
 * @param input.account - The account's view.
 * @returns The row.
 */
export function adsSituation(input: { browserAds: boolean | null; gpc: boolean; account: AccountAdsView }): AdsSituation {
  const { browserAds, gpc, account } = input;
  if (gpc) return 'gpc';
  if (browserAds === false) return 'browserRefused';
  if (typeof account === 'object') return account.optedOut ? 'accountOptedOut' : 'open';
  return account === 'unknown' ? 'accountUnknown' : 'open';
}

/** What a press does: write (sending the account switch first when `put` is set), ask first, or wait for the account. */
export type PressOutcome =
  | { readonly kind: 'write'; readonly writes: ConsentWrites; readonly put: boolean | null }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'wait' };

/**
 * What a press in the banner or the settings window does (design §4.4.4
 * click table). Signed in, a press that writes ads off closes the account
 * switch first, and a confirmed press that turns ads on opens it first.
 * @param input - The press.
 * @param input.press - `all` (accept all), `necessary` (reject all) or `save`.
 * @param input.window - Where it was pressed.
 * @param input.toggles - The settings switches, for `save`.
 * @param input.situation - Where ads stand ({@link adsSituation}).
 * @param input.browserAds - This browser's ads choice in force, or null without one.
 * @param input.signedIn - Whether an account is signed in.
 * @param input.confirmed - The answer to the confirmation, once asked.
 * @returns The outcome.
 */
export function writesForClick(input: {
  press: 'all' | 'necessary' | 'save';
  window: 'banner' | 'settings';
  toggles: { analytics: boolean; ads: boolean | null } | null;
  situation: AdsSituation;
  browserAds: boolean | null;
  signedIn: boolean;
  confirmed?: boolean;
}): PressOutcome {
  const { press, window: source, toggles, situation, browserAds, signedIn, confirmed } = input;
  const on =
    press === 'all' ? { analytics: true, ads: true } : press === 'save' && toggles !== null ? toggles : { analytics: false, ads: false };
  const analytics: CategoryWrite = { value: on.analytics, source };
  /**
   * Write analytics as pressed, and ads when given.
   * @param ads - The ads write, or undefined to leave ads as they are.
   * @param put - The account switch to send first, or null.
   * @returns The outcome.
   */
  const write = (ads: CategoryWrite | undefined, put: boolean | null = null): PressOutcome => ({
    kind: 'write',
    writes: ads === undefined ? { analytics } : { analytics, ads },
    put,
  });
  /**
   * Write ads off, closing the account switch first when signed in.
   * @returns The outcome.
   */
  const refuse = (): PressOutcome => write({ value: false, source }, signedIn ? false : null);
  // Under GPC ads stay off; a browser with no ads choice yet records the GPC refusal, so it is not asked again.
  const gpcRefusal: CategoryWrite | undefined = source === 'banner' || browserAds === null ? { value: false, source: 'gpc' } : undefined;
  if (situation === 'gpc' && press === 'save') return write(gpcRefusal);
  // A switch left as it was preset is no answer about ads.
  if (on.ads === null) return write(undefined);
  if (!on.ads) return refuse();
  if (situation === 'open') return write({ value: true, source });
  if (situation === 'gpc') return write(gpcRefusal);
  if (source === 'banner') {
    // The banner never turns ads on while they are opted out; a browser without a choice records the refusal.
    return situation === 'accountOptedOut' && browserAds === null ? refuse() : write(undefined);
  }
  if (situation === 'accountUnknown') return { kind: 'wait' };
  if (confirmed === undefined) return { kind: 'confirm' };
  return confirmed ? write({ value: true, source }, signedIn ? true : null) : write(undefined);
}

/** What the page does with ads, and what the windows show. */
export interface AdsView {
  readonly allowed: boolean;
  /** False while the account's answer is awaited for a browser that consents: nothing is refused yet. */
  readonly known: boolean;
  /** The settings window's status line. */
  readonly status: AdsStatus;
  /** Whether ads are opted out here: the banner then offers no ads and says so. */
  readonly optedOut: boolean;
  /** Whether the settings window's ads switch starts on. */
  readonly adsOn: boolean;
}

/**
 * The page's ads view (design §4.4.4, §4.4.6). While the account's answer is
 * unknown ads stay off, and the switch shows this browser's own choice.
 * @param input - What the page knows.
 * @param input.browserAds - This browser's ads choice in force, or null without one.
 * @param input.gpc - Whether the browser sends GPC.
 * @param input.account - The account's view.
 * @returns The view.
 */
export function adsViewFor(input: { browserAds: boolean | null; gpc: boolean; account: AccountAdsView }): AdsView {
  const { browserAds, gpc, account } = input;
  const allowed = adsAllowed({ browser: { consent: browserAds === true, gpc }, account });
  // Only a consent here waits for the account; this browser's own refusal, missing choice or GPC decide at once.
  const known = account !== 'unknown' || browserAds !== true || gpc;
  return {
    allowed,
    known,
    status: adsStatus({ gpc, account }),
    optedOut: adsOptedOut({ browserAds, gpc, account }),
    adsOn: known ? allowed : true,
  };
}

/**
 * The cookie's data and accepted categories after a write (design §4.4.4
 * `setConsent()`): each category written gets the same time; a category left
 * out keeps the choice in force before the press.
 * @param writes - The categories to write.
 * @param prior - The choices in force before this write.
 * @param stored - The cookie's data entries as stored.
 * @param decidedAt - The time of this write.
 * @returns The data to store and the categories to accept.
 */
export function cookieAfterWrites(
  writes: ConsentWrites,
  prior: BrowserChoices | null,
  stored: Record<string, unknown>,
  decidedAt: string,
): { data: Record<string, unknown>; accepted: ('analytics' | 'ads')[] } {
  const data: Record<string, unknown> = {
    analytics: prior?.analytics ? stored.analytics : undefined,
    ads: prior?.ads ? stored.ads : undefined,
  };
  const accepted = new Set((['analytics', 'ads'] as const).filter((c) => prior?.[c]?.value === true));
  for (const category of ['analytics', 'ads'] as const) {
    const write = writes[category];
    if (write === undefined) continue;
    data[category] = { decidedAt, source: write.source };
    if (write.value) accepted.add(category);
    else accepted.delete(category);
  }
  return { data, accepted: (['analytics', 'ads'] as const).filter((c) => accepted.has(c)) };
}

/**
 * The account's ad switch from an answer's `data`, checked before the page
 * trusts it.
 * @param data - The answer's `data`.
 * @returns The switch, or null when it is not one; the page then treats the answer as unknown.
 */
export function readAdsSharing(data: unknown): AdsSharing | null {
  if (typeof data !== 'object' || data === null) return null;
  const { optedOut, source } = data as Record<string, unknown>;
  if (optedOut === false && source === null) return { optedOut, source };
  if (optedOut === true && (source === 'settings' || source === 'gpc' || source === 'request')) return { optedOut, source };
  return null;
}

/**
 * The country Cloudflare reports for this visitor.
 * @param trace - The body of `/cdn-cgi/trace`.
 * @returns The two-letter code, or null when the body has none.
 */
export function countryFromTrace(trace: string): string | null {
  return /^loc=([A-Z0-9]{2})$/m.exec(trace)?.[1] ?? null;
}

/** How long the region lookup may take before the visitor is asked first. */
const TRACE_TIMEOUT_MS = 1000;

/**
 * Look the visitor's country up at the same-origin Cloudflare trace endpoint.
 * @param origin - The page's origin.
 * @param request - `httpRequest`, replaced in tests.
 * @param timeoutMs - The limit for the whole lookup, retries included.
 * @returns The country, or null when the lookup fails, errs or is slow; a
 *   self-hosted instance without Cloudflare lands here and asks first.
 */
export async function fetchCountry(
  origin: string,
  request: typeof httpRequest = httpRequest,
  timeoutMs: number = TRACE_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(
      new URL('/cdn-cgi/trace', origin).href,
      { credentials: 'omit' },
      { replaySafe: true, timeoutMs, signal: controller.signal },
    );
    return response.ok ? countryFromTrace(await response.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
