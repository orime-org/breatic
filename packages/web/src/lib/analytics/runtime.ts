// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Everything product analytics runs in the browser (inner#1442 design §4.4,
 * §4.6, §4.9). Loaded only on a build that configured a vendor; each vendor
 * loads only after its category is accepted, and is switched off and its
 * cookies cleared when the category is withdrawn.
 */

import {
  sanitizeEventProperties,
  type AnalyticsEventName,
  type ConsentSnapshot,
} from '@breatic/shared';
import {
  AMPLITUDE_API_KEY,
  CONSENT_COOKIE_DOMAIN,
  GOOGLE_ADS_TAG_ID,
  conversionLabels,
} from '@web/lib/analytics/build-config';
import {
  openConsentSettings,
  setConsentLanguage,
  startConsentBanner,
  type ConsentText,
} from '@web/lib/analytics/consent-banner';
import { fetchCountry, type BrowserChoice } from '@web/lib/analytics/consent-decision';

type Amplitude = typeof import('@amplitude/analytics-browser');

/** Who is signed in, for user properties. */
export interface AnalyticsUser {
  readonly id: string;
  readonly membershipTier: string;
  readonly language: string;
}

let amplitude: Amplitude | null = null;
let choice: BrowserChoice | null = null;
let user: AnalyticsUser | null = null;
let gtagLoaded = false;
let country: string | null = null;
let shared: { app_version: string; language: string; membership_tier?: string } = { app_version: '', language: '' };
const listeners = new Set<(consent: ConsentSnapshot) => void>();

/**
 * Start the banner and apply the choice in force.
 * @param options - What the page knows.
 * @param options.language - The interface language.
 * @param options.languages - Every interface language.
 * @param options.appVersion - The build's version, sent with every event.
 * @param options.text - Reads the banner's text in the current language.
 * @param options.privacyUrl - The privacy policy.
 */
export async function start(options: {
  language: string;
  languages: readonly string[];
  appVersion: string;
  text: () => ConsentText;
  privacyUrl: string;
}): Promise<void> {
  shared = { ...shared, app_version: options.appVersion, language: options.language };
  const countryLookup = fetchCountry(window.location.origin);
  await startConsentBanner({
    cookieDomain: CONSENT_COOKIE_DOMAIN,
    language: options.language,
    languages: options.languages,
    text: options.text,
    privacyUrl: options.privacyUrl,
    country: countryLookup,
    onChoice: (next) => void apply(next),
  });
  country = await countryLookup;
}

/**
 * Apply a choice to both vendors and tell the listeners.
 * @param next - The choice in force.
 */
async function apply(next: BrowserChoice | null): Promise<void> {
  choice = next;
  // A category not granted keeps no cookies, whether or not this page loaded its vendor.
  if (next?.analytics !== true) clearStorage('AMP_');
  if (next?.ads !== true) clearStorage('_gcl_');
  await applyAnalytics(next?.analytics === true);
  applyAds(next?.ads === true);
  const snapshot = consentSnapshot();
  for (const listener of listeners) listener(snapshot);
}

/**
 * Turn Amplitude on or off.
 * @param on - Whether analytics is accepted.
 */
async function applyAnalytics(on: boolean): Promise<void> {
  if (AMPLITUDE_API_KEY === '') return;
  if (on) {
    if (amplitude === null) {
      const module = await import('@amplitude/analytics-browser');
      // The choice may have been withdrawn while the SDK downloaded.
      if (choice?.analytics !== true) return;
      amplitude = module;
      amplitude.init(AMPLITUDE_API_KEY, undefined, {
        serverZone: 'US',
        // The domain the consent cookie uses, so withdrawal clears what the SDK wrote; empty means this host.
        cookieOptions: { domain: CONSENT_COOKIE_DOMAIN },
        autocapture: {
          attribution: false,
          pageViews: false,
          sessions: true,
          formInteractions: false,
          fileDownloads: false,
          elementInteractions: false,
          frustrationInteractions: false,
          webVitals: false,
          networkTracking: false,
          performanceTracking: false,
          pageUrlEnrichment: false,
        },
        remoteConfig: { fetchRemoteConfig: false },
        trackingOptions: { ipAddress: false, language: true, platform: true },
      });
      if (user !== null) nameUser(amplitude, user);
    }
    amplitude.setOptOut(false);
  } else if (amplitude !== null) {
    amplitude.setOptOut(true);
    clearStorage('AMP_');
  }
}

/**
 * Load the Google tag on first acceptance, and keep Consent Mode in step.
 * @param on - Whether ads are accepted.
 */
