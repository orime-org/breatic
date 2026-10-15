// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a page does with consent (inner#1442 design §4.4.2, §4.4.4, §4.4.6):
 * on load and on a press in the banner or the settings window; kept apart
 * from the banner library so the rules can be tested. The website keeps
 * verbatim copies, which its contract test compares.
 */

import { browserAdsConsent, httpRequest, type BrowserChoice, type BrowserChoices, type ConsentSource } from '@breatic/shared';

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
  // GPC refuses a regional default; the visitor's own choice stays as it is.
  if (stored.ads !== null) ads = gpc && stored.ads.value && stored.ads.source === 'implicit' ? gpcRefusal : null;
  else if (!optIn) ads = gpc ? gpcRefusal : { value: true, source: 'implicit' };
  const analytics: CategoryWrite | null = stored.analytics === null && !optIn ? { value: true, source: 'implicit' } : null;
  return { analytics, ads, showBanner: optIn && (stored.analytics === null || stored.ads === null) };
}

/**
 * What a press in the banner or the settings window writes (design §4.4.4
 * click table): both categories, as pressed; GPC does not change a press.
 * @param input - The press.
 * @param input.press - `all` (accept all), `necessary` (reject all) or `save`.
 * @param input.window - Where it was pressed.
 * @param input.toggles - The settings switches, for `save`.
 * @returns The writes.
 */
export function writesForClick(input: {
  press: 'all' | 'necessary' | 'save';
  window: 'banner' | 'settings';
  toggles: { analytics: boolean; ads: boolean } | null;
}): ConsentWrites {
  const { press, window: source, toggles } = input;
  const on =
    press === 'all' ? { analytics: true, ads: true } : press === 'save' && toggles !== null ? toggles : { analytics: false, ads: false };
  return { analytics: { value: on.analytics, source }, ads: { value: on.ads, source } };
}

/** What the page does with ads. */
export interface AdsView {
  readonly allowed: boolean;
}

/**
 * The page's ads view (design §4.4.4): this browser's ads choice, with GPC
 * refusing a regional default as the server does.
 * @param input - What the page knows.
 * @param input.ads - This browser's ads choice in force, or null without one.
 * @param input.gpc - Whether the browser sends GPC.
 * @returns The view.
 */
export function adsViewFor(input: { ads: Pick<BrowserChoice, 'value' | 'source'> | null; gpc: boolean }): AdsView {
  return { allowed: browserAdsConsent(input.ads, input.gpc) };
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
