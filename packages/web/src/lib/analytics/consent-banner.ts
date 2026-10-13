// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner and the consent cookie (inner#1442 design §4.4.3). The
 * cookie is the contract the API, collab and the website read: name
 * `breatic_consent`, categories `necessary` / `analytics` / `ads`, the policy
 * revision, and `data: { source, decidedAt }`.
 */

import * as CookieConsent from 'vanilla-cookieconsent';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import '@web/lib/analytics/consent-banner.css';
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_REVISION,
  CONSENT_SOURCES,
  requiresOptIn,
  revisionInForce,
  type ConsentSource,
} from '@breatic/shared';
import { decideOnLoad, type BrowserChoice } from '@web/lib/analytics/consent-decision';

/** Interface text, already translated. */
export interface ConsentText {
  readonly banner: { text: string; privacy: string; acceptAll: string; rejectAll: string; settings: string };
  readonly settings: {
    title: string;
    save: string;
    close: string;
    note: string;
    necessary: { title: string; description: string };
    analytics: { title: string; description: string };
    ads: { title: string; description: string };
  };
}

let onChoice: (choice: BrowserChoice | null) => void = ignoreChoice;

/** The listener until the banner starts. */
function ignoreChoice(): void {
  // Nothing listens yet.
}
// Which window the visitor last opened: a change made there is filed under it.
let openedModal: 'consentModal' | 'preferencesModal' | null = null;
// A button in the settings window was pressed; the library reports a save only when a category changes.
let saving = false;

/** The only pages the banner appears on: signing in and signing up (user 2026-10-12). */
const BANNER_PATHS: readonly string[] = ['/login', '/register'];
// An opt-in visitor who has not answered yet.
let undecided = false;
let onBannerPage = false;

// The library is running; it declines to run for crawlers and automated browsers.
let running = false;

/** Show the banner while an undecided visitor is on a banner page, and hide it elsewhere. */
function placeBanner(): void {
  if (!running) return;
  if (undecided && onBannerPage) CookieConsent.show(true);
  else CookieConsent.hide();
}

/**
 * Follow the page the visitor is on.
 * @param pathname - The page's path.
 */
export function followPage(pathname: string): void {
  onBannerPage = BANNER_PATHS.includes(pathname);
  placeBanner();
}

/**
 * The choice the cookie holds, when it holds one under the current policy.
 * Read from the cookie itself each time, so a choice another tab or the
 * website made is seen.
 * @returns The choice, or null.
 */
export function readBrowserChoice(): BrowserChoice | null {
  const cookie = CookieConsent.getCookie();
  if (!revisionInForce(cookie.revision) || !Array.isArray(cookie.categories)) return null;
  const data = (cookie.data ?? {}) as { source?: unknown; decidedAt?: unknown };
  const source = CONSENT_SOURCES.find((s) => s === data.source) ?? 'banner';
  const decidedAt = typeof data.decidedAt === 'string' ? data.decidedAt : cookie.lastConsentTimestamp;
  return {
    analytics: cookie.categories.includes('analytics'),
    ads: cookie.categories.includes('ads'),
    source,
    decidedAt,
  };
}

/**
 * The one write path for this browser's choice (design §4.4.4 `setConsent()`).
 * @param choice - The categories and where the choice came from.
 */
function setConsent(choice: BrowserChoice): void {
  const categories = ['analytics', 'ads'] as const;
  CookieConsent.acceptCategory(
    categories.filter((c) => choice[c]),
    categories.filter((c) => !choice[c]),
  );
  stamp(choice.source, choice.decidedAt);
}

/**
 * Record where the stored choice came from and when.
 * @param source - How the visitor arrived at it.
 * @param decidedAt - When, ISO.
 */
function stamp(source: ConsentSource, decidedAt: string): void {
  CookieConsent.setCookieData({ value: { source, decidedAt }, mode: 'overwrite' });
}

/** A choice the visitor made in the banner or the settings window. */
function onVisitorChoice(): void {
  if (openedModal === null) return;
  stamp(openedModal === 'preferencesModal' ? 'settings' : 'banner', new Date().toISOString());
  openedModal = null;
  undecided = false;
  lastSeen = readBrowserChoice();
  onChoice(lastSeen);
}

