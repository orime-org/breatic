// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Everything product analytics runs in the browser (inner#1442 design §4.4,
 * §4.6, §4.9). Loaded only on a build that configured a vendor; each vendor
 * loads only after its category is accepted, and is switched off and its
 * cookies cleared when the category is withdrawn.
 */

import type * as AmplitudeSdk from '@amplitude/analytics-browser';
import {
  adClickFrom,
  sanitizeEventProperties,
  snapshotOf,
  type AnalyticsEventName,
  type BrowserChoices,
  type ConsentSnapshot,
} from '@breatic/shared';
import {
  AMPLITUDE_API_KEY,
  CONSENT_COOKIE_DOMAIN,
  GOOGLE_ADS_TAG_ID,
  conversionLabels,
} from '@web/lib/analytics/build-config';
import {
  followPage,
  openConsentSettings,
  setConsentLanguage,
  startConsentBanner,
  type ConsentText,
} from '@web/lib/analytics/consent-banner';
import { readAttribution } from '@web/lib/analytics/attribution';
import { fetchCountry, type AdsView } from '@web/lib/analytics/consent-decision';

type Amplitude = typeof AmplitudeSdk;
type EventStorage = NonNullable<NonNullable<Parameters<Amplitude['init']>[2]>['storageProvider']>;

/** Who is signed in, for user properties. */
export interface AnalyticsUser {
  readonly id: string;
  readonly membershipTier: string;
  readonly language: string;
}

// How long a withdrawal waits for the SDK to send what it queued before clearing its storage.
const FLUSH_WAIT_MS = 5_000;

let sdkImport: Promise<Amplitude> | null = null;
let amplitude: Amplitude | null = null;
// Settles once the SDK has started; calls made before then are queued by the SDK and replayed later.
let sdkStarted: Promise<void> | null = null;
// Undefined until the banner has read the cookie; null on a page that collects no consent (a bot, where the banner never runs).
let choice: BrowserChoices | null | undefined = undefined;
// Whether ads run in this browser; the page decides it from the cookie (`adsViewFor`).
let adsAllowed = false;
/** The signed-in account; null when nobody is, undefined until the app knows. */
let account: AnalyticsUser | null | undefined = undefined;
let reportError: (err: unknown) => void = ignoreError;

/** The error sink until `start` sets one. */
function ignoreError(): void {
  // Nothing reports yet.
}
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
 * @param options.onError - Receives a failure applying a choice.
 */
export async function start(options: {
  language: string;
  languages: readonly string[];
  appVersion: string;
  text: () => ConsentText;
  privacyUrl: string;
  onError: (err: unknown) => void;
}): Promise<void> {
  reportError = options.onError;
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
 * Apply a choice to analytics and tell the listeners; ads wait for the page's
 * decision ({@link setAds}), and stop at once when this browser withdraws them.
 * @param next - The choices in force.
 */
async function apply(next: BrowserChoices | null): Promise<void> {
  choice = next;
  if (next?.ads?.value !== true) setAds({ allowed: false });
  const snapshot = consentSnapshot();
  for (const listener of listeners) listener(snapshot);
  try {
    await applyAnalytics(next?.analytics?.value === true);
  } catch (err) {
    reportError(err);
  }
  // A later choice arrived while this one waited, and applies itself.
  if (choice !== next) return;
  // Last, because opting the SDK out and sending its queue rewrite what it stores.
  if (next?.analytics?.value !== true) {
    clearStorage('AMP_');
    deleteDiagnostics();
  }
}

/**
 * Turn Amplitude on or off.
 * @param on - Whether analytics is accepted.
 */
async function applyAnalytics(on: boolean): Promise<void> {
  if (AMPLITUDE_API_KEY === '') return;
  if (!on) {
    if (amplitude === null || sdkStarted === null) return;
    await sdkStarted;
    // Events recorded while analytics was accepted are still sent; nothing new is recorded.
    amplitude.setOptOut(true);
    await Promise.race([amplitude.flush().promise, new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS))]);
    return;
  }
  // A failed download stays failed for this page (the browser keeps the failure); the next page load tries again.
  sdkImport ??= import('@amplitude/analytics-browser');
  const sdk = await sdkImport;
  // The choice may have been withdrawn while the SDK downloaded.
  if (choice?.analytics?.value !== true) return;
  if (amplitude === null) {
    amplitude = sdk;
    sdkStarted = sdk.init(AMPLITUDE_API_KEY, undefined, {
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
      storageProvider: consentedStorage,
    }).promise;
  }
  await sdkStarted;
  if (choice?.analytics?.value !== true) return;
  amplitude.setOptOut(false);
  followAccount(amplitude, false);
}

/**
 * Read one stored entry.
 * @param key - The entry's name.
 * @returns Its raw value, or undefined when absent or storage is blocked.
 */
function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where the SDK keeps events it has not sent yet: this browser's storage,
 * written only while analytics is accepted, so a send that finishes after a
 * withdrawal cannot store its queue again.
 */
const consentedStorage: EventStorage = {
  isEnabled: async () => {
    try {
      return typeof localStorage.length === 'number';
    } catch {
      return false;
    }
  },
  get: async (key: string) => {
    const raw = readStored(key);
    try {
      return raw === undefined ? undefined : (JSON.parse(raw) as never);
    } catch {
      return undefined;
    }
  },
  getRaw: async (key: string) => readStored(key),
  set: async (key: string, value: unknown) => {
    if (choice?.analytics?.value !== true) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked: the SDK keeps the queue in memory.
    }
  },
  remove: async (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing was stored.
    }
  },
  reset: async () => undefined,
};

