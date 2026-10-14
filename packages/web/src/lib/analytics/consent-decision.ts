// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a page does with consent (inner#1442 design §4.4.2, §4.4.4, §4.4.6):
 * on load, on a press in the banner or the settings window, and what it
 * reports to the account; kept apart from the banner library so the rules can
 * be tested.
 */

import {
  adsConsentOverridesOptOut,
  browserSuppressesOwnGpc,
  httpRequest,
  type AccountAdsHistory,
  type AdsOutcome,
  type BrowserAds,
  type BrowserChoices,
  type ConsentReport,
  type ConsentSource,
  type NoticeShown,
  type Ownership,
} from '@breatic/shared';

/** What to write for one category; the writer adds the id and the time. */
export interface CategoryWrite {
  readonly value: boolean;
  readonly source: ConsentSource;
  /** Ads only: which opt-out notice the settings window showed. */
  readonly noticeShown?: NoticeShown;
  /** Ads only: whether this browser sent GPC when the choice was saved. */
  readonly gpcAtDecision?: boolean;
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
 * Decide on load, category by category (design §4.4.4).
 * @param input - What the page knows.
 * @param input.stored - Each category's choice in force.
 * @param input.optIn - Whether the visitor's region asks before anything loads.
 * @param input.gpc - Whether the browser sends Global Privacy Control.
 * @returns What to write now, and whether to ask.
 */
export function decideOnLoad(input: { stored: BrowserChoices; optIn: boolean; gpc: boolean }): LoadDecision {
  const { stored, optIn, gpc } = input;
  const gpcRefusal: CategoryWrite = { value: false, source: 'gpc', gpcAtDecision: true };
  let ads: CategoryWrite | null = null;
  if (stored.ads !== null) {
    // GPC withdraws an ads consent, except an override the visitor saved while this browser already sent GPC.
    if (gpc && stored.ads.value && !browserSuppressesOwnGpc(stored.ads, 'none')) ads = gpcRefusal;
  } else if (!optIn) {
    ads = gpc ? gpcRefusal : { value: true, source: 'implicit' };
  }
  const analytics: CategoryWrite | null = stored.analytics === null && !optIn ? { value: true, source: 'implicit' } : null;
  return { analytics, ads, showBanner: optIn && (stored.analytics === null || stored.ads === null) };
}

/**
 * What a press in the banner or the settings window writes (design §4.4.4).
 * @param input - The press.
 * @param input.stored - This browser's ads choice before the press; an override in force stays when ads stay on.
 * @param input.role - `all` (accept all), `necessary` (reject all) or `save`.
 * @param input.window - Where it was pressed.
 * @param input.toggles - The settings switches, for `save`.
 * @param input.notice - The opt-out notice showing, if any.
 * @param input.gpc - Whether the browser sends GPC.
 * @returns The categories to write.
 */
export function writesForClick(input: {
  stored: BrowserAds | null;
  role: 'all' | 'necessary' | 'save';
  window: 'banner' | 'settings';
  toggles: { analytics: boolean; ads: boolean } | null;
  notice: NoticeShown;
  gpc: boolean;
}): ConsentWrites {
  const { stored, role, window, toggles, notice, gpc } = input;
  // With no notice showing, an override still in force needs no rewrite to keep ads on.
  const keepOverride = notice === false && stored !== null && adsConsentOverridesOptOut(stored);
  const source = window;
  // Only the settings window shows the notice, and only there does switching ads on override an opt-out.
  const shown: NoticeShown = window === 'settings' ? notice : false;
  if (role === 'all') {
    const analytics = { value: true, source };
    if (notice === 'account') return { analytics };
    if (notice === 'gpc') return { analytics, ads: { value: false, source: 'gpc', noticeShown: false, gpcAtDecision: true } };
    if (keepOverride) return { analytics };
    return { analytics, ads: { value: true, source, noticeShown: false, gpcAtDecision: gpc } };
  }
  const on = role === 'save' && toggles !== null ? toggles : { analytics: false, ads: false };
  if (on.ads && keepOverride) return { analytics: { value: on.analytics, source } };
  return {
    analytics: { value: on.analytics, source },
    ads: { value: on.ads, source, noticeShown: shown, gpcAtDecision: gpc },
  };
}

/**
 * The report a signed-in browser sends (design §4.4.6): each category the
 * visitor chose and that carries an id.
 * @param choices - The choices in force.
 * @param revision - The revision the library writes under.
 * @param sentAt - The browser's clock now.
 * @returns The body, or null when there is nothing to report.
 */
export function reportBody(choices: BrowserChoices, revision: number, sentAt: string): ConsentReport | null {
  const decisions: ConsentReport['decisions'][number][] = [];
  for (const category of ['analytics', 'ads'] as const) {
    const choice = choices[category];
    // A regional default is no choice of the person's, and only an operator records a request.
    if (choice === null || choice.decisionId === undefined || choice.source === 'implicit' || choice.source === 'request') {
      continue;
    }
    const ads = category === 'ads' ? (choice as BrowserAds) : null;
    decisions.push({
      decisionId: choice.decisionId,
      category,
      value: choice.value,
      source: choice.source,
      noticeShown: ads?.noticeShown ?? false,
      gpcAtDecision: ads?.gpcAtDecision ?? false,
      decidedAt: choice.decidedAt,
    });
  }
  return decisions.length === 0 ? null : { decisions, revision, sentAt };
}

/**
 * Which opt-out notice the settings window shows above the ads switch.
 * @param input - What the page knows.
 * @param input.signedIn - Whether an account is signed in.
 * @param input.outcome - `adsDecision` for this browser.
 * @param input.gpc - Whether the browser sends GPC.
 * @param input.ads - This browser's ads choice.
 * @returns `account` while a signed-in account's ads are stopped by an opt-out,
 *   `gpc` for a signed-out browser whose GPC counts, false otherwise.
 */
export function adsNotice(input: {
  signedIn: boolean;
  outcome: AdsOutcome;
  gpc: boolean;
  ads: BrowserAds | null;
}): NoticeShown {
  if (input.signedIn) return input.outcome.notice === null ? false : 'account';
  return input.gpc && !browserSuppressesOwnGpc(input.ads, 'none') ? 'gpc' : false;
}

/** What the page does with ads, and what the settings window starts with. */
export interface AdsView {
  readonly allowed: boolean;
  /** False while the account's answer is awaited for a browser that consents: nothing is refused yet. */
  readonly known: boolean;
  readonly notice: NoticeShown;
  /** Whether the settings window's ads switch starts on. */
  readonly adsOn: boolean;
}

/**
 * The page's ads view (design §4.4.4, §4.4.6). While the account's answer is
 * unknown ads stay off, and the switch shows this browser's own choice.
 * @param input - What the page knows.
 * @param input.signedIn - Whether an account is signed in.
 * @param input.outcome - `adsAllowed` for this browser, or null while the account's answer is unknown.
 * @param input.gpc - Whether the browser sends GPC.
 * @param input.ads - This browser's ads choice.
 * @returns The view.
 */
export function adsViewFor(input: {
  signedIn: boolean;
  outcome: AdsOutcome | null;
  gpc: boolean;
  ads: BrowserAds | null;
}): AdsView {
  const { signedIn, outcome, gpc, ads } = input;
  // Until the account answers, the notice is the one this browser decides alone: GPC.
  const notice = adsNotice({ signedIn: signedIn && outcome !== null, outcome: outcome ?? { allowed: false, notice: null }, gpc, ads });
  if (outcome !== null) return { allowed: outcome.allowed, known: true, notice, adsOn: outcome.allowed };
  const consents = ads?.value === true;
  return { allowed: false, known: !consents, notice, adsOn: consents };
}

/**
 * The cookie's data and accepted categories after a write (design §4.4.4
 * `setConsent()`): each category written gets a new id and the same time; a
 * category left out keeps the choice in force before the press.
 * @param writes - The categories to write.
 * @param prior - The choices in force before this write.
 * @param stored - The cookie's data entries as stored.
 * @param decidedAt - The time of this write.
 * @param newId - Makes a decision id.
 * @returns The data to store and the categories to accept.
 */
export function cookieAfterWrites(
  writes: ConsentWrites,
  prior: BrowserChoices | null,
  stored: Record<string, unknown>,
  decidedAt: string,
  newId: () => string,
): { data: Record<string, unknown>; accepted: ('analytics' | 'ads')[] } {
  const data: Record<string, unknown> = {
    analytics: prior?.analytics ? stored.analytics : undefined,
    ads: prior?.ads ? stored.ads : undefined,
  };
  const accepted = new Set((['analytics', 'ads'] as const).filter((c) => prior?.[c]?.value === true));
  for (const category of ['analytics', 'ads'] as const) {
    const write = writes[category];
    if (write === undefined) continue;
    const entry = { decisionId: newId(), decidedAt, source: write.source };
    data[category] =
      category === 'ads'
        ? { ...entry, noticeShown: write.noticeShown ?? false, gpcAtDecision: write.gpcAtDecision ?? false }
        : entry;
    if (write.value) accepted.add(category);
    else accepted.delete(category);
  }
  return { data, accepted: (['analytics', 'ads'] as const).filter((c) => accepted.has(c)) };
}

/** The account's ads record as `/users/me/analytics-consent` returns it. */
export interface AccountConsentView extends AccountAdsHistory {
  /** Whose receipt the ads decision in this browser's cookie is. */
  readonly ownership: Ownership;
  /** The server's clock when the record was read. */
  readonly serverTime: string;
}

/**
 * The account's record from an answer's `data`, checked before the page
 * trusts it.
 * @param data - The answer's `data`.
 * @returns The record, or null when it is not one; the page then treats the answer as unknown.
 */
export function readConsentView(data: unknown): AccountConsentView | null {
  if (typeof data !== 'object' || data === null) return null;
  const { receipts, gpcSeenAt, ownership, serverTime } = data as Record<string, unknown>;
  if (!Array.isArray(receipts)) return null;
  if (ownership !== 'self' && ownership !== 'other' && ownership !== 'none') return null;
  const times: unknown[] = [serverTime, ...(gpcSeenAt === null ? [] : [gpcSeenAt])];
  for (const receipt of receipts as unknown[]) {
    if (typeof receipt !== 'object' || receipt === null) return null;
    const { decisionId, value, source, noticeShown, decidedAt, revision } = receipt as Record<string, unknown>;
    const sources = ['banner', 'settings', 'implicit', 'gpc', 'request'];
    if (typeof decisionId !== 'string' || typeof value !== 'boolean' || !sources.includes(source as string)) return null;
    if ((noticeShown !== 'account' && noticeShown !== false) || !Number.isInteger(revision)) return null;
    times.push(decidedAt);
  }
  return times.every((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t))) ? (data as AccountConsentView) : null;
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