/**
 * The policy revision the library runs under and writes: the code's, or a newer one the stored choice was made under.
 * The account record takes the same, so a choice made here is not dropped as outdated.
 * @returns The revision.
 */
export function consentRevision(): number {
  return Math.max(CONSENT_REVISION, storedRevision());
}

/**
 * The policy revision the stored cookie was written under; readable before the library runs.
 * @returns The revision, or 0 when nothing is stored.
 */
function storedRevision(): number {
  // The library's getCookie(field, cookieName) reads a named cookie before run(); its type definitions omit the name.
  const read = CookieConsent.getCookie as (field: undefined, cookieName: string) => Partial<CookieConsent.CookieValue>;
  const { revision } = read(undefined, CONSENT_COOKIE_NAME);
  return typeof revision === 'number' ? revision : 0;
}

/** What the banner needs to start, kept so it can start again. */
interface BannerOptions {
  cookieDomain: string;
  language: string;
  languages: readonly string[];
  text: () => ConsentText;
  privacyUrl: string;
  country: Promise<string | null>;
  onChoice: (choice: BrowserChoice | null) => void;
}

let bannerOptions: BannerOptions | null = null;
let currentLanguage = '';
// The choice the cookie held when last read, so a cookie the browser refuses does not look like a change.
let lastSeen: BrowserChoice | null = null;

/**
 * Whether the library would decline to run here: the same test as its `hideFromBots`.
 * @returns True for crawlers and automated browsers.
 */
function isBot(): boolean {
  return navigator.webdriver || /bot|crawl|spider|slurp|teoma/i.test(navigator.userAgent);
}

/**
 * Show the banner when the visitor has to be asked, on the pages
 * {@link followPage} allows; apply the default otherwise; and report every
 * choice in force, including one another tab or the website makes.
 * @param options - Where to write and what to say.
 * @param options.cookieDomain - The cookie's domain; empty for the current host.
 * @param options.language - The interface language.
 * @param options.languages - Every interface language.
 * @param options.text - Reads the text in the current interface language.
 * @param options.privacyUrl - The privacy policy, linked from the banner.
 * @param options.country - The visitor's country lookup; null asks first.
 * @param options.onChoice - Called with the choice in force, now and after each change.
 */
export async function startConsentBanner(options: BannerOptions): Promise<void> {
  onChoice = options.onChoice;
  if (isBot()) {
    onChoice(null);
    return;
  }
  bannerOptions = options;
  currentLanguage = options.language;
  // Capture phase: runs before the library's own handler saves and hides the window.
  document.addEventListener(
    'click',
    (event) => {
      if (event.target instanceof Element && event.target.closest('#cc-main .pm [data-role]')) saving = true;
    },
    true,
  );
  await boot(options);
  // A restart while the lookup is still out would decide twice; the lookup ends within a second.
  await options.country;
  document.addEventListener('visibilitychange', () => void resync());
  // A window beside the one where the choice changed stays visible; it learns of it when it gets focus.
  window.addEventListener('focus', () => void resync());
}

/**
 * Pick up a choice another tab or the website wrote to the shared cookie
 * while this tab was hidden. The library keeps its own copy of the choice,
 * which its settings window shows and its next save compares against, so it
 * starts again on the cookie.
 */
async function resync(): Promise<void> {
  if (document.visibilityState !== 'visible' || bannerOptions === null) return;
  if (sameChoice(readBrowserChoice(), lastSeen)) return;
  CookieConsent.reset(false);
  await boot(bannerOptions);
}

/**
 * Start the library on the cookie, decide what is in force and report it.
 * @param options - Where to write and what to say.
 */
