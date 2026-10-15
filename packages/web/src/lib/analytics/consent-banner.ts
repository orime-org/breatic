// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The consent banner and the consent cookie (inner#1442 design §4.4.3). The
 * cookie is the contract the API, collab and the website read: name
 * `breatic_consent`, categories `necessary` / `analytics` / `ads`, the policy
 * revision, and per category the latest choice in `data` (`CONSENT_DATA_FIELDS`).
 *
 * The library draws the windows and holds the cookie; what a press writes is
 * decided here (`writesForClick`), so its buttons are answered before the
 * library sees them (design §4.4.4).
 */

import * as CookieConsent from 'vanilla-cookieconsent';
import 'vanilla-cookieconsent/dist/cookieconsent.css';
import '@web/lib/analytics/consent-banner.css';
import {
  CONSENT_COOKIE_NAME,
  CONSENT_MAX_AGE_DAYS,
  CONSENT_REVISION,
  parseConsentChoices,
  requiresOptIn,
  revisionInForce,
  type BrowserChoices,
} from '@breatic/shared';
import { cookieAfterWrites, decideOnLoad, writesForClick, type ConsentWrites } from '@web/lib/analytics/consent-decision';

/** Interface text, already translated. */
export interface ConsentText {
  readonly banner: {
    text: string;
    privacy: string;
    acceptAll: string;
    rejectAll: string;
    settings: string;
    gpc: string;
  };
  readonly settings: {
    title: string;
    save: string;
    close: string;
    status: { gpc: string };
    necessary: { title: string; description: string };
    analytics: { title: string; description: string };
    ads: { title: string; description: string };
  };
}

let onChoice: (choices: BrowserChoices | null) => void = ignoreChoice;

/** The listener until the banner starts. */
function ignoreChoice(): void {
  // Nothing listens yet.
}
/**
 * Whether the browser sends Global Privacy Control.
 * @returns True when it does.
 */
