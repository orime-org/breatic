// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The app's entry to product analytics (inner#1442). On a build without a
 * vendor configured every function here does nothing and the runtime behind
 * it is not in the bundle.
 */

import { captureException } from '@sentry/react';
import {
  adsAllowed,
  getLocale,
  onLocaleChange,
  t,
  type AccountAdsHistory,
  type AdsOutcome,
  type AnalyticsEventName,
  type Attribution,
  type ConsentSnapshot,
  type Ownership,
} from '@breatic/shared';
import { apiGet, apiPut } from '@web/data/api/request';
import { ApiException } from '@web/data/api/types';
import { getSupportedLocales } from '@web/i18n/locale-bootstrap';
import { captureAttribution, clearAttribution, readAttribution } from '@web/lib/analytics/attribution';
import { ANALYTICS_CONFIGURED } from '@web/lib/analytics/build-config';
import { adsNotice, reportBody } from '@web/lib/analytics/consent-decision';
import type { ConsentText } from '@web/lib/analytics/consent-banner';
import type { AnalyticsUser } from '@web/lib/analytics/runtime';
import type * as RuntimeModule from '@web/lib/analytics/runtime';
import { PRIVACY_URL } from '@web/lib/official-home';

type Runtime = typeof RuntimeModule;

let runtime: Promise<Runtime> | null = null;
let consent: ConsentSnapshot | undefined;
/** The signed-in account; null when nobody is, undefined until the app knows. */
let signedIn: string | null | undefined = undefined;

/** The account's ads record as `/users/me/analytics-consent` returns it. */
interface AccountConsentView extends AccountAdsHistory {
  readonly ownership: Ownership;
}

// The account's ads record and the cookie's ads decision it was read for; null until read, or when the read failed.
let account: { view: AccountConsentView; cookieId: string | undefined } | null = null;
// The ads decision this browser just wrote and is still reporting: it counts as the account's meanwhile.
let reporting: string | undefined;
// Bumped when the account changes, so an answer for an earlier one is dropped.
let generation = 0;

/**
 * The banner's text in the current interface language.
 * @returns The text.
 */
function consentText(): ConsentText {
  return {
    banner: {
      text: t('consent.banner.text'),
      privacy: t('consent.banner.privacy'),
      acceptAll: t('consent.banner.acceptAll'),
      rejectAll: t('consent.banner.rejectAll'),
      settings: t('consent.banner.settings'),
      gpc: t('consent.banner.gpc'),
    },
    settings: {
      title: t('consent.settings.title'),
      save: t('consent.settings.save'),
      close: t('consent.settings.close'),
      note: t('consent.settings.note'),
      notice: { gpc: t('consent.settings.notice.gpc'), account: t('consent.settings.notice.account') },
      necessary: { title: t('consent.settings.necessary.title'), description: t('consent.settings.necessary.description') },
      analytics: { title: t('consent.settings.analytics.title'), description: t('consent.settings.analytics.description') },
      ads: { title: t('consent.settings.ads.title'), description: t('consent.settings.ads.description') },
    },
  };
}

let attributionCaptured = false;

// The page the visitor is on, kept until the runtime loads.
let pathname = '';

/**
 * Follow the page the visitor is on; the banner appears only on some pages.
 * @param next - The page's path.
 */
export function followPage(next: string): void {
  pathname = next;
  withRuntime((module) => module.followPage(next));
}

/** Start the banner and the vendors the visitor accepts; call once at startup. */
export function startProductAnalytics(): void {
  if (!ANALYTICS_CONFIGURED || runtime !== null) return;
  // Read before the first render: the router rewrites the address (`/` to /studio, a signed-out visitor to /login)
  // long before consent applies. Held in memory only, so it needs no consent.
  const landing = new URL(window.location.href);
  const referrer = document.referrer;
  runtime = import('@web/lib/analytics/runtime').then(async (module) => {
    module.onConsentChange((next) => {
      consent = next;
      if (next.analytics || next.ads) {
        if (!attributionCaptured) captureAttribution(landing, referrer);
        attributionCaptured = true;
      } else {
        clearAttribution();
        attributionCaptured = false;
      }
      void syncAccount(module);
    });
    onLocaleChange((language) => void module.setLanguage(language));
    await module.start({
      language: getLocale(),
      languages: getSupportedLocales(),
      appVersion: import.meta.env.VITE_APP_VERSION ?? '',
      text: consentText,
      privacyUrl: PRIVACY_URL,
      onError: (err) => captureException(err, { tags: { area: 'product_analytics' } }),
    });
    module.followPage(pathname);
    return module;
  });
  runtime.catch((err: unknown) => captureException(err, { tags: { area: 'product_analytics' } }));
}

/**
 * Run against the runtime once it has loaded.
 * @param fn - What to do.
 */
function withRuntime(fn: (module: Runtime) => void): void {
  void runtime?.then(fn).catch((err: unknown) => captureException(err, { tags: { area: 'product_analytics' } }));
}

/**
 * Whose receipt the cookie's ads decision is, as far as this page knows.
 * @param decisionId - The cookie's ads decision id.
 * @returns The ownership to weigh the cookie with.
 */
