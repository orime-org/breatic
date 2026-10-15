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
  type AnalyticsEventName,
  type Attribution,
  type ConsentSnapshot,
} from '@breatic/shared';
import { apiPut } from '@web/data/api/request';
import { ApiException } from '@web/data/api/types';
import { getSupportedLocales } from '@web/i18n/locale-bootstrap';
import { captureAttribution, clearAttribution, readAttribution } from '@web/lib/analytics/attribution';
import { ANALYTICS_CONFIGURED } from '@web/lib/analytics/build-config';
import { adsViewFor } from '@web/lib/analytics/consent-decision';
import type { ConsentText } from '@web/lib/analytics/consent-banner';
import type { AnalyticsUser } from '@web/lib/analytics/runtime';
import type * as RuntimeModule from '@web/lib/analytics/runtime';
import { PRIVACY_URL } from '@web/lib/official-home';

type Runtime = typeof RuntimeModule;

let runtime: Promise<Runtime> | null = null;
let consent: ConsentSnapshot | undefined;
/** The signed-in account; null when nobody is, undefined until the app knows. */
let signedIn: string | null | undefined = undefined;
// The last report sent in this sign-in, as account and consent, so the same choice is not sent twice.
let lastReport: string | null = null;

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
      status: { gpc: t('consent.settings.status.gpc') },
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
      void reportConsent(module);
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
 * Whether the browser sends Global Privacy Control.
 * @returns True when it does.
 */
function sendsGpc(): boolean {
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

/**
 * Decide whether ads run in this browser from its own choice (design §4.4.4)
 * and hand the result to the runtime.
 * @param module - The loaded runtime.
 */
function decideAds(module: Runtime): void {
  module.setAds(adsViewFor({ ads: module.browserChoices()?.ads ?? null, gpc: sendsGpc() }));
}

/**
 * Report this browser's choice to the signed-in account (design §4.4.6):
 * after sign-in and after each change, as the snapshot the backend reads.
 * Nothing is reported before this page has read the cookie. A failure leaves the choice in this
 * browser as it is; the next change or page load reports again.
 * @param module - The loaded runtime.
 */
async function reportConsent(module: Runtime): Promise<void> {
  if (typeof signedIn !== 'string' || !module.browserChoices()) return;
  const body = module.consentSnapshot();
  const key = `${signedIn}:${JSON.stringify(body)}`;
  if (key === lastReport) return;
  lastReport = key;
  try {
    await apiPut('/users/me/consent', body);
  } catch (err) {
    if (lastReport === key) lastReport = null;
    // A session that ended is not a failure.
    if (!(err instanceof ApiException && err.status === 401)) captureException(err, { tags: { area: 'product_analytics' } });
  }
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
 * Name the signed-in account and report this browser's choice to it.
 * @param user - The account.
 */
export function identifyUser(user: AnalyticsUser): void {
  signedIn = user.id;
  withRuntime((module) => {
    module.identify(user);
    void reportConsent(module);
  });
}

/** Forget the account on sign-out, and when the app starts without a session. */
export function resetUser(): void {
  signedIn = null;
  lastReport = null;
  withRuntime((module) => module.reset());
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
