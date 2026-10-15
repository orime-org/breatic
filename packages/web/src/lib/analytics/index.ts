// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The app's entry to product analytics (inner#1442). On a build without a
 * vendor configured every function here does nothing and the runtime behind
 * it is not in the bundle.
 */

import { captureException } from '@sentry/react';
import {
  getLocale,
  onLocaleChange,
  t,
  type AccountAdsView,
  type AdsSharing,
  type AnalyticsEventName,
  type Attribution,
  type ConsentSnapshot,
} from '@breatic/shared';
import { apiGet, apiPut } from '@web/data/api/request';
import { ApiException } from '@web/data/api/types';
import { getSupportedLocales } from '@web/i18n/locale-bootstrap';
import { captureAttribution, clearAttribution, readAttribution } from '@web/lib/analytics/attribution';
import { ANALYTICS_CONFIGURED } from '@web/lib/analytics/build-config';
import { adsViewFor, readAdsSharing } from '@web/lib/analytics/consent-decision';
import type { ConsentHost, ConsentText } from '@web/lib/analytics/consent-banner';
import type { AnalyticsUser } from '@web/lib/analytics/runtime';
import type * as RuntimeModule from '@web/lib/analytics/runtime';
import { PRIVACY_URL } from '@web/lib/official-home';

type Runtime = typeof RuntimeModule;

let runtime: Promise<Runtime> | null = null;
let consent: ConsentSnapshot | undefined;
/** The signed-in account; null when nobody is, undefined until the app knows. */
let signedIn: string | null | undefined = undefined;

// The account's ad switch; null until read for the signed-in account, or when the read failed.
let sharing: AdsSharing | null = null;
// Bumped by every account request and every account change, so only the latest answer is taken.
let syncSeq = 0;
// Callers waiting for the account's switch to be known or to fail.
const settledWaiters: Array<() => void> = [];
// Callers waiting for the app to know whether anyone is signed in.
const sessionWaiters: Array<() => void> = [];

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
      optedOut: t('consent.banner.optedOut'),
    },
    settings: {
      title: t('consent.settings.title'),
      save: t('consent.settings.save'),
      close: t('consent.settings.close'),
      note: t('consent.settings.note'),
      status: {
        gpc: t('consent.settings.status.gpc'),
        account: t('consent.settings.status.account'),
        browser: t('consent.settings.status.browser'),
      },
      confirm: {
        body: t('consent.settings.confirm.body'),
        yes: t('consent.settings.confirm.yes'),
        no: t('consent.settings.confirm.no'),
      },
      error: t('consent.settings.error'),
      accountError: t('consent.settings.accountError'),
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
      decideAds(module);
    });
    onLocaleChange((language) => void module.setLanguage(language));
    await module.start({
      language: getLocale(),
      languages: getSupportedLocales(),
      appVersion: import.meta.env.VITE_APP_VERSION ?? '',
      text: consentText,
      privacyUrl: PRIVACY_URL,
      host: consentHost,
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
 * The account as ads decisions see it.
 * @returns Signed out, not known yet, or the account's switch.
 */
function accountView(): AccountAdsView {
  if (signedIn === null) return 'signedOut';
  return signedIn === undefined || sharing === null ? 'unknown' : sharing;
}

/**
 * Decide whether ads run in this browser (design §4.4.6) and hand the result
 * to the runtime: this browser's own choice and GPC, with the account's switch
 * when signed in; not while the switch is unknown, which keeps ads off without
 * counting as a refusal.
 * @param module - The loaded runtime.
 */
function decideAds(module: Runtime): void {
  const choices = module.browserChoices();
  // Before the cookie is read nothing is known: an account answer arriving first must not count as a refusal.
  if (choices === undefined) return;
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  module.setAds(adsViewFor({ browserAds: choices?.ads?.value ?? null, gpc, account: accountView() }));
}

/** Release whoever waits for the account's switch to be known or to fail. */
function settleAccount(): void {
  for (const resolve of settledWaiters.splice(0)) resolve();
}

/**
 * Read the account's ad switch (design §4.4.6), then decide ads again. A
 * failed read leaves the switch unknown, which keeps ads off. Only the
 * latest request's answer is taken.
 * @param module - The loaded runtime.
 * @returns True once the switch is known.
 */
async function syncAccount(module: Runtime): Promise<boolean> {
  const seq = ++syncSeq;
  try {
    const answer = readAdsSharing(await apiGet<unknown>('/users/me/ads-sharing'));
    if (seq !== syncSeq) return false;
    if (answer === null) throw new Error('ads sharing answer is not the account switch');
    sharing = answer;
  } catch (err) {
    if (seq !== syncSeq) return false;
    sharing = null;
    captureException(err, { tags: { area: 'product_analytics' } });
  }
  settleAccount();
  decideAds(module);
  return sharing !== null;
}

/**
 * Open or close the account's ad switch (design §4.4.4), then decide ads again.
 * A 401 means the session is gone: the account is forgotten here as on sign-out.
 * @param allowed - Whether ads are turned on.
 * @returns Whether the server took it, answered that nobody is signed in, or could not be reached.
 */
async function putAdsSharing(allowed: boolean): Promise<'took' | 'signedOut' | 'failed'> {
  const seq = ++syncSeq;
  try {
    const answer = readAdsSharing(await apiPut<unknown>('/users/me/ads-sharing', { allowed }));
    if (answer === null) throw new Error('ads sharing answer is not the account switch');
    if (seq === syncSeq) sharing = answer;
    return 'took';
  } catch (err) {
    if (err instanceof ApiException && err.status === 401) {
      resetUser();
      return 'signedOut';
    }
    captureException(err, { tags: { area: 'product_analytics' } });
    return 'failed';
  } finally {
    withRuntime(decideAds);
  }
}

/** Release whoever waits for the app to know whether anyone is signed in. */
function settleSession(): void {
  for (const resolve of sessionWaiters.splice(0)) resolve();
}

/** What the banner asks about the account. */
const consentHost: ConsentHost = {
  account: accountView,
  sessionKnown: () =>
    signedIn === undefined ? new Promise((resolve) => sessionWaiters.push(resolve)) : Promise.resolve(),
  accountSettled: () =>
    signedIn === null || sharing !== null ? Promise.resolve() : new Promise((resolve) => settledWaiters.push(resolve)),
  refreshAccount: async () => (typeof signedIn === 'string' && runtime !== null ? syncAccount(await runtime) : false),
  putAdsSharing,
};

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
 * Name the signed-in account and read its ad switch.
 * @param user - The account.
 */
export function identifyUser(user: AnalyticsUser): void {
  const changed = signedIn !== user.id;
  signedIn = user.id;
  settleSession();
  if (changed) {
    syncSeq += 1;
    sharing = null;
  }
  withRuntime((module) => {
    module.identify(user);
    if (changed) void syncAccount(module);
  });
}

/** Forget the account on sign-out, and when the app starts without a session. */
export function resetUser(): void {
  signedIn = null;
  syncSeq += 1;
  sharing = null;
  settleSession();
  settleAccount();
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