function applyAds(on: boolean): void {
  if (GOOGLE_ADS_TAG_ID === '') return;
  if (on && !gtagLoaded) {
    const w = window as Window & { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer ?? [];
    gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
    gtag('js', new Date());
    gtag('config', GOOGLE_ADS_TAG_ID, {
      send_page_view: false,
      cookie_domain: CONSENT_COOKIE_DOMAIN === '' ? 'none' : CONSENT_COOKIE_DOMAIN,
      page_location: window.location.origin + window.location.pathname,
    });
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GOOGLE_ADS_TAG_ID)}`;
    document.head.append(script);
    gtagLoaded = true;
  }
  if (!gtagLoaded) return;
  const state = on ? 'granted' : 'denied';
  gtag('consent', 'update', { ad_storage: state, ad_user_data: state, ad_personalization: state });
  if (!on) clearStorage('_gcl_');
}

/** The standard `gtag` command queue; Google's loader reads `arguments` objects, not arrays. */
const gtag: (...args: unknown[]) => void = function () {
  const w = window as Window & { dataLayer?: unknown[] };
  // eslint-disable-next-line prefer-rest-params
  (w.dataLayer ??= []).push(arguments);
};

/**
 * Remove this site's cookies and local-storage entries whose names start with
 * a prefix; cookies on the host and on the consent cookie's domain, where the
 * vendors are told to write them.
 * @param prefix - The name prefix.
 */
function clearStorage(prefix: string): void {
  const names = document.cookie
    .split(';')
    .map((pair) => pair.split('=')[0]!.trim())
    .filter((name) => name.startsWith(prefix));
  const domains = ['', CONSENT_COOKIE_DOMAIN].filter((d, i, all) => all.indexOf(d) === i);
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; Path=/${domain !== '' ? `; Domain=${domain}` : ''}`;
    }
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch {
    // Storage blocked: the vendor could not have written there either.
  }
}

/**
 * This browser's choice as the backend reads it.
 * @returns Both categories; off until a choice is in force.
 */
export function consentSnapshot(): ConsentSnapshot {
  return { analytics: choice?.analytics === true, ads: choice?.ads === true };
}

/**
 * The choice in force with its source and time, for the account record.
 * @returns It, or null while none is.
 */
export function browserChoice(): BrowserChoice | null {
  return choice;
}

/**
 * Follow consent changes.
 * @param listener - Called with each new snapshot.
 * @returns A function that stops following.
 */
export function onConsentChange(listener: (consent: ConsentSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Send a browser event.
 * @param name - The event.
 * @param properties - Candidate properties; only the listed ones leave.
 */
export function track(name: AnalyticsEventName, properties: Record<string, unknown> = {}): void {
  if (amplitude === null || choice?.analytics !== true) return;
  const allowed = sanitizeEventProperties(name, {
    ...shared,
    ...(country !== null ? { country } : {}),
    ...properties,
  });
  if (allowed !== null) amplitude.track(name, allowed);
}

/**
 * Name the signed-in account on this browser's events.
 * @param next - The account.
 */
export function identify(next: AnalyticsUser): void {
  user = next;
  shared = { ...shared, membership_tier: next.membershipTier, language: next.language };
  if (amplitude === null || choice?.analytics !== true) return;
  nameUser(amplitude, next);
}

/**
 * Put the account on the SDK; runs again once the SDK loads after sign-in.
 * @param sdk - The loaded SDK.
 * @param account - The signed-in account.
 */
function nameUser(sdk: Amplitude, account: AnalyticsUser): void {
  sdk.setUserId(account.id);
  sdk.identify(new sdk.Identify().set('membership_tier', account.membershipTier).set('language', account.language));
}

/**
 * Follow an interface language switch: the banner's text and the language
 * sent with events.
 * @param language - The new language.
 */
export async function setLanguage(language: string): Promise<void> {
  shared = { ...shared, language };
  await setConsentLanguage(language);
}

/** Forget the account on sign-out. */
export function reset(): void {
  user = null;
  shared = { app_version: shared.app_version, language: shared.language };
  // The SDK writes its cookie on reset, so it runs only while analytics is accepted.
  if (choice?.analytics === true) amplitude?.reset();
}

/**
 * Report an ad conversion through the Google tag; the backend reports the
 * same transaction id and Google counts the two once (design §4.9).
 * @param conversion - Which conversion action.
 * @param transactionId - The shared transaction id.
 * @param value - Revenue, for purchases.
 * @param value.amountCents - Amount in minor units.
 * @param value.currency - ISO currency code.
 */
export function conversion(
  conversion: string,
  transactionId: string,
  value?: { amountCents: number; currency: string },
): void {
  const label = conversionLabels()[conversion];
  if (!gtagLoaded || choice?.ads !== true || label === undefined) return;
  gtag('event', 'conversion', {
    send_to: `${GOOGLE_ADS_TAG_ID}/${label}`,
    transaction_id: transactionId,
    ...(value ? { value: value.amountCents / 100, currency: value.currency.toUpperCase() } : {}),
  });
}

export { openConsentSettings as openSettings };