async function boot(options: BannerOptions): Promise<void> {
  openedModal = null;
  await CookieConsent.run({
    autoShow: false,
    // A choice stored under a newer revision stands (readBrowserChoice); the library must hold it too.
    revision: consentRevision(),
    cookie: {
      name: CONSENT_COOKIE_NAME,
      ...(options.cookieDomain !== '' ? { domain: options.cookieDomain } : {}),
      path: '/',
      sameSite: 'Lax',
      secure: window.location.protocol === 'https:',
      expiresAfterDays: CONSENT_MAX_AGE_DAYS,
    },
    guiOptions: {
      consentModal: { layout: 'bar', position: 'bottom', equalWeightButtons: true },
      preferencesModal: { layout: 'box', equalWeightButtons: true },
    },
    categories: {
      necessary: { enabled: true, readOnly: true },
      analytics: {},
      ads: {},
    },
    language: {
      default: currentLanguage,
      // Built when shown, so a language switch reads the new text.
      translations: Object.fromEntries(
        options.languages.map((language) => [language, () => toTranslation(options.text(), options.privacyUrl)]),
      ),
    },
    onModalShow: ({ modalName }) => {
      if (modalName === 'consentModal' || modalName === 'preferencesModal') openedModal = modalName;
      // A press on a window that was already hiding (a double click) never reached onModalHide.
      if (modalName === 'preferencesModal') saving = false;
    },
    // A choice that changed a category reports before the window hides and clears openedModal.
    // A save that changed nothing reports nothing, yet is the visitor's choice; closing the window
    // without a save hands back to the banner when it is still up.
    onModalHide: ({ modalName }) => {
      if (modalName !== 'preferencesModal') return;
      if (openedModal === 'preferencesModal') {
        if (saving) onVisitorChoice();
        else openedModal = undecided && onBannerPage ? 'consentModal' : null;
      }
      saving = false;
    },
    onFirstConsent: onVisitorChoice,
    onChange: onVisitorChoice,
  });

  // What the library loaded into its own memory, which its settings window shows.
  const loaded = readBrowserChoice();
  const country = loaded ? null : await options.country;
  const stored = readBrowserChoice();
  // Another tab stored a choice during the lookup: start again on it, as resync does.
  if (!sameChoice(stored, loaded)) {
    CookieConsent.reset(false);
    await boot(options);
    return;
  }
  const decision = decideOnLoad({
    stored,
    optIn: requiresOptIn(country),
    gpc: (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
    now: new Date().toISOString(),
  });
  // This write is ours, even if the visitor opened a window and closed it without choosing.
  openedModal = null;
  if (decision.choice && decision.write) setConsent(decision.choice);
  undecided = decision.showBanner;
  running = true;
  placeBanner();
  lastSeen = readBrowserChoice();
  onChoice(decision.choice);
}

/**
 * Whether two choices are the same decision.
 * @param a - One choice.
 * @param b - The other.
 * @returns True when both are absent or match in every field.
 */
function sameChoice(a: BrowserChoice | null, b: BrowserChoice | null): boolean {
  if (a === null || b === null) return a === b;
  return a.analytics === b.analytics && a.ads === b.ads && a.source === b.source && a.decidedAt === b.decidedAt;
}

/**
 * The library's text for one language.
 * @param text - The translated text.
 * @param privacyUrl - The privacy policy.
 * @returns The banner and settings text.
 */
function toTranslation(text: ConsentText, privacyUrl: string): CookieConsent.Translation {
  return {
    consentModal: {
      description: `${text.banner.text} <a href="${privacyUrl}" target="_blank" rel="noreferrer">${text.banner.privacy}</a>`,
      acceptAllBtn: text.banner.acceptAll,
      acceptNecessaryBtn: text.banner.rejectAll,
      showPreferencesBtn: text.banner.settings,
    },
    preferencesModal: {
      title: text.settings.title,
      acceptAllBtn: text.banner.acceptAll,
      acceptNecessaryBtn: text.banner.rejectAll,
      savePreferencesBtn: text.settings.save,
      closeIconLabel: text.settings.close,
      sections: [
        { title: text.settings.necessary.title, description: text.settings.necessary.description, linkedCategory: 'necessary' },
        { title: text.settings.analytics.title, description: text.settings.analytics.description, linkedCategory: 'analytics' },
        { title: text.settings.ads.title, description: text.settings.ads.description, linkedCategory: 'ads' },
        { description: text.settings.note },
      ],
    },
  };
}

/**
 * Follow an interface language switch.
 * @param language - The new language.
 */
export async function setConsentLanguage(language: string): Promise<void> {
  currentLanguage = language;
  await CookieConsent.setLanguage(language, true);
}

/** Open the settings window; the "Cookie settings" entries call this. */
export function openConsentSettings(): void {
  if (running) CookieConsent.showPreferences();
}