/**
 * Keep the SDK's account in step with the app's: an account the SDK still
 * holds that is no longer signed in starts a new device, and the signed-in
 * account is named. A visitor who never signed in keeps their device.
 * @param sdk - The started SDK.
 * @param refresh - Send the account's properties even when it is already named.
 */
function followAccount(sdk: Amplitude, refresh: boolean): void {
  if (account === undefined) return;
  const named = sdk.getUserId();
  if (named !== undefined && named !== account?.id) sdk.reset();
  if (account !== null && (refresh || sdk.getUserId() !== account.id)) nameUser(sdk, account);
}

/**
 * Apply an account change to the SDK once it has started, while analytics is accepted.
 * @param refresh - Send the account's properties even when it is already named.
 */
function accountChanged(refresh: boolean): void {
  const sdk = amplitude;
  if (sdk === null || sdkStarted === null) return;
  void sdkStarted.then(() => {
    if (choice?.analytics?.value === true) followAccount(sdk, refresh);
  });
}

/**
 * Take the page's ads decision: load or stop the Google tag.
 * @param decision - The page's ads view.
 */
export function setAds(decision: AdsView): void {
  adsAllowed = decision.allowed;
  applyAds(decision.allowed);
  // A category not granted keeps no cookies, whether or not this page loaded its vendor.
  if (!decision.allowed) clearStorage('_gcl_');
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
  // Ads are used to measure conversions only, never to personalise them.
  gtag('consent', 'update', { ad_storage: state, ad_user_data: state, ad_personalization: 'denied' });
}

/** The standard `gtag` command queue; Google's loader reads `arguments` objects, not arrays. */
const gtag: (...args: unknown[]) => void = function () {
  const w = window as Window & { dataLayer?: unknown[] };
  // eslint-disable-next-line prefer-rest-params
  (w.dataLayer ??= []).push(arguments);
};

/**
 * Delete the database the SDK keeps for its own diagnostics, which it creates whatever its settings.
 * While this page's SDK holds it open, the deletion completes when the page closes.
 */
function deleteDiagnostics(): void {
  if (AMPLITUDE_API_KEY === '') return;
  try {
    indexedDB.deleteDatabase(`AMP_diagnostics_${AMPLITUDE_API_KEY.slice(0, 10)}`);
  } catch {
    // IndexedDB unavailable: the SDK could not have created it either.
  }
}

/**
 * Remove this site's cookies and local-storage entries whose names start with
 * a prefix; cookies on the host and on the consent cookie's domain, where the
 * vendors are told to write them.
 * @param prefix - The name prefix.
 */
function clearStorage(prefix: string): void {
  const names = document.cookie
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
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
 * This browser's choice as the backend reads it, GPC applied as the server applies it.
 * @returns Both categories; off until a choice is in force.
 */
export function consentSnapshot(): ConsentSnapshot {
  const gpc = (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  return snapshotOf(choice ?? { analytics: null, ads: null }, gpc);
}

/**
 * Each category's choice in force, for the ads decision.
 * @returns The choices; null on a page that collects no consent (a bot), undefined before the banner read the cookie.
 */
export function browserChoices(): BrowserChoices | null | undefined {
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
  if (amplitude === null || choice?.analytics?.value !== true) return;
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
  account = next;
  shared = { ...shared, membership_tier: next.membershipTier, language: next.language };
  accountChanged(true);
}

/** The source fields kept on the account in Amplitude, under the names its own web attribution uses (design §4.5). */
const SOURCE_PROPERTIES = ['utm_source', 'utm_medium', 'utm_campaign', 'landing_page'] as const;

/**
 * Put the account on the SDK; runs again once the SDK loads after sign-in.
 * Its first source is set once as `initial_*`, its latest overwrites the
 * plain names.
 * @param sdk - The loaded SDK.
 * @param account - The signed-in account.
 */
function nameUser(sdk: Amplitude, account: AnalyticsUser): void {
  sdk.setUserId(account.id);
  const identity = new sdk.Identify().set('membership_tier', account.membershipTier).set('language', account.language);
  const attribution = readAttribution();
  for (const field of SOURCE_PROPERTIES) {
    const first = attribution?.first[field];
    if (first !== undefined) identity.setOnce(`initial_${field}`, first);
  }
  for (const field of SOURCE_PROPERTIES) {
    const last = attribution?.last[field];
    if (last !== undefined) identity.set(field, last);
  }
  sdk.identify(identity);
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

/** Nobody is signed in: on sign-out, and when the app starts without a session. */
export function reset(): void {
  account = null;
  shared = { app_version: shared.app_version, language: shared.language };
  accountChanged(false);
}

/**
 * Report an ad conversion through the Google tag when this browser arrived
 * from an ad; the backend reports the same transaction id and Google counts
 * the two once (design §4.9).
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
  if (!gtagLoaded || !adsAllowed || label === undefined) return;
  // The same rule as the server upload: only a visitor who arrived from an ad in the click window.
  if (adClickFrom(readAttribution(), Date.now()) === null) return;
  gtag('event', 'conversion', {
    send_to: `${GOOGLE_ADS_TAG_ID}/${label}`,
    transaction_id: transactionId,
    ...(value ? { value: value.amountCents / 100, currency: value.currency.toUpperCase() } : {}),
  });
}

export { followPage, openConsentSettings as openSettings };