function ownershipOf(decisionId: string | undefined): Ownership {
  if (decisionId === undefined || account === null) return 'none';
  if (decisionId === reporting || account.view.receipts.some((r) => r.decisionId === decisionId)) return 'self';
  return decisionId === account.cookieId ? account.view.ownership : 'none';
}

/**
 * Decide whether ads run in this browser (design §4.4.6) and hand the result
 * to the runtime: signed out, this browser's own choice and GPC; signed in,
 * with the account's events too; not while the account's record is unknown.
 * @param module - The loaded runtime.
 */
function decideAds(module: Runtime): void {
  const choices = module.browserChoices();
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  const now = Date.now();
  const at = new Date(now).toISOString();
  const browser = { choice: choices?.ads ?? null, gpcAt: gpc ? at : null, at };
  let outcome: AdsOutcome = { allowed: false, notice: null };
  if (signedIn === null) outcome = adsAllowed({ receipts: [], gpcSeenAt: null }, browser, 'none', now);
  else if (signedIn !== undefined && account !== null) {
    outcome = adsAllowed(account.view, browser, ownershipOf(browser.choice?.decisionId), now);
  }
  const notice = adsNotice({ signedIn: typeof signedIn === 'string', outcome, gpc, ads: browser.choice });
  module.setAds({ allowed: outcome.allowed, notice });
}

/**
 * Send this browser's choices to the account and read the account's ads record
 * back (design §4.4.6), then decide ads again. Signed out, decide on the
 * browser alone. A failed request leaves ads off.
 * @param module - The loaded runtime.
 */
async function syncAccount(module: Runtime): Promise<void> {
  if (typeof signedIn !== 'string') {
    decideAds(module);
    return;
  }
  const started = generation;
  const choices = module.browserChoices();
  const cookieId = choices?.ads?.decisionId;
  // sentAt lets the server correct this browser's clock, which stamped decidedAt.
  const body = choices === null ? null : reportBody(choices, module.consentRevision(), new Date().toISOString());
  reporting = body?.decisions.some((d) => d.decisionId === cookieId) ? cookieId : undefined;
  decideAds(module);
  try {
    const view = body
      ? await apiPut<AccountConsentView>('/users/me/analytics-consent', body)
      : await apiGet<AccountConsentView>('/users/me/analytics-consent');
    if (started !== generation) return;
    account = { view, cookieId };
  } catch (err) {
    if (started !== generation) return;
    account = null;
    captureException(err, { tags: { area: 'product_analytics' } });
  } finally {
    if (started === generation) reporting = undefined;
  }
  decideAds(module);
}

/**
 * Send a browser event.
 * @param name - The event.
 * @param properties - Its properties; only the listed ones leave.
 */
export function trackEvent(name: AnalyticsEventName, properties?: Record<string, unknown>): void {
  withRuntime((module) => module.track(name, properties));
}

/**
 * Report an ad conversion; the backend reports the same transaction id.
 * @param conversion - Which conversion action.
 * @param transactionId - The shared transaction id.
 * @param value - Revenue, for purchases.
 * @param value.amountCents - Amount in minor units.
 * @param value.currency - ISO currency code.
 */
export function reportConversion(
  conversion: string,
  transactionId: string,
  value?: { amountCents: number; currency: string },
): void {
  withRuntime((module) => module.conversion(conversion, transactionId, value));
}

/**
 * Name the signed-in account, send it this browser's choices and read its ads record.
 * @param user - The account.
 */
export function identifyUser(user: AnalyticsUser): void {
  const changed = signedIn !== user.id;
  signedIn = user.id;
  if (changed) {
    generation += 1;
    account = null;
  }
  withRuntime((module) => {
    module.identify(user);
    if (changed) void syncAccount(module);
  });
}

/** Forget the account on sign-out, and when the app starts without a session. */
export function resetUser(): void {
  signedIn = null;
  generation += 1;
  account = null;
  withRuntime((module) => {
    module.reset();
    decideAds(module);
  });
}

/** Open the cookie settings window. */
export function openCookieSettings(): void {
  withRuntime((module) => module.openSettings());
}

/** Whether "Cookie settings" entries are shown: only where there is something to set. */
export const COOKIE_SETTINGS_AVAILABLE: boolean = ANALYTICS_CONFIGURED;

/**
 * This browser's choice for a collab request envelope (design §4.4.5).
 * @returns The snapshot, or undefined until one is in force.
 */
export function consentForCollab(): ConsentSnapshot | undefined {
  return consent;
}

/**
 * The campaign source to send with a sign-up request, when one was kept.
 * @returns `{ attribution }`, or nothing.
 */
export function attributionBody(): { attribution?: Attribution } {
  const attribution = readAttribution();
  return attribution === null ? {} : { attribution };
}

/**
 * A short code for a failed request, for `signup_failed`.
 * @param err - What the request threw.
 * @returns The server's code or status, or `network`.
 */
export function failureCode(err: unknown): string {
  if (err instanceof ApiException) return err.code ?? String(err.status);
  return 'network';
}