function sendsGpc(): boolean {
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

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
 * Each category's choice the cookie holds. Read from the cookie itself each
 * time, so a choice another tab or the website made is seen.
 * @returns The choices in force.
 */
function readBrowserChoices(): BrowserChoices {
  return parseConsentChoices(JSON.stringify(CookieConsent.getCookie()), Date.now());
}

/**
 * The one write path for this browser's choice (design §4.4.4 `setConsent()`):
 * each category written gets the same time; a category left out keeps the
 * choice in force before the press.
 * @param writes - The categories to write.
 * @param prior - The choices in force before this write.
 */
function writeConsent(writes: ConsentWrites, prior: BrowserChoices | null): void {
  const stored = (CookieConsent.getCookie().data ?? {}) as Record<string, unknown>;
  const { data, accepted } = cookieAfterWrites(writes, prior, stored, new Date().toISOString());
  CookieConsent.acceptCategory(accepted, (['analytics', 'ads'] as const).filter((c) => !accepted.includes(c)));
  CookieConsent.setCookieData({ value: data, mode: 'overwrite' });
}

/**
 * The switches in the settings window.
 * @returns Where the analytics and ads switches stand.
 */
function readToggles(): { analytics: boolean; ads: boolean } {
  /**
   * Whether one switch is on.
   * @param value - The switch's category.
   * @returns Whether it is checked.
   */
  const on = (value: string): boolean =>
    document.querySelector<HTMLInputElement>(`#cc-main .pm input[value="${value}"]`)?.checked === true;
  return { analytics: on('analytics'), ads: on('ads') };
}

/**
 * Answer a press in the banner or the settings window (design §4.4.4): write
 * the cookie, close the windows and report the choice.
 * @param press - The button.
 * @param window - Where it was pressed.
 * @param toggles - The settings switches, for a save.
 */
function answerPress(
  press: 'all' | 'necessary' | 'save',
  window: 'banner' | 'settings',
  toggles: { analytics: boolean; ads: boolean } | null,
): void {
  writeConsent(writesForClick({ press, window, toggles }), lastSeen);
  undecided = false;
  lastSeen = readBrowserChoices();
  CookieConsent.hidePreferences();
  placeBanner();
  onChoice(lastSeen);
}

/**
 * Take a press away from the library and answer it here: its buttons carry `data-role`.
 * @param event - The click, in the capture phase, before the library's handlers.
 */
function onPress(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('#cc-main [data-role]');
  const role = button?.getAttribute('data-role');
  if (button === null || button === undefined || (role !== 'all' && role !== 'necessary' && role !== 'save')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const window = button.closest('.pm') ? 'settings' : 'banner';
  answerPress(role, window, window === 'settings' ? readToggles() : null);
}

/**
 * Draw the GPC line in both windows: in the banner, and in the settings
 * window under the ads switch, which stays free to turn on (design §4.4.3).
 * Every place that rebuilds a window calls this.
 */
function renderConsentWindows(): void {
  const text = bannerOptions?.text();
  if (text === undefined) return;
  const gpc = sendsGpc();
  showLine(document.querySelector('#cc-main .cm__desc'), 'breatic-consent-notice', gpc ? text.banner.gpc : null);
  const section = document.querySelector('#cc-main .pm input[value="ads"]')?.closest('.pm__section--toggle') ?? null;
  // Inside the ads card, under its description.
  const body = section?.querySelector('.pm__section-desc-wrapper') ?? section;
  showLine(body, 'breatic-consent-notice', gpc ? text.settings.status.gpc : null);
}

/**
 * Show a line in a window, or remove it.
 * @param container - Where the line goes.
 * @param className - Which line.
 * @param text - The line, or null for none.
 */
function showLine(container: Element | null, className: string, text: string | null): void {
  container?.querySelector(`.${className}`)?.remove();
  if (container === null || text === null) return;
  const line = document.createElement('p');
  line.className = className;
  line.textContent = text;
  container.append(line);
}

/**
 * The policy revision the library runs under and writes: the code's, or a newer one the stored choice was made under.
 * @returns The revision.
 */
function consentRevision(): number {
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
  return revisionInForce(revision) ? (revision as number) : 0;
}

/** What the banner needs to start, kept so it can start again. */
interface BannerOptions {
  cookieDomain: string;
  language: string;
  languages: readonly string[];
  text: () => ConsentText;
  privacyUrl: string;
  country: Promise<string | null>;
  onChoice: (choices: BrowserChoices | null) => void;
}

let bannerOptions: BannerOptions | null = null;
let currentLanguage = '';
// The choice the cookie held when last read, so a cookie the browser refuses does not look like a change.
let lastSeen: BrowserChoices | null = null;

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
  // Capture phase: runs before the library's own handlers, which would save and hide the window themselves.
  document.addEventListener('click', onPress, true);
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
 * which its settings window shows, so it starts again on the cookie.
 */
async function resync(): Promise<void> {
  if (document.visibilityState !== 'visible' || bannerOptions === null) return;
  if (sameChoices(readBrowserChoices(), lastSeen)) return;
  CookieConsent.reset(false);
  await boot(bannerOptions);
}

/**
 * Start the library on the cookie, decide what is in force and report it.
 * @param options - Where to write and what to say.
 */
async function boot(options: BannerOptions): Promise<void> {
  await CookieConsent.run({
    autoShow: false,
    // A choice stored under a newer revision stands (readBrowserChoices); the library must hold it too.
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
    onModalShow: () => renderConsentWindows(),
  });

  // What the library loaded into its own memory, which its settings window shows.
  const loaded = readBrowserChoices();
  const complete = loaded.analytics !== null && loaded.ads !== null;
  const country = complete ? null : await options.country;
  const stored = readBrowserChoices();
  // Another tab stored a choice during the lookup: start again on it, as resync does.
  if (!sameChoices(stored, loaded)) {
    CookieConsent.reset(false);
    await boot(options);
    return;
  }
  const decision = decideOnLoad({ stored, optIn: requiresOptIn(country), gpc: sendsGpc() });
  const writes: ConsentWrites = {
    ...(decision.analytics ? { analytics: decision.analytics } : {}),
    ...(decision.ads ? { ads: decision.ads } : {}),
  };
  if (writes.analytics || writes.ads) writeConsent(writes, stored);
  lastSeen = readBrowserChoices();
  onChoice(lastSeen);
  undecided = decision.showBanner;
  running = true;
  placeBanner();
}

/**
 * Whether two readings of the cookie hold the same decisions.
 * @param a - One reading.
 * @param b - The other.
 * @returns True when they match in every field.
 */
function sameChoices(a: BrowserChoices | null, b: BrowserChoices | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  // The library builds both windows afresh, from its own state.
  await CookieConsent.setLanguage(language, true);
  renderConsentWindows();
}

/** Open the settings window; the "Cookie settings" entries call this. */
export function openConsentSettings(): void {
  if (running) CookieConsent.showPreferences();
}
